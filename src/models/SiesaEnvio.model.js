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
import {
  armarEntradaDirecta,
  referenciaEnvio,
  TIPO_ENVIO,
} from "../shared/siesaEntrada.js";
import {
  documentoSiesa,
  siesaConfigurado,
  siesaActivo,
  faltantesSiesa,
  terceroCarnes,
  TERCEROS_CARNES,
} from "../config/siesa.js";
import { enviarASiesa } from "../services/siesa.service.js";
import { notificarAnularInicial } from "../services/notificaciones.service.js";

const TABLA = "carnes_siesa_envios";

/** Estados que ocupan el lugar del envío de una recepción. Ver sql/010. */
const VIGENTES = ["enviando", "ok", "sin_confirmar"];

/**
 * Un `enviando` más viejo que esto es un envío cuya función murió en el medio:
 * el POST a SIESA tiene un timeout de 45 s, así que nadie legítimo sigue ahí.
 */
const ENVIANDO_ABANDONADO_MS = 2 * 60 * 1000;

const MIGRACIONES = [
  "sql/007_siesa.sql",
  "sql/008_pagos_y_tercero.sql",
  "sql/010_siesa_candado.sql",
  "sql/011_siesa_anulacion.sql",
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
        "recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) )",
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
      "*, recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) )",
    )
    .eq("id", id)
    .maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer el envío", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  if (!data) throw createError(404, "Envío no encontrado.");

  // El payload lleva el código del ítem y nada más: es lo que SIESA necesita.
  // Para la pantalla se le pega, a cada movimiento, el renglón de la recepción
  // del que salió: descripción, costo base y costo ajustado. Así el admin lee
  // "TABLA · 14,19 kg × $27.588 (base $30.000)" y puede ver de un vistazo si la
  // oficial salió con el costo liquidado o con el de lista.
  //
  // El renglón se busca por código Y cantidad, no solo por código: varios
  // cortes comparten el mismo código de SIESA —15187 lo tienen FALDITA, PUNTA
  // DE FALDA, ENTRAÑITAS y PUNTA ESPALDILLA— y un mapa por código se queda con
  // el último y muestra un corte que no es el que se recibió.
  //
  // Los costos son los de HOY, no los del momento del envío: si la liquidación
  // se reabrió después, `costo_ajustado` puede venir vacío. El precio enviado
  // sí es el de entonces, porque sale del payload guardado.
  const { data: items } = await supabase
    .from("carnes_recepcion_items")
    .select("id, codigo_item, descripcion, cantidad, costo_base, costo_ajustado")
    .eq("recepcion_id", data.recepcion_id)
    .in("tipo", ["carne", "adicional"])
    .gt("cantidad", 0)
    .order("orden");

  const milesimas = (n) => Math.round((Number(n) || 0) * 1000);
  const usados = new Set();
  const renglonDe = (m) => {
    const codigo = String(m.ITEM ?? "").trim();
    const mismoCodigo = (items || []).filter(
      (i) => !usados.has(i.id) && String(i.codigo_item ?? "").trim() === codigo,
    );
    const elegido =
      mismoCodigo.find((i) => milesimas(i.cantidad) === milesimas(m.CANTIDAD)) ||
      mismoCodigo[0] ||
      null;
    if (elegido) usados.add(elegido.id);
    return elegido;
  };

  const movimientos = (data.payload?.Movimientos || []).map((m) => {
    const cantidad = Number(m.CANTIDAD) || 0;
    const bruto = Number(m.VALOR_BRUTO) || 0;
    const renglon = renglonDe(m);
    const numero = (v) => (v === null || v === undefined ? null : Number(v));
    return {
      ...m,
      descripcion: renglon?.descripcion ?? null,
      cantidad,
      valor_bruto: bruto,
      precio_unitario:
        cantidad > 0 ? Math.round((bruto / cantidad) * 100) / 100 : null,
      costo_base: numero(renglon?.costo_base),
      costo_ajustado: numero(renglon?.costo_ajustado),
    };
  });

  return { ...data, movimientos };
}

// ─── El envío en sí ────────────────────────────────────────────────────────

/**
 * Arma, manda (si hay credenciales) y registra. No lanza por SIESA: devuelve
 * la fila guardada, con `estado` ok o error.
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
  const { payload, resumen, bloqueos } = armarEntradaDirecta({
    recepcion,
    items: recepcion.items,
    tipo,
    consecutivo,
    config: documentoSiesa(terceroId),
    referenciaInicial,
  });

  const fila = {
    recepcion_id: recepcion.id,
    liquidacion_id: liquidacionId,
    tipo,
    referencia: resumen.referencia,
    consecutivo,
    tipo_docto: payload.Documentos[0]?.TIPO_DOCTO || null,
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
    if (error) fallarSiFaltaMigracion(error, "No se pudo registrar el envío", MIGRACIONES);
    console.error(`🔴 SIESA ${tipo} recepción #${recepcion.id}: ${noSale}`);
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
      const vigente = await envioVigente(recepcion.id, tipo);
      return {
        ...(vigente || {
          recepcion_id: recepcion.id,
          tipo,
          estado: "enviando",
          referencia: fila.referencia,
        }),
        repetido: true,
      };
    }
    // Sin sql/010, el CHECK viejo no conoce `enviando`.
    if (errorReserva.code === "23514") {
      throw createError(
        503,
        "A la base le falta sql/010_siesa_candado.sql. Corrélo en Supabase y volvé a intentar.",
      );
    }
    fallarSiFaltaMigracion(errorReserva, "No se pudo registrar el envío", MIGRACIONES);
  }

  const resultado = await enviarASiesa(payload);
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
      `🔴 SIESA ${tipo} recepción #${recepcion.id}: respondió "${estado}" pero no se pudo anotar ` +
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
 * Qué pasaría al enviar la oficial, sin mandar nada. Para que el botón del
 * panel pueda decir "no se puede, por esto" antes de apretarlo.
 */
export async function previsualizarOficial(liquidacionId, terceroId) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado, especie, siesa_nit, siesa_sucursal")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer la liquidación", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { data: recs, error: e2 } = await supabase
    .from("carnes_recepciones")
    .select("id")
    .eq("liquidacion_id", liquidacionId);
  if (e2)
    fallarSiFaltaMigracion(e2, "Error al leer las recepciones", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);

  const sedes = [];
  for (const { id } of recs || []) {
    const recepcion = await cargarRecepcion(id);
    const inicial = await ultimoEnvio(id, TIPO_ENVIO.INICIAL);
    const oficial = await envioVigente(id, TIPO_ENVIO.OFICIAL);
    const { resumen, bloqueos } = armarEntradaDirecta({
      recepcion,
      items: recepcion.items,
      tipo: TIPO_ENVIO.OFICIAL,
      consecutivo: consecutivoDe(id, TIPO_ENVIO.OFICIAL),
      config: documentoSiesa(terceroId),
      referenciaInicial: inicial?.referencia,
    });
    sedes.push({
      recepcion_id: id,
      sede: recepcion.sede?.nombre,
      estado: recepcion.estado,
      yaEnviada: oficial?.estado === "ok",
      // Enviando o sin confirmar: no está en SIESA seguro, pero tampoco se
      // puede mandar de nuevo. Ver `motivoVigente`.
      oficial: oficial
        ? { id: oficial.id, estado: oficial.estado, referencia: oficial.referencia }
        : null,
      inicial: inicial
        ? { referencia: inicial.referencia, enviado_at: inicial.enviado_at }
        : null,
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
    bloqueosGlobales.push(
      "El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).",
    );
  }
  if (!configurado)
    bloqueosGlobales.push(
      `SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`,
    );

  return {
    liquidacion: liq,
    terceros: TERCEROS_CARNES,
    tercero: terceroCarnes(terceroId),
    configurado,
    bloqueos: bloqueosGlobales,
    sedes,
    puedeEnviar:
      bloqueosGlobales.length === 0 &&
      sedes.some((s) => !s.oficial && s.bloqueos.length === 0),
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
export async function enviarOficial(liquidacionId, por, terceroId) {
  const previa = await previsualizarOficial(liquidacionId, terceroId);
  if (previa.bloqueos.length) {
    throw createError(409, previa.bloqueos.join(" "));
  }
  // Sin esto, `every` sobre una lista vacía da true y cerraría una liquidación
  // sin haber mandado nada.
  if (!previa.sedes.length) {
    throw createError(409, "La liquidación no tiene recepciones para enviar.");
  }

  const resultados = [];
  for (const s of previa.sedes) {
    if (s.yaEnviada) {
      resultados.push({
        recepcion_id: s.recepcion_id,
        sede: s.sede,
        estado: "ok",
        repetido: true,
      });
      continue;
    }
    if (s.oficial) {
      resultados.push({
        recepcion_id: s.recepcion_id,
        sede: s.sede,
        estado: s.oficial.estado,
        error: motivoVigente(s.oficial),
        referencia: s.oficial.referencia,
        envio_id: s.oficial.id,
      });
      continue;
    }
    if (s.bloqueos.length) {
      resultados.push({
        recepcion_id: s.recepcion_id,
        sede: s.sede,
        estado: "error",
        error: s.bloqueos.join(" "),
      });
      continue;
    }
    const recepcion = await cargarRecepcion(s.recepcion_id);
    const inicial = await ultimoEnvio(s.recepcion_id, TIPO_ENVIO.INICIAL);
    const fila = await ejecutarEnvio({
      recepcion,
      tipo: TIPO_ENVIO.OFICIAL,
      liquidacionId,
      por,
      terceroId,
      referenciaInicial: inicial?.referencia,
    });

    // El correo a quien anula sale por cada oficial que entró bien, y se anota
    // que salió. Si el correo falla, el envío sigue siendo ok — SIESA ya lo
    // tiene — pero queda `aviso_anulacion = false` para reenviarlo a mano.
    //
    // Si otro pedido la reservó primero (`repetido`), el correo es de él.
    if (fila.estado === "ok" && !fila.repetido) {
      await avisarAnulacion(recepcion, inicial, fila);
    }
    resultados.push({
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      estado: fila.estado,
      error: fila.repetido && fila.estado !== "ok" ? motivoVigente(fila) : fila.error,
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
    if (e1)
      fallarSiFaltaMigracion(
        e1,
        "No se pudo marcar las recepciones como enviadas",
        ["sql/007_siesa.sql", "sql/008_pagos_y_tercero.sql"],
      );

    // Con qué tercero entró queda escrito: dentro de seis meses la pregunta es
    // "¿esta liquidación fue a nombre de quién?" y la respuesta tiene que estar
    // en la fila, no en el payload de un envío.
    const tercero = terceroCarnes(terceroId);
    const { error: e2 } = await supabase
      .from("carnes_liquidaciones")
      .update({
        estado: "Cerrada",
        siesa_nit: tercero.nit,
        siesa_sucursal: tercero.sucursal,
      })
      .eq("id", liquidacionId);
    if (e2)
      fallarSiFaltaMigracion(e2, "No se pudo cerrar la liquidación", [
        "sql/007_siesa.sql",
        "sql/008_pagos_y_tercero.sql",
      ]);
  }

  return { cerrada: todasOk, resultados };
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
    const recepcion = await cargarRecepcion(data.recepcion_id);
    const inicial = await ultimoEnvio(data.recepcion_id, TIPO_ENVIO.INICIAL);
    await avisarAnulacion(recepcion, inicial, data);
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
  const { data: enCurso, error: e2 } = await supabase
    .from(TABLA)
    .select("id, referencia, enviado_at")
    .in("recepcion_id", ids)
    .eq("estado", "enviando");
  if (e2) fallarSiFaltaMigracion(e2, "Error al leer los envíos", MIGRACIONES);
  const vivos = (enCurso || []).filter(
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
  const anulados = [...(cerrados || []), ...abandonados];
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
