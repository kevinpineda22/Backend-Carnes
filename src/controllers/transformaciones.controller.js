import * as SpsTransformacion from "../models/SpsTransformacion.model.js";
import {
  normalizarFiltrosTransformaciones,
  ultimaCorridaPorFecha,
} from "../shared/transformacionesFiltros.js";

/** GET /api/transformaciones */
export async function listar(req, res, next) {
  try {
    const filtros = normalizarFiltrosTransformaciones(req.query);
    const data = await SpsTransformacion.listar(filtros);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/transformaciones/:id — con payload y respuesta completos. */
export async function obtener(req, res, next) {
  try {
    const data = await SpsTransformacion.obtener(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/transformaciones/corridas — última corrida por (entorno, fecha). */
export async function listarCorridas(req, res, next) {
  try {
    const { entorno, fecha_desde, fecha_hasta } = req.query || {};
    const filtros = normalizarFiltrosTransformaciones({ entorno, fecha_desde, fecha_hasta });
    const filas = await SpsTransformacion.listarCorridas(filtros);
    res.json({ ok: true, data: ultimaCorridaPorFecha(filas) });
  } catch (error) {
    next(error);
  }
}
