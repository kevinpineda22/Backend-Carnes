/**
 * Envíos a SIESA: cuándo se manda, qué se guarda, qué cambia de estado.
 *
 * Armar el documento es de `shared/siesaEntrada.js`. Hacer el POST es de
 * `services/siesa.service.js`. Acá está la política:
 *
 *   inicial  automática al cerrar la recepción. Best-effort: si falla, se
 *            registra el error y la recepción se cierra igual. El recibidor
 *            no puede quedar trabado en la cava porque SIESA no responde.
 *   oficial  la dispara el admin desde la liquidación costeada. Si sale bien
 *            para todas las sedes, las recepciones pasan a Enviado_SIESA, la
 *            liquidación a Cerrada, y sale el correo a quien anula la inicial.
 *            Si alguna falla, NO se cierra nada: se devuelve qué falló y el
 *            admin reintenta cuando lo arregle.
 *
 * Todo intento —bueno o malo— deja una fila en `carnes_siesa_envios`.
 */

import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { ESTADOS } from "../shared/estados.js";
import { armarEntradaDirecta, referenciaEnvio, TIPO_ENVIO } from "../shared/siesaEntrada.js";
import { documentoSiesa, siesaConfigurado, siesaActivo, faltantesSiesa } from "../config/siesa.js";
import { enviarASiesa } from "../services/siesa.service.js";
import { notificarAnularInicial } from "../services/notificaciones.service.js";

const TABLA = "carnes_siesa_envios";

/**
 * Consecutivo propio para enlazar cabecera y movimientos dentro de un envío.
 *
 * SIESA lo recalcula (`F_CONSEC_AUTO_REG = 1`), así que solo tiene que ser
 * consistente adentro del mismo JSON y caber en 8 dígitos. `id × 10 + tipo`
 * es único por recepción y tipo, y deja ver de un vistazo a qué recepción
 * pertenece.
 */
const consecutivoDe = (recepcionId, tipo) =>
  Number(recepcionId) * 10 + (tipo === TIPO_ENVIO.OFICIAL ? 2 : 1);

// ─── Lectura ───────────────────────────────────────────────────────────────

/** La recepción con su sede (incluida la bodega) y sus renglones. */
async function cargarRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select("*, sede:carnes_sedes ( id, codigo_co, nombre, bodega_siesa )")
    .eq("id", recepcionId)
    .maybeSingle();
  if (error) fallar(error, "Error al leer la recepción");
  if (!data) throw createError(404, "Recepción no encontrada.");

  const { data: items, error: e2 } = await supabase
    .from("carnes_recepcion_items")
    .select("*")
    .eq("recepcion_id", recepcionId)
    .order("tipo")
    .order("orden");
  if (e2) fallar(e2, "Error al leer los renglones");

  return { ...data, items: items || [] };
}

/** El último envío ok de un tipo para una recepción, o null. */
async function ultimoEnvio(recepcionId, tipo, soloOk = true) {
  let q = supabase
    .from(TABLA)
    .select("*")
    .eq("recepcion_id", recepcionId)
    .eq("tipo", tipo)
    .order("enviado_at", { ascending: false })
    .limit(1);
  if (soloOk) q = q.eq("estado", "ok");
  const { data, error } = await q.maybeSingle();
  if (error) fallar(error, "Error al leer el envío");
  return data || null;
}

function esMigracionFaltante(error) {
  const codigo = error?.code || "";
  const mensaje = String(error?.message || "");
  return (
    ["42P01", "42703", "PGRST204", "PGRST205"].includes(codigo) ||
    /(relation|column|table).*(does not exist|not found)/i.test(mensaje) ||
    /schema cache/i.test(mensaje)
  );
}

function fallar(error, contexto) {
  if (esMigracionFaltante(error)) {
    throw createError(
      503,
      "A la base le falta el módulo de SIESA. Corré sql/007_siesa.sql en Supabase y volvé a intentar.",
    );
  }
  throw new Error(`${contexto}: ${error.message}`);
}

/**
 * GET — listado para el panel de trazabilidad.
 * @param {{tipo?, estado?, recepcion_id?, liquidacion_id?, limite?}} f
 */
export async function listar(f = {}) {
  let q = supabase
    .from(TABLA)
    .select(
      "id, recepcion_id, liquidacion_id, tipo, estado, referencia, consecutivo, tipo_docto, " +
        "http_status, error, renglones, total_kilos, total_valor, enviado_por, enviado_at, aviso_anulacion, " +
        "recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) )",
    )
    .order("enviado_at", { ascending: false })
    .limit(Math.min(Number(f.limite) || 100, 500));
  if (f.tipo) q = q.eq("tipo", f.tipo);
  if (f.estado) q = q.eq("estado", f.estado);
  if (f.recepcion_id) q = q.eq("recepcion_id", f.recepcion_id);
  if (f.liquidacion_id) q = q.eq("liquidacion_id", f.liquidacion_id);

  const { data, error } = await q;
  if (error) fallar(error, "Error al listar envíos");
  return data || [];
}

/** GET — un envío con el payload y la respuesta completos. */
export async function obtener(id) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*, recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) )")
    .eq("id", id)
    .maybeSingle();
  if (error) fallar(error, "Error al leer el envío");
  if (!data) throw createError(404, "Envío no encontrado.");

  // El payload lleva el código del ítem y nada más: es lo que SIESA necesita.
  // Para la pantalla se le pega la descripción y el precio unitario desde los
  // renglones de la recepción, así el admin lee "TABLA · 14,19 kg × $27.588"
  // y no "15197 · 14.1900 · 391470.0000".
  const { data: items } = await supabase
    .from("carnes_recepcion_items")
    .select("codigo_item, descripcion")
    .eq("recepcion_id", data.recepcion_id);
  const nombre = new Map((items || []).map((i) => [String(i.codigo_item ?? "").trim(), i.descripcion]));

  const movimientos = (data.payload?.Movimientos || []).map((m) => {
    const cantidad = Number(m.CANTIDAD) || 0;
    const bruto = Number(m.VALOR_BRUTO) || 0;
    return {
      ...m,
      descripcion: nombre.get(String(m.ITEM)) || null,
      cantidad,
      valor_bruto: bruto,
      precio_unitario: cantidad > 0 ? Math.round((bruto / cantidad) * 100) / 100 : null,
    };
  });

  return { ...data, movimientos };
}

// ─── El envío en sí ────────────────────────────────────────────────────────

/**
 * Arma, manda (si hay credenciales) y registra. No lanza por SIESA: devuelve
 * la fila guardada, con `estado` ok o error.
 */
async function ejecutarEnvio({ recepcion, tipo, liquidacionId = null, por, referenciaInicial }) {
  const consecutivo = consecutivoDe(recepcion.id, tipo);
  const { payload, resumen, bloqueos } = armarEntradaDirecta({
    recepcion,
    items: recepcion.items,
    tipo,
    consecutivo,
    config: documentoSiesa(),
    referenciaInicial,
  });

  let resultado;
  if (bloqueos.length) {
    resultado = { ok: false, status: null, respuesta: null, error: bloqueos.join(" ") };
  } else if (!siesaConfigurado()) {
    resultado = {
      ok: false,
      status: null,
      respuesta: null,
      error: `SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`,
    };
  } else {
    resultado = await enviarASiesa(payload);
  }

  const fila = {
    recepcion_id: recepcion.id,
    liquidacion_id: liquidacionId,
    tipo,
    estado: resultado.ok ? "ok" : "error",
    referencia: resumen.referencia,
    consecutivo,
    tipo_docto: payload.Documentos[0]?.TIPO_DOCTO || null,
    payload,
    respuesta: resultado.respuesta,
    http_status: resultado.status,
    error: resultado.error,
    renglones: resumen.renglones,
    total_kilos: resumen.totalKilos,
    total_valor: resumen.totalValor,
    enviado_por: por || null,
  };

  const { data, error } = await supabase.from(TABLA).insert(fila).select("*").single();
  if (error) fallar(error, "No se pudo registrar el envío");

  if (!resultado.ok) {
    console.error(`🔴 SIESA ${tipo} recepción #${recepcion.id}: ${resultado.error}`);
  }
  return data;
}

/**
 * Entrada INICIAL. Se llama al cerrar la recepción. Nunca lanza: si falla, la
 * fila queda con el error y se devuelve igual.
 */
export async function enviarInicial(recepcionId, por) {
  // Apagado: no se manda ni se registra. Registrar cada cierre como "error"
  // mientras el interruptor está en off llenaría el panel de filas que no
  // significan nada.
  if (!siesaActivo()) {
    return { estado: "apagado", tipo: TIPO_ENVIO.INICIAL, recepcion_id: recepcionId };
  }
  try {
    const recepcion = await cargarRecepcion(recepcionId);
    // Si ya hay una inicial ok, no se manda otra: SIESA tendría dos documentos
    // en elaboración de la misma carne y el que anula no sabría cuál.
    const previa = await ultimoEnvio(recepcionId, TIPO_ENVIO.INICIAL);
    if (previa) return { ...previa, repetido: true };

    return await ejecutarEnvio({ recepcion, tipo: TIPO_ENVIO.INICIAL, por });
  } catch (e) {
    console.error(`🔴 SIESA inicial recepción #${recepcionId}: ${e.message}`);
    return { estado: "error", error: e.message, tipo: TIPO_ENVIO.INICIAL, recepcion_id: recepcionId };
  }
}

/** Reintento manual de la inicial, desde el panel. Sí lanza si no se puede. */
export async function reintentarInicial(recepcionId, por) {
  if (!siesaActivo()) {
    throw createError(409, "El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).");
  }
  const recepcion = await cargarRecepcion(recepcionId);
  if (![ESTADOS.RECIBIDO, ESTADOS.APROBADO, ESTADOS.COSTEADO].includes(recepcion.estado)) {
    throw createError(409, `La recepción está en ${recepcion.estado}: la inicial ya no aplica.`);
  }
  const previa = await ultimoEnvio(recepcionId, TIPO_ENVIO.INICIAL);
  if (previa) throw createError(409, `Esta recepción ya tiene una entrada inicial ok (${previa.referencia}).`);
  return ejecutarEnvio({ recepcion, tipo: TIPO_ENVIO.INICIAL, por });
}

/**
 * Qué pasaría al enviar la oficial, sin mandar nada. Para que el botón del
 * panel pueda decir "no se puede, por esto" antes de apretarlo.
 */
export async function previsualizarOficial(liquidacionId) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado, especie")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallar(error, "Error al leer la liquidación");
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { data: recs, error: e2 } = await supabase
    .from("carnes_recepciones")
    .select("id")
    .eq("liquidacion_id", liquidacionId);
  if (e2) fallar(e2, "Error al leer las recepciones");

  const sedes = [];
  for (const { id } of recs || []) {
    const recepcion = await cargarRecepcion(id);
    const inicial = await ultimoEnvio(id, TIPO_ENVIO.INICIAL);
    const oficial = await ultimoEnvio(id, TIPO_ENVIO.OFICIAL);
    const { resumen, bloqueos } = armarEntradaDirecta({
      recepcion,
      items: recepcion.items,
      tipo: TIPO_ENVIO.OFICIAL,
      consecutivo: consecutivoDe(id, TIPO_ENVIO.OFICIAL),
      config: documentoSiesa(),
      referenciaInicial: inicial?.referencia,
    });
    sedes.push({
      recepcion_id: id,
      sede: recepcion.sede?.nombre,
      estado: recepcion.estado,
      yaEnviada: Boolean(oficial),
      inicial: inicial ? { referencia: inicial.referencia, enviado_at: inicial.enviado_at } : null,
      resumen,
      bloqueos,
    });
  }

  const configurado = siesaConfigurado();
  const bloqueosGlobales = [];
  if (liq.estado !== "Costeada" && liq.estado !== "Cerrada") {
    bloqueosGlobales.push("La liquidación tiene que estar costeada.");
  }
  if (!siesaActivo()) {
    bloqueosGlobales.push("El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).");
  }
  if (!configurado) bloqueosGlobales.push(`SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`);

  return {
    liquidacion: liq,
    configurado,
    bloqueos: bloqueosGlobales,
    sedes,
    puedeEnviar: bloqueosGlobales.length === 0 && sedes.some((s) => !s.yaEnviada && s.bloqueos.length === 0),
  };
}

/**
 * Entrada OFICIAL de todas las recepciones de una liquidación costeada.
 *
 * Manda una por sede. Las que ya tienen oficial ok se saltan (reintento
 * seguro). Si TODAS quedan ok → cierre: recepciones a Enviado_SIESA,
 * liquidación a Cerrada, correo a quien anula. Si alguna falla, no se cierra
 * nada y se devuelve el detalle.
 */
export async function enviarOficial(liquidacionId, por) {
  const previa = await previsualizarOficial(liquidacionId);
  if (previa.bloqueos.length) {
    throw createError(409, previa.bloqueos.join(" "));
  }

  const resultados = [];
  for (const s of previa.sedes) {
    if (s.yaEnviada) {
      resultados.push({ recepcion_id: s.recepcion_id, sede: s.sede, estado: "ok", repetido: true });
      continue;
    }
    if (s.bloqueos.length) {
      resultados.push({ recepcion_id: s.recepcion_id, sede: s.sede, estado: "error", error: s.bloqueos.join(" ") });
      continue;
    }
    const recepcion = await cargarRecepcion(s.recepcion_id);
    const inicial = await ultimoEnvio(s.recepcion_id, TIPO_ENVIO.INICIAL);
    const fila = await ejecutarEnvio({
      recepcion,
      tipo: TIPO_ENVIO.OFICIAL,
      liquidacionId,
      por,
      referenciaInicial: inicial?.referencia,
    });

    // El correo a quien anula sale por cada oficial que entró bien, y se anota
    // que salió. Si el correo falla, el envío sigue siendo ok — SIESA ya lo
    // tiene — pero queda `aviso_anulacion = false` para reenviarlo a mano.
    if (fila.estado === "ok") {
      const correo = await notificarAnularInicial(recepcion, inicial, fila);
      if (correo?.success) {
        await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", fila.id);
      }
    }
    resultados.push({
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      estado: fila.estado,
      error: fila.error,
      referencia: fila.referencia,
      envio_id: fila.id,
    });
  }

  const todasOk = resultados.every((r) => r.estado === "ok");
  if (todasOk) {
    const ahora = new Date().toISOString();
    const ids = resultados.map((r) => r.recepcion_id);
    const { error: e1 } = await supabase
      .from("carnes_recepciones")
      .update({ estado: ESTADOS.ENVIADO_SIESA, siesa_at: ahora })
      .in("id", ids)
      .neq("estado", ESTADOS.ENVIADO_SIESA);
    if (e1) fallar(e1, "No se pudo marcar las recepciones como enviadas");

    const { error: e2 } = await supabase
      .from("carnes_liquidaciones")
      .update({ estado: "Cerrada" })
      .eq("id", liquidacionId);
    if (e2) fallar(e2, "No se pudo cerrar la liquidación");
  }

  return { cerrada: todasOk, resultados };
}
