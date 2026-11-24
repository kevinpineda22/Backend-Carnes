import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * Lectura del vínculo recepción -> preliquidación para las guardas de los flujos
 * legados (eliminar, reabrir, rechazar, vincular a una liquidación, corregir novillos).
 *
 * `preliquidacion_id` NO está en la lista de columnas de `COLUMNAS_RECEPCION` a
 * propósito: esa lista viaja en cada lectura del módulo, y una columna que no
 * existe (base sin sql/038, o después del rollback sql/038_039_rollback.sql) tumbaría
 * TODAS las lecturas de recepciones. Aquí se consulta aparte y, si la columna no
 * existe, se responde "sin vínculo": el comportamiento es el de antes de esta función.
 */

function faltaColumna(error) {
  const codigo = error?.code || "";
  const mensaje = String(error?.message || "");
  return (
    (codigo === "42703" || codigo === "PGRST204" || /column .* does not exist/i.test(mensaje)) &&
    mensaje.includes("preliquidacion_id")
  );
}

/** Id de la preliquidación a la que pertenece la recepción, o `null`. */
export async function preliquidacionIdDeRecepcion(id, db = supabase) {
  const { data, error } = await db.from("carnes_recepciones").select("id, preliquidacion_id").eq("id", id).maybeSingle();
  if (error) {
    if (faltaColumna(error)) return null;
    throw new Error(`Error al leer la preliquidación de la recepción: ${error.message}`);
  }
  return data?.preliquidacion_id ?? null;
}

/** `Map` id de recepción -> id de preliquidación, solo de las que están vinculadas. */
export async function preliquidacionIdsDeRecepciones(ids, db = supabase) {
  const vinculos = new Map();
  if (!ids?.length) return vinculos;
  const { data, error } = await db.from("carnes_recepciones").select("id, preliquidacion_id").in("id", ids);
  if (error) {
    if (faltaColumna(error)) return vinculos;
    throw new Error(`Error al leer las preliquidaciones de las recepciones: ${error.message}`);
  }
  for (const fila of data || []) {
    if (fila.preliquidacion_id) vinculos.set(String(fila.id), fila.preliquidacion_id);
  }
  return vinculos;
}

/** 409 si la recepción está vinculada a una preliquidación. `accion` completa la frase. */
export async function exigirSinPreliquidacion(id, accion, db = supabase) {
  const preliquidacionId = await preliquidacionIdDeRecepcion(id, db);
  if (preliquidacionId) {
    throw createError(
      409,
      `La recepción está vinculada a la preliquidación #${preliquidacionId}: desvincúlela antes de ${accion}.`,
      "recepcion_en_preliquidacion",
    );
  }
}
