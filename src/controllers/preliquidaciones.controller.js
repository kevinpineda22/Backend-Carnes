import * as PreliquidacionModel from "../models/Preliquidacion.model.js";
import * as RetomasModel from "../models/PreliquidacionRetomas.model.js";
import * as CorreccionesModel from "../models/PreliquidacionCorrecciones.model.js";
import * as SaldosModel from "../models/PreliquidacionSaldos.model.js";
import * as InicialModel from "../models/PreliquidacionInicial.model.js";
import { conQuienHace } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";
import { authRequeridaEnProduccion, avisarAuthRequerida, motivoApagado } from "../config/preliquidacion.js";
import { revisarCorridasPerdidas } from "../models/PreliquidacionVigilancia.model.js";

/**
 * Alertas: las acciones de este controlador solo las ENCOLAN (a través de los modelos). Ningún endpoint
 * las despacha: se entregan únicamente por el cron (barrido horario + corrida de las 21:30), con hasta
 * 1 h de retraso. Despachar desde aquí retenía la respuesta del admin y en Vercel la función se congela al responder.
 */

/** Quién hace la acción (correo del usuario autenticado cuando `CARNES_AUTH` lo exige). */
const quien = (req) => conQuienHace(req, {}, "por").por ?? null;

/**
 * Con el interruptor apagado NINGUNA escritura de /preliquidaciones procede (crear,
 * configurar, editar, gastos, retomas, vincular, desvincular). Solo quedan las lecturas.
 * El router lo aplica a todo método que no sea GET (ver `exigirEscrituraHabilitada`).
 * La compuerta de auth se evalúa ANTES y sin depender del interruptor: en producción sin
 * `CARNES_AUTH=exigir` toda escritura, drenaje incluido, es 503 `auth_requerida`.
 */
function exigirEncendida({ drenaje = false } = {}) {
  if (authRequeridaEnProduccion()) {
    avisarAuthRequerida();
    throw createError(
      503,
      "La preliquidación requiere autenticación exigida en producción (CARNES_AUTH=exigir).",
      "auth_requerida",
    );
  }
  // Drenaje: con el interruptor apagado (y la auth ya superada) el admin puede terminar lo ya vinculado.
  if (motivoApagado() && !drenaje) {
    throw createError(
      409,
      "La preliquidación de talleres está apagada (CARNES_PRELIQUIDACION).",
      "preliquidacion_apagada",
    );
  }
}

/**
 * Rutas que siguen disponibles con el interruptor apagado (drenaje): procesar y cerrar lo ya
 * vinculado. La compuerta de auth (503) se evalúa antes y las alcanza igual: producción sin
 * CARNES_AUTH=exigir no deja operar ninguna, esté el interruptor encendido o no.
 */
const RUTAS_DRENAJE = [
  /^\/\d+\/procesar\/?$/,
  /^\/sedes\/\d+\/procesar\/?$/,
  /^\/\d+\/cerrar\/?$/,
  // Confirmar la anulación hecha en SIESA solo registra algo que ya pasó: no abre trabajo nuevo.
  /^\/sedes\/\d+\/anular\/?$/,
  // Anular la preliquidación entera es el rollback cuando nada salió a SIESA: debe poder hacerse apagada.
  /^\/\d+\/anular\/?$/,
];

/** Middleware: con el interruptor apagado corta toda escritura con 409, antes de validar y de tocar la base. */
export function exigirEscrituraHabilitada(req, _res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  try {
    exigirEncendida({ drenaje: req.method === "POST" && RUTAS_DRENAJE.some((re) => re.test(req.path)) });
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Ids de las preliquidaciones con la corrida programada perdida (R7). Con el interruptor
 * apagado no revisa nada; una falla de la revisión nunca rompe la lectura.
 */
async function idsConCorridaPerdida(preliquidaciones) {
  if (motivoApagado()) return new Set();
  try {
    const { perdidas } = await revisarCorridasPerdidas({ preliquidaciones });
    return new Set(perdidas.map(String));
  } catch (error) {
    console.error("Revisión de corridas perdidas falló:", error?.message);
    return new Set();
  }
}

/** GET /api/preliquidaciones */
export async function listar(req, res, next) {
  try {
    const { especie, estado } = req.query;
    const filtros = {};
    if (especie) filtros.especie = especie;
    if (estado) filtros.estado = estado;
    const data = await PreliquidacionModel.listar(filtros);
    const perdidas = await idsConCorridaPerdida(data);
    res.json({ ok: true, data: data.map((p) => ({ ...p, corrida_perdida: perdidas.has(String(p.id)) })) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones */
export async function crear(req, res, next) {
  try {
    const { especie, ...datos } = req.body;
    const data = await PreliquidacionModel.crear(especie, datos, { por: quien(req) });
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/preliquidaciones/:id */
export async function obtener(req, res, next) {
  try {
    const data = await PreliquidacionModel.obtener(req.idPreliquidacion);
    const perdidas = await idsConCorridaPerdida([data]);
    res.json({ ok: true, data: { ...data, corrida_perdida: perdidas.has(String(data.id)) } });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/preliquidaciones/:id — tras congelar solo `servicio`. */
export async function actualizar(req, res, next) {
  try {
    const data = await PreliquidacionModel.actualizar(req.idPreliquidacion, req.body, { por: quien(req) });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/preliquidaciones/:id/corte — Body: { corte: "<ISO con desfase>" | null }
 *
 * Fija el cierre a mano (instante futuro, hasta 7 días después del automático) o, con `null`,
 * restablece la regla automática. Solo mientras la preliquidación está abierta y sin liquidar.
 */
export async function fijarCorte(req, res, next) {
  try {
    const data = await PreliquidacionModel.fijarCorte(req.idPreliquidacion, req.body.corte, { por: quien(req) });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/preliquidaciones/:id/gastos — Body: { filas: [...] } */
export async function guardarGastos(req, res, next) {
  try {
    const data = await PreliquidacionModel.guardarGastos(req.idPreliquidacion, req.body.filas);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/preliquidaciones/:id/recepciones — Body: { recepcion_ids: [...], permitir_anterior?: boolean }
 *
 * `permitir_anterior` deja entrar a una preliquidación ya liquidada una recepción con ingreso hasta 2 días
 * antes de su primer ingreso (no mueve fecha, corte ni ventana).
 *
 * Vincula a mano. Cada recepción se intenta por separado y se informa el resultado
 * de cada una: que una no entre (fuera de ventana, ya vinculada) no frena las demás.
 * Si NINGUNA entra se responde con el estado HTTP del primer error.
 */
export async function vincular(req, res, next) {
  try {
    const resultados = [];
    let primerError = null;
    for (const recepcionId of req.body.recepcion_ids) {
      try {
        const r = await PreliquidacionModel.vincularRecepcion(recepcionId, {
          preliquidacionId: req.idPreliquidacion,
          permitirAnterior: req.body.permitir_anterior === true,
        });
        resultados.push({ recepcion_id: recepcionId, ok: true, ...r });
      } catch (error) {
        // Un error inesperado (sin `expose`) no se oculta dentro de la lista.
        if (!error.expose) throw error;
        primerError = primerError || error;
        resultados.push({ recepcion_id: recepcionId, ok: false, codigo: error.codigo ?? null, error: error.message });
      }
    }
    if (primerError && resultados.every((r) => !r.ok)) {
      return next(primerError);
    }
    res.json({ ok: true, data: resultados });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/preliquidaciones/:id/sedes/:sedeId — solo sedes nunca enviadas. */
export async function desvincular(req, res, next) {
  try {
    const data = await PreliquidacionModel.desvincularSede(req.idSede, {
      preliquidacionId: req.idPreliquidacion,
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/preliquidaciones/:id/previsualizar — no escribe nada. */
export async function previsualizar(req, res, next) {
  try {
    res.json({ ok: true, data: await PreliquidacionModel.previsualizar(req.idPreliquidacion) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/preliquidaciones/:id/sedes/:sedeId/hoja — costeo corte por corte de una sede; no escribe nada. */
export async function hojaSede(req, res, next) {
  try {
    res.json({ ok: true, data: await PreliquidacionModel.hojaSede(req.idPreliquidacion, req.idSede) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/preliquidaciones/:id/retomas — solo cerdo. */
export async function obtenerRetomas(req, res, next) {
  try {
    res.json({ ok: true, data: await RetomasModel.obtenerRetomas(req.idPreliquidacion) });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/preliquidaciones/:id/retomas — solo cerdo y solo antes de congelar. */
export async function guardarRetomas(req, res, next) {
  try {
    res.json({ ok: true, data: await RetomasModel.guardarRetomas(req.idPreliquidacion, req.body) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/preliquidaciones/config/:especie */
export async function obtenerConfig(req, res, next) {
  try {
    res.json({ ok: true, data: await PreliquidacionModel.obtenerConfig(req.params.especie) });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/preliquidaciones/config/:especie — servicio por animal > 0. */
export async function guardarConfig(req, res, next) {
  try {
    res.json({ ok: true, data: await PreliquidacionModel.guardarConfig(req.params.especie, req.body) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones/:id/procesar — liquida y envía lo pendiente (origen admin). */
export async function procesar(req, res, next) {
  try {
    const data = await PreliquidacionModel.procesarAdmin(req.idPreliquidacion, { por: quien(req) });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones/sedes/:sedeId/procesar — recostea y envía UNA sede. */
export async function procesarSede(req, res, next) {
  try {
    const data = await PreliquidacionModel.procesarSedeAdmin(req.idSede, { por: quien(req) });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones/:id/recalcular — cambios tras liquidar y recosteo de las sedes sin enviar. */
export async function recalcular(req, res, next) {
  try {
    const { cambios = {}, motivo = null } = req.body ?? {};
    const data = await PreliquidacionModel.recalcular(req.idPreliquidacion, { cambios, motivo }, { por: quien(req) });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/preliquidaciones/sedes/:sedeId/anular — Body: { confirmado_en_siesa: true, motivo? }.
 * El admin confirma que la entrada oficial ya se anuló a mano en SIESA (REQ-F2); idempotente (F-S3).
 */
export async function anularSede(req, res, next) {
  try {
    const { motivo = null } = req.body ?? {};
    res.json({ ok: true, data: await CorreccionesModel.anularSede(req.idSede, { por: quien(req), motivo }) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones/sedes/:sedeId/descartar-correccion — Body: { motivo }. */
export async function descartarCorreccion(req, res, next) {
  try {
    const { motivo } = req.body;
    res.json({ ok: true, data: await CorreccionesModel.descartarCorreccion(req.idSede, { por: quien(req), motivo }) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/preliquidaciones/saldos?especie=&estado= — saldos pendientes y banner (por defecto solo pendientes). */
export async function listarSaldos(req, res, next) {
  try {
    res.json({ ok: true, data: await SaldosModel.listarSaldos(req.datosValidados ?? {}) });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/preliquidaciones/saldos/:saldoId — Body: UNA de { valor } | { descartar: true } | { destino_id }. */
export async function actualizarSaldo(req, res, next) {
  try {
    res.json({ ok: true, data: await SaldosModel.actualizarSaldo(req.idSaldo, req.body, { por: quien(req) }) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones/:id/anular — Body: { motivo }. Solo si nada salió a SIESA (R12). */
export async function anular(req, res, next) {
  try {
    const { motivo } = req.body;
    res.json({ ok: true, data: await CorreccionesModel.anularPreliquidacion(req.idPreliquidacion, { por: quien(req), motivo }) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/preliquidaciones/sedes/:sedeId/omitir-inicial — sin cuerpo.
 * Un admin decide que la recepción de la sede NO manda la CEA inicial: solo sale la oficial (sql/044).
 * Idempotente. 409 si la recepción ya tiene una inicial vigente o la oficial de la sede ya salió.
 */
export async function omitirInicialSede(req, res, next) {
  try {
    res.json({ ok: true, data: await InicialModel.omitirInicialSede(req.idSede, { por: quien(req) }) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/preliquidaciones/:id/omitir-inicial — lo mismo para todas las sedes de la preliquidación
 * cuya recepción no tiene una inicial ok. Cada sede se intenta por separado y se informa el resultado
 * de cada una (`resultados`): que una se rechace no frena las demás.
 */
export async function omitirInicialPreliquidacion(req, res, next) {
  try {
    res.json({ ok: true, data: await InicialModel.omitirInicialPreliquidacion(req.idPreliquidacion, { por: quien(req) }) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones/:id/cerrar — cierre manual. */
export async function cerrar(req, res, next) {
  try {
    const data = await PreliquidacionModel.cerrar(req.idPreliquidacion);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
