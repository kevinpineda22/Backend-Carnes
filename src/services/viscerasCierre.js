import { motivoApagado } from "../config/preliquidacion.js";
import { siesaActivo, viscerasAlCierre } from "../config/siesa.js";
import * as PreliquidacionModel from "../models/Preliquidacion.model.js";
import * as SiesaEnvio from "../models/SiesaEnvio.model.js";

/**
 * Vísceras (CEI) de una recepción de res al CERRARLA, frente a la preliquidación.
 *
 * Las recepciones de res que la preliquidación lleva mandan su CEI cuando la entrada oficial de su
 * sede queda ok (`SiesaEnvio.enviarViscerasPreliquidacion`), no al cerrar: aunque
 * CARNES_SIESA_VISCERAS_AL_CIERRE esté prendida, el cierre no las manda.
 *
 * Problema: al cerrar todavía no se sabe si la recepción quedará vinculada; eso lo decide
 * `preliquidacionAlFinalizar` DESPUÉS del `Promise.all` de efectos. Por eso, con la preliquidación
 * habilitada, el controlador NO manda las vísceras en paralelo con la inicial: espera el vínculo y
 * pregunta a la base si la recepción tiene sede (la fuente de verdad, no el resultado de
 * `alFinalizar`, que ante un error inesperado no dice si llegó a vincular).
 *
 *   · con sede            -> `no_aplica`: la preliquidación las manda tras su oficial.
 *   · sin sede (sin preliquidación abierta, fuera de ventana, oficial legado) y bandera prendida
 *                         -> CEI al cierre como siempre, con el presupuesto contado desde el inicio del
 *                            pedido (la inicial ya consumió su parte de los 120 s del front).
 *   · no se pudo leer     -> `error` sin mandar: un CEI nunca debe adelantarse a la oficial.
 */

function dependenciasPorDefecto() {
  return {
    moduloActivo: () => motivoApagado() === null,
    siesaActivo: () => siesaActivo(),
    viscerasAlCierre: () => viscerasAlCierre(),
    leerSedeDeRecepcion: PreliquidacionModel.leerSedeDeRecepcion,
    enviarViscerasRecepcion: SiesaEnvio.enviarViscerasRecepcion,
    log: console,
  };
}

/** ¿Las vísceras de esta recepción las lleva la preliquidación (y por eso se difiere su decisión)? */
export function viscerasSeDifieren(recepcion, dependencias = {}) {
  const deps = { ...dependenciasPorDefecto(), ...dependencias };
  return recepcion?.especie === "res" && deps.moduloActivo();
}

/**
 * Se llama DESPUÉS de `preliquidacionAlFinalizar`, solo para las recepciones donde
 * `viscerasSeDifieren` es true. Nunca lanza. Devuelve el mismo contrato de
 * `enviarViscerasRecepcion` (`estado`, `referencia`, `error`).
 */
export async function viscerasTrasVinculo(recepcion, { inicioPeticion }, dependencias = {}) {
  const deps = { ...dependenciasPorDefecto(), ...dependencias };
  const base = { tipo: "visceras_recepcion", recepcion_id: recepcion.id };
  // Igual que `enviarViscerasRecepcion`: apagado no toca la base.
  if (!deps.siesaActivo() || !deps.viscerasAlCierre()) return { ...base, estado: "apagado" };
  try {
    const hallada = await deps.leerSedeDeRecepcion(recepcion.id);
    if (hallada) return { ...base, estado: "no_aplica" };
  } catch (error) {
    deps.log.error?.(`Vísceras al cierre de la recepción ${recepcion.id}: no se pudo leer su sede (${error?.message}).`);
    return { ...base, estado: "error", error: "No se pudo comprobar si la recepción está en una preliquidación." };
  }
  return deps.enviarViscerasRecepcion(recepcion.id, recepcion.recibido_por, { inicio: inicioPeticion });
}
