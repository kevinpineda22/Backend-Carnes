import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { resultadoAError } from "./Preliquidacion.model.js";

/**
 * Oficial sin inicial (sql/044).
 *
 * Normalmente la recepción manda una CEA inicial provisional al cerrarse y la preliquidación manda
 * después la oficial completa. Para algunas recepciones el negocio decide NO mandar la inicial: solo
 * sale la oficial. Aquí un admin lo decide, de forma explícita y auditada (`inicial_omitida_at` y
 * `inicial_omitida_por` en la recepción).
 *
 * Las reglas que dependen del estado de la base (inicial vigente, oficial ya enviada, sede anulada o
 * bloqueada, idempotencia) las decide la RPC `carnes_preliq_omitir_inicial` bajo lock. Este módulo solo
 * la llama, y en el caso masivo recorre las sedes que el admin indicó. Jamás llama a SIESA.
 */

const T_PRELIQ = "carnes_preliquidaciones";
const T_SEDES = "carnes_preliquidacion_sedes";
const T_ENVIOS = "carnes_siesa_envios";

async function llamarRpc(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args);
  if (error) throw new Error(`Error en ${nombre}: ${error.message}`);
  return data;
}

async function leerSede(sedeId) {
  const { data, error } = await supabase
    .from(T_SEDES)
    .select("id, preliquidacion_id, recepcion_id")
    .eq("id", sedeId)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la sede: ${error.message}`);
  return data;
}

/**
 * Omite la CEA inicial de la recepción de UNA sede.
 *
 * Idempotente: si ya estaba omitida responde `ya_omitida` sin error. Rechaza con 409
 * (`inicial_vigente`) si la recepción ya tiene una inicial enviando, ok o sin_confirmar, y con 409
 * (`oficial_enviada`) si la oficial de la sede ya salió o va en vuelo, y con 409 (`sede_no_enviable`)
 * si la sede está anulada o bloqueada.
 *
 * @param {number|string} sedeId
 * @param {{por?: string|null, preliquidacionId?: number|string|null}} [datos]
 * @returns {Promise<{resultado: "ok"|"ya_omitida", sede_id: number, recepcion_id: number, preliquidacion_id: number}>}
 */
export async function omitirInicialSede(sedeId, { por = null, preliquidacionId = null } = {}) {
  const sede = await leerSede(sedeId);
  // Una sede que no es de la preliquidación de la URL se trata como inexistente.
  if (!sede || (preliquidacionId && String(sede.preliquidacion_id) !== String(preliquidacionId))) {
    throw resultadoAError({ resultado: "no_encontrada" });
  }
  const respuesta = await llamarRpc("carnes_preliq_omitir_inicial", { p_sede_id: sede.id, p_por: por });
  const error = resultadoAError(respuesta);
  if (error) throw error;
  return {
    resultado: respuesta.resultado,
    sede_id: sede.id,
    recepcion_id: sede.recepcion_id,
    preliquidacion_id: sede.preliquidacion_id,
  };
}

/**
 * Omite la CEA inicial de las sedes INDICADAS de la preliquidación (`sedeIds`, obligatorio y no vacío):
 * no se omite nada que no esté listado. Cada sede se intenta por separado y se informa el resultado de
 * cada una: que una se rechace (no pertenece a la preliquidación, anulada o bloqueada, inicial en curso,
 * oficial ya enviada) no frena las demás. Las sedes con la inicial ya `ok` se saltan: esa inicial ya
 * está en SIESA y a esas les corresponde el flujo normal (anular la inicial al salir la oficial).
 *
 * @param {number|string} preliquidacionId
 * @param {{por?: string|null, sedeIds: Array<number|string>}} datos
 */
export async function omitirInicialPreliquidacion(preliquidacionId, { por = null, sedeIds } = {}) {
  const pedidas = [...new Set((Array.isArray(sedeIds) ? sedeIds : []).map(String))];
  if (!pedidas.length) throw createError(400, "Indique las sedes a las que se les omite la inicial (sede_ids).");

  const { data: cabecera, error: errorCabecera } = await supabase
    .from(T_PRELIQ)
    .select("id, estado")
    .eq("id", preliquidacionId)
    .maybeSingle();
  if (errorCabecera) throw new Error(`Error al leer la preliquidación: ${errorCabecera.message}`);
  if (!cabecera) throw resultadoAError({ resultado: "no_encontrada" });
  if (cabecera.estado !== "abierta") throw resultadoAError({ resultado: "no_abierta" });

  const { data: sedes, error: errorSedes } = await supabase
    .from(T_SEDES)
    .select("id, recepcion_id")
    .eq("preliquidacion_id", preliquidacionId)
    .order("id");
  if (errorSedes) throw new Error(`Error al leer las sedes: ${errorSedes.message}`);

  const delaPreliquidacion = new Map((sedes ?? []).map((s) => [String(s.id), s]));
  const aProcesar = pedidas.map((id) => delaPreliquidacion.get(id) ?? { id: Number(id), noPertenece: true });

  const recepcionIds = aProcesar.filter((s) => !s.noPertenece).map((s) => s.recepcion_id);
  let conInicialOk = new Set();
  if (recepcionIds.length) {
    const { data: envios, error: errorEnvios } = await supabase
      .from(T_ENVIOS)
      .select("recepcion_id")
      .eq("tipo", "inicial")
      .eq("estado", "ok")
      .in("recepcion_id", recepcionIds);
    if (errorEnvios) throw new Error(`Error al leer los envíos: ${errorEnvios.message}`);
    conInicialOk = new Set((envios ?? []).map((e) => String(e.recepcion_id)));
  }

  const resultados = [];
  for (const sede of aProcesar) {
    if (sede.noPertenece) {
      const e = resultadoAError({ resultado: "no_pertenece" });
      resultados.push({ sede_id: sede.id, recepcion_id: null, ok: false, codigo: "no_pertenece", error: e.message });
      continue;
    }
    const base = { sede_id: sede.id, recepcion_id: sede.recepcion_id };
    if (conInicialOk.has(String(sede.recepcion_id))) {
      resultados.push({ ...base, ok: true, resultado: "saltada", motivo: "inicial_ok" });
      continue;
    }
    try {
      const r = await omitirInicialSede(sede.id, { por, preliquidacionId });
      resultados.push({ ...base, ok: true, resultado: r.resultado });
    } catch (error) {
      // Un error inesperado (sin `expose`) no se oculta dentro de la lista.
      if (!error.expose) throw error;
      resultados.push({ ...base, ok: false, codigo: error.codigo ?? null, error: error.message });
    }
  }

  const cuenta = (fn) => resultados.filter(fn).length;
  return {
    preliquidacion_id: cabecera.id,
    resultados,
    resumen: {
      omitidas: cuenta((r) => r.resultado === "ok"),
      ya_omitidas: cuenta((r) => r.resultado === "ya_omitida"),
      saltadas: cuenta((r) => r.resultado === "saltada"),
      rechazadas: cuenta((r) => r.ok === false),
    },
  };
}
