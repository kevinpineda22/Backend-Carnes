/**
 * Vinculación de recepciones de taller (sedes) a una preliquidación.
 *
 * Todo es puro: las RPC solo persisten el plan que sale de aquí.
 *
 * Una sede se identifica por `recepcionId` (único por sede). Campos usados:
 * `animales`, `orden`, `fechaIngreso` (YYYY-MM-DD, Bogotá), `recibidoAt`
 * (instante de cierre; hace de "hora de ingreso", que la tabla no guarda),
 * `estado`, `motivoBloqueo`, `liberadaAt`.
 */

import { enVentana, finDiaBogota, ventanaFin as calcularVentanaFin } from "./preliquidacionTiempo.js";

// ─── elegirPreliquidacion ──────────────────────────────────────────────────

/**
 * Elige la preliquidación destino de una recepción: la abierta de la especie cuya
 * ventana contiene la fecha de ingreso; si no hay, la que aún no empezó
 * (`fecha_primer_ingreso` NULL).
 *
 * Un ingreso anterior al primer ingreso solo entra mientras la preliquidación no
 * se haya liquidado (entonces la ventana se adelanta, ver `planearVentana`).
 *
 * @param {{abiertas: Array<object>, especie: string, fechaIngreso: string}} p
 * @returns {{ok: true, preliquidacionId: *} | {ok: false, motivo: "sin_preliquidacion"|"fuera_ventana"}}
 */
export function elegirPreliquidacion({ abiertas, especie, fechaIngreso }) {
  const candidatas = abiertas.filter((p) => p.especie === especie && p.estado === "abierta");
  if (candidatas.length === 0) return { ok: false, motivo: "sin_preliquidacion" };

  const contiene = (p) => {
    if (!p.fecha_primer_ingreso) return false;
    if (fechaIngreso < p.fecha_primer_ingreso && p.liquidada_at) return false;
    return enVentana({ ingreso: fechaIngreso, ventanaFin: p.ventana_fin });
  };

  const conVentana = candidatas
    .filter(contiene)
    .sort((a, b) => (a.fecha_primer_ingreso < b.fecha_primer_ingreso ? -1 : a.fecha_primer_ingreso > b.fecha_primer_ingreso ? 1 : a.id - b.id));
  if (conVentana.length > 0) return { ok: true, preliquidacionId: conVentana[0].id };

  const sinIniciar = candidatas.filter((p) => !p.fecha_primer_ingreso).sort((a, b) => a.id - b.id);
  if (sinIniciar.length > 0) return { ok: true, preliquidacionId: sinIniciar[0].id };

  return { ok: false, motivo: "fuera_ventana" };
}

// ─── planearVentana ────────────────────────────────────────────────────────

/**
 * Fin de ventana con corte manual: el mayor entre el fin por fecha y el fin del día (Bogotá) del
 * corte. Así, correr el corte para esperar sedes tardías no deja la ventana cerrada antes que él.
 * @returns {Date}
 */
export function ventanaConCorte(fechaPrimerIngreso, dias, corteManual) {
  const porFecha = calcularVentanaFin(fechaPrimerIngreso, dias);
  if (!corteManual) return porFecha;
  const delCorte = finDiaBogota(corteManual);
  return delCorte.getTime() > porFecha.getTime() ? delCorte : porFecha;
}

/**
 * Inicio y fin de ventana tras vincular una recepción: el primer ingreso los fija;
 * un ingreso más temprano los adelanta solo si todavía no se liquidó. Con `corteManual`
 * la ventana llega al menos hasta el fin del día de ese corte (`ventanaConCorte`).
 * @returns {{cambia: boolean, fechaPrimerIngreso: string, ventanaFin: Date}}
 */
export function planearVentana({ fechaPrimerIngreso, liquidadaAt, fechaIngreso, dias = 2, corteManual = null }) {
  const adelanta = !!fechaPrimerIngreso && !liquidadaAt && fechaIngreso < fechaPrimerIngreso;
  const inicia = !fechaPrimerIngreso;
  const inicio = inicia || adelanta ? fechaIngreso : fechaPrimerIngreso;
  return {
    cambia: inicia || adelanta,
    fechaPrimerIngreso: inicio,
    ventanaFin: ventanaConCorte(inicio, dias, corteManual),
  };
}

// ─── planearVinculacion ────────────────────────────────────────────────────

function tiempo(valor) {
  return valor == null ? Number.POSITIVE_INFINITY : new Date(valor).getTime();
}

/** Prioridad de vinculación: (fecha de ingreso, recibido_at con NULL al final, recepción). */
function porPrioridad(a, b) {
  if (a.fechaIngreso !== b.fechaIngreso) return a.fechaIngreso < b.fechaIngreso ? -1 : 1;
  const ta = tiempo(a.recibidoAt);
  const tb = tiempo(b.recibidoAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.recepcionId - b.recepcionId;
}

function validarAnimales(valor, nombre) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new Error(`animales ${nombre} debe ser un entero > 0: ${valor}`);
  }
}

/** Una fija consume salvo que sea un desborde que aún no se liberó (D2). */
function esDesborde(sede) {
  return sede.estado === "bloqueada" && sede.motivoBloqueo === "excede_animales" && !sede.liberadaAt;
}

/**
 * Plan de vinculación.
 *
 * - `sedesFijas`: toda sede que no está en `vinculada`. Conservan su `orden`, nunca
 *   se reordenan y consumen primero (R3). Un desborde sin liberar no consume.
 * - `sedesVinculadas` (y la `candidata`): se ordenan por prioridad y reciben los
 *   slots de `orden` que ya ocupaban más uno nuevo (`max(orden) + 1`). Las que no
 *   caben pasan a `excede` y no consumen (las siguientes más pequeñas aún pueden entrar).
 * - Con la capacidad que queda, los desbordes fijos que ahora caben salen en
 *   `liberadas`: siguen `bloqueada(excede_animales)` y consumen desde ahora.
 *
 * @returns {{orden: Array<{recepcionId: *, orden: number}>, vincular: Array<*>, excede: Array<*>,
 *   liberadas: Array<*>, restantes: number, candidata: "vinculada"|"excede"|null}}
 */
export function planearVinculacion({ animales, sedesFijas = [], sedesVinculadas = [], candidata = null }) {
  validarAnimales(animales, "de la preliquidación");
  for (const s of [...sedesFijas, ...sedesVinculadas, ...(candidata ? [candidata] : [])]) {
    validarAnimales(s.animales, `de la sede ${s.recepcionId}`);
  }
  const vistos = new Set();
  for (const s of [...sedesFijas, ...sedesVinculadas, ...(candidata ? [candidata] : [])]) {
    if (vistos.has(s.recepcionId)) throw new Error(`sede duplicada en el plan: ${s.recepcionId}`);
    vistos.add(s.recepcionId);
  }

  let restantes = animales;
  for (const f of sedesFijas) if (!esDesborde(f)) restantes -= f.animales;

  // Slots: los de las vinculadas actuales + uno nuevo para la candidata.
  const slots = sedesVinculadas.map((s) => s.orden);
  if (candidata) {
    const maximo = Math.max(0, ...sedesFijas.map((s) => s.orden), ...sedesVinculadas.map((s) => s.orden));
    slots.push(maximo + 1);
  }
  slots.sort((a, b) => a - b);

  const pool = [...sedesVinculadas, ...(candidata ? [candidata] : [])].sort(porPrioridad);
  const orden = [];
  const vincular = [];
  const excede = [];
  pool.forEach((sede, i) => {
    orden.push({ recepcionId: sede.recepcionId, orden: slots[i] });
    if (sede.animales <= restantes) {
      restantes -= sede.animales;
      vincular.push(sede.recepcionId);
    } else {
      excede.push(sede.recepcionId);
    }
  });

  const liberadas = [];
  for (const f of sedesFijas.filter(esDesborde).sort(porPrioridad)) {
    if (f.animales <= restantes) {
      restantes -= f.animales;
      liberadas.push(f.recepcionId);
    }
  }

  return {
    orden,
    vincular,
    excede,
    liberadas,
    restantes,
    candidata: candidata ? (excede.includes(candidata.recepcionId) ? "excede" : "vinculada") : null,
  };
}

// ─── planearDesvinculacion ─────────────────────────────────────────────────

/** Estados de sede que ya salieron (o están saliendo) hacia SIESA: no se desvinculan. */
const ESTADOS_ENVIADOS = new Set(["enviando", "enviada", "sin_confirmar", "anulada"]);

/**
 * Plan de desvinculación (M4): quita la sede y recalcula la capacidad igual que
 * una vinculación, de modo que los desbordes que ahora caben salen en `liberadas`
 * (si no, quedarían bloqueados para siempre aunque sobre capacidad).
 *
 * Las sedes fijas restantes no se reordenan; las vinculadas se reasignan a los
 * slots que ya ocupaban (sin el de la sede quitada).
 *
 * @returns {{ok: true, desvinculada: *} & ReturnType<typeof planearVinculacion>
 *   | {ok: false, motivo: "sede_enviada"|"no_vinculada"}}
 */
export function planearDesvinculacion({ animales, sedesFijas = [], sedesVinculadas = [], recepcionId }) {
  const objetivo = [...sedesFijas, ...sedesVinculadas].find((s) => s.recepcionId === recepcionId);
  if (!objetivo) return { ok: false, motivo: "no_vinculada" };
  if (ESTADOS_ENVIADOS.has(objetivo.estado)) return { ok: false, motivo: "sede_enviada" };

  const plan = planearVinculacion({
    animales,
    sedesFijas: sedesFijas.filter((s) => s.recepcionId !== recepcionId),
    sedesVinculadas: sedesVinculadas.filter((s) => s.recepcionId !== recepcionId),
  });
  return { ok: true, desvinculada: recepcionId, ...plan };
}
