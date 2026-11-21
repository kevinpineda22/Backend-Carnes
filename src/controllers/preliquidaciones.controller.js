import * as PreliquidacionModel from "../models/Preliquidacion.model.js";
import { conQuienHace } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";
import { preliquidacionHabilitada } from "../config/preliquidacion.js";

/** Quién hace la acción (correo del usuario autenticado cuando `CARNES_AUTH` lo exige). */
const quien = (req) => conQuienHace(req, {}, "por").por ?? null;

/**
 * Con el interruptor apagado no se crean preliquidaciones ni se vincula nada nuevo.
 * Todo lo demás (lectura, configuración, desvincular) sigue disponible para poder
 * preparar el despliegue y para sacar lo ya vinculado.
 */
function exigirEncendida() {
  if (!preliquidacionHabilitada()) {
    throw createError(
      409,
      "La preliquidación de talleres está apagada (CARNES_PRELIQUIDACION).",
      "preliquidacion_apagada",
    );
  }
}

/** GET /api/preliquidaciones */
export async function listar(req, res, next) {
  try {
    const { especie, estado } = req.query;
    const filtros = {};
    if (especie) filtros.especie = especie;
    if (estado) filtros.estado = estado;
    res.json({ ok: true, data: await PreliquidacionModel.listar(filtros) });
  } catch (error) {
    next(error);
  }
}

/** POST /api/preliquidaciones */
export async function crear(req, res, next) {
  try {
    exigirEncendida();
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
    res.json({ ok: true, data: await PreliquidacionModel.obtener(req.idPreliquidacion) });
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
    exigirEncendida();
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
