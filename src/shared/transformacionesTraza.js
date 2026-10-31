/**
 * Trazabilidad de las transformaciones (historial de ejecuciones y documentos).
 *
 * Es pura y no toca la base: valida el query string, calcula rangos de paginación y
 * deriva estructuras de lectura (agrupación por destino, bloque de GitHub, conteos).
 * Si algo no es válido lanza un error 400 (`createError`).
 */
import { createError } from "../middleware/errorHandler.js";
import { ENTORNOS, TIPOS_DTO } from "./transformacionesFiltros.js";

export const JOBS = ["tocino", "negativos"];
export const ESTADOS_NEGATIVOS = ["PLANNED", "SENDING", "OK", "ERROR", "AMBIGUO", "CANCELADO"];
export const POR_PAGINA_EJECUCIONES = { defecto: 50, maximo: 200 };
export const POR_PAGINA_NEGATIVOS = { defecto: 100, maximo: 500 };
export const LIMITE_DOCUMENTOS_DETALLE = 1000;
export const PAGINA_MAXIMA = 1000000;

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function escalar(valor) {
  return Array.isArray(valor) ? valor[0] : valor;
}

function textoOpcional(valor) {
  const v = escalar(valor);
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  return t === "" ? undefined : t;
}

function fechaOpcional(valor, nombre) {
  const t = textoOpcional(valor);
  if (t === undefined) return undefined;
  const d = FECHA_ISO.test(t) ? new Date(`${t}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t)
    throw createError(400, `${nombre} debe tener el formato AAAA-MM-DD.`);
  return t;
}

function opcionDeLista(valor, lista, nombre) {
  const t = textoOpcional(valor);
  if (t === undefined) return undefined;
  const normalizado = t.toUpperCase();
  if (!lista.includes(normalizado))
    throw createError(400, `${nombre} debe ser uno de: ${lista.join(", ")}.`);
  return normalizado;
}

function enteroOpcional(valor, nombre) {
  const t = textoOpcional(valor);
  if (t === undefined) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) throw createError(400, `${nombre} debe ser un número.`);
  if (!Number.isInteger(n)) throw createError(400, `${nombre} debe ser un número entero.`);
  return n;
}

function ventanaYEntorno(q) {
  const entorno = opcionDeLista(q.entorno, ENTORNOS, "entorno") ?? "PROD";
  const fecha_desde = fechaOpcional(q.fecha_desde, "fecha_desde");
  const fecha_hasta = fechaOpcional(q.fecha_hasta, "fecha_hasta");
  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta)
    throw createError(400, "fecha_desde no puede ser posterior a fecha_hasta.");
  const base = { entorno };
  if (fecha_desde) base.fecha_desde = fecha_desde;
  if (fecha_hasta) base.fecha_hasta = fecha_hasta;
  return base;
}

function paginacionDeQuery(q, { defecto, maximo }) {
  const pagina = enteroOpcional(q.pagina, "pagina") ?? 1;
  if (pagina < 1 || pagina > PAGINA_MAXIMA)
    throw createError(400, `pagina debe ser un entero entre 1 y ${PAGINA_MAXIMA}.`);
  const bruto = enteroOpcional(q.por_pagina, "por_pagina");
  const por_pagina = bruto === undefined ? defecto : Math.min(Math.max(bruto, 1), maximo);
  return { pagina, por_pagina };
}

/**
 * Filtros del historial de ejecuciones. El único filtro de corrida es `entorno`
 * (PROD por defecto, QA solo si se pide); las corridas dry-run no se persisten.
 */
export function normalizarFiltrosEjecuciones(query = {}) {
  const q = query || {};
  const job = (textoOpcional(q.job) || "").toLowerCase();
  if (!JOBS.includes(job)) throw createError(400, `job debe ser uno de: ${JOBS.join(", ")}.`);
  return {
    job,
    ...ventanaYEntorno(q),
    ...paginacionDeQuery(q, POR_PAGINA_EJECUCIONES),
  };
}

/** Filtros del listado de documentos de negativos. */
export function normalizarFiltrosNegativos(query = {}) {
  const q = query || {};
  const filtros = { ...ventanaYEntorno(q), ...paginacionDeQuery(q, POR_PAGINA_NEGATIVOS) };
  const status = opcionDeLista(q.status, ESTADOS_NEGATIVOS, "status");
  const tipo_dto = opcionDeLista(q.tipo_dto, TIPOS_DTO, "tipo_dto");
  const co = textoOpcional(q.co);
  if (status) filtros.status = status;
  if (tipo_dto) filtros.tipo_dto = tipo_dto;
  if (co) filtros.co = co;
  return filtros;
}

/** Rango inclusivo (base 0) para `.range(desde, hasta)` de Supabase. */
export function rangoDePagina(pagina, por_pagina) {
  const desde = (pagina - 1) * por_pagina;
  return { desde, hasta: desde + por_pagina - 1 };
}

/** PostgREST responde 416 / PGRST103 cuando el rango pedido está más allá del total. */
export function esPaginaFueraDeRango(error) {
  return !!error && (error.code === "PGRST103" || error.status === 416);
}

export function armarPaginacion(pagina, por_pagina, total) {
  return { pagina, por_pagina, total: Number.isFinite(total) ? total : 0 };
}

/** Solo se exponen enlaces https hacia github.com. */
function esUrlGithub(valor) {
  if (typeof valor !== "string") return false;
  try {
    const u = new URL(valor);
    return u.protocol === "https:" && u.hostname === "github.com";
  } catch {
    return false;
  }
}

/** Bloque de GitHub de una corrida; `url` es null en corridas previas a la migración 009. */
export function githubDeCorrida(corrida) {
  const c = corrida || {};
  const url = esUrlGithub(c.github_run_url) ? c.github_run_url : null;
  return {
    run_id: c.github_run_id ?? null,
    attempt: c.github_run_attempt ?? null,
    job: c.github_job ?? null,
    url,
  };
}

/** Solo los conteos de `alertas` (para el listado); null si la corrida no los tiene. */
export function conteosDeAlertas(alertas) {
  return alertas && typeof alertas === "object" && alertas.conteos && typeof alertas.conteos === "object"
    ? alertas.conteos
    : null;
}

const ESTADOS_ORDEN = ["AMBIGUO", "ERROR", "SENDING", "PLANNED", "CANCELADO"];

function estadoDeDestino(filas) {
  for (const e of ESTADOS_ORDEN) if (filas.some((f) => f.status === e)) return e;
  return "OK";
}

/**
 * Agrupa filas de `sps_transformaciones_negativos` por destino (co, bodega, item_destino).
 * Cada grupo trae su CEI, sus CSA, un estado derivado y `plan_incompleto` (boolean aparte):
 * el CEI declara más CSA planificadas (`respuesta.plan.csas_planificadas`) que las guardadas.
 *
 * `estado`: AMBIGUO > ERROR > PLAN_INCOMPLETO > SENDING > PLANNED > CANCELADO > OK. Así un
 * plan incompleto nunca oculta un AMBIGUO ni un ERROR.
 *
 * Con `truncado` (la lista se recortó al tope) el último grupo puede estar partido: se marca
 * `truncado: true` y nunca se declara plan_incompleto.
 */
export function agruparNegativosPorDestino(filas, { truncado = false } = {}) {
  const grupos = new Map();
  for (const f of Array.isArray(filas) ? filas : []) {
    const clave = `${f.co}|${f.bodega}|${f.item_destino}`;
    let g = grupos.get(clave);
    if (!g) {
      g = { co: f.co, bodega: f.bodega, item_destino: f.item_destino, cei: null, csas: [], _filas: [] };
      grupos.set(clave, g);
    }
    g._filas.push(f);
    if (f.tipo_dto === "CEI") g.cei = f;
    else g.csas.push(f);
  }
  const lista = [...grupos.values()];
  return lista.map(({ _filas, ...g }, i) => {
    const parcial = truncado && i === lista.length - 1;
    const esperado = g.cei?.respuesta?.plan?.csas_planificadas;
    const plan_incompleto = !parcial && Number.isInteger(esperado) && esperado !== g.csas.length;
    const base = estadoDeDestino(_filas);
    const estado = plan_incompleto && base !== "AMBIGUO" && base !== "ERROR" ? "PLAN_INCOMPLETO" : base;
    return { ...g, plan_incompleto, truncado: parcial, estado };
  });
}

/** Recorta a LIMITE_DOCUMENTOS_DETALLE y avisa si recortó. */
export function limitarDocumentos(filas, limite = LIMITE_DOCUMENTOS_DETALLE) {
  const lista = Array.isArray(filas) ? filas : [];
  return lista.length > limite
    ? { items: lista.slice(0, limite), truncado: true }
    : { items: lista, truncado: false };
}
