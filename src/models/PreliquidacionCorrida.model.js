import { supabase } from "../config/supabase.js";

/**
 * Corridas de la preliquidación (`carnes_preliquidacion_corridas`): una fila por ejecución
 * del cron, del barrido, de un despacho manual, del envío inmediato o del admin.
 *
 * Reglas (R14): `p_corrida_id` de las RPC nunca es NULL, así que toda ejecución abre o
 * continúa una corrida. Un `corrida_id` desconocido o ya terminado NO se reutiliza: se crea
 * una corrida nueva. `resumen.reevaluadas` guarda las sedes bloqueadas ya reevaluadas para
 * que cada una se reevalúe una sola vez por corrida, aunque el workflow la continúe en
 * varias llamadas.
 */

const T_CORRIDAS = "carnes_preliquidacion_corridas";
const ORIGENES = ["schedule", "sweep", "dispatch", "admin", "inmediato"];

const aISO = (fecha) => (fecha instanceof Date ? fecha.toISOString() : new Date(fecha).toISOString());

/** Fila de la base -> corrida en memoria (con `resumen.reevaluadas` siempre presente). */
function aCorrida(fila) {
  const resumen = { ...(fila.resumen ?? {}) };
  resumen.reevaluadas = Array.isArray(resumen.reevaluadas) ? [...resumen.reevaluadas] : [];
  return { ...fila, preliquidacion_ids: [...(fila.preliquidacion_ids ?? [])], resumen };
}

/** Crea una corrida `en_curso`. */
export async function iniciarCorrida({ origen, ghRunId = null, dryRun = false, ahora = new Date() } = {}) {
  if (!ORIGENES.includes(origen)) throw new Error(`origen de corrida desconocido: ${String(origen)}`);
  const { data, error } = await supabase
    .from(T_CORRIDAS)
    .insert({
      origen,
      gh_run_id: ghRunId == null ? null : String(ghRunId),
      dry_run: dryRun === true,
      iniciada_at: aISO(ahora),
      estado: "en_curso",
      preliquidacion_ids: [],
      resumen: { reevaluadas: [] },
    })
    .select()
    .single();
  if (error) throw new Error(`Error al crear la corrida: ${error.message}`);
  return aCorrida(data);
}

/**
 * Continúa la corrida `corridaId` si existe y sigue `en_curso`; en cualquier otro caso
 * (sin id, id inválido, desconocido o terminado) crea una nueva.
 */
export async function abrirCorrida({ corridaId = null, origen, ghRunId = null, dryRun = false, ahora = new Date() } = {}) {
  const id = Number(corridaId);
  if (corridaId != null && Number.isInteger(id) && id > 0) {
    const { data, error } = await supabase.from(T_CORRIDAS).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Error al leer la corrida: ${error.message}`);
    if (data && data.estado === "en_curso") return aCorrida(data);
  }
  return iniciarCorrida({ origen, ghRunId, dryRun, ahora });
}

/**
 * Guarda el avance: une la preliquidación a `preliquidacion_ids`, acumula los contadores del
 * `resultado` en `resumen` y persiste `resumen.reevaluadas`. Muta `corrida`.
 */
export async function registrarProgreso(corrida, { preliquidacionId, resultado = null } = {}) {
  if (preliquidacionId != null && !corrida.preliquidacion_ids.includes(preliquidacionId)) {
    corrida.preliquidacion_ids.push(preliquidacionId);
  }
  if (resultado) {
    for (const [clave, valor] of Object.entries(resultado)) {
      // Solo se acumulan contadores: una clave que en la corrida no es numérica (p. ej.
      // `reevaluadas`, que allí es la lista de ids) nunca se sobrescribe con la suma.
      const actual = corrida.resumen[clave];
      const esContador = actual === undefined || typeof actual === "number";
      if (typeof valor === "number" && esContador && clave !== "preliquidacion_id" && clave !== "pendientes") {
        corrida.resumen[clave] = (actual ?? 0) + valor;
      }
    }
  }
  const { error } = await supabase
    .from(T_CORRIDAS)
    .update({ preliquidacion_ids: corrida.preliquidacion_ids, resumen: corrida.resumen })
    .eq("id", corrida.id);
  if (error) throw new Error(`Error al guardar el avance de la corrida: ${error.message}`);
  return corrida;
}

/**
 * Cierra la corrida: `ok`, o `error` con el mensaje. Con `continua` (quedan pendientes y el
 * workflow la retomará con el mismo `corrida_id`) solo guarda el resumen y sigue `en_curso`.
 */
export async function terminarCorrida(corrida, { error = null, ahora = new Date(), continua = false } = {}) {
  const cambios = { preliquidacion_ids: corrida.preliquidacion_ids, resumen: corrida.resumen };
  if (!continua) {
    cambios.estado = error ? "error" : "ok";
    cambios.terminada_at = aISO(ahora);
    if (error) cambios.error = error?.message ?? String(error);
  }
  const { error: fallo } = await supabase.from(T_CORRIDAS).update(cambios).eq("id", corrida.id);
  if (fallo) throw new Error(`Error al cerrar la corrida: ${fallo.message}`);
  return { ...corrida, ...cambios };
}
