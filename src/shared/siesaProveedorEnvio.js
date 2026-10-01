/**
 * Decisiones PURAS del envío a SIESA de una recepción de proveedor: qué hacer
 * (mandar, reconciliar, esperar, rechazar) según el estado de la recepción y de
 * sus envíos. No toca la base ni SIESA: `models/SiesaEnvio.model.js` lee, llama a
 * estas funciones y ejecuta lo que digan.
 *
 * Armar el JSON es de `siesaProveedor.js`; esto es la POLÍTICA, igual que el
 * encabezado de SiesaEnvio.model.js lo es para Talleres.
 *
 * ─── Las reglas ────────────────────────────────────────────────────────────
 *
 *   · AL FINALIZAR la entrada sale sola, pero SOLO si la recepción no tiene
 *     NINGÚN envío `entrada_proveedor` (ni siquiera uno con error): cada recarga
 *     del celular reintenta `finalizar`, y los errores los reintenta el admin a
 *     propósito (`debeEnviarEntrada`).
 *   · REINTENTAR (admin): si ya hay una entrada `ok` no se manda otra, se
 *     RECONCILIA el estado (Finalizada → Enviada_SIESA); con una en curso o sin
 *     confirmar se pide resolverla; si no, se manda por el candado.
 *   · NOTA CRÉDITO: sale cuando la entrada está `ok` y hay renglones devueltos.
 *     Automática: una sola vez (sin ningún envío de nota crédito previo);
 *     manual: mientras no haya uno vigente u `ok`. Un bloqueo previo al POST
 *     (conector sin configurar, SIESA sin credenciales) NO se anota como envío
 *     `error`: devolverlo y listo, o cada disparo llenaría la tabla de filas
 *     idénticas.
 *   · ANULAR: mientras haya un envío en curso o sin confirmar no se anula; uno
 *     `ok` exige que el admin confirme que ya lo anuló en SIESA.
 */
import { ESTADOS } from "./estadosProveedor.js";
import { debeEnviarEntrada } from "./finalizarProveedor.js";
import { TIPO_ENVIO_PROVEEDOR } from "./siesaProveedor.js";

export const TIPOS_ENVIO_PROVEEDOR = Object.values(TIPO_ENVIO_PROVEEDOR);

/** ¿Es un envío de una recepción de proveedor (y no de Talleres)? */
export const esTipoProveedor = (tipo) => TIPOS_ENVIO_PROVEEDOR.includes(tipo);

/** Los estados que ocupan el lugar del envío (índice único de sql/023). */
export const ESTADOS_VIGENTES = ["enviando", "ok", "sin_confirmar"];

/** Los que están en el aire: SIESA pudo haberlos creado y todavía no se sabe. */
export const ESTADOS_EN_CURSO = ["enviando", "sin_confirmar"];

export const MENSAJE_APAGADO = "El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).";

// ─── Lectura de los envíos ─────────────────────────────────────────────────

const aMs = (v) => {
  const t = new Date(v ?? 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** El más reciente primero: por `enviado_at` y, a igualdad, por `id`. */
function masRecientePrimero(a, b) {
  return aMs(b?.enviado_at) - aMs(a?.enviado_at) || Number(b?.id ?? 0) - Number(a?.id ?? 0);
}

/**
 * Qué hay de un tipo de envío en una recepción.
 *
 * @returns {{total: number, ok: object|null, enCurso: object|null,
 *   vigente: object|null, ultimo: object|null}}
 *   `vigente` es el que ocupa el lugar (el índice garantiza uno solo por tipo);
 *   `ultimo` es el intento más reciente, sea cual sea su estado.
 */
export function resumirEnvios(envios, tipo) {
  const propios = (envios || []).filter((e) => e?.tipo === tipo).sort(masRecientePrimero);
  const ok = propios.find((e) => e.estado === "ok") || null;
  const enCurso = propios.find((e) => ESTADOS_EN_CURSO.includes(e.estado)) || null;
  return {
    total: propios.length,
    ok,
    enCurso,
    vigente: ok || enCurso,
    ultimo: propios[0] || null,
  };
}

/** Por qué no se puede mandar con un envío vigente, dicho para una persona. */
export function motivoEnvioVigente(envio) {
  if (!envio) return "Ya hay un envío vigente.";
  if (envio.estado === "ok") return `Ya está en SIESA (${envio.referencia}).`;
  if (envio.estado === "enviando") {
    return `Hay un envío en curso (${envio.referencia}). Esperá a que termine y actualizá.`;
  }
  return (
    `El envío ${envio.referencia} quedó sin confirmar: SIESA pudo haberlo creado. ` +
    "Verificalo en SIESA y marcalo desde el panel de envíos antes de reintentar."
  );
}

/** Lo que el front necesita del estado del envío de la ENTRADA. */
export function siesaDeFila(fila) {
  if (!fila) return { estado: "pendiente", referencia: null, error: null, envio_id: null };
  return {
    estado: fila.estado,
    referencia: fila.referencia ?? null,
    error: fila.error ?? null,
    envio_id: fila.id ?? null,
  };
}

/**
 * El estado de la entrada según lo que ya hay anotado: el envío `ok` si existe,
 * si no el que está en curso, si no el último intento (un error). Sin envíos,
 * "pendiente".
 */
export function siesaDeEnvios(envios) {
  const { vigente, ultimo } = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.ENTRADA);
  return siesaDeFila(vigente || ultimo);
}

// ─── Devoluciones ──────────────────────────────────────────────────────────

/**
 * ¿Hay algún renglón recibido con cantidad devuelta? Es la MISMA condición con la
 * que `armarNotaCreditoProveedor` elige los renglones de la nota crédito.
 */
export function hayDevoluciones(items) {
  return (items || []).some(
    (i) => (Number(i?.cantidad) || 0) > 0 && (Number(i?.cantidad_devuelta) || 0) > 0,
  );
}

// ─── Entrada ───────────────────────────────────────────────────────────────

/**
 * Qué hace `finalizar` con la entrada.
 *
 *   enviar   no hay ningún envío de entrada y SIESA está activo.
 *   apagado  no hay ninguno, pero CARNES_SIESA_ACTIVO está apagado: no se manda ni
 *            se anota nada (como la inicial de Talleres).
 *   omitir   ya hay envíos de entrada (cualquier estado), o la recepción no está
 *            Finalizada: se informa el estado que hay, no se manda otro.
 *
 * @param {{estado: string, envios?: object[], activo: boolean}} p
 */
export function decidirEntradaAlFinalizar({ estado, envios = [], activo }) {
  const entrada = (envios || []).filter((e) => e?.tipo === TIPO_ENVIO_PROVEEDOR.ENTRADA);
  if (!debeEnviarEntrada({ estado, enviosEntrada: entrada })) return { accion: "omitir" };
  if (!activo) return { accion: "apagado" };
  return { accion: "enviar" };
}

/**
 * Qué hace el reintento manual de la entrada (admin).
 *
 *   rechazar    409 con el motivo: borrador, anulada, envío en curso / sin
 *               confirmar, estado inconsistente o SIESA apagado.
 *   reconciliar ya hay una entrada `ok`: no se manda otra, solo se alinea el
 *               estado de la recepción con lo que ya está en SIESA.
 *   enviar      se manda por el candado.
 *
 * Reconciliar no depende de que SIESA esté activo: no habla con SIESA.
 *
 * @param {{estado: string, envios?: object[], activo: boolean}} p
 */
export function decidirReintentoEntrada({ estado, envios = [], activo }) {
  const rechazo = (mensaje, codigo, status = 409) => ({ accion: "rechazar", status, codigo, mensaje });

  if (estado === ESTADOS.BORRADOR) {
    return rechazo("La recepción todavía es un borrador: no hay nada que enviar.", "RECEPCION_BORRADOR");
  }
  if (estado === ESTADOS.ANULADA) {
    return rechazo("La recepción está anulada.", "RECEPCION_ANULADA");
  }
  if (estado !== ESTADOS.FINALIZADA && estado !== ESTADOS.ENVIADA_SIESA) {
    return rechazo(`No se puede enviar una recepción en estado "${estado}".`, "ESTADO_DESCONOCIDO");
  }

  const { ok, enCurso } = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.ENTRADA);
  if (ok) return { accion: "reconciliar", envio: ok };
  if (enCurso) return rechazo(motivoEnvioVigente(enCurso), "ENVIO_VIGENTE");

  // Enviada_SIESA sin una entrada ok: no se puede reenviar (dejaría dos documentos
  // si la entrada sí está en SIESA); hay que mirarlo a mano.
  if (estado === ESTADOS.ENVIADA_SIESA) {
    return rechazo(
      'La recepción figura como "Enviada_SIESA" pero no tiene una entrada confirmada. ' +
        "Revisá los envíos en SIESA antes de tocarla.",
      "ESTADO_INCONSISTENTE",
    );
  }
  if (!activo) return rechazo(MENSAJE_APAGADO, "SIESA_APAGADO");
  return { accion: "enviar" };
}

// ─── Nota crédito ──────────────────────────────────────────────────────────

/**
 * Qué hacer con la nota crédito de una recepción.
 *
 *   no_requerida  ningún renglón devuelto.
 *   no_aplica     la recepción no está firmada (borrador, anulada).
 *   esperar       la entrada todavía no está `ok`: la nota crédito sale después.
 *   omitir        ya está ok, está en curso, o (en automático) ya hubo un intento
 *                 y el reintento es del admin.
 *   apagado       SIESA está apagado.
 *   bloquear      no se puede armar o mandar (conector sin configurar, SIESA sin
 *                 credenciales, datos faltantes). NO se anota ningún envío.
 *   enviar        se manda por el candado.
 *
 * `estado` es el que se le informa al front para la nota crédito: no_requerida,
 * pendiente, bloqueada, enviando, sin_confirmar, error u ok.
 *
 * @param {object}   p
 * @param {string}   p.estado     de la recepción
 * @param {object[]} p.items
 * @param {object[]} p.envios     todos los de la recepción
 * @param {boolean}  p.activo     `siesaActivo()`
 * @param {string[]} [p.bloqueos] los del armador, más los de credenciales
 * @param {boolean}  [p.manual]   true = lo pidió el admin (reintenta tras un error)
 */
export function decidirNotaCredito({ estado, items = [], envios = [], activo, bloqueos = [], manual = false }) {
  if (!hayDevoluciones(items)) {
    return { accion: "no_requerida", estado: "no_requerida", motivo: "La recepción no tiene renglones devueltos." };
  }
  if (estado !== ESTADOS.FINALIZADA && estado !== ESTADOS.ENVIADA_SIESA) {
    return { accion: "no_aplica", estado: "pendiente", motivo: `La recepción está en "${estado}".` };
  }

  const entrada = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.ENTRADA);
  if (!entrada.ok) {
    return {
      accion: "esperar",
      estado: "pendiente",
      motivo: "La entrada todavía no está en SIESA: la nota crédito sale después de ella.",
    };
  }

  const nc = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO);
  if (nc.ok) return { accion: "omitir", estado: "ok", motivo: motivoEnvioVigente(nc.ok), envio: nc.ok };
  if (nc.enCurso) {
    return { accion: "omitir", estado: nc.enCurso.estado, motivo: motivoEnvioVigente(nc.enCurso), envio: nc.enCurso };
  }
  // En automático, un intento anterior (con error) lo reintenta el admin.
  if (!manual && nc.total > 0) {
    return {
      accion: "omitir",
      estado: "error",
      motivo: nc.ultimo?.error || "El envío de la nota crédito falló: un administrador la reintenta.",
      envio: nc.ultimo,
    };
  }

  if (!activo) return { accion: "apagado", estado: "pendiente", motivo: MENSAJE_APAGADO };
  if (bloqueos.length) {
    return { accion: "bloquear", estado: "bloqueada", bloqueo: bloqueos.join(" "), motivo: bloqueos.join(" ") };
  }
  return { accion: "enviar", estado: "pendiente" };
}

/**
 * La nota crédito como la ve el front: `{requerida, estado, bloqueo}` más la
 * referencia y el error del envío cuando hubo uno.
 *
 * @param {object} decision `decidirNotaCredito(...)`
 * @param {object} [fila]   el envío recién hecho, si se mandó
 */
export function notaCreditoParaFront(decision, fila = null) {
  const requerida = decision.estado !== "no_requerida";
  const envio = fila || decision.envio || null;
  return {
    requerida,
    estado: fila ? fila.estado : decision.estado,
    bloqueo: decision.accion === "bloquear" ? decision.bloqueo : null,
    referencia: envio?.referencia ?? null,
    error: envio?.error ?? null,
  };
}

/**
 * Qué responde el endpoint MANUAL cuando la decisión no es enviar: un 409 con el
 * motivo. `null` si hay que enviar.
 */
export function rechazoDeNotaCredito(decision) {
  const rechazo = (codigo) => ({ status: 409, codigo, mensaje: decision.bloqueo || decision.motivo });
  switch (decision.accion) {
    case "enviar":
      return null;
    case "no_requerida":
      return rechazo("SIN_DEVOLUCIONES");
    case "no_aplica":
      return rechazo("RECEPCION_NO_FIRMADA");
    case "esperar":
      return rechazo("ENTRADA_NO_ENVIADA");
    case "omitir":
      return rechazo("NOTA_CREDITO_VIGENTE");
    case "apagado":
      return rechazo("SIESA_APAGADO");
    default:
      return rechazo("NOTA_CREDITO_BLOQUEADA");
  }
}

// ─── Snapshots ─────────────────────────────────────────────────────────────

/**
 * Lo que cambió en los maestros desde que se tomó la foto de la recepción. Vacío
 * si no hay nada que actualizar. Se aplica SOLO mientras no haya una entrada `ok`
 * (después queda congelada: lo que SIESA ya recibió no se reescribe). Un maestro
 * que ya no existe se deja como está.
 *
 * @param {object} recepcion
 * @param {{proveedor?: ?{nit: string, sucursal: string, razon_social: string},
 *          sede?: ?{codigo_co: ?string, bodega_siesa: ?string}}} maestros
 * @returns {object} columnas a actualizar
 */
export function armarRefrescoSnapshots(recepcion, { proveedor, sede } = {}) {
  const cambios = {};
  const distinto = (a, b) => String(a ?? "") !== String(b ?? "");
  if (proveedor) {
    for (const [columna, valor] of [
      ["proveedor_nit", proveedor.nit],
      ["proveedor_sucursal", proveedor.sucursal],
      ["proveedor_razon_social", proveedor.razon_social],
    ]) {
      if (distinto(recepcion?.[columna], valor)) cambios[columna] = valor;
    }
  }
  if (sede) {
    for (const [columna, valor] of [
      ["bodega_siesa", sede.bodega_siesa ?? null],
      ["codigo_co", sede.codigo_co ?? null],
    ]) {
      if (distinto(recepcion?.[columna], valor)) cambios[columna] = valor;
    }
  }
  return cambios;
}

// ─── Anulación ─────────────────────────────────────────────────────────────

/**
 * ¿Se pueden anular los envíos de la recepción para anular la recepción?
 *
 *   · Uno en curso o sin confirmar (`enviando`, `sin_confirmar`) bloquea: SIESA
 *     pudo haberlo creado. Se resuelve primero desde el panel de envíos. (Un
 *     `enviando` ABANDONADO también bloquea: es tan incierto como un sin
 *     confirmar, y `resolver` lo sabe cerrar.)
 *   · Uno `ok` exige `anuladoEnSiesa`: alguien lo anuló en SIESA y lo confirma.
 *     Recién entonces se marcan como `anulado`.
 *
 * @param {{envios?: object[], anuladoEnSiesa?: boolean}} p
 * @returns {{ok: true, aAnular: object[]} | {ok: false, status: 409, codigo: string, mensaje: string}}
 */
export function planearAnulacionEnvios({ envios = [], anuladoEnSiesa = false } = {}) {
  const referencias = (lista) => lista.map((e) => e.referencia).join(", ");
  const enCurso = (envios || []).filter((e) => ESTADOS_EN_CURSO.includes(e?.estado));
  if (enCurso.length) {
    return {
      ok: false,
      status: 409,
      codigo: "ENVIO_SIN_RESOLVER",
      mensaje:
        `Hay envíos sin resolver (${referencias(enCurso)}). Verificalos en SIESA y marcalos desde el ` +
        "panel de envíos antes de anular la recepción.",
    };
  }
  const enSiesa = (envios || []).filter((e) => e?.estado === "ok");
  if (enSiesa.length && !anuladoEnSiesa) {
    return {
      ok: false,
      status: 409,
      codigo: "ANULAR_EN_SIESA",
      mensaje:
        `La recepción ya está en SIESA (${referencias(enSiesa)}). Anulá el documento en SIESA y ` +
        "confirmalo para poder anular la recepción.",
    };
  }
  return { ok: true, aAnular: enSiesa };
}

// ─── Detalle de un envío (PanelSiesa) ──────────────────────────────────────

const milesimas = (n) => Math.round((Number(n) || 0) * 1000);

/**
 * Le pega a cada movimiento del payload el renglón de la recepción de proveedor
 * del que salió, con la forma que lee el panel de envíos (la de la CEA de
 * Talleres, más `equivalencia` y `unidad`).
 *
 * El renglón se busca por código de ítem y cantidad: la entrada manda
 * `cantidad`; la nota crédito, `cantidad_devuelta`. Dos renglones con el mismo
 * ítem se distinguen por la cantidad; cada renglón se usa una sola vez.
 *
 * @param {{tipo: string, movimientos?: object[], items?: object[], sede?: ?object}} p
 */
export function enriquecerMovimientosProveedor({ tipo, movimientos = [], items = [], sede = null }) {
  const usados = new Set();
  const cantidadDe = (i) => (tipo === TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO ? i.cantidad_devuelta : i.cantidad);

  return (movimientos || []).map((m, n) => {
    const codigo = String(m?.ITEM ?? "").trim();
    const candidatos = (items || []).filter(
      (i) => !usados.has(i.id) && String(i.codigo_item ?? "").trim() === codigo,
    );
    const renglon =
      candidatos.find((i) => milesimas(cantidadDe(i)) === milesimas(m?.CANTIDAD)) || candidatos[0] || null;
    if (renglon) usados.add(renglon.id);

    const cantidad = Number(m?.CANTIDAD) || 0;
    const bruto = Number(m?.VALOR_BRUTO) || 0;
    return {
      ...m,
      NRO_REGISTRO: m?.NRO_REGISTRO ?? String(n + 1),
      CO_MOVIMIENTO: m?.CO_MOVIMIENTO ?? "",
      sede: sede?.nombre ?? null,
      descripcion: renglon ? String(renglon.equivalencia ?? "").trim() || renglon.descripcion_item || null : null,
      equivalencia: renglon ? String(renglon.equivalencia ?? "").trim() || null : null,
      unidad: String(m?.UNIDAD_MEDIDA ?? "").trim() || null,
      cantidad,
      valor_bruto: bruto,
      precio_unitario: cantidad > 0 ? Math.round((bruto / cantidad) * 100) / 100 : null,
      // Los costos base y ajustado son de la liquidación de Talleres: no aplican.
      costo_base: null,
      costo_ajustado: null,
    };
  });
}
