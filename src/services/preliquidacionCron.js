import { motivoApagado } from "../config/preliquidacion.js";
import * as PreliquidacionModel from "../models/Preliquidacion.model.js";
import * as Corridas from "../models/PreliquidacionCorrida.model.js";
import * as Vigilancia from "../models/PreliquidacionVigilancia.model.js";
import { despacharAlertas } from "./preliquidacionAlertas.js";
import { ESPERA_MINIMA_CIERRE_MS, esperaParaEnvio } from "../shared/siesaAjusteVisceras.js";
import { TIMEOUT_OFICIAL_MS } from "./siesa.service.js";

/**
 * Orquestador del cron de la preliquidación (`POST /api/cron/preliquidaciones`).
 *
 * Una invocación abre (o continúa) una corrida, hace el barrido de ventanas vencidas,
 * procesa cada preliquidación abierta con un presupuesto de tiempo, despacha el backlog de
 * alertas y deja la corrida `en_curso` si quedan pendientes (el workflow la retoma con el
 * mismo `corrida_id`). Es idempotente: una segunda llamada sin cambios envía `enviadas: 0`.
 *
 * El corte NO se juzga por la hora de la corrida sino por los datos (`debeLiquidar` en
 * `procesarPreliquidacion`), así que un barrido horario no liquida antes de tiempo.
 */

const ORIGENES = ["schedule", "sweep", "dispatch"];
const ESPECIES = ["res", "cerdo"];
/** Margen bajo el límite de la función serverless (el workflow espera hasta 290 s). */
export const PRESUPUESTO_CRON_MS = 240_000;
/** Alertas que se despachan por invocación del cron (el resto lo toma el siguiente ciclo). */
const LIMITE_DESPACHO_CRON = 10;

/**
 * Valida el cuerpo del cron. Un cuerpo ausente equivale a `{}`.
 * @returns {{ok: true, valor: object} | {ok: false, mensaje: string}}
 */
export function validarCuerpoCron(body) {
  const cuerpo = body ?? {};
  if (typeof cuerpo !== "object" || Array.isArray(cuerpo)) return { ok: false, mensaje: "El cuerpo debe ser un objeto." };

  const { especie, dry_run: dryRun = false, origen = "schedule", gh_run_id: ghRunId, corrida_id: corridaId } = cuerpo;
  if (especie != null && !ESPECIES.includes(especie)) return { ok: false, mensaje: "especie debe ser res o cerdo." };
  if (typeof dryRun !== "boolean") return { ok: false, mensaje: "dry_run debe ser booleano." };
  if (!ORIGENES.includes(origen)) return { ok: false, mensaje: "origen debe ser schedule, sweep o dispatch." };

  let corrida = null;
  if (corridaId != null) {
    corrida = Number(corridaId);
    if (!Number.isInteger(corrida) || corrida <= 0) return { ok: false, mensaje: "corrida_id no es válido." };
  }
  return {
    ok: true,
    valor: {
      especie: especie ?? undefined,
      dryRun,
      origen,
      ghRunId: ghRunId == null ? null : String(ghRunId),
      corridaId: corrida,
    },
  };
}

function dependenciasPorDefecto() {
  return {
    motivoApagado: () => motivoApagado(),
    ahora: () => new Date(),
    ahoraMs: () => Date.now(),
    presupuestoMs: PRESUPUESTO_CRON_MS,
    abrirCorrida: Corridas.abrirCorrida,
    registrarProgreso: Corridas.registrarProgreso,
    terminarCorrida: Corridas.terminarCorrida,
    escanearVentanas: Vigilancia.escanearVentanas,
    revisarCorridasPerdidas: Vigilancia.revisarCorridasPerdidas,
    listarAbiertas: PreliquidacionModel.listar,
    procesar: PreliquidacionModel.procesarPreliquidacion,
    despacharAlertas,
    log: console,
  };
}

/** Contadores de sedes del contrato de respuesta a partir del resumen de una preliquidación. */
function contadoresSedes(resumen = {}) {
  return {
    enviadas: resumen.enviadas ?? 0,
    simuladas: resumen.simuladas ?? 0,
    bloqueadas: resumen.bloqueadas ?? 0,
    errores: resumen.errores ?? 0,
    sin_confirmar: resumen.sin_confirmar ?? 0,
    inicial_pendiente: resumen.inicial_pendiente ?? 0,
  };
}

/**
 * @param {{especie?: string, dryRun?: boolean, origen: string, ghRunId?: string|null, corridaId?: number|null}} entrada
 * @param {object} [dependencias] inyectables para pruebas
 */
export async function ejecutarCron(entrada, dependencias = {}) {
  const deps = { ...dependenciasPorDefecto(), ...dependencias };
  const { especie, dryRun = false, origen = "schedule", ghRunId = null, corridaId = null } = entrada;
  const { log } = deps;

  // Apagado (flag o compuerta de auth): inerte, sin corrida ni escrituras.
  const motivo = deps.motivoApagado();
  if (motivo) return { ok: true, flag: "off", motivo };

  const ahora = deps.ahora();
  const inicio = deps.ahoraMs();
  // Tiempo que queda para un envío dentro de la función serverless (null = ya no alcanza).
  const restante = () =>
    esperaParaEnvio(deps.ahoraMs() - inicio, { maxEsperaMs: TIMEOUT_OFICIAL_MS, minimoMs: ESPERA_MINIMA_CIERRE_MS });
  const hayPresupuesto = () => deps.ahoraMs() - inicio < deps.presupuestoMs && restante() !== null;
  const corrida = await deps.abrirCorrida({ corridaId, origen, ghRunId, dryRun, ahora });

  const procesadas = [];
  let pendientes = 0;
  let agotado = false;
  let fallo = null;

  try {
    // Barrido de ventanas vencidas: independiente de si hay sedes pendientes. Nunca detiene la corrida.
    if (!dryRun) {
      try {
        await deps.escanearVentanas({ ahora, especie });
      } catch (error) {
        log.error?.(`Cron preliquidación: el barrido de ventanas falló: ${error?.message}`);
      }
    }

    // La corrida programada de un corte anterior que no corrió: alerta deduplicada (R7).
    if (!dryRun) {
      try {
        await deps.revisarCorridasPerdidas({ ahora, especie });
      } catch (error) {
        log.error?.(`Cron preliquidación: la revisión de corridas perdidas falló: ${error?.message}`);
      }
    }

    const filtros = { estado: "abierta" };
    if (especie) filtros.especie = especie;
    const abiertas = await deps.listarAbiertas(filtros);

    for (const preliq of abiertas) {
      if (!hayPresupuesto()) {
        // Sin presupuesto: lo que no se alcanzó a procesar queda pendiente para el siguiente ciclo.
        agotado = true;
        pendientes += 1;
        continue;
      }
      try {
        const resumen = await deps.procesar(preliq.id, {
          ahora,
          dryRun,
          origen,
          corrida,
          hayPresupuesto,
          timeoutMs: () => restante() ?? ESPERA_MINIMA_CIERRE_MS,
        });
        await deps.registrarProgreso(corrida, { preliquidacionId: preliq.id, resultado: resumen });
        pendientes += resumen?.pendientes ?? 0;
        if (resumen?.agotado) agotado = true;
        procesadas.push({
          id: preliq.id,
          especie: preliq.especie,
          resultado: resumen?.resultado ?? "ok",
          liquidada: resumen?.liquidada === true,
          sedes: contadoresSedes(resumen),
        });
      } catch (error) {
        fallo ??= error;
        log.error?.(`Cron preliquidación ${preliq.id} falló: ${error?.message}`);
        procesadas.push({ id: preliq.id, especie: preliq.especie, resultado: "error", error: error?.message ?? String(error) });
      }
    }
  } catch (error) {
    fallo ??= error;
  }

  const continua = !dryRun && pendientes > 0 && !fallo;
  try {
    await deps.terminarCorrida(corrida, { error: fallo, ahora: deps.ahora(), continua });
  } finally {
    // Backlog de alertas: se despacha DESPUÉS de cerrar la corrida y acotado por el tiempo que queda y un límite.
    // Corre aunque el cierre rechace (el error del cierre sigue propagándose igual) y una falla aquí nunca altera
    // el resultado de la corrida.
    if (!dryRun) {
      try {
        const margen = restante();
        if (margen !== null) {
          await deps.despacharAlertas({ ahora, limite: LIMITE_DESPACHO_CRON, hasta: Date.now() + margen });
        }
      } catch (error) {
        log.error?.(`Cron preliquidación: el despacho de alertas falló: ${error?.message}`);
      }
    }
  }

  const respuesta = {
    ok: !fallo,
    flag: "on",
    corrida_id: corrida.id,
    procesadas,
    pendientes,
    presupuesto_agotado: agotado,
  };
  if (dryRun) respuesta.dry_run = true;
  return respuesta;
}
