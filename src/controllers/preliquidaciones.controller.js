import * as PreliquidacionModel from "../models/Preliquidacion.model.js";
import * as RetomasModel from "../models/PreliquidacionRetomas.model.js";
import { conQuienHace } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";
import { avisarAuthRequerida, motivoApagado } from "../config/preliquidacion.js";
import { revisarCorridasPerdidas } from "../models/PreliquidacionVigilancia.model.js";

/** Quién hace la acción (correo del usuario autenticado cuando `CARNES_AUTH` lo exige). */
const quien = (req) => conQuienHace(req, {}, "por").por ?? null;

/**
 * Con el interruptor apagado NINGUNA escritura de /preliquidaciones procede (crear,
 * configurar, editar, gastos, retomas, vincular, desvincular). Solo quedan las lecturas.
 * El router lo aplica a todo método que no sea GET (ver `exigirEscrituraHabilitada`);
 * no depende de `CARNES_AUTH`, que hoy puede estar en `off`.
 */
function exigirEncendida() {
  const motivo = motivoApagado();
  if (motivo === "auth_requerida") {
    avisarAuthRequerida();
    throw createError(
      503,
      "La preliquidación requiere autenticación exigida en producción (CARNES_AUTH=exigir).",
      "auth_requerida",
    );
  }
  if (motivo) {
    throw createError(
      409,
      "La preliquidación de talleres está apagada (CARNES_PRELIQUIDACION).",
      "preliquidacion_apagada",
    );
  }
}

/** Middleware: con el interruptor apagado corta toda escritura con 409, antes de validar y de tocar la base. */
export function exigirEscrituraHabilitada(req, _res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  try {
    exigirEncendida();
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
 * POST /api/preliquidaciones/:id/recepciones — Body: { recepcion_ids: [...] }
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
        });
        resultados.push({ recepcion_id: recepcionId, ok: true, ...r });
      } catch (error) {
        // Un error inesperado (sin `expose`) no se oculta dentro de la lista.
        if (!error.expose) throw error;
        primerError = primerError || error;
        resultados.push({ recepcion_id: recepcionId, ok: false, codigo: error.codigo ?? null, error: error.message });
      }
    }
    if (primerError && resultados.every((r) => !r.ok)) return next(primerError);
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
