import { supabase } from "../config/supabase.js";
import { encolarAlerta } from "../services/preliquidacionAlertas.js";
import { corridaPerdida, ventanaVencida } from "../shared/preliquidacionTiempo.js";

/**
 * Vigilancia de la preliquidación: señales que no dependen de que haya sedes por enviar.
 *
 *  - `escanearVentanas`: alerta única de ventana vencida con animales sin asignar (A4).
 *  - `revisarCorridasPerdidas`: la corrida programada no corrió (R7); la usan el cron, el
 *    cierre de recepciones y las lecturas del panel, para no depender solo de GitHub.
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

const T_CORRIDAS = "carnes_preliquidacion_corridas";
const MARGEN_CORRIDA_MS = 60 * 60 * 1000;

async function leerCorridasDb({ desde }) {
  const { data, error } = await supabase
    .from(T_CORRIDAS)
    .select("id, estado, dry_run, preliquidacion_ids, terminada_at")
    .eq("estado", "ok")
    .eq("dry_run", false)
    .gte("terminada_at", desde.toISOString());
  if (error) throw new Error(`Error al leer las corridas: ${error.message}`);
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

/**
 * Detecta las preliquidaciones cuya corrida programada se perdió (`corridaPerdida`, pura) y
 * encola `corrida_perdida` (clave `(evento, id, 0, 0)`: una vez por preliquidación; el puerto
 * deduplica). Solo consulta las corridas recientes si hay alguna candidata.
 *
 * @param {object} [p]
 * @param {Array}  [p.preliquidaciones] ya leídas (lecturas GET); si no, lee las abiertas
 * @returns {Promise<{perdidas: number[]}>}
 */
export async function revisarCorridasPerdidas({
  ahora = new Date(),
  especie,
  preliquidaciones,
  encolar = encolarAlerta,
  leerAbiertas = leerAbiertasDb,
  leerCorridas = leerCorridasDb,
  log = console,
} = {}) {
  const base = preliquidaciones ?? (await leerAbiertas(especie ? { especie } : {}));
  const abiertas = base.filter((p) => p.estado === "abierta");
  // Sin corridas, `corridaPerdida` solo es verdadera para las candidatas (debe liquidar y pasó el margen).
  const candidatas = abiertas.filter((preliq) => corridaPerdida({ preliq, corridas: [], ahora }));
  if (!candidatas.length) return { perdidas: [], nuevas: 0 };

  const corridas = await leerCorridas({ desde: new Date(ahora.getTime() - MARGEN_CORRIDA_MS) });
  const perdidas = [];
  let nuevas = 0;
  for (const preliq of candidatas) {
    if (!corridaPerdida({ preliq, corridas, ahora })) continue;
    perdidas.push(preliq.id);
    try {
      const r = await encolar(
        { evento: "corrida_perdida", preliquidacionId: preliq.id, sedeId: 0, ocurrencia: 0, detalle: { especie: preliq.especie } },
        { log },
      );
      if (r?.encolada === true) nuevas += 1;
    } catch (error) {
      log.error?.(`Alerta de corrida perdida de la preliquidación ${preliq.id} falló: ${error?.message}`);
    }
  }
  return { perdidas, nuevas };
}
