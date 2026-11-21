import { supabase } from "../config/supabase.js";
import { encolarAlerta } from "../services/preliquidacionAlertas.js";
import { ventanaVencida } from "../shared/preliquidacionTiempo.js";

/**
 * Vigilancia de la preliquidación: señales que no dependen de que haya sedes por enviar.
 *
 *  - `escanearVentanas`: alerta única de ventana vencida con animales sin asignar (A4).
 *
 * Las lecturas y escrituras son inyectables para probar sin base.
 */

const T_PRELIQ = "carnes_preliquidaciones";

async function leerAbiertasDb({ especie } = {}) {
  let q = supabase.from(T_PRELIQ).select("*").eq("estado", "abierta");
  if (especie) q = q.eq("especie", especie);
  const { data, error } = await q.order("id");
  if (error) throw new Error(`Error al leer las preliquidaciones abiertas: ${error.message}`);
  return data || [];
}

async function marcarAvisoDb(id, cuando) {
  const { error } = await supabase
    .from(T_PRELIQ)
    .update({ aviso_ventana_at: cuando.toISOString() })
    .eq("id", id)
    .is("aviso_ventana_at", null);
  if (error) throw new Error(`Error al marcar el aviso de ventana: ${error.message}`);
}

/**
 * Barrido de ventanas vencidas sobre TODAS las preliquidaciones abiertas (independiente de
 * si tienen sedes pendientes). Encola `ventana_vencida` (clave `(evento, id, 0, 0)`, una vez
 * por preliquidación) y, solo si la alerta quedó en la cola real, marca `aviso_ventana_at`
 * para no repetirla. Con el puerto aún en no-op NO se marca: la alerta no se ha entregado.
 * Una alerta que falla no impide revisar las demás.
 *
 * @returns {Promise<{vencidas: number[], avisadas: number[]}>}
 */
export async function escanearVentanas({
  ahora = new Date(),
  especie,
  encolar = encolarAlerta,
  leerAbiertas = leerAbiertasDb,
  marcarAviso = marcarAvisoDb,
  log = console,
} = {}) {
  const abiertas = await leerAbiertas(especie ? { especie } : {});
  const vencidas = [];
  const avisadas = [];
  for (const preliq of abiertas) {
    if (!ventanaVencida({ preliq, ahora })) continue;
    vencidas.push(preliq.id);
    try {
      const respuesta = await encolar(
        {
          evento: "ventana_vencida",
          preliquidacionId: preliq.id,
          sedeId: 0,
          ocurrencia: 0,
          detalle: { restantes: preliq.restantes, ventana_fin: preliq.ventana_fin },
        },
        { log },
      );
      if (respuesta?.ok && !respuesta.noop) {
        await marcarAviso(preliq.id, ahora);
        avisadas.push(preliq.id);
      }
    } catch (error) {
      log.error?.(`Aviso de ventana vencida de la preliquidación ${preliq.id} falló: ${error?.message}`);
    }
  }
  return { vencidas, avisadas };
}
