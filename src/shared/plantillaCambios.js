/**
 * Qué columnas de una fila de la plantilla cambiaron de verdad.
 *
 * La grilla del admin manda la tabla ENTERA en cada guardado. Actualizar las
 * 38 filas de res una por una tardaba ~31 s (cada UPDATE es un viaje a
 * Supabase) y el front corta a los 30: el admin veía "El servidor tardó
 * demasiado" aunque el guardado terminaba bien. Comparando contra lo que ya
 * está en la base, un cambio de costo en una fila es UN solo UPDATE.
 *
 * Módulo puro: entra la fila del cliente (ya filtrada por la lista blanca) y
 * la de la base, sale el objeto con lo que difiere.
 */

/** `null`, `undefined` y `""` significan lo mismo: "sin valor". */
const vacio = (v) => v === null || v === undefined || v === "";

/**
 * El cliente manda números como string ("15000") y la base devuelve las
 * columnas numéricas como número (15000); comparar con `!==` marcaría todo como
 * cambiado. Pero solo se compara como número cuando la BASE trae un número: un
 * código de SIESA es texto, y "015216" no es lo mismo que "15216".
 */
function iguales(delCliente, enBase) {
  if (vacio(delCliente) && vacio(enBase)) return true;
  if (vacio(delCliente) || vacio(enBase)) return false;
  if (typeof enBase === "boolean") return Boolean(delCliente) === enBase;
  if (typeof enBase === "number") return Number(delCliente) === enBase;
  return String(delCliente) === String(enBase);
}

/**
 * @param {object} limpio  fila del cliente, solo columnas escribibles
 * @param {object|undefined} actual  la misma fila leída de la base
 * @returns {object} solo las columnas que cambiaron; `{}` si no cambió nada.
 *   Sin `actual` (la fila no está en la base) se devuelve `limpio` entero.
 */
export function cambiosDeFila(limpio, actual) {
  if (!actual) return { ...limpio };
  const cambios = {};
  for (const [col, valor] of Object.entries(limpio)) {
    if (!iguales(valor, actual[col])) cambios[col] = valor;
  }
  return cambios;
}

/**
 * Parte un lote de filas nuevas en grupos con EXACTAMENTE las mismas columnas.
 *
 * En un insert de varias filas, Supabase arma la unión de las columnas y a la
 * fila a la que le falta una le manda NULL —no el DEFAULT de la columna—. La
 * grilla del admin solo manda lo que se completó, así que dos ítems nuevos con
 * columnas distintas (uno con `orden`, otro sin) hacían fallar el guardado
 * entero contra un NOT NULL. Es el mismo bug que rompió "Recibir Res" el 30/09.
 * Insertando cada grupo por separado, lo que falta toma su default.
 *
 * Conserva el orden de llegada dentro de cada grupo y el de los grupos.
 *
 * @param {object[]} filas
 * @returns {object[][]}
 */
export function agruparPorColumnas(filas = []) {
  const grupos = new Map();
  for (const fila of filas) {
    const firma = Object.keys(fila).sort().join("|");
    if (!grupos.has(firma)) grupos.set(firma, []);
    grupos.get(firma).push(fila);
  }
  return [...grupos.values()];
}
