/**
 * Transformaciones tocino → chicharrón (tabla `sps_transformaciones`).
 *
 * SOLO LECTURA: otro proyecto escribe esta tabla. Acá se consulta para el panel
 * del admin; no se inserta, no se actualiza y no se borra nada.
 */
import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

const TABLA = "sps_transformaciones";

// Todo menos `payload` y `respuesta`, que son pesados y solo se piden en el detalle.
const COLUMNAS_LISTA =
  "id, fecha, co, bodega, item_venta, tipo_dto, status, unidades_netas, cantidad, " +
  "error, intentos, entorno, created_at, updated_at";

/**
 * GET — listado para el panel. Recibe los filtros ya validados por
 * `normalizarFiltrosTransformaciones`.
 */
export async function listar(filtros = {}) {
  let q = supabase
    .from(TABLA)
    .select(COLUMNAS_LISTA)
    .order("fecha", { ascending: false })
    .order("co", { ascending: true })
    .order("bodega", { ascending: true })
    // item_venta antes que tipo_dto: el CEI y el CSA de un mismo grupo quedan contiguos y el
    // límite no parte un par. `id` desempata de forma determinista.
    .order("item_venta", { ascending: true })
    .order("tipo_dto", { ascending: true })
    .order("id", { ascending: true })
    .limit(filtros.limite);
  if (filtros.entorno) q = q.eq("entorno", filtros.entorno);
  if (filtros.fecha_desde) q = q.gte("fecha", filtros.fecha_desde);
  if (filtros.fecha_hasta) q = q.lte("fecha", filtros.fecha_hasta);
  if (filtros.status) q = q.eq("status", filtros.status);
  if (filtros.tipo_dto) q = q.eq("tipo_dto", filtros.tipo_dto);
  if (filtros.co) q = q.eq("co", filtros.co);

  const { data, error } = await q;
  if (error) throw createError(500, "Error al listar las transformaciones.");
  return data || [];
}

/** GET — una transformación con el payload y la respuesta completos. */
export async function obtener(id) {
  const { data, error } = await supabase.from(TABLA).select("*").eq("id", id).maybeSingle();
  if (error) throw createError(500, "Error al leer la transformación.");
  if (!data) throw createError(404, "Transformación no encontrada.");
  return data;
}

const TABLA_CORRIDAS = "sps_transformaciones_corridas";
const LIMITE_CORRIDAS = 1000;

/**
 * GET — corridas del flujo (una fila por ejecución, con historial). Recibe `entorno`,
 * `fecha_desde` y `fecha_hasta` ya validados. El controlador deja la última por fecha.
 */
export async function listarCorridas(filtros = {}) {
  let q = supabase
    .from(TABLA_CORRIDAS)
    .select("*")
    .order("fecha", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(LIMITE_CORRIDAS);
  if (filtros.entorno) q = q.eq("entorno", filtros.entorno);
  if (filtros.fecha_desde) q = q.gte("fecha", filtros.fecha_desde);
  if (filtros.fecha_hasta) q = q.lte("fecha", filtros.fecha_hasta);

  const { data, error } = await q;
  if (error) throw createError(500, "Error al listar las corridas de transformación.");
  return data || [];
}
