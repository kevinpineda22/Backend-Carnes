import { supabase } from "../config/supabase.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import {
  FILAS_POR_FUENTE,
  elegirCorte,
  normalizarBusqueda,
  unirCatalogo,
} from "../shared/catalogoCortes.js";

/* =============================================
   Catálogo de cortes para "Agregar corte" (plantilla del proveedor, admin) y
   "Cortes adicionales" (recepción en borrador, recibidor).

   Solo LEE. La unión de las fuentes, el orden y el dedupe viven en
   `shared/catalogoCortes.js` (puro, con tests); acá solo se piden las filas.
   ============================================= */

const MIGRACIONES = ["sql/022_proveedores.sql"];

/**
 * Las filas activas de cada fuente que calzan con `filtro` (un filtro `or` de
 * PostgREST, ya armado con texto saneado) o, sin filtro, las que tengan ese código.
 */
async function leerFuentes({ filtros }) {
  const consulta = (tabla, columnas, filtro) => {
    let q = supabase.from(tabla).select(columnas).eq("activo", true).limit(FILAS_POR_FUENTE);
    q = filtro(q);
    return q;
  };
  const [plantilla, viceras, equivalencias] = await Promise.all([
    consulta("carnes_plantilla_items", "codigo_item, descripcion", filtros.plantilla),
    consulta("carnes_viceras_items", "codigo_item, nombre, unidad", filtros.viceras).not("codigo_item", "is", null),
    consulta("carnes_proveedor_equivalencias", "codigo_item, descripcion_item, unidad", filtros.equivalencias),
  ]);
  for (const r of [plantilla, viceras, equivalencias]) {
    if (r.error) fallarSiFaltaMigracion(r.error, "Error al leer el catálogo de cortes", MIGRACIONES);
  }
  return {
    plantilla: plantilla.data || [],
    viceras: viceras.data || [],
    equivalencias: equivalencias.data || [],
  };
}

/**
 * Busca cortes por código o descripción (ya validado: mínimo 2 caracteres).
 *
 * @returns {Promise<{codigo_item: string, descripcion_item: string|null, unidad: string}[]>}
 */
export async function buscarCortes(texto, { limite } = {}) {
  const q = normalizarBusqueda(texto);
  const patron = `%${q}%`;
  const por = (descripcion) => (consulta) =>
    consulta.or(`codigo_item.ilike.${patron},${descripcion}.ilike.${patron}`);
  const fuentes = await leerFuentes({
    filtros: {
      plantilla: por("descripcion"),
      viceras: por("nombre"),
      equivalencias: por("descripcion_item"),
    },
  });
  return unirCatalogo(fuentes, { q, limite });
}

/**
 * El corte exacto del catálogo (código + unidad), o `null` si el sistema no lo
 * conoce. El servidor NO confía en lo que mande el cliente: el código y la unidad
 * salen del catálogo, y la descripción que vio el usuario en la búsqueda solo se
 * respeta si es la de una fila real del catálogo con ese código y unidad.
 */
export async function obtenerCorte({ codigo_item, unidad, descripcion_item }) {
  const codigo = String(codigo_item ?? "").trim();
  const por = (consulta) => consulta.eq("codigo_item", codigo);
  const fuentes = await leerFuentes({ filtros: { plantilla: por, viceras: por, equivalencias: por } });
  return elegirCorte(fuentes, { codigo_item: codigo, unidad, descripcion_item });
}
