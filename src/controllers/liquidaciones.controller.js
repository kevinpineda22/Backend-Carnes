import * as LiquidacionModel from "../models/Liquidacion.model.js";

/** POST /api/liquidaciones */
export async function crear(req, res, next) {
  try {
    const data = await LiquidacionModel.crear(req.body);
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/liquidaciones */
export async function listar(req, res, next) {
  try {
    const data = await LiquidacionModel.listar(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/liquidaciones/:id — cabecera, gastos y recepciones con sus renglones. */
export async function obtener(req, res, next) {
  try {
    const data = await LiquidacionModel.obtener(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/liquidaciones/:id */
export async function actualizar(req, res, next) {
  try {
    const data = await LiquidacionModel.actualizar(req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/liquidaciones/:id/gastos — Body: { filas: [...] } */
export async function guardarGastos(req, res, next) {
  try {
    const data = await LiquidacionModel.guardarGastos(req.params.id, req.body.filas);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/liquidaciones/:id/recepciones — Body: { recepcion_ids: [] } */
export async function vincular(req, res, next) {
  try {
    const data = await LiquidacionModel.vincular(req.params.id, req.body.recepcion_ids);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/liquidaciones/:id/recepciones/:recepcionId */
export async function desvincular(req, res, next) {
  try {
    const data = await LiquidacionModel.desvincular(req.params.id, req.params.recepcionId);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/liquidaciones/:id/previsualizar
 *
 * El "así va a quedar": corre el consolidado sin escribir nada. Devuelve además
 * `cierre.bloqueos`, para que el panel pueda deshabilitar el botón de costear y
 * decir POR QUÉ, en vez de dejar que el admin lo apriete y reciba un error.
 */
export async function previsualizar(req, res, next) {
  try {
    const data = await LiquidacionModel.previsualizar(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/liquidaciones/:id/costear
 *
 * Congela los costos y pasa todo a "Costeado".
 */
export async function costear(req, res, next) {
  try {
    const data = await LiquidacionModel.costear(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    // Los bloqueos viajan enumerados: "todavía no se puede costear" sin decir
    // cuál de los seis motivos es deja al admin probando a ciegas.
    if (error.bloqueos) {
      return res.status(409).json({ ok: false, error: error.message, bloqueos: error.bloqueos });
    }
    next(error);
  }
}

/** POST /api/liquidaciones/:id/reabrir — Costeada → Abierta. */
export async function reabrir(req, res, next) {
  try {
    const data = await LiquidacionModel.reabrir(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}
