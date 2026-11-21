import test from "node:test";
import assert from "node:assert/strict";

import { planearEnvios } from "../src/shared/preliquidacionPlan.js";

const AHORA = new Date("2026-11-20T03:00:00.000Z");
const HACE_10_MIN = new Date(AHORA.getTime() - 600_000).toISOString();

const HEADER = { orden_version: 2, liquidada_at: "2026-11-20T02:30:00.000Z" };
const HEADER_SIN_LIQUIDAR = { orden_version: 2, liquidada_at: null };

let contador = 0;
/** Sede con costeo vigente respecto de HEADER. */
const sede = (extra = {}) => ({
  id: ++contador,
  estado: "calculada",
  animales: 4,
  gasto_sede: "1000.00",
  costeo_orden_version: 2,
  costeo_animales: 4,
  intentos: 0,
  error_tipo: null,
  ultima_corrida: null,
  envio_id: null,
  claimed_at: null,
  motivo_bloqueo: null,
  motivo_pendiente: null,
  liberada_at: null,
  ...extra,
});

/** Sede cuyo costeo quedó obsoleto (otra orden_version). */
const obsoleta = (extra = {}) => sede({ costeo_orden_version: 1, ...extra });

const plan = (sedes, extra = {}) =>
  planearEnvios(sedes, {
    header: HEADER,
    origen: "schedule",
    corrida: { id: 50, resumen: {} },
    siesaActivo: true,
    ahora: AHORA,
    ...extra,
  });

const ids = (lista) => lista.map((x) => (x.sede ? x.sede.id : x.id)).sort((a, b) => a - b);

// ─── Buckets ───────────────────────────────────────────────────────────────

test("porCorregir: bloqueada(servicio_cero) una vez liquidada la preliquidación", () => {
  const s = sede({ estado: "bloqueada", motivo_bloqueo: "servicio_cero" });
  const r = plan([s]);
  assert.deepEqual(ids(r.porCorregir), [s.id]);
  assert.deepEqual(ids(r.bloqueadas), [s.id]);
});

test("porCorregir: vacío mientras la preliquidación no está liquidada", () => {
  const s = sede({ estado: "bloqueada", motivo_bloqueo: "servicio_cero" });
  const r = plan([s], { header: HEADER_SIN_LIQUIDAR });
  assert.deepEqual(ids(r.porCorregir), []);
  assert.deepEqual(ids(r.bloqueadas), [s.id]);
  assert.equal(r.pendientes, 0);
});

test("porReevaluar: bloqueada(armado_invalido|costeo_invalido) no reevaluada en esta corrida", () => {
  const a = sede({ estado: "bloqueada", motivo_bloqueo: "armado_invalido" });
  const c = sede({ estado: "bloqueada", motivo_bloqueo: "costeo_invalido" });
  const r = plan([a, c]);
  assert.deepEqual(ids(r.porReevaluar), [a.id, c.id].sort((x, y) => x - y));
});

test("porReevaluar: una sede ya reevaluada en la corrida no vuelve a entrar", () => {
  const a = sede({ estado: "bloqueada", motivo_bloqueo: "armado_invalido" });
  const b = sede({ estado: "bloqueada", motivo_bloqueo: "costeo_invalido" });
  const r = plan([a, b], { corrida: { id: 50, resumen: { reevaluadas: [a.id] } } });
  assert.deepEqual(ids(r.porReevaluar), [b.id]);
  assert.equal(r.pendientes, 1);
});

test("porCalcular: vinculada solo cuando la preliquidación está liquidada", () => {
  const v = sede({ estado: "vinculada", gasto_sede: null, costeo_orden_version: null, costeo_animales: null });
  assert.deepEqual(ids(plan([v]).porCalcular), [v.id]);
  assert.deepEqual(ids(plan([v], { header: HEADER_SIN_LIQUIDAR }).porCalcular), []);
});

test("porCalcular: calculada / simulada / lista_para_enviar con costeo obsoleto", () => {
  const c = obsoleta({ estado: "calculada" });
  const s = obsoleta({ estado: "simulada" });
  const l = obsoleta({ estado: "lista_para_enviar" });
  const vigente = sede({ estado: "lista_para_enviar" });
  const r = plan([c, s, l, vigente]);
  assert.deepEqual(ids(r.porCalcular), [c.id, s.id, l.id].sort((x, y) => x - y));
});

test("porCalcular: gasto_sede NULL y animales distintos también cuentan como obsoleto", () => {
  const sinMonto = sede({ estado: "calculada", gasto_sede: null });
  const otrosAnimales = sede({ estado: "calculada", costeo_animales: 3 });
  const r = plan([sinMonto, otrosAnimales]);
  assert.deepEqual(ids(r.porCalcular), [sinMonto.id, otrosAnimales.id].sort((x, y) => x - y));
});

test("porCalcular: bloqueada(excede_animales) liberada se encola a costeo", () => {
  const lib = sede({ estado: "bloqueada", motivo_bloqueo: "excede_animales", liberada_at: "2026-11-20T02:40:00.000Z", gasto_sede: null });
  const noLib = sede({ estado: "bloqueada", motivo_bloqueo: "excede_animales", liberada_at: null, gasto_sede: null });
  const r = plan([lib, noLib]);
  assert.deepEqual(ids(r.porCalcular), [lib.id]);
});

test("porCalcular: error solo se recostea con origen admin", () => {
  const e = obsoleta({ estado: "error", error_tipo: "permanente" });
  assert.deepEqual(ids(plan([e]).porCalcular), []);
  assert.deepEqual(ids(plan([e], { origen: "admin" }).porCalcular), [e.id]);
});

test("porEnviar: calculada vigente, con resetIntentos=false y sin recosteo previo", () => {
  const c = sede();
  const r = plan([c]);
  assert.equal(r.porEnviar.length, 1);
  assert.equal(r.porEnviar[0].sede.id, c.id);
  assert.equal(r.porEnviar[0].resetIntentos, false);
  assert.equal(r.porEnviar[0].requiereCosteo, false);
});

test("porEnviar: una vinculada se reclama solo tras costearse (requiereCosteo)", () => {
  const v = sede({ estado: "vinculada", gasto_sede: null, costeo_orden_version: null, costeo_animales: null });
  const r = plan([v]);
  assert.deepEqual(ids(r.porCalcular), [v.id]);
  assert.equal(r.porEnviar.length, 1);
  assert.equal(r.porEnviar[0].sede.id, v.id);
  assert.equal(r.porEnviar[0].requiereCosteo, true);
});

test("porEnviar: una calculada obsoleta se recostea y luego se reclama", () => {
  const c = obsoleta();
  const r = plan([c]);
  assert.deepEqual(ids(r.porCalcular), [c.id]);
  assert.equal(r.porEnviar[0].requiereCosteo, true);
});

test("porEnviar: error transitorio con intentos < 3 de otra corrida", () => {
  const e = sede({ estado: "error", error_tipo: "transitorio", intentos: 1, ultima_corrida: 49 });
  const r = plan([e]);
  assert.deepEqual(ids(r.porEnviar), [e.id]);
});

test("porEnviar: enviando abandonado sin envio_id", () => {
  const e = sede({ estado: "enviando", envio_id: null, claimed_at: HACE_10_MIN });
  const r = plan([e]);
  assert.deepEqual(ids(r.porEnviar), [e.id]);
  assert.deepEqual(ids(r.enCurso), []);
});

test("porEnviar admin: lista_para_enviar / error / simulada con reinicio de intentos y recosteo", () => {
  const l = sede({ estado: "lista_para_enviar" });
  const e = sede({ estado: "error", error_tipo: "permanente", intentos: 3 });
  const s = sede({ estado: "simulada" });
  const r = plan([l, e, s], { origen: "admin" });
  assert.deepEqual(ids(r.porEnviar), [l.id, e.id, s.id].sort((x, y) => x - y));
  for (const item of r.porEnviar) {
    assert.equal(item.resetIntentos, true);
    assert.equal(item.requiereCosteo, true, "el admin siempre recostea antes de reclamar (T2)");
  }
  assert.deepEqual(ids(r.porCalcular), [l.id, e.id, s.id].sort((x, y) => x - y));
});

test("porSimular: con SIESA apagado las calculadas van a simulada y no a porEnviar", () => {
  const c = sede();
  const r = plan([c], { siesaActivo: false });
  assert.deepEqual(ids(r.porSimular), [c.id]);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.equal(r.pendientes, 1);
});

test("porSimular: una vinculada con SIESA apagado se costea y luego pasa a simulada", () => {
  const v = sede({ estado: "vinculada", gasto_sede: null, costeo_orden_version: null, costeo_animales: null });
  const r = plan([v], { siesaActivo: false });
  assert.deepEqual(ids(r.porCalcular), [v.id]);
  assert.deepEqual(ids(r.porSimular), [v.id]);
  assert.deepEqual(ids(r.porEnviar), []);
});

test("porSimular: una simulada con SIESA apagado no entra a ningún bucket de acción", () => {
  const s = sede({ estado: "simulada" });
  const r = plan([s], { siesaActivo: false });
  assert.deepEqual(ids(r.porSimular), []);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.equal(r.pendientes, 0);
});

test("listasParaEnviar y enCurso son informativos", () => {
  const l = sede({ estado: "lista_para_enviar" });
  const e = sede({ estado: "enviando", envio_id: 9, claimed_at: HACE_10_MIN });
  const r = plan([l, e]);
  assert.deepEqual(ids(r.listasParaEnviar), [l.id]);
  assert.deepEqual(ids(r.enCurso), [e.id]);
});

test("bloqueadas lista todas las bloqueadas, sin importar el motivo", () => {
  const a = sede({ estado: "bloqueada", motivo_bloqueo: "utilidad_negativa" });
  const b = sede({ estado: "bloqueada", motivo_bloqueo: "excede_animales" });
  assert.deepEqual(ids(plan([a, b]).bloqueadas), [a.id, b.id].sort((x, y) => x - y));
});

// ─── pendientes: lo accionable AHORA por este origen ───────────────────────

test("pendientes cuenta la unión de los buckets sin duplicar sedes", () => {
  const v = sede({ estado: "vinculada", gasto_sede: null, costeo_orden_version: null, costeo_animales: null });
  const c = sede();
  const cero = sede({ estado: "bloqueada", motivo_bloqueo: "servicio_cero" });
  const arm = sede({ estado: "bloqueada", motivo_bloqueo: "armado_invalido" });
  const sim = obsoleta({ estado: "simulada" });
  // v: porCalcular+porEnviar (1), c: porEnviar (1), cero: porCorregir (1), arm: porReevaluar (1),
  // sim: porCalcular, y tras recostear queda `calculada` y se reclama (1)
  assert.equal(plan([v, c, cero, arm, sim]).pendientes, 5);
});

test("pendientes excluye lista_para_enviar y error permanente para orígenes automáticos", () => {
  const l = sede({ estado: "lista_para_enviar" });
  const p = sede({ estado: "error", error_tipo: "permanente", intentos: 1, ultima_corrida: 49 });
  const agotada = sede({ estado: "error", error_tipo: "transitorio", intentos: 3, ultima_corrida: 49 });
  assert.equal(plan([l, p, agotada]).pendientes, 0);
  assert.equal(plan([l, p, agotada], { origen: "admin" }).pendientes, 3);
});

test("pendientes excluye bloqueada(excede_animales sin liberar | utilidad_negativa)", () => {
  const e = sede({ estado: "bloqueada", motivo_bloqueo: "excede_animales", liberada_at: null });
  const u = sede({ estado: "bloqueada", motivo_bloqueo: "utilidad_negativa" });
  assert.equal(plan([e, u]).pendientes, 0);
});

test("pendientes excluye vinculada mientras no se liquida (antes del corte)", () => {
  const v = sede({ estado: "vinculada", gasto_sede: null, costeo_orden_version: null, costeo_animales: null });
  assert.equal(plan([v], { header: HEADER_SIN_LIQUIDAR }).pendientes, 0);
  assert.equal(plan([v]).pendientes, 1);
});

test("pendientes excluye inicial_pendiente en automático (se reintenta pero no hace girar el flujo)", () => {
  const i = sede({ motivo_pendiente: "inicial_pendiente" });
  const r = plan([i]);
  assert.deepEqual(ids(r.porEnviar), [i.id], "se vuelve a comprobar la inicial en cada corrida");
  assert.equal(r.pendientes, 0);
});

test("pendientes excluye error transitorio ya intentado en esta corrida", () => {
  const e = sede({ estado: "error", error_tipo: "transitorio", intentos: 1, ultima_corrida: 50 });
  const r = plan([e]);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.equal(r.pendientes, 0);
});

test("pendientes excluye bloqueadas ya reevaluadas, sin_confirmar, anulada y enviando no abandonado", () => {
  const rev = sede({ estado: "bloqueada", motivo_bloqueo: "costeo_invalido" });
  const sc = sede({ estado: "sin_confirmar" });
  const an = sede({ estado: "anulada" });
  const en = sede({ estado: "enviando", envio_id: null, claimed_at: new Date(AHORA.getTime() - 30_000).toISOString() });
  const r = plan([rev, sc, an, en], { corrida: { id: 50, resumen: { reevaluadas: [rev.id] } } });
  assert.equal(r.pendientes, 0);
  assert.deepEqual(ids(r.enCurso), [en.id]);
});

test("pendientes con SIESA apagado excluye simulada (no hay nada accionable)", () => {
  const s = sede({ estado: "simulada" });
  assert.equal(plan([s], { siesaActivo: false }).pendientes, 0);
});

test("planearEnvios rechaza argumentos incompletos y orígenes desconocidos", () => {
  assert.throws(() => planearEnvios([sede()], { origen: "schedule", corrida: { id: 1 }, ahora: AHORA }), /header/);
  assert.throws(() => planearEnvios([sede()], { header: HEADER, origen: "schedule", ahora: AHORA }), /corrida/);
  assert.throws(() => plan([sede()], { origen: "otro" }), /origen/);
});

// ═══ M1: ninguna sede queda varada cuando el costeo se vuelve obsoleto ═════

test("[M1] error(transitorio, intentos<3) obsoleto va a porCalcular y luego se reclama (automático)", () => {
  const e = obsoleta({ estado: "error", error_tipo: "transitorio", intentos: 1, ultima_corrida: 49 });
  const r = plan([e]);
  assert.deepEqual(ids(r.porCalcular), [e.id]);
  assert.equal(r.porEnviar.length, 1);
  assert.equal(r.porEnviar[0].sede.id, e.id);
  assert.equal(r.porEnviar[0].requiereCosteo, true);
  assert.equal(r.porEnviar[0].resetIntentos, false, "el recosteo automático no reinicia intentos");
  assert.equal(r.pendientes, 1);
});

test("[M1] error(transitorio) obsoleto ya intentado en esta corrida no se recostea ni cuenta como pendiente", () => {
  const e = obsoleta({ estado: "error", error_tipo: "transitorio", intentos: 1, ultima_corrida: 50 });
  const r = plan([e]);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.equal(r.pendientes, 0);
});

test("[M1] error(transitorio) obsoleto con 3 intentos, o permanente, no se recostea en automático", () => {
  const agotada = obsoleta({ estado: "error", error_tipo: "transitorio", intentos: 3, ultima_corrida: 49 });
  const permanente = obsoleta({ estado: "error", error_tipo: "permanente", intentos: 1, ultima_corrida: 49 });
  const r = plan([agotada, permanente]);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.equal(r.pendientes, 0);
});

test("[M1] enviando abandonado con costeo obsoleto se recostea y luego se reclama", () => {
  const e = obsoleta({ estado: "enviando", envio_id: null, claimed_at: HACE_10_MIN, intentos: 1 });
  const r = plan([e]);
  assert.deepEqual(ids(r.porCalcular), [e.id]);
  assert.equal(r.porEnviar[0].sede.id, e.id);
  assert.equal(r.porEnviar[0].requiereCosteo, true);
  assert.deepEqual(ids(r.enCurso), []);
  assert.equal(r.pendientes, 1);
});

test("[M1] enviando reciente (no abandonado) con costeo obsoleto no se toca y no cuenta como pendiente", () => {
  const reciente = new Date(AHORA.getTime() - 30_000).toISOString();
  const e = obsoleta({ estado: "enviando", envio_id: null, claimed_at: reciente });
  const r = plan([e]);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.deepEqual(ids(r.enCurso), [e.id]);
  assert.equal(r.pendientes, 0);
});

test("[M1] enviando con envio_id y costeo obsoleto nunca se recostea (ya hay fila en SIESA)", () => {
  const e = obsoleta({ estado: "enviando", envio_id: 9, claimed_at: HACE_10_MIN });
  const r = plan([e]);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.deepEqual(ids(r.enCurso), [e.id]);
  assert.equal(r.pendientes, 0);
});

// ═══ M6: las sedes liberadas por desborde esperan a que la preliquidación se liquide ═══

const LIBERADA = { estado: "bloqueada", motivo_bloqueo: "excede_animales", liberada_at: "2026-11-20T02:40:00.000Z", gasto_sede: null, costeo_orden_version: null, costeo_animales: null };

test("[M6] bloqueada(excede, liberada) con liquidada_at NULL no entra a porCalcular ni a pendientes", () => {
  const l = sede(LIBERADA);
  const r = plan([l], { header: HEADER_SIN_LIQUIDAR });
  assert.deepEqual(ids(r.porCalcular), []);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.deepEqual(ids(r.bloqueadas), [l.id]);
  assert.equal(r.pendientes, 0);
});

test("[M6] con liquidada_at puesto la liberada se encola a costeo (lista_para_enviar) y nunca se reclama en automático", () => {
  const l = sede(LIBERADA);
  const r = plan([l]);
  assert.deepEqual(ids(r.porCalcular), [l.id]);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.equal(r.pendientes, 1);
});

test("[M6] tampoco el admin la reclama antes de costearse: solo se costea", () => {
  const l = sede(LIBERADA);
  const r = plan([l], { origen: "admin" });
  assert.deepEqual(ids(r.porCalcular), [l.id]);
  assert.deepEqual(ids(r.porEnviar), []);
});

// ═══ M5: con SIESA apagado el admin no obtiene un Enviar sin resultado ═════

test("[M5] admin con SIESA apagado: lista_para_enviar / error / simulada van a noReclamables(siesa_apagado)", () => {
  const l = sede({ estado: "lista_para_enviar" });
  const e = sede({ estado: "error", error_tipo: "permanente", intentos: 1 });
  const s = sede({ estado: "simulada" });
  const r = plan([l, e, s], { origen: "admin", siesaActivo: false });
  assert.deepEqual(ids(r.porEnviar), []);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.deepEqual(ids(r.noReclamables), [l.id, e.id, s.id].sort((x, y) => x - y));
  for (const item of r.noReclamables) assert.equal(item.motivo, "siesa_apagado");
  assert.equal(r.pendientes, 0);
});

test("[M5] con SIESA activo el admin no tiene noReclamables", () => {
  const r = plan([sede({ estado: "simulada" })], { origen: "admin", siesaActivo: true });
  assert.deepEqual(r.noReclamables, []);
  assert.equal(r.porEnviar.length, 1);
});

test("[M5] admin con SIESA apagado y una calculada: se simula como siempre", () => {
  const c = sede();
  const r = plan([c], { origen: "admin", siesaActivo: false });
  assert.deepEqual(ids(r.porSimular), [c.id]);
  assert.deepEqual(r.noReclamables, []);
});

test("[M5] automático con SIESA apagado no produce noReclamables (esas sedes ni se consideran)", () => {
  const r = plan([sede({ estado: "simulada" }), sede({ estado: "lista_para_enviar" })], { siesaActivo: false });
  assert.deepEqual(r.noReclamables, []);
});

// ─── I1: servicio_cero ya bloqueada no genera trabajo por barrido ──────────

test("I1: bloqueada(servicio_cero) sin liquidar no entra a ningún bucket accionable ni a pendientes", () => {
  const cero = sede({ estado: "bloqueada", motivo_bloqueo: "servicio_cero" });
  const r = plan([cero], { header: HEADER_SIN_LIQUIDAR });
  assert.deepEqual(ids(r.porCorregir), []);
  assert.deepEqual(ids(r.porReevaluar), []);
  assert.deepEqual(ids(r.porCalcular), []);
  assert.deepEqual(ids(r.porEnviar), []);
  assert.equal(r.pendientes, 0);
  assert.deepEqual(ids(r.bloqueadas), [cero.id]);
});
