import { supabase } from "../config/supabase.js";
import { encolarAlerta } from "../services/preliquidacionAlertas.js";
import { decidirAutocierre, decidirCierreManual } from "../shared/preliquidacionCierre.js";

/**
 * Cierre de la preliquidación: auto-cierre (D3) tras un envío exitoso y cierre manual del admin.
 *
 * Las reglas están en `shared/preliquidacionCierre.js` (puras); aquí solo se lee, se decide y se
 * escribe por `carnes_preliq_cerrar`, que valida `orden_version` bajo candado. Este módulo NO
 * importa `Preliquidacion.model.js` ni `SiesaEnvio.model.js` para que ambos puedan usarlo sin
 * crear un ciclo de importación.
 */

const T_PRELIQ = "carnes_preliquidaciones";
const T_SEDES = "carnes_preliquidacion_sedes";
const MAX_INTENTOS_VERSION = 3;

async function leerDb(id) {
  const [cabecera, sedes] = await Promise.all([
    supabase.from(T_PRELIQ).select("*").eq("id", id).maybeSingle(),
    supabase.from(T_SEDES).select("*").eq("preliquidacion_id", id),
  ]);
  if (cabecera.error) throw new Error(`Error al leer la preliquidación: ${cabecera.error.message}`);
  if (sedes.error) throw new Error(`Error al leer las sedes: ${sedes.error.message}`);
  return { cabecera: cabecera.data, sedes: sedes.data || [] };
}

async function rpcDb(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args);
  if (error) throw new Error(`Error en ${nombre}: ${error.message}`);
  return data;
}

/**
 * Lee, decide y cierra; relee y reintenta (máx. 3) si cambió la `orden_version`.
 * @returns {Promise<{resultado: string, motivo?: string, monto_no_asignado?: string}>}
 */
async function cerrarSegun(decidir, id, { leer = leerDb, rpc = rpcDb, encolar = encolarAlerta, log = console } = {}) {
  let ultimo = { resultado: "version_cambiada" };
  for (let intento = 0; intento < MAX_INTENTOS_VERSION; intento += 1) {
    const { cabecera, sedes } = await leer(id);
    if (!cabecera) return { resultado: "no_encontrada" };
    const decision = decidir({ cabecera, sedes });
    if (!decision.cerrar) {
      if (decision.motivo === "no_abierta" || decision.motivo === "no_liquidada") return { resultado: decision.motivo };
      return { resultado: "no_cerrable", motivo: decision.motivo };
    }

    const respuesta = await rpc("carnes_preliq_cerrar", {
      p_id: id,
      p_orden_version: cabecera.orden_version,
      p_monto_no_asignado: decision.montoNoAsignado,
    });
    if (respuesta?.resultado === "version_cambiada") {
      ultimo = respuesta;
      continue;
    }
    if (respuesta?.resultado === "ok") {
      try {
        await encolar(
          { evento: "cerrada", preliquidacionId: id, sedeId: 0, ocurrencia: 0, detalle: { monto_no_asignado: decision.montoNoAsignado } },
          { log },
        );
      } catch (error) {
        log.error?.(`Alerta de cierre de la preliquidación ${id} falló: ${error?.message}`);
      }
      return { resultado: "ok", monto_no_asignado: decision.montoNoAsignado };
    }
    return respuesta ?? { resultado: "invalido" };
  }
  return ultimo;
}

/**
 * Auto-cierre (D3 + I5) tras pasar una sede a `enviada`. NUNCA lanza: un fallo aquí no puede
 * deshacer un envío que ya salió a SIESA; la siguiente corrida o el admin lo cierran.
 * @returns {Promise<{cerrada: boolean, motivo?: string, monto_no_asignado?: string}>}
 */
export async function intentarAutocierre(id, deps = {}) {
  const log = deps.log ?? console;
  try {
    const r = await cerrarSegun(decidirAutocierre, id, deps);
    if (r.resultado === "ok") return { cerrada: true, monto_no_asignado: r.monto_no_asignado };
    return { cerrada: false, motivo: r.motivo ?? r.resultado };
  } catch (error) {
    log.error?.(`Auto-cierre de la preliquidación ${id} falló: ${error?.message}`);
    return { cerrada: false, motivo: "error" };
  }
}

/**
 * Cierre manual del admin. Devuelve el resultado de negocio (`ok`, `no_cerrable`, `no_abierta`,
 * `no_liquidada`, `version_cambiada`, `no_encontrada`); los errores de infraestructura se lanzan.
 */
export async function cerrarPreliquidacion(id, deps = {}) {
  return cerrarSegun(decidirCierreManual, id, deps);
}
