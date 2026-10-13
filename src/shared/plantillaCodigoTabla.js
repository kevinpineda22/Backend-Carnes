/**
 * Reglas del "Orden prov." (`codigo_tabla`) de la plantilla de cortes.
 *
 * Es la clave única por especie (`idx_carnes_plantilla_especie_tabla`, sql/001),
 * y el índice cuenta también las filas desactivadas. Sin estas revisiones, una
 * fila sin número llegaba como 0, varias chocaban entre sí y Postgres devolvía
 * un "duplicate key" que el admin veía como un 500 genérico.
 *
 * Funciones puras: el modelo lee la base y decide con ellas.
 */

const ROTULO = "«Orden prov.»";

const nombre = (f) => (f.descripcion ? String(f.descripcion).trim() : "") || "un corte sin descripción";

const sinNumero = (v) => v === null || v === undefined || v === "";

/**
 * Faltantes y repetidos dentro de lo que manda la grilla.
 *
 * @param {object[]} filas
 * @returns {null | {status: 400, codigo: string, mensaje: string}}
 */
export function revisarCodigosTabla(filas = []) {
  const faltantes = filas.filter((f) => sinNumero(f.codigo_tabla));
  if (faltantes.length) {
    return {
      status: 400,
      codigo: "ORDEN_PROV_FALTANTE",
      mensaje:
        `Falta el ${ROTULO} en: ${faltantes.map(nombre).join(", ")}. ` +
        "Cada corte necesita un número propio.",
    };
  }

  const porCodigo = new Map();
  for (const f of filas) {
    const clave = Number(f.codigo_tabla);
    porCodigo.set(clave, [...(porCodigo.get(clave) || []), f]);
  }
  const repetidos = [...porCodigo.entries()].filter(([, grupo]) => grupo.length > 1);
  if (repetidos.length) {
    const detalle = repetidos
      .map(([codigo, grupo]) => `${codigo} (${grupo.map(nombre).join(", ")})`)
      .join("; ");
    return {
      status: 400,
      codigo: "ORDEN_PROV_REPETIDO",
      mensaje: `Hay ${ROTULO} repetidos: ${detalle}. Cada corte necesita un número distinto.`,
    };
  }
  return null;
}

/**
 * Choques con filas guardadas que NO vienen en este envío: un corte desactivado,
 * o uno que el admin acaba de sacar de la grilla (se desactiva, pero conserva su
 * número).
 *
 * @param {object[]} filas     lo que manda la grilla
 * @param {object[]} guardados filas de la base con alguno de esos códigos
 *                             (`id, codigo_tabla, descripcion, activo`)
 * @returns {null | {status: 409, codigo: string, mensaje: string}}
 */
export function conflictoConGuardados(filas = [], guardados = []) {
  const idsEnvio = new Set(filas.filter((f) => f.id).map((f) => String(f.id)));
  const ajenos = guardados.filter((g) => !idsEnvio.has(String(g.id)));
  if (!ajenos.length) return null;

  const usados = new Set(ajenos.map((g) => Number(g.codigo_tabla)));
  const choques = filas.filter((f) => usados.has(Number(f.codigo_tabla)));
  if (!choques.length) return null;

  const detalle = choques
    .map((f) => {
      const g = ajenos.find((x) => Number(x.codigo_tabla) === Number(f.codigo_tabla));
      const estado = g.activo ? "que sacaste de la grilla" : "desactivado";
      return `${f.codigo_tabla} de ${nombre(f)} ya lo tiene ${nombre(g)} (${estado})`;
    })
    .join("; ");
  return {
    status: 409,
    codigo: "ORDEN_PROV_EN_USO",
    mensaje: `El ${ROTULO} ya está en uso: ${detalle}. Usá otro número.`,
  };
}
