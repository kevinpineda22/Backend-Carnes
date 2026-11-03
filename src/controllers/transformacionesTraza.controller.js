import * as Traza from "../models/SpsTransformacionTraza.model.js";
import {
  JOBS,
  armarDetalleNegativos,
  armarPaginacion,
  githubDeCorrida,
  limitarDocumentos,
  normalizarFiltrosEjecuciones,
  normalizarFiltrosNegativos,
} from "../shared/transformacionesTraza.js";
import { createError } from "../middleware/errorHandler.js";

const COLUMNAS_GITHUB = ["github_run_id", "github_run_attempt", "github_job", "github_run_url"];

/** Reemplaza las columnas github_* planas por un bloque `github` con `url` nullable. */
function conBloqueGithub(corrida) {
  const resto = { ...corrida };
  for (const c of COLUMNAS_GITHUB) delete resto[c];
  return { ...resto, github: githubDeCorrida(corrida) };
}

/** GET /api/transformaciones/ejecuciones — historial paginado de un job (solo conteos de alertas). */
export async function listarEjecuciones(req, res, next) {
  try {
    const filtros = normalizarFiltrosEjecuciones(req.query);
    const { data, total } = await Traza.listarEjecuciones(filtros);
    res.json({
      ok: true,
      data: data.map(conBloqueGithub),
      paginacion: armarPaginacion(filtros.pagina, filtros.por_pagina, total),
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/transformaciones/ejecuciones/:job/:id — corrida con alertas completas y sus documentos. */
export async function obtenerEjecucion(req, res, next) {
  try {
    const job = String(req.params.job || "").toLowerCase();
    if (!JOBS.includes(job)) throw createError(400, `job debe ser uno de: ${JOBS.join(", ")}.`);
    const corrida = await Traza.obtenerEjecucion(job, req.params.id);
    const docs = await Traza.documentosDeEjecucion(job, corrida);

    if (job === "tocino") {
      const { items, truncado } = limitarDocumentos(docs);
      return res.json({ ok: true, job, corrida: conBloqueGithub(corrida), truncado, documentos: items });
    }

    // Negativos: documentos por tienda (tabla nueva) + historial por destino (tabla anterior).
    const legado = limitarDocumentos(docs.legado);
    const tiendas = limitarDocumentos(docs.tiendas);
    const truncado = legado.truncado || tiendas.truncado;
    const detalle = armarDetalleNegativos({ tiendas: tiendas.items, legado: legado.items, truncado: legado.truncado });
    return res.json({ ok: true, job, corrida: conBloqueGithub(corrida), truncado, ...detalle });
  } catch (error) {
    next(error);
  }
}

/** GET /api/transformaciones/negativos — documentos de negativos paginados. */
export async function listarNegativos(req, res, next) {
  try {
    const filtros = normalizarFiltrosNegativos(req.query);
    const { data, total } = await Traza.listarNegativos(filtros);
    res.json({
      ok: true,
      data,
      paginacion: armarPaginacion(filtros.pagina, filtros.por_pagina, total),
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/transformaciones/negativos/:id — con payload y respuesta completos. */
export async function obtenerNegativo(req, res, next) {
  try {
    const data = await Traza.obtenerNegativo(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/transformaciones/negativos/tienda/:id — documento por tienda con payload y respuesta. */
export async function obtenerNegativoTienda(req, res, next) {
  try {
    const data = await Traza.obtenerNegativoTienda(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
