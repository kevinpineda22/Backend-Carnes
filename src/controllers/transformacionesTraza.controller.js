import * as Traza from "../models/SpsTransformacionTraza.model.js";
import {
  JOBS,
  agruparNegativosPorDestino,
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

function sinRespuesta({ respuesta: _respuesta, ...fila }) {
  return fila;
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
    const filas = await Traza.documentosDeEjecucion(job, corrida);
    const { items, truncado } = limitarDocumentos(filas);

    const base = { ok: true, job, corrida: conBloqueGithub(corrida), truncado };
    if (job === "tocino") return res.json({ ...base, documentos: items });

    // PLAN_INCOMPLETO se deriva de respuesta->plan; la respuesta en sí no sale en el detalle.
    const destinos = agruparNegativosPorDestino(
      items.map(({ plan, ...f }) => ({ ...f, respuesta: plan ? { plan } : null })),
      { truncado },
    ).map((d) => ({
      ...d,
      cei: d.cei && sinRespuesta(d.cei),
      csas: d.csas.map(sinRespuesta),
    }));
    return res.json({ ...base, destinos });
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
