/**
 * Armado del documento ENTRADA_DIRECTA_ALMACEN para el conector de SIESA.
 *
 * Módulo PURO, como `costeo.js`: entra una recepción con sus renglones y la
 * configuración, sale el JSON que espera el conector. No hace HTTP, no toca la
 * base. Por eso se puede testear contra la recepción real de López sin tener
 * las credenciales de SIESA a mano.
 *
 * ─── Las dos entradas ─────────────────────────────────────────────────────
 *
 * Cada recepción va DOS veces a SIESA, y las dos quedan "en elaboración":
 *
 *   INICIAL  cuando el recibidor cierra. Precio = costo base de la plantilla.
 *            Sirve para que inventario vea que la carne llegó, mientras llega
 *            la factura. Alguien la ANULA en SIESA cuando sale la oficial.
 *   OFICIAL  cuando el admin costea la liquidación. Precio = costo ajustado
 *            por el factor. Es la que se aprueba.
 *
 * Las notas dicen cuál es cuál, y la oficial lleva en `PENDIENTE` (documento
 * de referencia) la referencia de la inicial, para que quien anula sepa qué
 * anular sin buscar.
 *
 * ─── Lo que el conector tiene FIJO y lo que espera VARIABLE ───────────────
 *
 * En la configuración del conector (pantallazos del 21/09) hay valores fijos
 * que NO viajan en el JSON: compañía 001, CO del documento 001, clase 408,
 * concepto 401, grupo 403, comprador 901150440, moneda COP, estado 0
 * (elaboración), consecutivo automático. Acá se arman solo las variables.
 *
 * ─── Sobre el consecutivo ─────────────────────────────────────────────────
 *
 * `F_CONSEC_AUTO_REG = 1`: SIESA recalcula el consecutivo al importar. El que
 * se manda acá es un número propio para que Documentos y Movimientos se
 * enlacen entre sí en el mismo envío — no es el número que va a tener el
 * documento en SIESA. Por eso la referencia cruzada entre inicial y oficial
 * va por `PENDIENTE` y por las notas, que sí viajan tal cual.
 *
 * ─── Vísceras: NO van en esta entrada ─────────────────────────────────────
 *
 * Desde el 29/09/2026 las vísceras no viajan en la inicial ni en la oficial
 * (`vaASiesa` en `shared/visceras.js` las excluye): la CEA es la factura y solo
 * lleva cortes. Entran al inventario por un documento aparte, el ajuste de
 * vísceras CEI (`shared/siesaAjusteVisceras.js`): por liquidación, o por
 * recepción al cerrar si CARNES_SIESA_VISCERAS_AL_CIERRE está prendida.
 *
 * (Entre `sql/016_visceras_siesa.sql` y esa decisión sí iban como un renglón
 * más, con su propia unidad y sin prorratear: `costo_base`, nunca
 * `costo_ajustado`. Esos renglones ya no se arman acá.)
 */
import {
  esProducto,
  tieneCodigoSiesa,
  vaASiesa,
  ajustarCantidadAUnidad,
  decimalesDeUnidad,
} from "./visceras.js";

/** Los dos tipos de envío, y cómo se leen en SIESA. */
export const TIPO_ENVIO = {
  INICIAL: "inicial",
  OFICIAL: "oficial",
};

const NOTA = {
  [TIPO_ENVIO.INICIAL]: "TALLER DE CARNES - ENTRADA INICIAL",
  [TIPO_ENVIO.OFICIAL]: "TALLER DE CARNES - ENTRADA OFICIAL",
};

/** `PENDIENTE` (f451_num_docto_referencia) admite 12 caracteres. */
const LARGO_REFERENCIA = 12;

/**
 * La forma legible si entra en los 12 caracteres de `PENDIENTE`; si no, la
 * compacta. Nunca se corta la legible: cortarla se come dígitos del número y
 * dos recepciones distintas terminarían con la misma referencia en SIESA.
 */
export function ajustarReferencia(legible, compacta) {
  return legible.length <= LARGO_REFERENCIA ? legible : compacta.slice(0, LARGO_REFERENCIA);
}

/**
 * Referencia propia de un envío: `TC INI R23` / `TC OFI R23`.
 *
 * TC = Taller de Carnes. Tiene que caber en 12 caracteres y leerse en SIESA sin
 * un diccionario al lado. Entra legible hasta la recepción #9999; de ahí en
 * adelante pasa a `TCIR12345`.
 *
 * Antes del 28/09/2026 el formato era `R23I` / `R23O`. Esas referencias siguen
 * en la base tal cual —se leen de cada envío, nunca se recalculan con esta
 * función—, así que el correo de anulación sigue nombrando el documento que
 * existe de verdad en SIESA.
 */
export function referenciaEnvio(recepcionId, tipo) {
  const corto = tipo === TIPO_ENVIO.OFICIAL ? "OFI" : "INI";
  return ajustarReferencia(`TC ${corto} R${recepcionId}`, `TC${corto[0]}R${recepcionId}`);
}

/**
 * El bloque `siesa` que el recibidor ve al finalizar Talleres. Siempre lleva la
 * referencia de la entrada inicial para anotarla en la factura física: la del envío
 * si existe (puede ser de formato anterior) y, si no (SIESA apagado o falló antes
 * de reservar el envío), la que tendrá cuando se envíe.
 */
export function siesaParaRecibidor(siesa, recepcionId) {
  return {
    estado: siesa?.estado ?? null,
    referencia: siesa?.referencia ?? referenciaEnvio(recepcionId, TIPO_ENVIO.INICIAL),
    error: siesa?.error ?? null,
    novedad: siesa?.novedad ?? null,
  };
}

/**
 * Referencia de la oficial de una liquidación: `TC OFI L12`.
 *
 * `L` y no `R` para que en SIESA se distinga a simple vista de las oficiales
 * viejas por sede, que quedan en el historial. Antes del 28/09/2026: `L12O`.
 *
 * Desde sql/033 la oficial sale UNA POR FECHA DE INGRESO. Con una sola fecha la
 * referencia es la de siempre (`TC OFI L12`); con varias, cada documento lleva
 * dos letras derivadas de su fecha (`TC OFI L12KD`). Ver `sufijoDocumento`. La
 * forma legible cabe en 12 caracteres hasta la liquidación #99 con sufijo; de ahí
 * pasa a `TCOL123KD`.
 *
 * @param {number|string} liquidacionId
 * @param {string} [sufijo]  `""` (una sola fecha) o la letra de `sufijoDocumento`
 */
export function referenciaLiquidacion(liquidacionId, sufijo = "") {
  return ajustarReferencia(`TC OFI L${liquidacionId}${sufijo}`, `TCOL${liquidacionId}${sufijo}`);
}

/**
 * Sufijo de DOS letras que distingue los documentos de una misma liquidación
 * cuando salen varios (uno por fecha). Sale de la FECHA, no de la posición: el
 * mismo día da siempre las mismas letras, aunque después se vincule una
 * recepción con una fecha más antigua. Con un solo documento no lleva nada, y
 * así la referencia queda idéntica a la de antes de sql/033.
 *
 * Esquema: días transcurridos desde el 01/01/2026, módulo 676, escritos en base
 * 26 con letras A-Z (A=0): 21/09/2026 (día 263) → `KD`, 24/09/2026 → `KG`.
 * Dos letras porque `TC OFI L12` + 2 = 12 caracteres, el máximo de PENDIENTE. Las
 * letras después de un id numérico no se confunden con el id. Dos fechas de la
 * misma liquidación solo chocan si distan un múltiplo exacto de 676 días; aun así
 * el modelo bloquea el envío si una referencia pendiente repite otra de la
 * liquidación (`referenciasEnConflicto`).
 *
 * @param {string|null} fecha  AAAAMMDD
 * @param {number} total       cuántos documentos salen
 */
export function sufijoDocumento(fecha, total) {
  if (!(total > 1)) return "";
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(fecha ?? ""));
  if (!m) return "XX";
  const dias = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(2026, 0, 1)) / 86400000);
  const n = ((dias % 676) + 676) % 676;
  return String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
}

/** `f350_notas` es texto largo, pero no infinito: se acota por las dudas. */
const LARGO_NOTAS = 255;

/**
 * Notas del documento, legibles para quien lo abre en SIESA:
 * "TALLER DE CARNES - ENTRADA INICIAL - RECEPCION #23 Lopez - TC INI R23".
 *
 * Desde el 30/09/2026 el conector 256783 tiene `f350_notas` como la variable
 * `NOTAS` (antes era fijo, "TALLER DE CARNES"), así que esto SÍ viaja y se lee
 * tal cual en SIESA. Exportada para el armador de proveedores.
 */
export function notasDocumento(nota, detalle, referencia) {
  return [nota, detalle, referencia].filter(Boolean).join(" - ").slice(0, LARGO_NOTAS);
}

/** `2026-09-16` → `20260916`. El plano pide AAAAMMDD. */
export function fechaSiesa(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

/**
 * La más antigua de una lista de fechas. Ya NO decide la fecha de la oficial
 * (desde sql/033 sale un documento por fecha); queda como red de seguridad de
 * los armadores de UN documento, que reciben recepciones de un solo día.
 *
 * @param {string[]} fechas AAAAMMDD (las inválidas ya filtradas)
 * @returns {string|null}
 */
export function fechaMasAntigua(fechas = []) {
  return [...fechas].sort()[0] ?? null;
}

/** `20260916` → `2026-09-16`, para la columna `fecha_docto` (date). Inválida → null. */
export function fechaDocto(aaaammdd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(aaaammdd ?? ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Agrupa las recepciones por su fecha de ingreso (AAAAMMDD), de la más antigua a
 * la más nueva. Las que no tienen una fecha válida van juntas al final con
 * `fecha: null`: arman un documento que se bloquea con "no tiene fecha".
 *
 * Es la regla de sql/033: un documento de SIESA por fecha de ingreso, porque la
 * entrada no puede postear carne en un día en que no existía.
 *
 * @param {Array} recepciones  con `fecha_ingreso`
 * @returns {Array<{ fecha: string|null, recepciones: Array }>}
 */
export function agruparPorFecha(recepciones = []) {
  const grupos = new Map();
  for (const r of recepciones) {
    const f = fechaSiesa(r?.fecha_ingreso);
    grupos.set(f, [...(grupos.get(f) || []), r]);
  }
  return [...grupos.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
    .map(([fecha, grupo]) => ({ fecha, recepciones: grupo }));
}

/**
 * Centro de operación del movimiento, en el formato del plano (3 caracteres).
 *
 * `carnes_sedes.codigo_co` guarda "01".."08"; el plano pide "001". Se rellena
 * con ceros a la izquierda. Si SIESA usara otro código para el CO de la sede,
 * se cambia acá y en ningún otro lado.
 */
export function coMovimiento(codigoCo) {
  const limpio = String(codigoCo ?? "").trim();
  if (!limpio) return null;
  return limpio.padStart(3, "0").slice(-3);
}

/**
 * Número con N decimales exactos, como string. Sin separador de miles.
 *
 * La cantidad de decimales la manda SIESA, no el ancho del campo del plano: el
 * valor tiene que traer los de la moneda y la cantidad los de la unidad de
 * medida. Ver `decimalesValor` / `decimalesCantidad` en config/siesa.js.
 */
export const decimal = (n, decimales) => {
  const d = Number.isInteger(decimales) ? decimales : 2;
  const f = 10 ** d;
  return (Math.round((Number(n) || 0) * f) / f).toFixed(d);
};

/**
 * Renglones que van a SIESA: productos (con o sin código — sin código
 * BLOQUEA, ver abajo) y vísceras CON código, todos con cantidad > 0.
 *
 * Una víscera sin código se descarta acá mismo, en silencio: `vaASiesa`
 * decide eso. Lo que queda tras este filtro es exactamente lo que sale en
 * `Movimientos`.
 */
const VA_A_SIESA = (i) => vaASiesa(i);

/**
 * Arma el JSON del conector.
 *
 * @param {object} p
 * @param {object} p.recepcion   fila de `carnes_recepciones` con `sede`
 * @param {Array}  p.items       renglones de la recepción
 * @param {string} p.tipo        TIPO_ENVIO.INICIAL | TIPO_ENVIO.OFICIAL
 * @param {number} p.consecutivo número propio, enlaza cabecera y movimientos
 * @param {object} p.config      { tipoDocto, nit, sucursal, unidadMedida, unidadNegocio }
 * @param {string} [p.referenciaInicial] en la oficial: la referencia de la inicial
 * @param {boolean} [p.omitirSinCodigo] solo la INICIAL: los productos sin código de
 *        SIESA no bloquean, se dejan fuera del documento y se anotan en `novedades`.
 *        La oficial NO lo usa: ahí un producto sin código sigue bloqueando.
 * @returns {{ payload: object, resumen: object, bloqueos: string[],
 *             novedades: string[], omitidos: object[] }}
 */
export function armarEntradaDirecta({
  recepcion,
  items = [],
  tipo,
  consecutivo,
  config = {},
  referenciaInicial,
  omitirSinCodigo = false,
}) {
  const bloqueos = [];
  const novedades = [];
  const sede = recepcion?.sede || {};

  // ─── Lo que tiene que estar, o no se manda ───
  const faltantes = ["tipoDocto", "nit", "sucursal", "unidadMedida", "unidadNegocio"].filter(
    (k) => !String(config[k] ?? "").trim(),
  );
  if (faltantes.length) {
    bloqueos.push(`Falta configurar en SIESA: ${faltantes.join(", ")}.`);
  }
  if (!sede.bodega_siesa) {
    bloqueos.push(`La sede "${sede.nombre ?? recepcion?.sede_id}" no tiene bodega de SIESA configurada.`);
  }
  const co = coMovimiento(sede.codigo_co);
  if (!co) {
    bloqueos.push(`La sede "${sede.nombre ?? recepcion?.sede_id}" no tiene centro de operación.`);
  }
  const fecha = fechaSiesa(recepcion?.fecha_ingreso);
  if (!fecha) bloqueos.push("La recepción no tiene fecha de ingreso.");

  // Sin código: en la oficial bloquea (un producto sin homologar no puede entrar
  // al ERP con el costo liquidado). En la inicial —`omitirSinCodigo`— no se frena
  // a la sede: esos renglones se dejan fuera, se sube el resto y se deja una
  // novedad para que el admin los homologue antes de liquidar. Las vísceras no
  // viajan nunca (`vaASiesa`), así que no cuentan acá.
  const sinCodigo = items.filter(
    (i) => esProducto(i) && (Number(i.cantidad) || 0) > 0 && !tieneCodigoSiesa(i),
  );
  const omitidos = omitirSinCodigo ? sinCodigo : [];
  if (sinCodigo.length && !omitirSinCodigo) {
    bloqueos.push(
      `${sinCodigo.length} renglón(es) sin código de SIESA: ` +
        sinCodigo.map((i) => i.descripcion).join(", ") +
        ". Homologalos antes de enviar.",
    );
  }
  if (omitidos.length) {
    const uno = omitidos.length === 1;
    novedades.push(
      `${omitidos.length} ${uno ? "renglón sin código" : "renglones sin código"} de SIESA ` +
        `no se ${uno ? "subió" : "subieron"}: ` +
        omitidos.map((i) => i.descripcion).join(", ") +
        `. ${uno ? "Homologarlo" : "Homologarlos"} antes de liquidar.`,
    );
  }

  const renglones = items.filter((i) => VA_A_SIESA(i) && !omitidos.includes(i));
  if (renglones.length === 0) {
    bloqueos.push(
      omitidos.length
        ? "Ningún renglón tiene código de SIESA: no hay nada que subir. Homologarlos y reintentar."
        : "La recepción no tiene renglones con cantidad.",
    );
  }

  // ─── El precio depende del tipo de entrada ───
  //
  // Inicial: costo base (lo que dice la plantilla). Oficial: costo ajustado por
  // el factor de la liquidación. Si se pide la oficial y el renglón no tiene
  // costo ajustado, es que la liquidación no se costeó: se bloquea, no se
  // manda el precio de lista como si fuera el real.
  const precioDe = (i) => {
    if (tipo === TIPO_ENVIO.OFICIAL) {
      if (i.costo_ajustado === null || i.costo_ajustado === undefined) return null;
      return Number(i.costo_ajustado);
    }
    return Number(i.costo_base) || 0;
  };
  const sinCosteo = renglones.filter((i) => precioDe(i) === null);
  if (sinCosteo.length) {
    bloqueos.push(
      "La entrada oficial necesita el costo ajustado y hay renglones sin costear. " +
        "Costeá la liquidación primero.",
    );
  }

  // Oficial con TODOS los PRODUCTOS al costo de lista: el factor de la
  // liquidación no se aplicó (costo teórico en cero, o un costeo que no
  // escribió). No existe una compra real donde lo pagado coincida al peso con
  // la lista en cada corte, así que no se manda: subiría como "liquidada" una
  // entrada que es la inicial con otro nombre.
  //
  // Solo productos: las vísceras SIEMPRE están "al costo de lista" (no se
  // prorratean), así que si entraran acá, una recepción con solo dos vísceras
  // y ningún producto bloquearía la entrada oficial sin que el factor tenga
  // nada que ver.
  const productosRenglones = renglones.filter(esProducto);
  if (
    tipo === TIPO_ENVIO.OFICIAL &&
    productosRenglones.length > 0 &&
    sinCosteo.length === 0 &&
    productosRenglones.every((i) => Number(i.costo_ajustado) === Number(i.costo_base))
  ) {
    bloqueos.push(
      "El costo liquidado es igual al costo base en todos los renglones: el factor de " +
        "la liquidación no se aplicó. Revisá los gastos y volvé a costear.",
    );
  }

  const referencia = referenciaEnvio(recepcion?.id, tipo);
  const tipoDocto = String(config.tipoDocto ?? "").trim();
  const consec = String(consecutivo ?? "");

  // ─── Documentos ───
  //
  // `PENDIENTE` es el documento de referencia (12 chars). En la oficial apunta a
  // la inicial, que es lo que quien anula necesita leer. En la inicial lleva su
  // propia referencia, para que aparezca en SIESA y se pueda buscar.
  //
  // `NOTAS` es variable del conector desde el 30/09/2026 (f350_notas dejó de ser
  // fijo en "TALLER DE CARNES"): las dos entradas quedan distinguibles a simple
  // vista en SIESA por su texto.
  const documento = {
    TIPO_DOCTO: tipoDocto,
    CONSECUTIVO_DOCTO: consec,
    FECHA: fecha ?? "",
    NIT: String(config.nit ?? "").trim(),
    SUCURSAL: String(config.sucursal ?? "").trim(),
    PENDIENTE: (tipo === TIPO_ENVIO.OFICIAL && referenciaInicial ? referenciaInicial : referencia).slice(
      0,
      LARGO_REFERENCIA,
    ),
    NOTAS: notasDocumento(
      NOTA[tipo] ?? "TALLER DE CARNES",
      `RECEPCION #${recepcion?.id} ${sede.nombre ?? ""}`.trim(),
      referencia,
    ),
  };

  // ─── Movimientos ───
  //
  // `VALOR_BRUTO` es el TOTAL del renglón (cantidad × precio), sin impuestos.
  // Si SIESA lo esperara unitario, es esta línea y solo esta.
  let totalKilos = 0;
  let totalValor = 0;
  const movimientos = renglones.map((i, n) => {
    // Con unidad propia (vísceras: UND o KL) la cantidad se lleva a los
    // decimales que SIESA acepta para esa unidad, y el valor se calcula
    // sobre ESA cantidad: si no, SIESA recibiría 2,66 UND valorizadas como 2,667.
    const cantidad = i.unidad
      ? ajustarCantidadAUnidad(i.cantidad, i.unidad)
      : Number(i.cantidad) || 0;
    const precio = precioDe(i) ?? 0;
    // Se redondea a los MISMOS decimales que se van a reportar: si se redondea
    // a 2 y se imprime con 4, los dos últimos son ceros inventados.
    const dv = Number.isInteger(config.decimalesValor) ? config.decimalesValor : 2;
    const bruto = Math.round(cantidad * precio * 10 ** dv) / 10 ** dv;
    totalKilos += cantidad;
    totalValor += bruto;
    return {
      TIPO_DOCTO: tipoDocto,
      NRO_DOCTO: consec,
      NRO_REGISTRO: String(n + 1),
      BODEGA: String(sede.bodega_siesa ?? ""),
      CO_MOVIMIENTO: co ?? "",
      // Del renglón si lo trae (Lengua es UND, el resto de vísceras KL); si no
      // —todo lo que es carne/adicional— la fija de la configuración.
      UNIDAD_MEDIDA: String(i.unidad || config.unidadMedida || ""),
      CANTIDAD: decimal(
        cantidad,
        i.unidad ? decimalesDeUnidad(i.unidad) : config.decimalesCantidad,
      ),
      VALOR_BRUTO: decimal(bruto, config.decimalesValor),
      ITEM: String(i.codigo_item ?? "").trim(),
      UNIDAD_NEGOCIO: String(config.unidadNegocio ?? ""),
    };
  });

  return {
    // `Descuentos` NO va, ni siquiera como arreglo vacío.
    //
    // El conector valida la sección apenas la clave existe: con `Descuentos: []`
    // respondió 400 "Error en la Estructura" y siete quejas pidiendo TIPO_DOCTO,
    // CONSECUTIVO_DOCTO, NRO_REGISTRO, ORDEN_DESCUENTO y VALOR_TOTAL "en la
    // sección Descuentos". Omitir la clave es lo que significa "esta entrada no
    // tiene descuentos" — y no los tiene: el factor de la liquidación ya viene
    // aplicado en el precio de cada renglón.
    payload: {
      Documentos: [documento],
      Movimientos: movimientos,
    },
    resumen: {
      tipo,
      referencia,
      referenciaInicial: tipo === TIPO_ENVIO.OFICIAL ? (referenciaInicial ?? null) : null,
      renglones: movimientos.length,
      totalKilos: Math.round(totalKilos * 1000) / 1000,
      totalValor: Math.round(totalValor * 100) / 100,
      sede: sede.nombre ?? null,
      fecha: recepcion?.fecha_ingreso ?? null,
    },
    bloqueos,
    novedades,
    omitidos,
  };
}


/**
 * La oficial de una liquidación: una CEA POR FECHA DE INGRESO, con los renglones
 * de todas las sedes que recibieron ese día.
 *
 * La cabecera de la CEA no tiene nada de la sede —tipo, fecha, NIT, sucursal,
 * notas—; la bodega y el CO viajan en cada movimiento. Así que se arma cada
 * sede con `armarEntradaDirecta` (mismas reglas: códigos, costo ajustado, costo
 * base, bodega, CO) y se juntan los movimientos de las sedes de un mismo día
 * bajo una cabecera.
 *
 * ─── Una CEA por fecha (sql/033) ───────────────────────────────────────────
 *
 * Antes iba UNA CEA con la fecha de la recepción más antigua. En un taller de
 * carne que recibe en varios días eso posteaba existencias en días en que no
 * existían y obligaba a ajustes grandes de inventario. Ahora cada fecha de
 * ingreso es su propio documento, con esa fecha y solo sus renglones. Los costos
 * son por recepción (`costo_ajustado` congelado en cada renglón), así que partir
 * por fecha no prorratea nada.
 *
 * Con UNA sola fecha el resultado es idéntico al de antes: mismo payload, misma
 * referencia (`TC OFI L12`), mismas notas. Con varias, cada documento lleva en la
 * referencia dos letras derivadas de su fecha (`TC OFI L12KD`; ver
 * `sufijoDocumento`) y la fecha completa en las notas.
 *
 * Todo o nada: si una sede de CUALQUIER fecha tiene un bloqueo, no sale ningún
 * documento (el modelo valida todos antes de mandar el primero). Cada
 * documento trae además sus propios `bloqueos`.
 *
 * @param {object} p
 * @param {number} p.liquidacionId
 * @param {Array}  p.recepciones  filas de `carnes_recepciones` con `sede` e `items`
 * @param {number} p.consecutivo  el mismo para todos los documentos: SIESA lo
 *                                recalcula y solo enlaza cabecera y movimientos
 *                                dentro de cada payload
 * @param {object} p.config
 * @returns {{
 *   payload: object, resumen: object, bloqueos: string[], porSede: object[],
 *   documentos: Array<{ fecha: string|null, indice: number, payload: object,
 *     resumen: object, bloqueos: string[], recepcion_ids: number[], porSede: object[] }>,
 * }}
 *   `payload` y `resumen` de primer nivel son los del PRIMER documento (el único,
 *   salvo que haya varias fechas). `bloqueos` junta los de todos.
 */
export function armarEntradaLiquidacion({ liquidacionId, recepciones = [], consecutivo, config = {} }) {
  const bloqueos = [];
  const tipoDocto = String(config.tipoDocto ?? "").trim();
  const consec = String(consecutivo ?? "");

  // Los de la liquidación entera (no de un día): van en cada documento.
  const globales = [];
  if (recepciones.length === 0) {
    globales.push("La liquidación no tiene recepciones.");
  }

  // Lo que falta en la configuración es igual para todas las sedes: se dice una
  // vez, no nueve.
  const faltantes = ["tipoDocto", "nit", "sucursal", "unidadMedida", "unidadNegocio"].filter(
    (k) => !String(config[k] ?? "").trim(),
  );
  if (faltantes.length) {
    globales.push(`Falta configurar en SIESA: ${faltantes.join(", ")}.`);
  }
  bloqueos.push(...globales);

  const porSede = recepciones.map((recepcion) => {
    const armado = armarEntradaDirecta({
      recepcion,
      items: recepcion.items || [],
      tipo: TIPO_ENVIO.OFICIAL,
      consecutivo,
      config,
    });
    return {
      recepcion_id: recepcion.id,
      sede: recepcion.sede?.nombre ?? null,
      fecha: recepcion.fecha_ingreso ?? null,
      movimientos: armado.payload.Movimientos,
      resumen: armado.resumen,
      // La de configuración ya se dijo arriba.
      bloqueos: armado.bloqueos.filter((b) => !b.startsWith("Falta configurar en SIESA")),
    };
  });

  const bloqueosDeSede = (s) => s.bloqueos.map((b) => `${s.sede ?? `Recepción #${s.recepcion_id}`}: ${b}`);
  for (const s of porSede) bloqueos.push(...bloqueosDeSede(s));

  // Un grupo por fecha. Sin recepciones, un grupo vacío: el documento existe (con
  // su bloqueo) para que `payload` y `resumen` de primer nivel no queden undefined.
  const grupos = agruparPorFecha(porSede.map((s) => ({ ...s, fecha_ingreso: s.fecha })));
  const gruposFinales = grupos.length ? grupos : [{ fecha: null, recepciones: [] }];
  const total = gruposFinales.length;

  const documentos = gruposFinales.map((g, indice) => {
    const sedes = g.recepciones;
    const sufijo = sufijoDocumento(g.fecha, total);
    const referencia = referenciaLiquidacion(liquidacionId, sufijo);

    // Movimientos de las sedes de ESTE día, numerados de corrido: `NRO_REGISTRO`
    // es la posición dentro del documento, no dentro de la sede.
    const movimientos = sedes
      .flatMap((s) => s.movimientos)
      .map((m, n) => ({ ...m, NRO_DOCTO: consec, NRO_REGISTRO: String(n + 1) }));

    // Con varias fechas, cuál es el documento queda escrito en las notas.
    const detalle =
      total > 1
        ? `LIQUIDACION #${liquidacionId} - INGRESO ${g.fecha ?? "SIN FECHA"} (${indice + 1}/${total})`
        : `LIQUIDACION #${liquidacionId}`;

    const documento = {
      TIPO_DOCTO: tipoDocto,
      CONSECUTIVO_DOCTO: consec,
      // Sin fecha, las sedes de ese grupo ya lo dijeron en su bloqueo.
      FECHA: g.fecha ?? "",
      NIT: String(config.nit ?? "").trim(),
      SUCURSAL: String(config.sucursal ?? "").trim(),
      // Una CEA de nueve sedes no puede apuntar a nueve iniciales en un campo de
      // 12 caracteres: lleva su propia referencia, y el correo a quien anula las
      // lista todas.
      PENDIENTE: referencia,
      NOTAS: notasDocumento(NOTA[TIPO_ENVIO.OFICIAL], detalle, referencia),
    };

    const totalKilos = sedes.reduce((a, s) => a + s.resumen.totalKilos, 0);
    const totalValor = sedes.reduce((a, s) => a + s.resumen.totalValor, 0);

    return {
      fecha: g.fecha,
      indice,
      payload: { Documentos: [documento], Movimientos: movimientos },
      resumen: {
        tipo: TIPO_ENVIO.OFICIAL,
        referencia,
        referenciaInicial: null,
        renglones: movimientos.length,
        sedes: sedes.length,
        totalKilos: Math.round(totalKilos * 1000) / 1000,
        totalValor: Math.round(totalValor * 100) / 100,
        fecha: g.fecha,
      },
      bloqueos: [...globales, ...sedes.flatMap(bloqueosDeSede)],
      recepcion_ids: sedes.map((s) => s.recepcion_id),
      porSede: sedes.map(({ movimientos: _m, ...s }) => s),
    };
  });

  return {
    payload: documentos[0].payload,
    resumen: documentos[0].resumen,
    bloqueos,
    porSede: porSede.map(({ movimientos: _m, ...s }) => s),
    documentos,
  };
}
