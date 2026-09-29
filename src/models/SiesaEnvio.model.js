/**
 * Envíos a SIESA: cuándo se manda, qué se guarda, qué cambia de estado.
 *
 * Armar el documento es de `shared/siesaEntrada.js`. Hacer el POST es de
 * `services/siesa.service.js`. Acá está la política:
 *
 *   inicial  automática al cerrar la recepción. Best-effort: si falla, se
 *            registra el error y la recepción se cierra igual. El recibidor
 *            no puede quedar trabado en la cava porque SIESA no responde.
 *   oficial  la dispara el admin desde la liquidación costeada. Es UNA CEA
 *            con los renglones de todas las sedes (sql/012). Si entra, las
 *            recepciones pasan a Enviado_SIESA, la liquidación a Cerrada, y
 *            sale un correo con todas las iniciales a anular. Si falla, no se
 *            cierra nada.
 *
 *            Antes era una CEA por sede. Esas filas quedan como historial, y
 *            si alguna sigue vigente bloquea la consolidada: mandar la
 *            consolidada encima de oficiales por sede duplicaría la carne.
 *
 *  ajuste_visceras
 *            las vísceras entran al inventario por un documento aparte (CEI,
 *            conector AJUSTE_INV_VISCERAS), UNO por recepción, y SIESA lo
 *            CONTABILIZA al importarlo. Lo dispara el admin con la entrada
 *            oficial ya en SIESA (sql/019). No cierra nada: la liquidación ya
 *            está cerrada.
 *
 * Todo intento —bueno o malo— deja una fila en `carnes_siesa_envios`.
 *
 * ─── El candado ───────────────────────────────────────────────────────────
 *
 * Un envío se RESERVA antes de mandarse: la fila entra en `enviando`, y un
 * índice único (sql/010) no deja que haya dos vigentes —enviando, ok o
 * sin_confirmar— para la misma recepción y tipo. Antes, "¿ya se mandó?" y el
 * POST eran dos pasos separados, y entre los dos cabía un segundo pedido: así
 * entraron R2O y R4O dos veces en la prueba de cerdo.
 */

import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { ESTADOS } from "../shared/estados.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { puedeEliminarEnvio } from "../shared/eliminacionAdmin.js";
import {
  armarEntradaDirecta,
  armarEntradaLiquidacion,
  TIPO_ENVIO,
} from "../shared/siesaEntrada.js";
import {
  armarAjusteVisceras,
  coberturaOficial,
  viscerasEnCea,
  esperaParaSede,
  TIPO_AJUSTE_VISCERAS,
} from "../shared/siesaAjusteVisceras.js";
import {
  DOCUMENTO_AJUSTE_VISCERAS,
  documentoSiesa,
  siesaConfigurado,
  siesaActivo,
  faltantesSiesa,
  terceroCarnes,
  TERCEROS_CARNES,
} from "../config/siesa.js";
import {
  enviarASiesa,
  TIMEOUT_INICIAL_MS,
  TIMEOUT_OFICIAL_MS,
} from "../services/siesa.service.js";
import {
  notificarAnularInicial,
  notificarAnularIniciales,
} from "../services/notificaciones.service.js";

const TABLA = "carnes_siesa_envios";

/** Estados que ocupan el lugar del envío de una recepción. Ver sql/010. */
const VIGENTES = ["enviando", "ok", "sin_confirmar"];

/**
 * Un `enviando` más viejo que esto es un envío cuya función murió en el medio.
 * Tiene que quedar POR ENCIMA de la espera más larga a SIESA
 * (TIMEOUT_OFICIAL_MS, 4 min) y del límite de la función en Vercel (300 s, el
 * default de Fluid compute; vercel.json no lleva bloque `functions`): un envío
 * vivo nunca puede verse abandonado, o alguien lo reenvía mientras corre.
 */
const ENVIANDO_ABANDONADO_MS = 6 * 60 * 1000;

const MIGRACIONES = [
  "sql/007_siesa.sql",
  "sql/008_pagos_y_tercero.sql",
  "sql/010_siesa_candado.sql",
  "sql/011_siesa_anulacion.sql",
  "sql/012_siesa_cea_liquidacion.sql",
  "sql/019_ajuste_visceras.sql",
];

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

/** Lo mismo para la oficial consolidada: `id × 10 + 3`, no choca con las de sede. */
const consecutivoLiquidacion = (liquidacionId) => Number(liquidacionId) * 10 + 3;

// ─── Lectura ───────────────────────────────────────────────────────────────

/** La recepción con su sede (incluida la bodega) y sus renglones. */
async function cargarRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select("*, sede:carnes_sedes ( id, codigo_co, nombre, bodega_siesa )")
    .eq("id", recepcionId)
    .maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer la recepción", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  if (!data) throw createError(404, "Recepción no encontrada.");

  const { data: items, error: e2 } = await supabase
    .from("carnes_recepcion_items")
    .select("*")
    .eq("recepcion_id", recepcionId)
    .order("tipo")
    .order("orden");
  if (e2)
    fallarSiFaltaMigracion(e2, "Error al leer los renglones", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);

  return { ...data, items: items || [] };
}

/**
 * El envío que ocupa el lugar de esta recepción y tipo —enviando, ok o
 * sin_confirmar—, o null si se puede mandar.
 */
async function envioVigente(recepcionId, tipo) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("recepcion_id", recepcionId)
    .eq("tipo", tipo)
    .in("estado", VIGENTES)
    .order("enviado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  return data || null;
}

/**
 * La oficial CONSOLIDADA que ocupa el lugar de esta liquidación —enviando, ok o
 * sin_confirmar—, o null. Es la que cuida el índice de sql/012.
 */
async function oficialDeLiquidacion(liquidacionId) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("liquidacion_id", liquidacionId)
    .is("recepcion_id", null)
    .eq("tipo", TIPO_ENVIO.OFICIAL)
    .in("estado", VIGENTES)
    .order("enviado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  return data || null;
}

/** Los ids de las recepciones vinculadas a una liquidación. */
async function idsDeLiquidacion(liquidacionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select("id")
    .eq("liquidacion_id", liquidacionId)
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer las recepciones", MIGRACIONES);
  return (data || []).map((r) => r.id);
}

/**
 * Los envíos que tocan una recepción: los directos (`recepcion_id`) y los de
 * la CEA consolidada que la incluye (`recepcion_ids`, ver sql/012).
 *
 * Lo usa `Recepcion.model.js#eliminarRecepcionAdmin` para decidir si se puede
 * borrar, y el endpoint de solo lectura que le muestra al admin qué
 * referencias de SIESA hay que anular allá antes de borrar acá.
 */
export async function enviosDeRecepcion(recepcionId) {
  const [{ data: directos, error: e1 }, { data: consolidados, error: e2 }] = await Promise.all([
    supabase
      .from(TABLA)
      .select("id, tipo, estado, referencia, enviado_at")
      .eq("recepcion_id", recepcionId),
    supabase
      .from(TABLA)
      .select("id, tipo, estado, referencia, enviado_at")
      .is("recepcion_id", null)
      .overlaps("recepcion_ids", [Number(recepcionId)]),
  ]);
  if (e1) fallarSiFaltaMigracion(e1, "Error al leer los envíos", MIGRACIONES);
  if (e2) fallarSiFaltaMigracion(e2, "Error al leer los envíos", MIGRACIONES);
  return [...(directos || []), ...(consolidados || [])];
}

/**
 * ¿El insert del ajuste falló porque a la base le falta sql/019?
 *
 * En una base sin migrar `tipo` es VARCHAR(10): 'ajuste_visceras' (15) no
 * cabe y Postgres responde 22001 (valor demasiado largo), no el CHECK. Con la
 * columna ya ensanchada pero sin el CHECK nuevo sería 23514. Los dos significan
 * lo mismo: falta correr la migración.
 */
const faltaMigracion019 = (error, tipo) =>
  tipo === TIPO_AJUSTE_VISCERAS && ["22001", "23514"].includes(error?.code);

const errorFaltaMigracion019 = () =>
  createError(
    503,
    "A la base le falta sql/019_ajuste_visceras.sql. Corrélo en Supabase y volvé a intentar.",
  );

/** Por qué no se puede mandar, dicho para una persona. */
function motivoVigente(envio) {
  if (envio.estado === "ok") return `Ya está en SIESA (${envio.referencia}).`;
  if (envio.estado === "enviando") {
    return `Hay un envío en curso (${envio.referencia}). Esperá a que termine y actualizá.`;
  }
  return (
    `El envío ${envio.referencia} quedó sin confirmar: SIESA pudo haberlo creado. ` +
    "Verificalo en SIESA y marcalo desde el panel de envíos antes de reintentar."
  );
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
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer el envío", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  return data || null;
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
        "recepcion_ids, " +
        "recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) ), " +
        // La oficial consolidada no tiene recepción: la especie y la fecha
        // salen de la liquidación.
        "liquidacion:carnes_liquidaciones ( id, especie, fecha, estado )",
    )
    .order("enviado_at", { ascending: false })
    .limit(Math.min(Number(f.limite) || 100, 500));
  if (f.tipo) q = q.eq("tipo", f.tipo);
  if (f.estado) q = q.eq("estado", f.estado);
  if (f.recepcion_id) q = q.eq("recepcion_id", f.recepcion_id);
  if (f.liquidacion_id) q = q.eq("liquidacion_id", f.liquidacion_id);

  const { data, error } = await q;
  if (error)
    fallarSiFaltaMigracion(error, "Error al listar envíos", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  return data || [];
}

/** GET — un envío con el payload y la respuesta completos. */
export async function obtener(id) {
  const { data, error } = await supabase
    .from(TABLA)
    .select(
      "*, recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) ), " +
        "liquidacion:carnes_liquidaciones ( id, especie, fecha, estado )",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  if (!data) throw createError(404, "Envío no encontrado.");

  // El payload lleva el código del ítem y nada más: es lo que SIESA necesita.
  // Para la pantalla se le pega, a cada movimiento, el renglón de la recepción
  // del que salió: sede, descripción, costo base y costo ajustado. Así el admin
  // puede ver de un vistazo si la oficial salió con el costo liquidado.
  //
  // El renglón se busca por código, cantidad y —en la consolidada— bodega. Solo
  // por código no alcanza: varios cortes comparten el mismo código de SIESA
  // (15187 lo tienen FALDITA, PUNTA DE FALDA, ENTRAÑITAS y PUNTA ESPALDILLA), y
  // en la consolidada el mismo corte aparece una vez por sede.
  //
  // Los costos son los de HOY, no los del momento del envío: si la liquidación
  // se reabrió después, `costo_ajustado` puede venir vacío. El costo enviado sí
  // es el de entonces, porque sale del payload guardado.
  const idsRecepciones = data.recepcion_id
    ? [data.recepcion_id]
    : data.recepcion_ids?.length
      ? data.recepcion_ids
      : data.liquidacion_id
        ? await idsDeLiquidacion(data.liquidacion_id)
        : [];

  // El ajuste de vísceras se explica con los renglones de VÍSCERA; la CEA, con
  // los de carne y adicionales.
  const esAjuste = data.tipo === TIPO_AJUSTE_VISCERAS;
  let items = [];
  const sedeDe = new Map();
  if (idsRecepciones.length) {
    const [{ data: filas }, { data: recs }] = await Promise.all([
      supabase
        .from("carnes_recepcion_items")
        .select("id, recepcion_id, codigo_item, descripcion, cantidad, costo_base, costo_ajustado")
        .in("recepcion_id", idsRecepciones)
        .in("tipo", esAjuste ? ["vicera"] : ["carne", "adicional"])
        .gt("cantidad", 0)
        .order("recepcion_id")
        .order("orden"),
      supabase
        .from("carnes_recepciones")
        .select("id, sede:carnes_sedes ( nombre, bodega_siesa )")
        .in("id", idsRecepciones),
    ]);
    items = filas || [];
    for (const r of recs || []) sedeDe.set(r.id, r.sede || {});
  }

  const milesimas = (n) => Math.round((Number(n) || 0) * 1000);
  const usados = new Set();
  const renglonDe = (m) => {
    const codigo = String(m.ITEM ?? "").trim();
    const bodega = String(m.BODEGA ?? "").trim();
    const candidatos = items.filter(
      (i) =>
        !usados.has(i.id) &&
        String(i.codigo_item ?? "").trim() === codigo &&
        // Con una sola recepción la bodega no discrimina nada; con varias, sí.
        (idsRecepciones.length === 1 ||
          String(sedeDe.get(i.recepcion_id)?.bodega_siesa ?? "").trim() === bodega),
    );
    const elegido =
      candidatos.find((i) => milesimas(i.cantidad) === milesimas(m.CANTIDAD)) ||
      candidatos[0] ||
      null;
    if (elegido) usados.add(elegido.id);
    return elegido;
  };

  const numero = (v) => (v === null || v === undefined ? null : Number(v));
  const movimientos = (data.payload?.Movimientos || []).map((m, n) => {
    const cantidad = Number(m.CANTIDAD) || 0;
    // El ajuste no manda VALOR_BRUTO sino el costo UNITARIO (COSTO_PROMEDIO), con
    // las claves "C.O." y "C.O MOVIMIENTO" del conector. Se lleva a la forma de
    // la CEA para que la pantalla lea los dos igual.
    const costoUnitario = esAjuste ? Number(m.COSTO_PROMEDIO) || 0 : null;
    const bruto = esAjuste
      ? Math.round(cantidad * costoUnitario * 100) / 100
      : Number(m.VALOR_BRUTO) || 0;
    const renglon = renglonDe(m);
    return {
      ...m,
      NRO_REGISTRO: m.NRO_REGISTRO ?? String(n + 1),
      CO_MOVIMIENTO: m.CO_MOVIMIENTO ?? m["C.O MOVIMIENTO"] ?? "",
      sede: renglon ? sedeDe.get(renglon.recepcion_id)?.nombre ?? null : null,
      descripcion: renglon?.descripcion ?? null,
      cantidad,
      valor_bruto: bruto,
      precio_unitario: esAjuste
        ? costoUnitario
        : cantidad > 0
          ? Math.round((bruto / cantidad) * 100) / 100
          : null,
      costo_base: numero(renglon?.costo_base),
      costo_ajustado: numero(renglon?.costo_ajustado),
    };
  });

  return { ...data, movimientos };
}

// ─── El envío en sí ────────────────────────────────────────────────────────

/**
 * Envío de UNA recepción (la inicial): arma y delega en `registrarYEnviar`.
 */
async function ejecutarEnvio({
  recepcion,
  tipo,
  liquidacionId = null,
  por,
  referenciaInicial,
  terceroId,
}) {
  const consecutivo = consecutivoDe(recepcion.id, tipo);
  const armado = armarEntradaDirecta({
    recepcion,
    items: recepcion.items,
    tipo,
    consecutivo,
    config: documentoSiesa(terceroId),
    referenciaInicial,
  });
  return registrarYEnviar({
    armado,
    base: { recepcion_id: recepcion.id, liquidacion_id: liquidacionId, tipo, consecutivo },
    por,
    vigente: () => envioVigente(recepcion.id, tipo),
    etiqueta: `${tipo} recepción #${recepcion.id}`,
  });
}

/**
 * Registra, reserva, manda y anota el resultado. No lanza por SIESA: devuelve
 * la fila guardada.
 *
 * Sirve para los dos niveles: una recepción (la inicial) y una liquidación (la
 * oficial consolidada). Lo que cambia es la fila base y cómo se busca el envío
 * vigente cuando el índice único rechaza la reserva.
 *
 * @param {object}   p
 * @param {object}   p.armado    { payload, resumen, bloqueos }
 * @param {object}   p.base      columnas propias: recepcion_id, liquidacion_id, tipo, consecutivo…
 * @param {string}   [p.por]
 * @param {Function} p.vigente   () => el envío que ocupa el lugar, o null
 * @param {string}   p.etiqueta  para los logs
 * @param {{idDocumento: string, nombreDocumento: string}} [p.documento]
 *        conector destino; sin él, la CEA de carnes
 * @param {number}   [p.timeoutMs]  espera a SIESA; sin él, según el tipo
 */
async function registrarYEnviar({ armado, base, por, vigente, etiqueta, documento, timeoutMs }) {
  const { payload, resumen, bloqueos } = armado;
  const tipo = base.tipo;

  const fila = {
    ...base,
    referencia: resumen.referencia,
    // El ajuste de vísceras no manda TIPO_DOCTO (es fijo en el conector): el
    // tipo, si hay, lo trae `base`.
    tipo_docto: payload.Documentos[0]?.TIPO_DOCTO || base.tipo_docto || null,
    payload,
    renglones: resumen.renglones,
    total_kilos: resumen.totalKilos,
    total_valor: resumen.totalValor,
    enviado_por: por || null,
  };

  // ─── No sale nada: se anota el motivo y listo ───
  //
  // Sin reserva: un bloqueo no manda nada a SIESA, así que no hay duplicado
  // que evitar, y la fila `error` no ocupa el lugar.
  const noSale = bloqueos.length
    ? bloqueos.join(" ")
    : !siesaConfigurado()
      ? `SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`
      : null;
  if (noSale) {
    const { data, error } = await supabase
      .from(TABLA)
      .insert({ ...fila, estado: "error", error: noSale })
      .select("*")
      .single();
    if (faltaMigracion019(error, tipo)) throw errorFaltaMigracion019();
    if (error) fallarSiFaltaMigracion(error, "No se pudo registrar el envío", MIGRACIONES);
    console.error(`🔴 SIESA ${etiqueta}: ${noSale}`);
    return data;
  }

  // ─── Reserva ───
  //
  // Si ya hay uno vigente, el índice único rechaza el insert y NO se manda.
  const { data: reserva, error: errorReserva } = await supabase
    .from(TABLA)
    .insert({ ...fila, estado: "enviando" })
    .select("*")
    .single();
  if (errorReserva) {
    if (errorReserva.code === "23505") {
      const ocupado = await vigente();
      return {
        ...(ocupado || { ...base, estado: "enviando", referencia: fila.referencia }),
        repetido: true,
      };
    }
    // Sin sql/019 el tipo `ajuste_visceras` no cabe (22001) o no está en el
    // CHECK (23514); sin sql/010 el CHECK viejo no conoce `enviando`.
    if (faltaMigracion019(errorReserva, tipo)) throw errorFaltaMigracion019();
    if (errorReserva.code === "23514") {
      throw createError(
        503,
        "A la base le falta sql/010_siesa_candado.sql. Corrélo en Supabase y volvé a intentar.",
      );
    }
    fallarSiFaltaMigracion(errorReserva, "No se pudo registrar el envío", MIGRACIONES);
  }

  const resultado = await enviarASiesa(payload, {
    timeoutMs:
      timeoutMs ?? (tipo === TIPO_ENVIO.OFICIAL ? TIMEOUT_OFICIAL_MS : TIMEOUT_INICIAL_MS),
    ...(documento ? { documento } : {}),
  });
  const estado = resultado.ok ? "ok" : resultado.incierto ? "sin_confirmar" : "error";

  const cierre = {
    estado,
    respuesta: resultado.respuesta,
    http_status: resultado.status,
    error: resultado.error,
  };
  // Solo si sigue en `enviando`: si alguien la resolvió o la anuló mientras
  // SIESA contestaba, no se pisa lo que esa persona registró.
  const { data, error } = await supabase
    .from(TABLA)
    .update(cierre)
    .eq("id", reserva.id)
    .eq("estado", "enviando")
    .select("*")
    .maybeSingle();
  if (error || !data) {
    // SIESA ya contestó y no se pudo anotar. Se devuelve lo que la base DICE,
    // no lo que SIESA respondió: si se devolviera `ok` sin haberlo escrito, el
    // que llama podría cerrar la liquidación con la fila todavía en `enviando`.
    // Queda trabado —se resuelve desde el panel—, que es mejor que duplicado.
    console.error(
      `🔴 SIESA ${etiqueta}: respondió "${estado}" pero no se pudo anotar ` +
        `(${error?.message || "la fila ya no estaba en enviando"}).`,
    );
    const { data: real } = await supabase
      .from(TABLA)
      .select("*")
      .eq("id", reserva.id)
      .maybeSingle();
    const actual = real || reserva;
    return {
      ...actual,
      error:
        `SIESA respondió "${estado}" pero no se pudo anotar. Verificá en SIESA la ` +
        `referencia ${actual.referencia} y resolvelo desde el panel de envíos.`,
    };
  }

  if (estado !== "ok") {
    console.error(`🔴 SIESA ${etiqueta}: ${resultado.error}`);
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
    return {
      estado: "apagado",
      tipo: TIPO_ENVIO.INICIAL,
      recepcion_id: recepcionId,
    };
  }
  try {
    const recepcion = await cargarRecepcion(recepcionId);
    // Si ya hay una inicial vigente, no se manda otra: SIESA tendría dos
    // documentos de la misma carne y el que anula no sabría cuál.
    const previa = await envioVigente(recepcionId, TIPO_ENVIO.INICIAL);
    if (previa) return { ...previa, repetido: true };

    return await ejecutarEnvio({ recepcion, tipo: TIPO_ENVIO.INICIAL, por });
  } catch (e) {
    console.error(`🔴 SIESA inicial recepción #${recepcionId}: ${e.message}`);
    return {
      estado: "error",
      error: e.message,
      tipo: TIPO_ENVIO.INICIAL,
      recepcion_id: recepcionId,
    };
  }
}

/** Reintento manual de la inicial, desde el panel. Sí lanza si no se puede. */
export async function reintentarInicial(recepcionId, por) {
  if (!siesaActivo()) {
    throw createError(
      409,
      "El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).",
    );
  }
  const recepcion = await cargarRecepcion(recepcionId);
  if (
    ![ESTADOS.RECIBIDO, ESTADOS.APROBADO, ESTADOS.COSTEADO].includes(
      recepcion.estado,
    )
  ) {
    throw createError(
      409,
      `La recepción está en ${recepcion.estado}: la inicial ya no aplica.`,
    );
  }
  const previa = await envioVigente(recepcionId, TIPO_ENVIO.INICIAL);
  if (previa) throw createError(409, motivoVigente(previa));
  const fila = await ejecutarEnvio({ recepcion, tipo: TIPO_ENVIO.INICIAL, por });
  // Otro pedido la reservó entre la pregunta de arriba y la reserva.
  if (fila.repetido) throw createError(409, motivoVigente(fila));
  return fila;
}

/**
 * Arma la oficial consolidada de una liquidación con los datos de AHORA.
 *
 * Se llama dos veces: al previsualizar y justo antes de mandar. La segunda no
 * reusa la primera: entre una y otra el admin pudo volver a costear.
 */
async function armarOficial(liquidacionId, terceroId) {
  const ids = await idsDeLiquidacion(liquidacionId);
  const recepciones = [];
  for (const id of ids) recepciones.push(await cargarRecepcion(id));
  const armado = armarEntradaLiquidacion({
    liquidacionId,
    recepciones,
    consecutivo: consecutivoLiquidacion(liquidacionId),
    config: documentoSiesa(terceroId),
  });
  return { ids, recepciones, armado };
}

/**
 * Oficiales POR SEDE (el esquema de antes) que siguen vigentes. Si hay alguna,
 * la consolidada no sale: esa carne ya está en SIESA en otro documento.
 */
async function oficialesPorSedeVigentes(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, recepcion_id, estado, referencia")
    .in("recepcion_id", ids)
    .eq("tipo", TIPO_ENVIO.OFICIAL)
    .in("estado", VIGENTES);
  if (error) fallarSiFaltaMigracion(error, "Error al leer los envíos", MIGRACIONES);
  return data || [];
}

/**
 * CEA consolidadas vigentes de OTRAS liquidaciones que ya llevan alguna de
 * estas recepciones.
 *
 * El candado de sql/012 es por liquidación: no ve que la misma recepción esté
 * en el documento de otra. Eso pasa si se la movió de liquidación con la CEA de
 * la primera todavía viva. `desvincular` ya lo frena; esto es la segunda capa,
 * justo antes de mandar, porque acá un error duplica inventario.
 */
async function oficialesDeOtrasLiquidaciones(liquidacionId, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, liquidacion_id, estado, referencia")
    .is("recepcion_id", null)
    .eq("tipo", TIPO_ENVIO.OFICIAL)
    .in("estado", VIGENTES)
    .neq("liquidacion_id", liquidacionId)
    .overlaps("recepcion_ids", ids);
  if (error) fallarSiFaltaMigracion(error, "Error al leer los envíos", MIGRACIONES);
  return data || [];
}

/**
 * Qué pasaría al enviar la oficial, sin mandar nada. Para que el botón del
 * panel pueda decir "no se puede, por esto" antes de apretarlo.
 */
export async function previsualizarOficial(liquidacionId, terceroId) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado, especie, siesa_nit, siesa_sucursal")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { ids, recepciones, armado } = await armarOficial(liquidacionId, terceroId);
  const [oficial, porSede, deOtras] = await Promise.all([
    oficialDeLiquidacion(liquidacionId),
    oficialesPorSedeVigentes(ids),
    oficialesDeOtrasLiquidaciones(liquidacionId, ids),
  ]);

  const sedes = [];
  for (const s of armado.porSede) {
    const inicial = await ultimoEnvio(s.recepcion_id, TIPO_ENVIO.INICIAL);
    const vieja = porSede.find((e) => e.recepcion_id === s.recepcion_id) || null;
    sedes.push({
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      estado: recepciones.find((r) => r.id === s.recepcion_id)?.estado,
      inicial: inicial
        ? { referencia: inicial.referencia, enviado_at: inicial.enviado_at }
        : null,
      // Oficial por sede del esquema anterior, si sigue vigente.
      oficialPorSede: vieja ? { id: vieja.id, estado: vieja.estado, referencia: vieja.referencia } : null,
      resumen: s.resumen,
      bloqueos: s.bloqueos,
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
  if (!configurado) {
    bloqueosGlobales.push(`SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`);
  }
  if (deOtras.length) {
    bloqueosGlobales.push(
      `Alguna recepción de esta liquidación ya está en la entrada oficial de otra liquidación ` +
        `(${deOtras.map((e) => `${e.referencia}, ${e.estado}`).join("; ")}). ` +
        "Anulala en SIESA y registralo antes de mandar esta, o la carne entraría dos veces.",
    );
  }
  if (porSede.length) {
    bloqueosGlobales.push(
      `Esta liquidación ya tiene oficiales por sede en SIESA (${porSede.map((e) => e.referencia).join(", ")}). ` +
        "Anulalas en SIESA y registralo antes de mandar la consolidada, o la carne entraría dos veces.",
    );
  }

  return {
    liquidacion: liq,
    terceros: TERCEROS_CARNES,
    tercero: terceroCarnes(terceroId),
    configurado,
    bloqueos: bloqueosGlobales,
    // La CEA que se mandaría: una sola, con todas las sedes.
    documento: { ...armado.resumen, bloqueos: armado.bloqueos },
    // `enviado_at` para que la pantalla distinga un envío vivo de uno abandonado.
    oficial: oficial
      ? {
          id: oficial.id,
          estado: oficial.estado,
          referencia: oficial.referencia,
          enviado_at: oficial.enviado_at,
        }
      : null,
    sedes,
    puedeEnviar:
      bloqueosGlobales.length === 0 &&
      armado.bloqueos.length === 0 &&
      !oficial &&
      sedes.length > 0,
  };
}

/**
 * Cierra la liquidación: recepciones a Enviado_SIESA, liquidación a Cerrada,
 * y se anota con qué tercero entró.
 *
 * El tercero sale del PAYLOAD que se mandó, no del que el admin tenga elegido
 * ahora en pantalla: si se cierra en un segundo clic (después de resolver un
 * "sin confirmar"), lo que vale es lo que está en SIESA.
 */
async function cerrarLiquidacion(liquidacionId, ids, envio) {
  const doc = envio.payload?.Documentos?.[0] || {};
  const { error: e1 } = await supabase
    .from("carnes_recepciones")
    .update({ estado: ESTADOS.ENVIADO_SIESA, siesa_at: new Date().toISOString() })
    .in("id", ids)
    .neq("estado", ESTADOS.ENVIADO_SIESA);
  if (e1) fallarSiFaltaMigracion(e1, "No se pudo marcar las recepciones como enviadas", MIGRACIONES);

  // Con qué tercero entró queda escrito: dentro de seis meses la pregunta es
  // "¿esta liquidación fue a nombre de quién?" y la respuesta tiene que estar
  // en la fila, no en el payload de un envío.
  const { error: e2 } = await supabase
    .from("carnes_liquidaciones")
    .update({
      estado: "Cerrada",
      siesa_nit: doc.NIT || null,
      siesa_sucursal: doc.SUCURSAL || null,
    })
    .eq("id", liquidacionId);
  if (e2) fallarSiFaltaMigracion(e2, "No se pudo cerrar la liquidación", MIGRACIONES);
}

/**
 * Entrada OFICIAL de una liquidación costeada: UNA CEA con todas las sedes.
 *
 * Si entra → cierre (recepciones a Enviado_SIESA, liquidación a Cerrada) y un
 * correo con las iniciales a anular. Si ya estaba ok (un segundo clic, o un
 * "sin confirmar" que se resolvió como ok) solo cierra: no manda nada.
 *
 * @returns {{ cerrada: boolean, envio: object }}
 */
export async function enviarOficial(liquidacionId, por, terceroId) {
  const previa = await previsualizarOficial(liquidacionId, terceroId);
  if (previa.bloqueos.length) throw createError(409, previa.bloqueos.join(" "));
  if (!previa.sedes.length) {
    throw createError(409, "La liquidación no tiene recepciones para enviar.");
  }

  if (previa.oficial) {
    if (previa.oficial.estado !== "ok") {
      throw createError(409, motivoVigente(previa.oficial));
    }
    // Ya está en SIESA: se cierra lo que haya quedado abierto, sin mandar.
    const envio = await oficialDeLiquidacion(liquidacionId);
    // Entre la previsualización y acá alguien pudo registrar la anulación.
    if (!envio || envio.estado !== "ok") {
      throw createError(409, "La entrada oficial cambió de estado. Actualizá y volvé a intentar.");
    }
    if (previa.liquidacion.estado !== "Cerrada") {
      await cerrarLiquidacion(liquidacionId, await idsDeLiquidacion(liquidacionId), envio);
    }
    return { cerrada: true, repetido: true, envio: resumenEnvio(envio) };
  }

  if (previa.documento.bloqueos.length) {
    throw createError(409, previa.documento.bloqueos.join(" "));
  }

  // Se arma de nuevo con los datos de este instante: la previsualización pudo
  // quedar vieja si alguien volvió a costear entre medio.
  const { ids, recepciones, armado } = await armarOficial(liquidacionId, terceroId);
  const fila = await registrarYEnviar({
    armado,
    base: {
      recepcion_id: null,
      liquidacion_id: Number(liquidacionId),
      recepcion_ids: ids,
      tipo: TIPO_ENVIO.OFICIAL,
      consecutivo: consecutivoLiquidacion(liquidacionId),
    },
    por,
    vigente: () => oficialDeLiquidacion(liquidacionId),
    etiqueta: `oficial liquidación #${liquidacionId}`,
  });

  if (fila.estado !== "ok") {
    return {
      cerrada: false,
      envio: {
        ...resumenEnvio(fila),
        error: fila.repetido ? motivoVigente(fila) : fila.error,
      },
    };
  }

  await cerrarLiquidacion(liquidacionId, ids, fila);
  // Si otro pedido la reservó primero (`repetido`), el correo es de él.
  if (!fila.repetido) {
    await avisarAnulacionLiquidacion(previa.liquidacion, recepciones, fila);
  }
  return { cerrada: true, repetido: Boolean(fila.repetido), envio: resumenEnvio(fila) };
}

/** Lo que el front necesita de un envío, sin el payload entero. */
function resumenEnvio(e) {
  if (!e) return null;
  return {
    id: e.id,
    estado: e.estado,
    referencia: e.referencia,
    error: e.error ?? null,
    renglones: e.renglones,
    total_kilos: e.total_kilos,
    total_valor: e.total_valor,
  };
}

/**
 * Un solo correo con todas las iniciales a anular de la liquidación.
 *
 * Las iniciales que ya están anuladas —o que nunca entraron— no se piden. Si no
 * queda ninguna, no se manda nada y el aviso se da por cumplido.
 */
async function avisarAnulacionLiquidacion(liquidacion, recepciones, oficial) {
  const iniciales = [];
  for (const r of recepciones) {
    const inicial = await ultimoEnvio(r.id, TIPO_ENVIO.INICIAL);
    if (inicial) {
      iniciales.push({
        sede: r.sede?.nombre || `Sede ${r.sede_id}`,
        referencia: inicial.referencia,
        total_kilos: inicial.total_kilos,
        total_valor: inicial.total_valor,
      });
    }
  }
  if (!iniciales.length) {
    await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
    return;
  }
  const correo = await notificarAnularIniciales(liquidacion, iniciales, oficial);
  if (correo?.success) {
    await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
  }
}

/**
 * Correo a quien anula la inicial, y se anota que salió.
 *
 * Si la inicial ya está ANULADA (se anuló todo para reenviar), no hay nada que
 * pedir: el correo diría "anulá R2I" sobre un documento que ya no existe. Se
 * marca el aviso como cumplido y no se manda.
 */
async function avisarAnulacion(recepcion, inicial, oficial) {
  if (!inicial) {
    const { data: anulada } = await supabase
      .from(TABLA)
      .select("id")
      .eq("recepcion_id", recepcion.id)
      .eq("tipo", TIPO_ENVIO.INICIAL)
      .eq("estado", "anulado")
      .limit(1)
      .maybeSingle();
    if (anulada) {
      await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
      return;
    }
  }
  const correo = await notificarAnularInicial(recepcion, inicial, oficial);
  if (correo?.success) {
    await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
  }
}

/**
 * Resolver un envío que quedó en el aire, después de mirar en SIESA.
 *
 * `sin_confirmar` (timeout o corte después de mandar) o un `enviando`
 * abandonado (la función murió en el medio). El sistema no puede saber si
 * SIESA lo creó; una persona sí, buscando la referencia. Hasta que lo diga, el
 * envío bloquea el reintento: mejor trabado que duplicado.
 *
 *   `ok`        está en SIESA → queda ok. Si es oficial, sale el correo de
 *               anulación que el envío no llegó a mandar.
 *   `no_llego`  no está → queda error, y se puede reintentar.
 *
 * @param {number|string} id
 * @param {{ resultado: "ok"|"no_llego", por?: string }} p
 */
export async function resolver(id, { resultado, por } = {}) {
  if (!["ok", "no_llego"].includes(resultado)) {
    throw createError(400, 'resultado tiene que ser "ok" o "no_llego".');
  }

  const { data: envio, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  if (!envio) throw createError(404, "Envío no encontrado.");

  const abandonado =
    envio.estado === "enviando" &&
    Date.now() - new Date(envio.enviado_at).getTime() > ENVIANDO_ABANDONADO_MS;
  if (envio.estado !== "sin_confirmar" && !abandonado) {
    throw createError(
      409,
      envio.estado === "enviando"
        ? "El envío todavía está en curso. Esperá un par de minutos."
        : `El envío está en "${envio.estado}": no hay nada que resolver.`,
    );
  }

  const nota =
    resultado === "ok"
      ? `Confirmado en SIESA por ${por || "el admin"}.`
      : `Marcado como no llegó por ${por || "el admin"}.`;
  const { data, error: e2 } = await supabase
    .from(TABLA)
    .update({
      estado: resultado === "ok" ? "ok" : "error",
      error: [envio.error, nota].filter(Boolean).join(" "),
      resuelto_por: por || null,
      resuelto_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Si alguien lo resolvió al mismo tiempo, no se pisa.
    .eq("estado", envio.estado)
    .select("*")
    .maybeSingle();
  if (e2) fallarSiFaltaMigracion(e2, "No se pudo resolver el envío", MIGRACIONES);
  if (!data) throw createError(409, "Otro usuario ya resolvió este envío. Actualizá.");

  if (data.estado === "ok" && data.tipo === TIPO_ENVIO.OFICIAL) {
    if (data.recepcion_id) {
      const recepcion = await cargarRecepcion(data.recepcion_id);
      const inicial = await ultimoEnvio(data.recepcion_id, TIPO_ENVIO.INICIAL);
      await avisarAnulacion(recepcion, inicial, data);
    } else {
      // Consolidada. La liquidación NO se cierra acá: el admin vuelve a
      // "Enviar entrada oficial", que ve la oficial en ok y solo cierra.
      const { data: liq } = await supabase
        .from("carnes_liquidaciones")
        .select("id, especie")
        .eq("id", data.liquidacion_id)
        .maybeSingle();
      const ids = data.recepcion_ids?.length ? data.recepcion_ids : await idsDeLiquidacion(data.liquidacion_id);
      const recepciones = [];
      for (const rid of ids) recepciones.push(await cargarRecepcion(rid));
      await avisarAnulacionLiquidacion(liq, recepciones, data);
    }
  }
  return data;
}

/**
 * Las oficiales de una liquidación se anularon en SIESA: se refleja acá y se
 * deja la liquidación lista para volver a mandar.
 *
 * Lo que hace, en este orden:
 *   1. Los envíos oficiales (ok, duplicado o sin_confirmar) pasan a `anulado`.
 *      Eso libera el índice único de sql/010: se puede reservar uno nuevo.
 *      Con `inicialesAnuladas`, las iniciales también: así el reenvío no pide
 *      anular una inicial que ya no existe.
 *   2. Las recepciones vuelven de `Enviado_SIESA` a `Costeado`.
 *   3. La liquidación vuelve de `Cerrada` a `Costeada`, con los costos intactos.
 *
 * Después el admin verifica los costos —o reabre, corrige y vuelve a costear—
 * y manda la oficial de nuevo. Los duplicados los sigue cuidando el candado.
 *
 * NO toca SIESA: la anulación allá la hace una persona. Esto solo registra que
 * ya se hizo, y por eso lo dice quien lo marca.
 *
 * @param {number|string} liquidacionId
 * @param {{ por?: string, motivo?: string, inicialesAnuladas?: boolean }} p
 */
export async function anularOficiales(liquidacionId, { por, motivo, inicialesAnuladas = false } = {}) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { data: recs, error: e1 } = await supabase
    .from("carnes_recepciones")
    .select("id")
    .eq("liquidacion_id", liquidacionId);
  if (e1) fallarSiFaltaMigracion(e1, "Error al leer las recepciones", MIGRACIONES);
  const ids = (recs || []).map((r) => r.id);
  if (!ids.length) throw createError(409, "La liquidación no tiene recepciones.");

  // Un envío en curso de verdad (no abandonado) todavía puede terminar ok: no
  // se anula algo que SIESA quizás está creando en este momento.
  // Por sede y la consolidada (que no tiene recepción, va por liquidación).
  const [porSede, consolidada] = await Promise.all([
    supabase.from(TABLA).select("id, referencia, enviado_at").in("recepcion_id", ids).eq("estado", "enviando"),
    supabase
      .from(TABLA)
      .select("id, referencia, enviado_at")
      .eq("liquidacion_id", liquidacionId)
      .is("recepcion_id", null)
      .eq("estado", "enviando"),
  ]);
  const e2 = porSede.error || consolidada.error;
  if (e2) fallarSiFaltaMigracion(e2, "Error al leer los envíos", MIGRACIONES);
  const enCurso = [...(porSede.data || []), ...(consolidada.data || [])];
  const vivos = enCurso.filter(
    (e) => Date.now() - new Date(e.enviado_at).getTime() <= ENVIANDO_ABANDONADO_MS,
  );
  if (vivos.length) {
    throw createError(
      409,
      `Hay envíos en curso (${vivos.map((e) => e.referencia).join(", ")}). Esperá a que terminen.`,
    );
  }

  const tipos = inicialesAnuladas
    ? [TIPO_ENVIO.OFICIAL, TIPO_ENVIO.INICIAL]
    : [TIPO_ENVIO.OFICIAL];
  const marca = {
    estado: "anulado",
    anulado_por: por || null,
    anulado_at: new Date().toISOString(),
    motivo_anulacion: String(motivo ?? "").trim() || null,
  };

  // Dos updates y no uno: un `enviando` solo se anula si ya está ABANDONADO,
  // y la condición va en la misma consulta que lo cambia. Si fuera en el
  // chequeo de arriba, un envío reservado entre el chequeo y el update se
  // anularía estando vivo, con su POST a SIESA todavía en camino.
  const limite = new Date(Date.now() - ENVIANDO_ABANDONADO_MS).toISOString();
  const { data: cerrados, error: e3 } = await supabase
    .from(TABLA)
    .update(marca)
    .in("recepcion_id", ids)
    .in("tipo", tipos)
    .in("estado", ["ok", "duplicado", "sin_confirmar"])
    .select("id, tipo, referencia");
  let abandonados = [];
  if (!e3) {
    const r = await supabase
      .from(TABLA)
      .update(marca)
      .in("recepcion_id", ids)
      .in("tipo", tipos)
      .eq("estado", "enviando")
      .lt("enviado_at", limite)
      .select("id, tipo, referencia");
    if (r.error) fallarSiFaltaMigracion(r.error, "No se pudieron anular los envíos", MIGRACIONES);
    abandonados = r.data || [];
  }
  // La consolidada: misma regla, pero se busca por liquidación.
  let consolidadas = [];
  if (!e3) {
    const [c1, c2] = await Promise.all([
      supabase
        .from(TABLA)
        .update(marca)
        .eq("liquidacion_id", liquidacionId)
        .is("recepcion_id", null)
        .eq("tipo", TIPO_ENVIO.OFICIAL)
        .in("estado", ["ok", "duplicado", "sin_confirmar"])
        .select("id, tipo, referencia"),
      supabase
        .from(TABLA)
        .update(marca)
        .eq("liquidacion_id", liquidacionId)
        .is("recepcion_id", null)
        .eq("tipo", TIPO_ENVIO.OFICIAL)
        .eq("estado", "enviando")
        .lt("enviado_at", limite)
        .select("id, tipo, referencia"),
    ]);
    const ec = c1.error || c2.error;
    if (ec) fallarSiFaltaMigracion(ec, "No se pudo anular la oficial consolidada", MIGRACIONES);
    consolidadas = [...(c1.data || []), ...(c2.data || [])];
  }
  const anulados = [...(cerrados || []), ...abandonados, ...consolidadas];
  if (e3) {
    // Sin sql/011, el CHECK no conoce `anulado`.
    if (e3.code === "23514") {
      throw createError(
        503,
        "A la base le falta sql/011_siesa_anulacion.sql. Corrélo en Supabase y volvé a intentar.",
      );
    }
    fallarSiFaltaMigracion(e3, "No se pudieron anular los envíos", MIGRACIONES);
  }
  const oficiales = (anulados || []).filter((e) => e.tipo === TIPO_ENVIO.OFICIAL);
  if (!oficiales.length && liq.estado !== "Cerrada") {
    throw createError(409, "Esta liquidación no tiene entradas oficiales para anular.");
  }

  const { data: reabiertas, error: e4 } = await supabase
    .from("carnes_recepciones")
    .update({ estado: ESTADOS.COSTEADO, siesa_at: null })
    .in("id", ids)
    .eq("estado", ESTADOS.ENVIADO_SIESA)
    .select("id");
  if (e4) fallarSiFaltaMigracion(e4, "No se pudieron reabrir las recepciones", MIGRACIONES);

  if (liq.estado === "Cerrada") {
    const { error: e5 } = await supabase
      .from("carnes_liquidaciones")
      .update({ estado: "Costeada" })
      .eq("id", liquidacionId);
    if (e5) fallarSiFaltaMigracion(e5, "No se pudo reabrir la liquidación", MIGRACIONES);
  }

  console.log(
    `↩️  Liquidación #${liquidacionId}: ${oficiales.length} oficial(es) anulada(s) por ${por || "—"}.`,
  );
  return {
    anulados: (anulados || []).map((e) => ({ id: e.id, tipo: e.tipo, referencia: e.referencia })),
    recepciones: (reabiertas || []).length,
  };
}

/**
 * El ADMIN borra un envío que quedó en `error`.
 *
 * Solo ese estado: ver `puedeEliminarEnvio` en `shared/eliminacionAdmin.js`.
 * No toca el candado de sql/010 —ese índice único solo cubre
 * `enviando`/`ok`/`sin_confirmar`— así que un `error` nunca lo ocupaba y
 * borrarlo no destraba ni traba nada.
 */
export async function eliminarEnvioAdmin(id) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, estado, referencia")
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  if (!data) throw createError(404, "Envío no encontrado.");

  const { ok, motivo } = puedeEliminarEnvio({ estado: data.estado });
  if (!ok) throw createError(409, motivo);

  const { error: errorBorrar } = await supabase.from(TABLA).delete().eq("id", id);
  if (errorBorrar) fallarSiFaltaMigracion(errorBorrar, "No se pudo borrar el envío", MIGRACIONES);

  console.log(`🗑️  Envío SIESA #${id} (${data.referencia}) eliminado por el admin.`);
  return { eliminado: Number(id), referencia: data.referencia };
}

// ─── Ajuste de inventario de vísceras (CEI) ────────────────────────────────
//
// Un documento por recepción, con las vísceras de esa sede (ver
// `shared/siesaAjusteVisceras.js`). Se manda DESPUÉS de la entrada oficial, y
// SIESA lo contabiliza al importar: no hay etapa de elaboración donde alguien lo
// revise. Por eso el candado es el mismo de las demás (una vigente por
// recepción y tipo, sql/010) y por eso `enviarAjusteVisceras` para al primer
// fallo o duda en vez de seguir con las demás sedes.

// El tiempo que hay para mandar sedes se decide en `esperaParaSede`
// (shared/siesaAjusteVisceras.js): cada envío espera a SIESA hasta
// TIMEOUT_OFICIAL_MS (4 min) y la función de Vercel vive 300 s. Pasados 40 s desde
// el INICIO del pedido no se arranca otra sede, y la espera de cada una se recorta
// para terminar antes del límite. Lo que quedó pendiente se manda apretando de
// nuevo: las sedes que ya están ok se saltan solas.

/** Las recepciones de una liquidación, con su ajuste armado. */
async function armarAjustes(liquidacionId) {
  const ids = await idsDeLiquidacion(liquidacionId);
  const porSede = [];
  for (const id of ids) {
    const recepcion = await cargarRecepcion(id);
    porSede.push({
      recepcion,
      armado: armarAjusteVisceras({
        recepcion,
        items: recepcion.items,
        config: DOCUMENTO_AJUSTE_VISCERAS,
      }),
    });
  }
  return { ids, porSede };
}

/**
 * Los envíos de ajuste de estas recepciones y, por recepción, la entrada
 * oficial ya en SIESA que la cubre (`cobertura`, ver `coberturaOficial`).
 *
 * La consolidada cubre solo las recepciones con las que salió; una vinculada
 * después no cuenta. Las oficiales por sede del esquema anterior cubren la
 * recepción a la que pertenecen. La cobertura trae el payload guardado de esa
 * CEA, para saber si ya llevaba las vísceras.
 */
async function estadoAjustes(liquidacionId, ids) {
  if (!ids.length) return { ajustes: new Map(), cobertura: new Map() };
  const [ajustes, consolidada, porSede] = await Promise.all([
    supabase
      .from(TABLA)
      .select("id, recepcion_id, estado, referencia, enviado_at, error, renglones, total_valor")
      .in("recepcion_id", ids)
      .eq("tipo", TIPO_AJUSTE_VISCERAS)
      .order("enviado_at", { ascending: false }),
    oficialDeLiquidacion(liquidacionId),
    supabase
      .from(TABLA)
      .select("recepcion_id, payload")
      .in("recepcion_id", ids)
      .eq("tipo", TIPO_ENVIO.OFICIAL)
      .eq("estado", "ok"),
  ]);
  if (ajustes.error) {
    fallarSiFaltaMigracion(ajustes.error, "Error al leer los ajustes de vísceras", MIGRACIONES);
  }
  if (porSede.error) fallarSiFaltaMigracion(porSede.error, "Error al leer los envíos", MIGRACIONES);

  // Por recepción: el vigente si lo hay (es el que ocupa el lugar) y, si no, el
  // último intento, para mostrar qué pasó.
  const mapa = new Map();
  for (const a of ajustes.data || []) {
    const previo = mapa.get(a.recepcion_id) || { vigente: null, ultimo: null };
    if (!previo.ultimo) previo.ultimo = a;
    if (!previo.vigente && VIGENTES.includes(a.estado)) previo.vigente = a;
    mapa.set(a.recepcion_id, previo);
  }

  const cobertura = coberturaOficial({ ids, consolidada, porSede: porSede.data || [] });
  return { ajustes: mapa, cobertura };
}

/** Lo que el front necesita de un envío de ajuste. */
const resumenAjuste = (a) =>
  a
    ? {
        id: a.id,
        estado: a.estado,
        referencia: a.referencia,
        enviado_at: a.enviado_at,
        error: a.error ?? null,
      }
    : null;

/**
 * Qué pasaría al mandar el ajuste de vísceras de una liquidación, sin mandar
 * nada: por sede, el documento, los renglones y qué lo bloquea.
 *
 * Por cada sede:
 *   pendiente   tiene vísceras para ajustar y no hay envío vigente
 *   enviado     ya está en SIESA (ok)
 *   enCurso     hay uno enviando o sin confirmar: hasta resolverlo no se manda
 *               nada más
 *   vacio       no tiene ninguna víscera con código y cantidad
 */
export async function previsualizarAjusteVisceras(liquidacionId) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado, especie")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { ids, porSede: armados } = await armarAjustes(liquidacionId);
  const { ajustes, cobertura } = await estadoAjustes(liquidacionId, ids);

  const sedes = armados.map(({ recepcion, armado }) => {
    const { vigente, ultimo } = ajustes.get(recepcion.id) || {};
    const enviado = vigente?.estado === "ok";
    const enCurso = Boolean(vigente) && !enviado;
    const pendiente = !armado.vacio && !vigente;

    // Lo que solo importa si todavía se va a mandar algo de esta sede.
    const extra = [];
    if (pendiente && cobertura.size > 0) {
      const cubre = cobertura.get(recepcion.id);
      if (!cubre) {
        // Hay entrada oficial en SIESA, pero salió sin esta recepción: se la
        // vinculó después. Sus vísceras entrarían sin la carne que las trajo.
        extra.push(
          "Esta recepción no está en la entrada oficial que ya está en SIESA (se vinculó " +
            "después de enviarla). El ajuste se manda cuando su carne esté en SIESA.",
        );
      } else {
        // Las CEA anteriores al 29/09/2026 llevaban las vísceras como un renglón
        // más: mandar el ajuste las entraría dos veces, y contabilizado.
        const yaEstan = viscerasEnCea({
          payload: cubre.payload,
          items: recepcion.items,
          bodega: recepcion.sede?.bodega_siesa,
        });
        if (yaEstan.length) {
          extra.push(
            `La entrada oficial que ya está en SIESA trae estas vísceras: ${yaEstan.join(", ")}. ` +
              "Mandar el ajuste las entraría dos veces. Anulá esa entrada oficial y volvela a " +
              "enviar (ya sin vísceras) antes de hacer el ajuste.",
          );
        }
      }
    }
    return {
      recepcion_id: recepcion.id,
      sede: recepcion.sede?.nombre ?? null,
      fecha: recepcion.fecha_ingreso ?? null,
      resumen: armado.resumen,
      renglones: armado.renglones,
      bloqueos: [...armado.bloqueos, ...extra],
      vacio: armado.vacio,
      // El vigente si lo hay; si no, el último intento (un error, una anulación).
      envio: resumenAjuste(vigente || ultimo),
      enviado,
      enCurso,
      pendiente,
    };
  });

  const configurado = siesaConfigurado();
  const bloqueosGlobales = [];
  if (!ids.length) {
    bloqueosGlobales.push("La liquidación no tiene recepciones.");
  } else if (cobertura.size === 0) {
    // Ninguna sede tiene su entrada oficial en SIESA. Si solo faltan algunas, el
    // bloqueo es de cada una (arriba).
    bloqueosGlobales.push(
      "La entrada oficial todavía no está en SIESA. El ajuste de vísceras se manda después de ella.",
    );
  }
  if (!siesaActivo()) {
    bloqueosGlobales.push("El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).");
  }
  if (!configurado) {
    bloqueosGlobales.push(`SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`);
  }

  const pendientes = sedes.filter((s) => s.pendiente);
  const conDocumento = sedes.filter((s) => !s.vacio);
  const suma = (lista, k) => lista.reduce((a, s) => a + (Number(s.resumen[k]) || 0), 0);

  return {
    liquidacion: liq,
    documento: {
      nombre: DOCUMENTO_AJUSTE_VISCERAS.nombreDocumento,
      tipoDocto: DOCUMENTO_AJUSTE_VISCERAS.tipoDocto,
    },
    configurado,
    activo: siesaActivo(),
    bloqueos: bloqueosGlobales,
    sedes,
    totales: {
      sedes: conDocumento.length,
      renglones: suma(conDocumento, "renglones"),
      totalValor: Math.round(suma(conDocumento, "totalValor") * 100) / 100,
      pendientes: pendientes.length,
      pendientesValor: Math.round(suma(pendientes, "totalValor") * 100) / 100,
    },
    puedeEnviar:
      bloqueosGlobales.length === 0 &&
      pendientes.length > 0 &&
      pendientes.every((s) => s.bloqueos.length === 0) &&
      !sedes.some((s) => s.enCurso),
  };
}

/**
 * Manda el ajuste de vísceras de cada sede pendiente, UNA a la vez.
 *
 * Se detiene en la primera que no salga ok —error, sin confirmar, o un envío
 * que otro dejó reservado—: el documento se contabiliza al entrar, y seguir con
 * las demás sobre una duda solo agranda lo que hay que revisar en SIESA. Las que
 * no se intentaron quedan `pendiente` y se mandan al volver a apretar; las que
 * ya están ok se saltan.
 *
 * @returns {{ completo: boolean, enviadas: number, resultados: object[] }}
 */
export async function enviarAjusteVisceras(liquidacionId, por) {
  // El reloj arranca ANTES de previsualizar: leer las nueve recepciones también
  // gasta función.
  const inicio = Date.now();
  const previa = await previsualizarAjusteVisceras(liquidacionId);
  if (previa.bloqueos.length) throw createError(409, previa.bloqueos.join(" "));

  const enCurso = previa.sedes.filter((s) => s.enCurso);
  if (enCurso.length) {
    throw createError(
      409,
      enCurso.map((s) => `${s.sede}: ${motivoVigente(s.envio)}`).join(" "),
    );
  }
  const bloqueadas = previa.sedes.filter((s) => s.pendiente && s.bloqueos.length);
  if (bloqueadas.length) {
    // Todo o nada ANTES de empezar: si una sede no puede salir, no se manda
    // ninguna, para no dejar el ajuste a medias por algo que se sabía.
    throw createError(
      409,
      bloqueadas.map((s) => `${s.sede}: ${s.bloqueos.join(" ")}`).join(" "),
    );
  }

  const resultados = [];
  let detenida = false;
  let enviadas = 0;

  const anotar = (s, extra) =>
    resultados.push({
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      referencia: s.resumen.referencia,
      renglones: s.resumen.renglones,
      total_valor: s.resumen.totalValor,
      error: null,
      ...extra,
    });

  for (const s of previa.sedes) {
    if (s.vacio) {
      anotar(s, { estado: "sin_renglones" });
      continue;
    }
    if (s.enviado) {
      anotar(s, { estado: "ok", repetido: true, referencia: s.envio.referencia });
      continue;
    }
    if (detenida || esperaParaSede(Date.now() - inicio, TIMEOUT_OFICIAL_MS) === null) {
      detenida = true;
      anotar(s, { estado: "pendiente" });
      continue;
    }

    // Se arma de nuevo con los datos de este instante: entre la previsualización
    // y esta sede pueden haber pasado segundos u otros envíos.
    const recepcion = await cargarRecepcion(s.recepcion_id);
    const armado = armarAjusteVisceras({
      recepcion,
      items: recepcion.items,
      config: DOCUMENTO_AJUSTE_VISCERAS,
    });
    if (armado.vacio || armado.bloqueos.length) {
      detenida = true;
      anotar(s, {
        estado: "error",
        error: armado.vacio
          ? "La recepción ya no tiene vísceras para ajustar."
          : armado.bloqueos.join(" "),
      });
      continue;
    }

    // Se mide de nuevo justo antes de mandar: armar esta sede también tomó tiempo.
    const espera = esperaParaSede(Date.now() - inicio, TIMEOUT_OFICIAL_MS);
    if (espera === null) {
      detenida = true;
      anotar(s, { estado: "pendiente" });
      continue;
    }

    const fila = await registrarYEnviar({
      armado,
      base: {
        recepcion_id: recepcion.id,
        liquidacion_id: Number(liquidacionId),
        tipo: TIPO_AJUSTE_VISCERAS,
        consecutivo: null,
        tipo_docto: DOCUMENTO_AJUSTE_VISCERAS.tipoDocto,
      },
      por,
      vigente: () => envioVigente(recepcion.id, TIPO_AJUSTE_VISCERAS),
      etiqueta: `ajuste vísceras recepción #${recepcion.id}`,
      documento: DOCUMENTO_AJUSTE_VISCERAS,
      timeoutMs: espera,
    });

    if (fila.estado === "ok" && !fila.repetido) enviadas += 1;
    else detenida = true;
    anotar(s, {
      estado: fila.estado,
      referencia: fila.referencia,
      renglones: fila.renglones ?? s.resumen.renglones,
      total_valor: fila.total_valor ?? s.resumen.totalValor,
      // Otro pedido la reservó primero: no es un envío de este.
      repetido: Boolean(fila.repetido) || undefined,
      error: fila.repetido ? motivoVigente(fila) : (fila.error ?? null),
    });
  }

  const completo = resultados.every((r) => r.estado === "ok" || r.estado === "sin_renglones");
  return { completo, enviadas, resultados };
}

/**
 * El ajuste de UNA sede se anuló en SIESA: se refleja acá y se libera el lugar
 * para mandarlo de nuevo.
 *
 * Es por sede a propósito: el ajuste de cada una es un documento distinto, y
 * liberar los de todas haría que el reenvío duplicara las que siguen vivas en
 * SIESA. No toca SIESA: la anulación allá la hace una persona.
 *
 * Solo se anula un `ok`, un `sin_confirmar` o un `enviando` ya abandonado; uno
 * en vuelo de verdad todavía puede terminar ok.
 *
 * @param {number|string} liquidacionId
 * @param {{ recepcionId: number|string, por?: string, motivo?: string }} p
 */
export async function anularAjusteVisceras(liquidacionId, { recepcionId, por, motivo } = {}) {
  if (!recepcionId) throw createError(400, "Falta recepcion_id: el ajuste se anula sede por sede.");

  const ids = await idsDeLiquidacion(liquidacionId);
  if (!ids.includes(Number(recepcionId))) {
    throw createError(404, "Esa recepción no está en esta liquidación.");
  }

  const marca = {
    estado: "anulado",
    anulado_por: por || null,
    anulado_at: new Date().toISOString(),
    motivo_anulacion: String(motivo ?? "").trim() || null,
  };
  const limite = new Date(Date.now() - ENVIANDO_ABANDONADO_MS).toISOString();
  const base = () =>
    supabase
      .from(TABLA)
      .update(marca)
      .eq("recepcion_id", recepcionId)
      .eq("tipo", TIPO_AJUSTE_VISCERAS);

  const [cerrados, abandonados] = await Promise.all([
    base().in("estado", ["ok", "sin_confirmar"]).select("id, referencia"),
    // La condición va en la misma consulta que lo cambia: un envío reservado
    // entre un chequeo y el update no se anula estando vivo.
    base().eq("estado", "enviando").lt("enviado_at", limite).select("id, referencia"),
  ]);
  const e = cerrados.error || abandonados.error;
  if (e) fallarSiFaltaMigracion(e, "No se pudo anular el ajuste de vísceras", MIGRACIONES);

  const anulados = [...(cerrados.data || []), ...(abandonados.data || [])];
  if (!anulados.length) {
    throw createError(409, "Esa sede no tiene un ajuste de vísceras para anular (o está en curso).");
  }

  console.log(
    `↩️  Ajuste de vísceras recepción #${recepcionId}: ${anulados
      .map((a) => a.referencia)
      .join(", ")} anulado por ${por || "—"}.`,
  );
  return { anulados: anulados.map((a) => ({ id: a.id, referencia: a.referencia })) };
}
