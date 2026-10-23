/**
 * Reglas PURAS de "Recepciones en curso": los borradores abiertos de proveedor que
 * el recibidor ve antes de abrir una recepción. Sin Supabase: el modelo lee y
 * este archivo da forma (ver test/enCurso.test.js).
 */

/** Tope de borradores que devuelve el listado. */
export const LIMITE_EN_CURSO = 50;

/** Cabecera mínima del listado. Sin firma ni cédula, igual que el resto del flujo del recibidor. */
export const COLUMNAS_EN_CURSO = `
  id, proveedor_id, proveedor_razon_social, factura, sede_id, recibido_por,
  recibidor_nombre, abierto_at, updated_at,
  sede:carnes_sedes ( id, nombre )
`;

/** Renglones de un borrador: solo hace falta saber si tienen cantidad. */
export const COLUMNAS_ITEMS_EN_CURSO = "recepcion_id, cantidad";

/** Filas por página al leer renglones (Supabase corta en 1000 por consulta). */
export const FILAS_POR_PAGINA_ITEMS = 1000;

/** Borradores por consulta de renglones. */
export const BORRADORES_POR_CONSULTA_ITEMS = 5;

/**
 * Cuenta renglones totales y con cantidad > 0. `cantidad` puede llegar como
 * número o como texto (numeric de Postgres); lo que no es número cuenta como 0.
 */
export function contarRenglones(items = []) {
  let conCantidad = 0;
  for (const item of items) {
    const n = Number(item?.cantidad);
    if (Number.isFinite(n) && n > 0) conCantidad += 1;
  }
  return { renglones_con_cantidad: conCantidad, renglones_total: items.length };
}

/** Un borrador como lo ve la lista. `abierto_at` cae a `updated_at` si falta. */
export function armarFilaEnCurso({ cabecera, items = [] }) {
  return {
    id: cabecera.id,
    proveedor_id: cabecera.proveedor_id,
    proveedor_razon_social: cabecera.proveedor_razon_social,
    factura: cabecera.factura,
    sede: cabecera.sede
      ? { id: cabecera.sede.id, nombre: cabecera.sede.nombre }
      : { id: cabecera.sede_id ?? null, nombre: null },
    recibido_por: cabecera.recibido_por ?? null,
    recibidor_nombre: cabecera.recibidor_nombre ?? null,
    abierto_at: cabecera.abierto_at ?? cabecera.updated_at ?? null,
    updated_at: cabecera.updated_at ?? cabecera.abierto_at ?? null,
    ...contarRenglones(items),
  };
}
