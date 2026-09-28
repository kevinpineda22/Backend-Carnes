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
 * `cantidad = factor × novillos`, redondeada a 3 decimales.
 *
 * Sin factor o sin novillos da 0 — no `NaN`. Un renglón en 0 es información (no
 * llegaron novillos todavía, o esta víscera no tiene factor); un `NaN` se
 * arrastraría al costeo y al total de kilos sin que nada lo explique.
 */
export function cantidadPorNovillo(factor, novillos) {
  return redondear(num(factor) * num(novillos), DECIMALES_CANTIDAD);
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
      ? { ...item, cantidad: cantidadPorNovillo(item.factor_novillo, novillos) }
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
 * Producto: sí, siempre que tenga cantidad — CON o SIN código (sin código se
 * manda igual y es `siesaEntrada.js` quien bloquea el envío entero, para que
 * el admin lo homologue; no desaparece en silencio).
 *
 * Víscera: solo si tiene cantidad Y código. Una víscera sin código de SIESA
 * (Vísceras, Entrañita) NO tiene cómo entrar al ERP — y a diferencia de un
 * producto sin homologar, eso no es un error de nadie: simplemente no hay
 * ítem del otro lado. Se omite sin bloquear el resto del documento.
 */
export function vaASiesa(item) {
  if (!(esProducto(item) || esVicera(item))) return false;
  if (!(num(item?.cantidad) > 0)) return false;
  if (esVicera(item) && !tieneCodigoSiesa(item)) return false;
  return true;
}
