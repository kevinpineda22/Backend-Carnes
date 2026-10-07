/**
 * Reglas PURAS del lado ADMIN de las recepciones de proveedor: qué columnas salen
 * en el listado y en el detalle, cómo se arma cada fila, qué acciones tiene
 * disponibles una recepción y qué se decide antes de corregir la referencia de
 * factura o de anular. No toca la base ni SIESA: `models/RecepcionProveedorAdmin.model.js`
 * lee, llama acá y ejecuta lo que se decida.
 *
 * ─── Qué sale y qué NO sale ────────────────────────────────────────────────
 *
 *   · El LISTADO nunca lleva `firma_data` (hasta ~500 KB por fila) ni la cédula del
 *     recibidor. Las columnas se nombran una por una: con `*` bastaría que alguien
 *     agregue una columna sensible a la tabla para que se filtre en la lista.
 *   · El DETALLE del admin es el ÚNICO lugar que devuelve `firma_data` y
 *     `recibidor_cedula`. Backend-Carnes no tiene autenticación: "admin" es una
 *     frontera de la pantalla, no un control de acceso (misma postura que el resto
 *     de las rutas de Carnes).
 *   · `factura_clave` y `factura_siesa_clave` son internas y no salen en ninguno.
 */
import {
  ESTADOS,
  estaFirmada,
  puedeEnviarASiesa,
  validarTransicion,
} from "./estadosProveedor.js";
import {
  LARGO_FACTURA_SIESA,
  facturaCabeEnSiesa,
  normalizarFactura,
  resumenRecepcion,
  valorDevuelto,
} from "./proveedorValores.js";
import { DIAS_BORRADOR_VIEJO, diasDesde } from "./aperturaProveedor.js";
import { TIPO_ENVIO_PROVEEDOR } from "./siesaProveedor.js";
import {
  decidirReintentoEntrada,
  motivoEnvioVigente,
  planearAnulacionEnvios,
  rechazoDeNotaCredito,
  resumirEnvios,
  siesaDeEnvios,
} from "./siesaProveedorEnvio.js";

// ─── Columnas ──────────────────────────────────────────────────────────────

/**
 * La cabecera que ve el admin en la LISTA. Sin firma, sin cédula, sin
 * observaciones (texto libre, puede ser largo) y sin las claves internas.
 */
export const COLUMNAS_LISTA_ADMIN = `
  id, proveedor_id, proveedor_nit, proveedor_sucursal, proveedor_razon_social,
  factura, factura_siesa, sede_id, bodega_siesa, codigo_co, fecha_recepcion,
  estado, recibido_por, abierto_at, recibidor_nombre, recibidor_otro,
  finalizado_at, siesa_at, anulado_por, anulado_at, motivo_anulacion,
  created_at, updated_at,
  sede:carnes_sedes ( id, codigo_co, nombre )
`;

/**
 * La cabecera del DETALLE: la de la lista más lo que solo el admin puede ver
 * (firma, cédula, quién firmó, observaciones). Es la única consulta del módulo
 * que pide `firma_data`.
 */
export const COLUMNAS_DETALLE_ADMIN = `
  ${COLUMNAS_LISTA_ADMIN},
  observaciones, recibidor_id, recibidor_cedula, firma_data,
  proveedor_firma, proveedor_firma_nombre, proveedor_firma_documento
`;

/** Lo que el listado necesita de los renglones: solo lo que entra en el resumen. */
export const COLUMNAS_ITEMS_RESUMEN = "recepcion_id, cantidad, valor_total, cantidad_devuelta";

/** Lo que el listado necesita de los envíos: sin `payload` ni `respuesta` (pesan). */
export const COLUMNAS_ENVIOS_LISTA = "id, recepcion_proveedor_id, tipo, estado, referencia, enviado_at";

// ─── Límites del listado ───────────────────────────────────────────────────

export const LIMITE_LISTA_DEFECTO = 100;
export const LIMITE_LISTA_MAX = 200;

/**
 * Cuántas recepciones por consulta de renglones. PostgREST corta en silencio en
 * 1000 filas: con una plantilla de hasta ~50 renglones, 20 recepciones no pasan
 * de 1000. Con más de eso el resumen del listado saldría incompleto sin avisar.
 */
export const RECEPCIONES_POR_CONSULTA_ITEMS = 20;

/** Los envíos por recepción son pocos (entrada + nota crédito + reintentos). */
export const RECEPCIONES_POR_CONSULTA_ENVIOS = 50;

/** Parte una lista en tandas de `tamano`. */
export function enLotes(lista = [], tamano = 20) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
}

/** Agrupa filas por el valor de `campo` (como texto): `{ "12": [fila, ...] }`. */
export function agruparPor(filas = [], campo) {
  const grupos = {};
  for (const fila of filas) {
    const clave = String(fila?.[campo]);
    (grupos[clave] ||= []).push(fila);
  }
  return grupos;
}

// ─── Fila del listado ──────────────────────────────────────────────────────

/** La referencia que ve SIESA: la corregida por el admin si existe, si no la factura. */
export function facturaSiesaEfectiva(cabecera) {
  const corregida = String(cabecera?.factura_siesa ?? "").trim();
  return corregida || String(cabecera?.factura ?? "").trim();
}

/**
 * Para un borrador: cuántos días lleva abierto (días de calendario de Bogotá) y si
 * ya huele a abandonado (mismo umbral que el mensaje que ve quien choca con él).
 * Para cualquier otro estado, nada.
 */
export function datosBorrador(cabecera, ahora = new Date()) {
  if (cabecera?.estado !== ESTADOS.BORRADOR) return { dias_abierta: null, borrador_viejo: false };
  const dias = diasDesde(cabecera.abierto_at, ahora);
  return { dias_abierta: dias, borrador_viejo: dias >= DIAS_BORRADOR_VIEJO };
}

/**
 * Por qué una fila pide mirada del admin. Códigos cortos para que la pantalla los
 * pinte; vacío = nada que hacer. Es información, no una acción: las acciones
 * permitidas salen de `armarAcciones` en el detalle.
 */
function motivosDeAtencion({ cabecera, resumen, siesa, notaCreditoEstado, borradorViejo }) {
  const motivos = [];
  if (borradorViejo) motivos.push("borrador_viejo");
  if (cabecera.estado === ESTADOS.FINALIZADA && siesa) {
    if (siesa.estado === "sin_confirmar") motivos.push("siesa_sin_confirmar");
    else if (siesa.estado === "error") motivos.push("siesa_error");
    else if (siesa.estado === "pendiente") motivos.push("siesa_pendiente");
  }
  // La nota crédito sale cuando la entrada ya está en SIESA: ahí es cuando falta de verdad.
  if (
    cabecera.estado === ESTADOS.ENVIADA_SIESA &&
    resumen.renglones_con_devolucion > 0 &&
    notaCreditoEstado !== "ok"
  ) {
    motivos.push("nota_credito_pendiente");
  }
  return motivos;
}

/**
 * Una fila del listado: la cabecera (sin firma ni cédula) más lo calculado.
 *
 * `siesa` es el estado de la ENTRADA (null en un borrador: no hay nada que enviar);
 * viaja sin el texto del error, que pesa y solo se lee en el detalle.
 * `nota_credito_estado` es el del último envío de nota crédito (null si no hubo).
 *
 * @param {{cabecera: object, items?: object[], envios?: object[], ahora?: Date}} p
 */
export function armarFilaListado({ cabecera, items = [], envios = [], ahora = new Date() }) {
  const resumen = resumenRecepcion(items);
  const borrador = datosBorrador(cabecera, ahora);

  let siesa = null;
  if (cabecera.estado !== ESTADOS.BORRADOR) {
    const { error: _error, ...sinError } = siesaDeEnvios(envios);
    siesa = sinError;
  }
  const nc = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO);
  const notaCreditoEstado = (nc.vigente || nc.ultimo)?.estado ?? null;

  return {
    ...cabecera,
    factura_siesa_efectiva: facturaSiesaEfectiva(cabecera),
    ...borrador,
    resumen,
    siesa,
    nota_credito_estado: notaCreditoEstado,
    atencion: motivosDeAtencion({
      cabecera,
      resumen,
      siesa,
      notaCreditoEstado,
      borradorViejo: borrador.borrador_viejo,
    }),
  };
}

// ─── Detalle ───────────────────────────────────────────────────────────────

/** Los renglones con su `valor_devuelto` CALCULADO (no se guarda: no puede quedar viejo). */
export function itemsConDevuelto(items = []) {
  return items.map((item) => ({ ...item, valor_devuelto: valorDevuelto(item) }));
}

/**
 * Un envío se puede RESOLVER (confirmar o descartar a mano mirando SIESA) si quedó
 * `sin_confirmar` o si es un `enviando` ABANDONADO (la función murió en el medio).
 * Es la misma condición que aplica `SiesaEnvio.resolver`: acá se calcula para que
 * la pantalla muestre el botón solo cuando va a funcionar.
 *
 * @param {object[]} envios
 * @param {{ahora?: number, limiteMs: number}} opciones `limiteMs` = cuánto tiene
 *        que llevar `enviando` para considerarse abandonado
 */
export function marcarResolvibles(envios = [], { ahora = Date.now(), limiteMs } = {}) {
  return envios.map((envio) => {
    const edad = ahora - new Date(envio?.enviado_at ?? 0).getTime();
    const abandonado = envio?.estado === "enviando" && Number.isFinite(edad) && edad > limiteMs;
    return { ...envio, abandonado, resolvible: envio?.estado === "sin_confirmar" || abandonado };
  });
}

/**
 * La nota crédito como la ve el detalle del admin: `{requerida, estado, bloqueo,
 * referencia, error}` más `pendiente` (hay que mandarla y todavía no está en SIESA).
 * En un borrador o una recepción anulada no aplica.
 *
 * @param {object} vista `notaCreditoParaFront(decision)` — la vista automática
 * @param {string} estado estado de la recepción
 */
export function notaCreditoAdmin(vista, estado) {
  if (!estaFirmada(estado)) {
    return {
      requerida: false,
      estado: "no_aplica",
      bloqueo: null,
      referencia: null,
      error: null,
      pendiente: false,
    };
  }
  const v = vista || { requerida: false, estado: "no_requerida", bloqueo: null, referencia: null, error: null };
  return { ...v, pendiente: Boolean(v.requerida) && v.estado !== "ok" };
}

// ─── Corregir la referencia de factura ─────────────────────────────────────

/**
 * ¿Se puede corregir la referencia de factura de una recepción?
 *
 *   · Solo Finalizada (en Enviada_SIESA ya hay un documento en el ERP con la
 *     referencia vieja; en Borrador todavía no hay nada que corregir).
 *   · Y sin una entrada vigente u ok: cambiarla mientras SIESA la tiene (o la tiene
 *     en el aire) dejaría la recepción diciendo una cosa y SIESA otra.
 *
 * @returns {{ok: true} | {ok: false, status: 409, codigo: string, mensaje: string}}
 */
export function decidirEstadoCorreccion({ estado, envios = [] }) {
  const rechazo = (codigo, mensaje) => ({ ok: false, status: 409, codigo, mensaje });
  if (estado === ESTADOS.BORRADOR) {
    return rechazo("RECEPCION_BORRADOR", "La recepción todavía es un borrador: no hay nada que corregir.");
  }
  if (estado === ESTADOS.ANULADA) {
    return rechazo("RECEPCION_ANULADA", "La recepción está anulada.");
  }
  if (estado === ESTADOS.ENVIADA_SIESA) {
    return rechazo(
      "RECEPCION_ENVIADA",
      "La recepción ya está en SIESA: la referencia no se puede cambiar. Anulá la recepción y volvela a recibir.",
    );
  }
  if (!puedeEnviarASiesa(estado)) {
    return rechazo("ESTADO_DESCONOCIDO", `No se puede corregir una recepción en estado "${estado}".`);
  }
  const { vigente } = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.ENTRADA);
  if (vigente) return rechazo("ENVIO_VIGENTE", motivoEnvioVigente(vigente));
  return { ok: true };
}

/**
 * La corrección completa: formato de la referencia y estado.
 *
 * La referencia se normaliza igual que la factura (mayúsculas, espacios
 * colapsados, clave solo A-Z/0-9) y tiene que caber en el PENDIENTE de SIESA
 * (1 a 12 caracteres): para eso existe la corrección. Un formato inválido es 400;
 * un estado que no la admite, 409.
 *
 * @returns {{accion: "corregir", factura: string, clave: string}
 *   | {accion: "rechazar", status: number, codigo: string, mensaje: string}}
 */
export function decidirCorreccionFactura({ estado, envios = [], factura_siesa }) {
  const { factura, clave } = normalizarFactura(factura_siesa);
  if (!clave) {
    return {
      accion: "rechazar",
      status: 400,
      codigo: "FACTURA_SIESA_INVALIDA",
      mensaje: "La referencia para SIESA no es válida: tiene que tener letras o números.",
    };
  }
  if (!facturaCabeEnSiesa(factura)) {
    return {
      accion: "rechazar",
      status: 400,
      codigo: "FACTURA_SIESA_NO_CABE",
      mensaje:
        `La referencia para SIESA no puede pasar de ${LARGO_FACTURA_SIESA} caracteres ` +
        `(esta tiene ${factura.length}).`,
    };
  }
  const estadoOk = decidirEstadoCorreccion({ estado, envios });
  if (!estadoOk.ok) {
    const { ok: _ok, ...rechazo } = estadoOk;
    return { accion: "rechazar", ...rechazo };
  }
  return { accion: "corregir", factura, clave };
}

/**
 * El mensaje cuando la referencia nueva choca con otra recepción VIVA del mismo
 * proveedor. `otra` = `{id, factura, factura_siesa, estado, sede?: {nombre}}`.
 * Choca tanto con la factura original de la otra como con su referencia corregida
 * (regla simétrica: dos recepciones vivas no pueden tener ante SIESA el mismo papel).
 */
export function mensajeFacturaSiesaDuplicada(referencia, otra) {
  if (!otra) return `La referencia "${referencia}" ya la usa otra recepción de este proveedor.`;
  const donde = otra.sede?.nombre ? ` en ${otra.sede.nombre}` : "";
  const propia = String(otra.factura_siesa ?? "").trim();
  const detalle = propia ? `factura ${otra.factura}, referencia ${propia}` : `factura ${otra.factura}`;
  return (
    `La referencia "${referencia}" ya la usa la recepción #${otra.id} de este proveedor ` +
    `(${detalle}, ${otra.estado}${donde}). Anulala primero o elegí otra referencia.`
  );
}

// ─── Anular ────────────────────────────────────────────────────────────────

/**
 * ¿Se puede anular la recepción? Finalizada o Enviada_SIESA; un borrador se
 * DESCARTA (nunca tuvo efecto afuera) y una anulada ya no se toca. Qué pasa con
 * los envíos lo dice `SiesaEnvio.anularEnviosProveedor` (`planearAnulacionEnvios`).
 *
 * @returns {{accion: "anular"} | {accion: "rechazar", status: 409, codigo: string, mensaje: string}}
 */
export function decidirAnulacion({ estado }) {
  const rechazo = (codigo, mensaje) => ({ accion: "rechazar", status: 409, codigo, mensaje });
  if (estado === ESTADOS.BORRADOR) {
    return rechazo("RECEPCION_BORRADOR", "Un borrador no se anula, se descarta.");
  }
  if (estado === ESTADOS.ANULADA) {
    return rechazo("RECEPCION_ANULADA", "La recepción ya está anulada.");
  }
  const transicion = validarTransicion(estado, ESTADOS.ANULADA);
  if (!transicion.ok) return rechazo("ESTADO_NO_ANULABLE", transicion.motivo);
  return { accion: "anular" };
}

// ─── Eliminar ──────────────────────────────────────────────────────────────

/**
 * Estados de envío que dicen que SIESA tiene (o puede tener) el documento vigente.
 * En una recepción Anulada no deberían existir: `anular` exige resolverlos antes.
 */
const ENVIOS_VIGENTES = new Set(["ok", "enviando", "sin_confirmar", "duplicado"]);

/**
 * ¿Se puede ELIMINAR la recepción? Solo una Anulada, típicamente una prueba que ya
 * no aporta nada en la lista. Borra también sus envíos a SIESA (la FK es
 * `ON DELETE RESTRICT`), así que se exige que ninguno siga vigente: los anulados y
 * los fallidos se pueden borrar; un `ok` o uno sin resolver no.
 *
 * @returns {{accion: "eliminar"} | {accion: "rechazar", status: 409, codigo: string, mensaje: string}}
 */
export function decidirEliminacion({ estado, envios = [] }) {
  const rechazo = (codigo, mensaje) => ({ accion: "rechazar", status: 409, codigo, mensaje });
  if (estado !== ESTADOS.ANULADA) {
    return rechazo("RECEPCION_NO_ANULADA", "Solo se puede eliminar una recepción anulada.");
  }
  if (envios.some((e) => ENVIOS_VIGENTES.has(e.estado))) {
    return rechazo(
      "ENVIO_VIGENTE",
      "Tiene un envío a SIESA que no figura anulado: resolvelo antes de eliminar la recepción.",
    );
  }
  return { accion: "eliminar" };
}

// ─── Acciones del detalle ──────────────────────────────────────────────────

const permitida = (extra = {}) => ({ permitido: true, codigo: null, motivo: null, ...extra });
const denegada = (codigo, motivo, extra = {}) => ({ permitido: false, codigo, motivo, ...extra });

/**
 * Qué puede hacer el admin con una recepción AHORA, con el motivo cuando no puede.
 * Es la MISMA decisión que toma cada endpoint (se reusan sus funciones puras): la
 * pantalla muestra un botón solo si va a funcionar, sin duplicar las reglas.
 *
 *   descartar               solo un borrador (DELETE /:id).
 *   eliminar                solo una anulada, con sus envíos (DELETE /:id/admin).
 *   anular                  `requiere_anulado_en_siesa` si hay envíos ok: el body
 *                           tiene que traer `anulado_en_siesa: true`.
 *   corregir_factura        Finalizada y sin entrada vigente u ok.
 *   reintentar_siesa        `accion`: "enviar" o "reconciliar" (ya hay un ok).
 *   reintentar_nota_credito necesita la decisión MANUAL de la nota crédito.
 *
 * @param {object}   p
 * @param {string}   p.estado
 * @param {object[]} p.envios
 * @param {boolean}  p.activo  `siesaActivo()`
 * @param {object}   [p.decisionNotaCredito] `decidirNotaCredito({... manual: true})`
 */
export function armarAcciones({ estado, envios = [], activo, decisionNotaCredito = null }) {
  const descartar =
    estado === ESTADOS.BORRADOR
      ? permitida()
      : denegada("RECEPCION_NO_BORRADOR", "Solo se puede descartar un borrador.");

  const eliminacion = decidirEliminacion({ estado, envios });
  const eliminar =
    eliminacion.accion === "eliminar" ? permitida() : denegada(eliminacion.codigo, eliminacion.mensaje);

  let anular;
  const anulacion = decidirAnulacion({ estado });
  if (anulacion.accion === "rechazar") {
    anular = denegada(anulacion.codigo, anulacion.mensaje, { requiere_anulado_en_siesa: false });
  } else {
    const plan = planearAnulacionEnvios({ envios, anuladoEnSiesa: false });
    if (plan.ok) anular = permitida({ requiere_anulado_en_siesa: false });
    else if (plan.codigo === "ANULAR_EN_SIESA") {
      anular = permitida({ requiere_anulado_en_siesa: true, motivo: plan.mensaje });
    } else anular = denegada(plan.codigo, plan.mensaje, { requiere_anulado_en_siesa: false });
  }

  const correccion = decidirEstadoCorreccion({ estado, envios });
  const corregirFactura = correccion.ok ? permitida() : denegada(correccion.codigo, correccion.mensaje);

  const reintento = decidirReintentoEntrada({ estado, envios, activo });
  const reintentarSiesa =
    reintento.accion === "rechazar"
      ? denegada(reintento.codigo, reintento.mensaje, { accion: null })
      : permitida({ accion: reintento.accion });

  let reintentarNotaCredito;
  if (!decisionNotaCredito) {
    reintentarNotaCredito = denegada("SIN_DATOS", "No se pudo evaluar la nota crédito.");
  } else {
    const rechazo = rechazoDeNotaCredito(decisionNotaCredito);
    reintentarNotaCredito = rechazo ? denegada(rechazo.codigo, rechazo.mensaje) : permitida();
  }

  return {
    descartar,
    eliminar,
    anular,
    corregir_factura: corregirFactura,
    reintentar_siesa: reintentarSiesa,
    reintentar_nota_credito: reintentarNotaCredito,
  };
}
