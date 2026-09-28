/**
 * Cálculo del `valor` de una fila de gasto cuando viene cargada por Peso ×
 * Precio KL en vez de tipeada a mano.
 *
 * Módulo PURO, mismo espíritu que `costeo.js`: entra un objeto, sale un
 * número, se testea contra casos simples y no depende de Supabase ni Express.
 *
 * La regla es la que pidió el admin: si AMBOS —peso y precio_kilo— vienen
 * cargados y son mayores a 0, el valor se calcula (`peso × precio_kilo`,
 * redondeado a 2 decimales) y le gana a lo que haya tipeado el cliente. Si
 * falta cualquiera de los dos, la fila se comporta exactamente como hoy: el
 * `valor` que mandó el cliente queda tal cual. Este cálculo se hace en el
 * backend a propósito — un cálculo hecho en el navegador no es confiable como
 * fuente del costeo.
 */

/** Convierte a número tolerando `null`, `undefined`, strings y NaN. */
function num(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/** Redondeo a `n` decimales, evitando la basura de punto flotante. */
function redondear(valor, n) {
  if (!Number.isFinite(valor)) return 0;
  return Number(valor.toFixed(n));
}

const DECIMALES_VALOR = 2;

/**
 * @param {object} fila
 * @param {number|null} [fila.peso]         kilos, opcional
 * @param {number|null} [fila.precio_kilo]  precio por kilo, opcional
 * @param {number} fila.valor               valor tipeado a mano por el cliente
 * @returns {number} el valor final de la fila
 */
export function calcularValorGasto({ peso, precio_kilo, valor } = {}) {
  const pesoNum = num(peso);
  const precioNum = num(precio_kilo);

  if (pesoNum > 0 && precioNum > 0) {
    return redondear(pesoNum * precioNum, DECIMALES_VALOR);
  }

  return num(valor);
}
