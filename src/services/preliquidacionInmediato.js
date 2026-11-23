import { motivoApagado } from "../config/preliquidacion.js";
import { siesaActivo } from "../config/siesa.js";
import * as PreliquidacionModel from "../models/Preliquidacion.model.js";
import * as Corridas from "../models/PreliquidacionCorrida.model.js";
import * as Vigilancia from "../models/PreliquidacionVigilancia.model.js";
import { ESPERA_MINIMA_CIERRE_MS, esperaParaEnvio } from "../shared/siesaAjusteVisceras.js";
import { debeLiquidar } from "../shared/preliquidacionTiempo.js";
import { TIMEOUT_OFICIAL_MS } from "./siesa.service.js";
import { despacharAlertas, encolarAlerta } from "./preliquidacionAlertas.js";

/**
 * Camino inmediato de la preliquidación: se ejecuta al finalizar una recepción de taller.
 *
 * Vincula la recepción a su preliquidación y, si la preliquidación ya liquidó (o ya debe
 * liquidar: la primera sede después de las 21:30, D1), programa el envío de ESA sede con
 * `waitUntil` ANTES de que el controlador responda. Si no hay presupuesto de tiempo, o
 * `waitUntil` no está disponible, queda `diferido` y lo recoge el barrido horario.
 *
 * Nunca lanza ni retrasa la respuesta de `finalizar`: la recepción ya está cerrada y lo que
 * falle aquí se ve en el estado de la sede, en una alerta o en la siguiente corrida.
 */

const ESPECIES = ["res", "cerdo"];
const ALERTAS_SIN_VINCULO = ["sin_preliquidacion", "fuera_ventana", "oficial_legacy"];

let avisoWaitUntilEmitido = false;

/** Solo para pruebas: permite volver a emitir el aviso. */
export function reiniciarAvisoWaitUntil() {
  avisoWaitUntilEmitido = false;
}

/**
 * Registra la tarea con `waitUntil` de `@vercel/functions`. Devuelve `false` (y NO inicia la
 * tarea) si la dependencia no está instalada: en ese caso el envío queda diferido y se avisa
 * una sola vez con `log.warn`.
 */
export async function waitUntilPorDefecto(
  crearTarea,
  { importar = () => import("@vercel/functions"), log = console } = {},
) {
  let waitUntil;
  try {
    ({ waitUntil } = await importar());
  } catch (error) {
    if (!avisoWaitUntilEmitido) {
      avisoWaitUntilEmitido = true;
      log.warn?.(
        `@vercel/functions no se pudo cargar (${error?.message}): el envío inmediato queda diferido al cron.`,
      );
    }
    return false;
  }
  if (typeof waitUntil !== "function") return false;
  waitUntil(crearTarea());
  return true;
}

function dependenciasPorDefecto() {
  return {
    motivoApagado: () => motivoApagado(),
    siesaActivo: () => siesaActivo(),
    ahoraMs: () => Date.now(),
    vincular: (id) => PreliquidacionModel.vincularRecepcion(id),
    leerSedeDeRecepcion: PreliquidacionModel.leerSedeDeRecepcion,
    encolar: encolarAlerta,
    despacharAlertas,
    revisarCorridasPerdidas: Vigilancia.revisarCorridasPerdidas,
    abrirCorrida: Corridas.abrirCorrida,
    registrarProgreso: Corridas.registrarProgreso,
    terminarCorrida: Corridas.terminarCorrida,
    procesar: PreliquidacionModel.procesarPreliquidacion,
    waitUntil: waitUntilPorDefecto,
    segundoPlano: waitUntilPorDefecto,
    log: console,
  };
}

/** Alertas que se despachan por invocación en el camino inmediato (el resto lo drena el barrido). */
const LIMITE_DESPACHO_INMEDIATO = 10;

/** Despacha el backlog de alertas; una falla del correo nunca debe afectar a quien llama. */
async function despacharSeguro(deps) {
  try {
    await deps.despacharAlertas({ ahora: new Date(), limite: LIMITE_DESPACHO_INMEDIATO });
  } catch (error) {
    deps.log.error?.(`Despacho de alertas falló: ${error?.message}`);
  }
}

/**
 * Alertas sin envío (desborde, recepción sin preliquidación): se despachan en segundo plano para
 * no retrasar la respuesta de `finalizar`. Si no hay cómo, quedan en cola y las toma el barrido.
 */
async function despacharEnSegundoPlano(deps) {
  try {
    await deps.segundoPlano(() => despacharSeguro(deps));
  } catch (error) {
    deps.log.error?.(`No se pudo programar el despacho de alertas: ${error?.message}`);
  }
}

/** Alerta de una recepción que no pudo vincularse: una por recepción (clave con sede 0). */
async function alertarSinVinculo(codigo, recepcion, error, { encolar, log }) {
  try {
    await encolar(
      {
        evento: codigo,
        preliquidacionId: 0,
        sedeId: 0,
        ocurrencia: recepcion.id,
        detalle: { recepcion_id: recepcion.id, especie: recepcion.especie, fecha_ingreso: recepcion.fecha_ingreso, motivo: error?.message },
      },
      { log },
    );
  } catch (e) {
    log.error?.(`Alerta ${codigo} de la recepción ${recepcion.id} falló: ${e?.message}`);
  }
}

/**
 * @param {object} recepcion la recepción recién finalizada (`id`, `especie`, `fecha_ingreso`, `recibido_por`)
 * @param {object} opciones
 * @param {number} opciones.inicioPeticion `Date.now()` al empezar `finalizar`
 * @param {Date}   [opciones.ahora]
 * @param {string} [opciones.inicialEstado] estado de la CEA inicial de esta recepción
 * @param {object} [dependencias] inyectables para pruebas
 * @returns {Promise<null | {resultado: string, envio: string|null}>} `null` si no aplica (flag apagado, otra especie)
 */
export async function alFinalizar(recepcion, opciones = {}, dependencias = {}) {
  const deps = { ...dependenciasPorDefecto(), ...dependencias };
  const { log } = deps;
  const { inicioPeticion, ahora = new Date(), inicialEstado } = opciones;

  try {
    if (deps.motivoApagado()) return null;
    if (!ESPECIES.includes(recepcion?.especie)) return null;

    // Corrida perdida (R7): también se revisa aquí, independiente del cron. Nunca bloquea al recibidor.
    try {
      await deps.revisarCorridasPerdidas({ ahora });
    } catch (error) {
      log.error?.(`Revisión de corridas perdidas falló: ${error?.message}`);
    }

    // 1. Vincular. Los motivos de negocio se alertan; ya_vinculada sigue con la sede existente.
    let vinculo = { resultado: "vinculada" };
    try {
      vinculo = await deps.vincular(recepcion.id);
    } catch (error) {
      const codigo = error?.codigo;
      if (ALERTAS_SIN_VINCULO.includes(codigo)) {
        await alertarSinVinculo(codigo, recepcion, error, deps);
        await despacharEnSegundoPlano(deps);
        return { resultado: codigo, envio: null };
      }
      if (codigo !== "ya_vinculada") throw error;
    }

    const hallada = await deps.leerSedeDeRecepcion(recepcion.id);
    if (!hallada) return { resultado: vinculo.resultado ?? "vinculada", envio: null };
    const { sede, cabecera } = hallada;
    const resultado = vinculo.resultado ?? "vinculada";

    // 2. Desborde: la sede queda bloqueada y se alerta; nunca se envía.
    if (resultado === "excede" || (sede.estado === "bloqueada" && sede.motivo_bloqueo === "excede_animales")) {
      try {
        await deps.encolar(
          {
            evento: "excede_animales",
            preliquidacionId: sede.preliquidacion_id ?? cabecera.id,
            sedeId: sede.id,
            ocurrencia: sede.version,
            detalle: { restantes: vinculo.restantes ?? null, solicitados: recepcion.novillos ?? null },
          },
          { log },
        );
      } catch (e) {
        log.error?.(`Alerta excede_animales de la sede ${sede.id} falló: ${e?.message}`);
      }
      await despacharEnSegundoPlano(deps);
      return { resultado: "excede", envio: "bloqueada" };
    }

    // 3. Antes del corte de la primera corrida no se envía nada.
    if (!cabecera.liquidada_at && !debeLiquidar({ preliq: cabecera, ahora })) {
      return { resultado, envio: "espera_corte" };
    }

    // 4. El presupuesto de tiempo de la función decide si se envía ahora o queda diferido.
    const restante = () =>
      esperaParaEnvio(deps.ahoraMs() - inicioPeticion, {
        maxEsperaMs: TIMEOUT_OFICIAL_MS,
        minimoMs: ESPERA_MINIMA_CIERRE_MS,
      });
    const timeoutMs = restante();
    if (timeoutMs === null) return { resultado, envio: "diferido" };

    const siesaEncendido = deps.siesaActivo();
    // Con SIESA encendido la CEA inicial de ESTA recepción debe estar ok: si no, el barrido la reintenta.
    if (siesaEncendido && inicialEstado !== undefined && inicialEstado !== "ok") {
      return { resultado, envio: "inicial_pendiente" };
    }

    let corrida;
    try {
      corrida = await deps.abrirCorrida({ origen: "inmediato", ahora });
    } catch (error) {
      log.error?.(`No se pudo abrir la corrida inmediata: ${error?.message}`);
      return { resultado, envio: "diferido" };
    }

    // 5. La tarea se registra ANTES de responder; si no se pudo registrar, no se ejecuta.
    const tarea = async () => {
      let fallo = null;
      try {
        const resumen = await deps.procesar(cabecera.id, {
          ahora,
          origen: "inmediato",
          corrida,
          soloSedeId: sede.id,
          timeoutMs,
          hayPresupuesto: () => restante() !== null,
          por: recepcion.recibido_por ?? null,
          siesaActivo: siesaEncendido,
        });
        await deps.registrarProgreso(corrida, { preliquidacionId: cabecera.id, resultado: resumen });
      } catch (error) {
        fallo = error;
        log.error?.(`Envío inmediato de la sede ${sede.id} falló: ${error?.message}`);
      }
      // Lo que el envío encoló (error, sin_confirmar, bloqueos) sale en la misma tarea.
      await despacharSeguro(deps);
      try {
        await deps.terminarCorrida(corrida, { error: fallo, ahora: new Date() });
      } catch (error) {
        log.error?.(`No se pudo cerrar la corrida inmediata ${corrida.id}: ${error?.message}`);
      }
    };
    const registrada = await deps.waitUntil(tarea);
    if (registrada === false) return { resultado, envio: "diferido" };

    return { resultado, envio: siesaEncendido ? "programado" : "simulada" };
  } catch (error) {
    log.error?.(`Preliquidación al finalizar la recepción ${recepcion?.id} falló: ${error?.message}`);
    return { resultado: "error", envio: null };
  }
}
