/**
 * Trazabilidad de transformaciones (historial de ejecuciones y documentos de negativos).
 *
 * SOLO LECTURA: otro proyecto escribe estas tablas. Requiere la migración 009 del
 * proyecto de sync (columnas github_* y alertas): se seleccionan de forma explícita, así
 * que sin la migración las consultas fallan. Aplicar 009 antes de desplegar.
 */
import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { LIMITE_DOCUMENTOS_DETALLE, esPaginaFueraDeRango, rangoDePagina } from "../shared/transformacionesTraza.js";

/** Registra la causa real en el servidor y lanza el 500 genérico (sin filtrar detalles al cliente). */
function fallaDb(error, contexto, mensaje) {
  console.error(`🔴 Trazabilidad de transformaciones, ${contexto}: [${error?.code ?? "sin código"}] ${error?.message}`);
  return createError(500, mensaje);
}

/** Total con los mismos filtros, sin traer filas (para páginas fuera de rango). */
async function contarFilas(tabla, filtrar) {
  const { count, error } = await filtrar(supabase.from(tabla).select("id", { count: "exact", head: true }));
  if (error) throw fallaDb(error, `contar ${tabla}`, "Error al listar los datos.");
  return count ?? 0;
}

const TABLAS_CORRIDAS = {
  tocino: "sps_transformaciones_corridas",
  negativos: "sps_transformaciones_negativos_corridas",
};
const TABLA_TOCINO = "sps_transformaciones";
const TABLA_NEGATIVOS = "sps_transformaciones_negativos";

const GITHUB = "github_run_id, github_run_attempt, github_job, github_run_url";

const COLUMNAS_CORRIDA = {
  tocino:
    "id, fecha, entorno, resultado, filas_vivo, filas_acum, filas_dia, grupos, unidades, " +
    "kilos, fallos, dias_disponibles, mensaje, origen, created_at, " +
    GITHUB,
  negativos:
    "id, fecha, entorno, resultado, destinos, documentos, omitidos, ambiguos, fallos, " +
    "mensaje, origen, created_at, " +
    GITHUB,
};

// Listado: sin dias_disponibles y con solo los conteos de `alertas` (las listas son pesadas).
const COLUMNAS_CORRIDA_LISTA = {
  tocino:
    COLUMNAS_CORRIDA.tocino.replace("dias_disponibles, ", "") + ", alertas_conteos:alertas->conteos",
  negativos: COLUMNAS_CORRIDA.negativos + ", alertas_conteos:alertas->conteos",
};

// Documentos sin `payload` ni `respuesta` (se piden por documento).
const COLUMNAS_DOC_NEGATIVOS =
  "id, entorno, fecha, co, bodega, item_destino, tipo_dto, item_origen, status, cantidad, " +
  "costo_unitario, um, disponible_snapshot, error, intentos, created_at, updated_at";
const COLUMNAS_DOC_TOCINO =
  "id, fecha, co, bodega, item_venta, tipo_dto, status, unidades_netas, cantidad, " +
  "error, intentos, entorno, created_at, updated_at";

/** GET — historial completo de corridas de un job (todas, no solo la última por día). */
export async function listarEjecuciones(filtros) {
  const { job, entorno, fecha_desde, fecha_hasta, pagina, por_pagina } = filtros;
  const { desde, hasta } = rangoDePagina(pagina, por_pagina);
  const filtrar = (q) => {
    q = q.eq("entorno", entorno);
    if (fecha_desde) q = q.gte("fecha", fecha_desde);
    if (fecha_hasta) q = q.lte("fecha", fecha_hasta);
    return q;
  };
  const tabla = TABLAS_CORRIDAS[job];
  const { data, error, count } = await filtrar(
    supabase.from(tabla).select(COLUMNAS_CORRIDA_LISTA[job], { count: "exact" }),
  )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(desde, hasta);
  if (esPaginaFueraDeRango(error)) return { data: [], total: await contarFilas(tabla, filtrar) };
  if (error) throw fallaDb(error, "listar ejecuciones", "Error al listar las ejecuciones.");
  return { data: data || [], total: count ?? 0 };
}

/** GET — una corrida con todas sus columnas de traza (alertas completas). */
export async function obtenerEjecucion(job, id) {
  const { data, error } = await supabase
    .from(TABLAS_CORRIDAS[job])
    .select(`${COLUMNAS_CORRIDA[job]}, alertas`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fallaDb(error, "leer ejecución", "Error al leer la ejecución.");
  if (!data) throw createError(404, "Ejecución no encontrada.");
  return data;
}

/**
 * GET — documentos de la fecha/entorno de una corrida (sin payload/respuesta). Pide uno más
 * que el tope para poder avisar el recorte.
 */
export async function documentosDeEjecucion(job, corrida) {
  const limite = LIMITE_DOCUMENTOS_DETALLE + 1;
  if (job === "tocino") {
    const { data, error } = await supabase
      .from(TABLA_TOCINO)
      .select(COLUMNAS_DOC_TOCINO)
      .eq("entorno", corrida.entorno)
      .eq("fecha", corrida.fecha)
      .order("co", { ascending: true })
      .order("bodega", { ascending: true })
      .order("item_venta", { ascending: true })
      .order("tipo_dto", { ascending: true })
      .order("id", { ascending: true })
      .limit(limite);
    if (error) throw fallaDb(error, "documentos de ejecución", "Error al leer los documentos de la ejecución.");
    return data || [];
  }
  // `plan` = respuesta->plan del CEI: permite detectar PLAN_INCOMPLETO sin traer la respuesta.
  const { data, error } = await supabase
    .from(TABLA_NEGATIVOS)
    .select(`${COLUMNAS_DOC_NEGATIVOS}, plan:respuesta->plan`)
    .eq("entorno", corrida.entorno)
    .eq("fecha", corrida.fecha)
    .order("co", { ascending: true })
    .order("bodega", { ascending: true })
    .order("item_destino", { ascending: true })
    .order("tipo_dto", { ascending: true })
    .order("item_origen", { ascending: true })
    .order("id", { ascending: true })
    .limit(limite);
  if (error) throw fallaDb(error, "documentos de ejecución", "Error al leer los documentos de la ejecución.");
  return data || [];
}

/** GET — listado paginado de documentos de negativos (sin payload/respuesta). */
export async function listarNegativos(filtros) {
  const { entorno, fecha_desde, fecha_hasta, status, tipo_dto, co, pagina, por_pagina } = filtros;
  const { desde, hasta } = rangoDePagina(pagina, por_pagina);
  const filtrar = (q) => {
    q = q.eq("entorno", entorno);
    if (fecha_desde) q = q.gte("fecha", fecha_desde);
    if (fecha_hasta) q = q.lte("fecha", fecha_hasta);
    if (status) q = q.eq("status", status);
    if (tipo_dto) q = q.eq("tipo_dto", tipo_dto);
    if (co) q = q.eq("co", co);
    return q;
  };
  const { data, error, count } = await filtrar(
    supabase.from(TABLA_NEGATIVOS).select(COLUMNAS_DOC_NEGATIVOS, { count: "exact" }),
  )
    .order("fecha", { ascending: false })
    .order("co", { ascending: true })
    .order("bodega", { ascending: true })
    .order("item_destino", { ascending: true })
    .order("tipo_dto", { ascending: true })
    .order("id", { ascending: true })
    .range(desde, hasta);
  if (esPaginaFueraDeRango(error)) return { data: [], total: await contarFilas(TABLA_NEGATIVOS, filtrar) };
  if (error) throw fallaDb(error, "listar negativos", "Error al listar los documentos de negativos.");
  return { data: data || [], total: count ?? 0 };
}

/** GET — un documento de negativos con payload y respuesta completos. */
export async function obtenerNegativo(id) {
  const { data, error } = await supabase.from(TABLA_NEGATIVOS).select("*").eq("id", id).maybeSingle();
  if (error) throw fallaDb(error, "leer negativo", "Error al leer el documento de negativos.");
  if (!data) throw createError(404, "Documento de negativos no encontrado.");
  return data;
}
