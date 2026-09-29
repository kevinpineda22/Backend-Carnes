/**
 * Vísceras de res que se cuentan "por novillo" y no se digitan.
 *
 * Del catálogo de once vísceras de res, nueve tienen homólogo en SIESA (ver
 * `sql/016_visceras_siesa.sql`). De esas nueve, seis NO las pesa el recibidor:
 * el Excel las calcula como `factor × cantidad de novillos` (columna B del
 * bloque informativo). Acá vive ESE cálculo, puro, para que:
 *
 *   · el recibidor las vea como texto ("factor × novillos"), no como un campo
 *     vacío esperando que alguien digite un número que no puede pesar,
 *   · el admin pueda corregir los novillos DESPUÉS del cierre y las seis
 *     cantidades se recalculen solas, en vez de quedar pegadas al valor viejo,
 *   · `siesaEntrada.js` decida caso por caso si un renglón de víscera se manda
 *     o se omite en silencio, sin repetir la lista de tipos en cada archivo.
 *
 * Mondongo, Lengua, Chunchulla, Vísceras y Entrañita NO tienen factor: las
 * sigue pesando (o contando, Lengua es UND) el recibidor, exactamente igual
 * que antes de este cambio.
 *
 * ─── SIESA y descuento son DOS preguntas distintas (sql/017) ───────────────
 *
 * Al principio (sql/016) las seis con factor viajaban con `bloque =
 * 'bonificacion'` en el catálogo, porque ese era el único valor que hacía que
 * `Recepcion.model.js#renglonesDesdePlantilla` les creara un renglón. El
 * gerente corrigió la regla de negocio: esas seis SIGUEN yendo a SIESA
 * (`vaASiesa` no mira `bloque` — solo código y cantidad), pero NO tienen que
 * restar del costo real cuando el admin prende "Sumar Viceras". Por eso
 * `bloque` volvió a su significado original ('informativo' para las seis,
 * sql/017) y pasó a decidir UNA sola cosa: si `descuentaEnLiquidacion`.
 *
 * Módulo PURO, como `costeo.js` y `siesaEntrada.js`: sin Supabase, sin Express.
 */

/** Decimales de guardado de una cantidad de víscera: los mismos que el resto de kilos. */
const DECIMALES_CANTIDAD = 3;

/** Redondeo a `n` decimales, evitando la basura de punto flotante. */
function redondear(valor, n) {
  if (!Number.isFinite(valor)) return 0;
  return Number(valor.toFixed(n));
}

function num(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Decimales que SIESA acepta en la cantidad, según la unidad del renglón.
 *
 * UND: 2. El 29/09/2026 la oficial TC OFI L10 volvió con "la cantidad de
 * decimales de la cantidad base deben ser iguales a la cantidad de decimales de
 * la unidad de medida" en los Riñones de 5,333 / 2,667 / 14,667 UND (los de
 * 4,000 pasaron). El encargado definió dos decimales. Si SIESA rechazara también
 * los de dos, este número es el único que hay que tocar.
 */
export const DECIMALES_POR_UNIDAD = { KL: DECIMALES_CANTIDAD, UND: 2 };

export function decimalesDeUnidad(unidad) {
  return DECIMALES_POR_UNIDAD[unidad] ?? DECIMALES_CANTIDAD;
}

/**
 * Deja una cantidad con los decimales de su unidad, TRUNCANDO, no redondeando:
 * así lo pidió el encargado (2,667 → 2,66 y 14,667 → 14,66, no 2,67 / 14,67).
 *
 * Se trunca sobre la cantidad YA redondeada a 3 decimales, nunca sobre el
 * producto crudo: 1,33333 × 3 da 3,99999, que truncado directo sería 3,99
 * cuando la cantidad de siempre es 4,000.
 */
export function ajustarCantidadAUnidad(cantidad, unidad) {
  const base = redondear(num(cantidad), DECIMALES_CANTIDAD);
  const d = decimalesDeUnidad(unidad);
  if (d >= DECIMALES_CANTIDAD) return base;
  const paso = 10 ** (DECIMALES_CANTIDAD - d);
  const milesimas = Math.trunc(Math.round(base * 10 ** DECIMALES_CANTIDAD) / paso) * paso;
  return redondear(milesimas / 10 ** DECIMALES_CANTIDAD, d);
}

/**
 * `cantidad = factor × novillos`, redondeada a 3 decimales y llevada a los
 * decimales de la unidad (`ajustarCantidadAUnidad`).
 *
 * Sin factor o sin novillos da 0 — no `NaN`. Un renglón en 0 es información (no
 * llegaron novillos todavía, o esta víscera no tiene factor); un `NaN` se
 * arrastraría al costeo y al total de kilos sin que nada lo explique.
 */
export function cantidadPorNovillo(factor, novillos, unidad) {
  return ajustarCantidadAUnidad(num(factor) * num(novillos), unidad);
}

/** ¿Este renglón de vísceras se calcula solo, o lo pesa/cuenta el recibidor? */
export function esViceraPorFactor(item) {
  return item?.tipo === "vicera" && item.factor_novillo !== null && item.factor_novillo !== undefined;
}

/**
 * Recalcula, dentro de una lista de renglones, la cantidad de las vísceras que
 * se cuentan por novillo. El resto de los renglones vuelve TAL CUAL —esta
 * función no toca lo que el recibidor pesó a mano.
 *
 * Se usa en tres momentos: cuando el recibidor guarda el borrador (si cambió
 * `novillos`), cuando el admin corrige los novillos de una recepción ya
 * cerrada, y al cerrar la recepción (`finalizar`).
 */
export function recalcularVicerasPorNovillo(items = [], novillos) {
  return items.map((item) =>
    esViceraPorFactor(item)
      ? { ...item, cantidad: cantidadPorNovillo(item.factor_novillo, novillos, item.unidad) }
      : item,
  );
}

/** ¿Es un renglón de PRODUCTO (carne o adicional)? Estos siempre van a SIESA si tienen cantidad. */
export function esProducto(item) {
  return item?.tipo === "carne" || item?.tipo === "adicional";
}

/** ¿Es un renglón de víscera? */
export function esVicera(item) {
  return item?.tipo === "vicera";
}

/** ¿Tiene código de SIESA cargado? */
export function tieneCodigoSiesa(item) {
  return Boolean(String(item?.codigo_item ?? "").trim());
}

/**
 * ¿Este renglón se manda a SIESA?
 *
 * Solo productos (carne o adicional) con cantidad — CON o SIN código: sin
 * código se manda igual y es `siesaEntrada.js` quien bloquea el envío entero,
 * para que el admin lo homologue; no desaparece en silencio.
 *
 * Las vísceras NUNCA van en la entrada (inicial ni oficial), tengan código o
 * no. Lo definió el negocio el 29/09/2026, con el Excel de referencia en la
 * mano: la entrada de SIESA es la factura, y en la "Plantilla de ingreso a
 * SIESA" de cada sede solo hay cortes. Las vísceras "son solo para costear
 * mejor" (el SI/NO de bonificación) y entran al inventario por un documento de
 * ajuste aparte, que se hace a mano en SIESA. SIESA además no acepta renglones
 * en $0, así que tampoco pueden viajar como bonificación dentro de la entrada.
 *
 * Mandarlas sumaba su valor encima de la factura: TC OFI L10 salió por
 * $184.856.964 contra una factura de $173.197.064.
 */
export function vaASiesa(item) {
  return esProducto(item) && num(item?.cantidad) > 0;
}

/**
 * ¿Este renglón de víscera resta del costo real de la sede cuando la
 * liquidación tiene "Sumar Viceras" en SI?
 *
 * 'bonificacion' sí, 'informativo' no — es la mitad del significado que
 * `bloque` siempre tuvo en el catálogo (la otra mitad, "va a SIESA", ahora la
 * decide `vaASiesa` sola, sin mirar `bloque` para nada).
 *
 * `null`/`undefined` cuentan como 'bonificacion': son renglones de ANTES de
 * sql/017 (o leídos antes de que esa migración corra) y, por construcción,
 * las once vísceras de res estuvieron en 'bonificacion' hasta esa migración —
 * tratarlos como 'informativo' les cambiaría, retroactivamente, un costo que
 * ya se calculó así.
 *
 * No filtra por tipo a propósito — el llamador (`consolidado.js`) ya filtró
 * `tipo === "vicera"` antes de preguntar esto; acá solo se decide bonificación
 * vs. informativo.
 */
export function descuentaEnLiquidacion(item) {
  return item?.bloque !== "informativo";
}
