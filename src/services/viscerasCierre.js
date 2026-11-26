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
 * Al cerrar todavía no se sabe con certeza si la recepción quedará vinculada (eso lo decide
 * `preliquidacionAlFinalizar`, DESPUÉS del `Promise.all` de efectos). Para no serializar el cierre de
 * las que NO se vinculan, la decisión se toma con la misma regla que usa el vínculo
 * (`PreliquidacionModel.recepcionSeVincularia`: especie + módulo habilitado + una preliquidación abierta de
 * la especie que la reciba) y corre DENTRO del `Promise.all`, en paralelo con la inicial:
 *
 *   · no se vincularía (sin preliquidación abierta, fuera de ventana, cerdo, módulo apagado)
 *                         -> CEI al cierre en paralelo con la inicial, exactamente como antes
 *                            (presupuesto contado desde el inicio del pedido).
 *   · se vincularía       -> NO se manda aquí; `diferidas: true`. El controlador, tras
 *                            `preliquidacionAlFinalizar`, llama a `viscerasTrasVinculo`, que pregunta a la base
 *                            si de verdad quedó con sede (la fuente de verdad: el vínculo puede fallar o
 *                            perder una carrera) y, si no, la manda al cierre.
 *   · no se pudo decidir  -> se difiere (camino seguro: un CEI nunca debe adelantarse a la oficial).
 *
 * Si la decisión de "no se vincularía" fallara por una carrera (se abrió una preliquidación entre la lectura y
 * el vínculo), las vísceras se mandan al cierre Y la preliquidación las vería después con un CEI vigente:
 * el índice único de `carnes_siesa_envios` evita el duplicado (`repetido`).
 */

function dependenciasPorDefecto() {
  return {
    moduloActivo: () => motivoApagado() === null,
    siesaActivo: () => siesaActivo(),
    viscerasAlCierre: () => viscerasAlCierre(),
    recepcionSeVincularia: PreliquidacionModel.recepcionSeVincularia,
    leerSedeDeRecepcion: PreliquidacionModel.leerSedeDeRecepcion,
    enviarViscerasRecepcion: SiesaEnvio.enviarViscerasRecepcion,
    log: console,
  };
}

/**
 * Se llama DENTRO del `Promise.all` del cierre. Nunca lanza.
 *
 * @returns {Promise<{diferidas: true} | {diferidas: false, resultado: object}>} `resultado` tiene el contrato de
 *   `enviarViscerasRecepcion` (`estado`, `referencia`, `error`).
 */
export async function viscerasAlCerrar(recepcion, { inicioPeticion }, dependencias = {}) {
  const deps = { ...dependenciasPorDefecto(), ...dependencias };
  const alCierre = () => deps.enviarViscerasRecepcion(recepcion.id, recepcion.recibido_por, { inicio: inicioPeticion });

  // Solo la res con el módulo habilitado y con algo que mandar al cierre puede ser de la preliquidación.
  // Sin SIESA o sin la bandera `enviarViscerasRecepcion` responde "apagado" sin tocar la base: no hay nada que decidir.
  if (recepcion?.especie !== "res" || !deps.moduloActivo() || !deps.siesaActivo() || !deps.viscerasAlCierre()) {
    return { diferidas: false, resultado: await alCierre() };
  }
  let seVincularia;
  try {
    seVincularia = await deps.recepcionSeVincularia(recepcion);
  } catch (error) {
    deps.log.error?.(`Vísceras al cierre de la recepción ${recepcion.id}: no se pudo decidir el vínculo (${error?.message}).`);
    return { diferidas: true };
  }
  if (seVincularia) return { diferidas: true };
  return { diferidas: false, resultado: await alCierre() };
}

/**
 * Se llama DESPUÉS de `preliquidacionAlFinalizar`, solo para las recepciones donde `viscerasAlCerrar` devolvió
 * `diferidas: true`. Nunca lanza. Devuelve el mismo contrato de `enviarViscerasRecepcion` (`estado`, `referencia`,
 * `error`).
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
