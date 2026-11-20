import test from "node:test";
import assert from "node:assert/strict";

import {
  elegirPreliquidacion,
  planearVinculacion,
  planearVentana,
} from "../src/shared/preliquidacionVinculacion.js";

// Una sede se identifica por su recepcionId (UNIQUE en carnes_preliquidacion_sedes).
// Campos: animales, orden, fechaIngreso (YYYY-MM-DD, Bogotá), recibidoAt, estado,
// motivoBloqueo, liberadaAt.
const vinculada = (recepcionId, animales, orden, extra = {}) => ({
  recepcionId,
  animales,
  orden,
  estado: "vinculada",
  fechaIngreso: "2026-12-01",
  recibidoAt: `2026-12-01T1${recepcionId}:00:00.000Z`,
  ...extra,
});
const fija = (recepcionId, animales, orden, estado = "calculada", extra = {}) =>
  vinculada(recepcionId, animales, orden, { estado, ...extra });
const excedida = (recepcionId, animales, orden, extra = {}) =>
  fija(recepcionId, animales, orden, "bloqueada", { motivoBloqueo: "excede_animales", liberadaAt: null, ...extra });
const candidata = (recepcionId, animales, extra = {}) => ({
  recepcionId,
  animales,
  fechaIngreso: "2026-12-01",
  recibidoAt: `2026-12-01T1${recepcionId}:00:00.000Z`,
  ...extra,
});
const ordenPorRecepcion = (plan) => Object.fromEntries(plan.orden.map((o) => [o.recepcionId, o.orden]));

// ─── elegirPreliquidacion ──────────────────────────────────────────────────

const ABIERTA = {
  id: 10,
  especie: "res",
  estado: "abierta",
  fecha_primer_ingreso: "2026-12-01",
  ventana_fin: "2026-12-03T04:59:59.999Z", // 2 días calendario Bogotá: 1 y 2 de diciembre
  liquidada_at: null,
};

test("elegirPreliquidacion: elige la abierta de la especie cuya ventana contiene el ingreso", () => {
  for (const fechaIngreso of ["2026-12-01", "2026-12-02"]) {
    assert.deepEqual(elegirPreliquidacion({ abiertas: [ABIERTA], especie: "res", fechaIngreso }), {
      ok: true,
      preliquidacionId: 10,
    });
  }
});

test("elegirPreliquidacion B-S6: sin preliquidación abierta de la especie -> sin_preliquidacion", () => {
  assert.deepEqual(elegirPreliquidacion({ abiertas: [], especie: "cerdo", fechaIngreso: "2026-12-01" }), {
    ok: false,
    motivo: "sin_preliquidacion",
  });
  // Una abierta de otra especie o cerrada/anulada no cuenta.
  const otras = [
    { ...ABIERTA, especie: "res", estado: "cerrada" },
    { ...ABIERTA, id: 11, especie: "res", estado: "anulada" },
    { ...ABIERTA, id: 12, especie: "cerdo" },
  ];
  assert.equal(elegirPreliquidacion({ abiertas: otras, especie: "res", fechaIngreso: "2026-12-01" }).motivo, "sin_preliquidacion");
});

test("elegirPreliquidacion: ingreso posterior al fin de ventana -> fuera_ventana", () => {
  assert.deepEqual(elegirPreliquidacion({ abiertas: [ABIERTA], especie: "res", fechaIngreso: "2026-12-03" }), {
    ok: false,
    motivo: "fuera_ventana",
  });
});

test("elegirPreliquidacion: sin primer ingreso (no iniciada) acepta cualquier ingreso", () => {
  const sinIniciar = { ...ABIERTA, id: 20, fecha_primer_ingreso: null, ventana_fin: null };
  assert.deepEqual(elegirPreliquidacion({ abiertas: [sinIniciar], especie: "res", fechaIngreso: "2026-12-09" }), {
    ok: true,
    preliquidacionId: 20,
  });
});

test("elegirPreliquidacion: prefiere la que contiene el ingreso sobre la no iniciada", () => {
  const sinIniciar = { ...ABIERTA, id: 20, fecha_primer_ingreso: null, ventana_fin: null };
  const r = elegirPreliquidacion({ abiertas: [sinIniciar, ABIERTA], especie: "res", fechaIngreso: "2026-12-02" });
  assert.deepEqual(r, { ok: true, preliquidacionId: 10 });
});

test("elegirPreliquidacion: ingreso anterior al primer ingreso solo si aún no se liquidó", () => {
  const abierta = { ...ABIERTA };
  assert.equal(elegirPreliquidacion({ abiertas: [abierta], especie: "res", fechaIngreso: "2026-11-30" }).ok, true);
  const liquidada = { ...ABIERTA, liquidada_at: "2026-12-02T02:30:00.000Z" };
  assert.deepEqual(elegirPreliquidacion({ abiertas: [liquidada], especie: "res", fechaIngreso: "2026-11-30" }), {
    ok: false,
    motivo: "fuera_ventana",
  });
});

// ─── planearVentana ────────────────────────────────────────────────────────

test("planearVentana: el primer ingreso fija fecha_primer_ingreso y ventana_fin", () => {
  const r = planearVentana({ fechaPrimerIngreso: null, liquidadaAt: null, fechaIngreso: "2026-12-01" });
  assert.equal(r.cambia, true);
  assert.equal(r.fechaPrimerIngreso, "2026-12-01");
  assert.equal(r.ventanaFin.toISOString(), "2026-12-03T04:59:59.999Z");
});

test("planearVentana: un ingreso más temprano adelanta el inicio solo si no se liquidó", () => {
  const adelanta = planearVentana({ fechaPrimerIngreso: "2026-12-02", liquidadaAt: null, fechaIngreso: "2026-12-01" });
  assert.equal(adelanta.cambia, true);
  assert.equal(adelanta.fechaPrimerIngreso, "2026-12-01");

  const congelada = planearVentana({
    fechaPrimerIngreso: "2026-12-02",
    liquidadaAt: "2026-12-03T02:30:00.000Z",
    fechaIngreso: "2026-12-01",
  });
  assert.equal(congelada.cambia, false);
  assert.equal(congelada.fechaPrimerIngreso, "2026-12-02");
});

test("planearVentana: un ingreso igual o posterior no cambia nada", () => {
  const r = planearVentana({ fechaPrimerIngreso: "2026-12-01", liquidadaAt: null, fechaIngreso: "2026-12-02" });
  assert.equal(r.cambia, false);
  assert.equal(r.fechaPrimerIngreso, "2026-12-01");
});

// ─── planearVinculacion ────────────────────────────────────────────────────

test("planearVinculacion B-S2: orden C, A, B por (fecha, recibido_at) y restantes 0", () => {
  // A (4) y B (5) ya vinculadas; llega C (1) con fecha de ingreso anterior.
  const A = vinculada(1, 4, 1, { fechaIngreso: "2026-12-01", recibidoAt: "2026-12-01T13:00:00.000Z" });
  const B = vinculada(2, 5, 2, { fechaIngreso: "2026-12-01", recibidoAt: "2026-12-01T14:30:00.000Z" });
  const C = candidata(3, 1, { fechaIngreso: "2026-11-30", recibidoAt: "2026-12-01T18:00:00.000Z" });
  const plan = planearVinculacion({ animales: 10, sedesVinculadas: [A, B], candidata: C });

  assert.deepEqual(ordenPorRecepcion(plan), { 3: 1, 1: 2, 2: 3 });
  assert.deepEqual(plan.vincular, [3, 1, 2]);
  assert.deepEqual(plan.excede, []);
  assert.equal(plan.restantes, 0);
  assert.equal(plan.candidata, "vinculada");
});

test("planearVinculacion B-S3: agota exacto, restantes 0, sin excede", () => {
  const plan = planearVinculacion({
    animales: 10,
    sedesVinculadas: [vinculada(1, 7, 1)],
    candidata: candidata(2, 3),
  });
  assert.equal(plan.restantes, 0);
  assert.deepEqual(plan.excede, []);
  assert.equal(plan.candidata, "vinculada");
});

test("planearVinculacion B-S4: desborde -> la candidata excede, no consume y las otras no cambian", () => {
  const A = vinculada(1, 4, 1);
  const B = vinculada(2, 5, 2);
  const C = candidata(3, 3);
  const plan = planearVinculacion({ animales: 10, sedesVinculadas: [A, B], candidata: C });

  assert.equal(plan.candidata, "excede");
  assert.deepEqual(plan.excede, [3]);
  assert.deepEqual(plan.vincular, [1, 2]);
  assert.equal(plan.restantes, 1);
  assert.equal(ordenPorRecepcion(plan)[1], 1);
  assert.equal(ordenPorRecepcion(plan)[2], 2);
});

test("planearVinculacion: una sede de 1 animal cabe en el último hueco (no se corta la fila)", () => {
  const plan = planearVinculacion({
    animales: 10,
    sedesVinculadas: [vinculada(1, 4, 1), vinculada(2, 5, 2)],
    candidata: candidata(3, 1, { recibidoAt: "2026-12-01T20:00:00.000Z" }),
  });
  assert.equal(plan.candidata, "vinculada");
  assert.equal(plan.restantes, 0);
});

test("planearVinculacion: la candidata sin hermanos recibe orden 1; con fijas recibe max(orden)+1", () => {
  const sola = planearVinculacion({ animales: 5, candidata: candidata(1, 2) });
  assert.deepEqual(ordenPorRecepcion(sola), { 1: 1 });

  const conFijas = planearVinculacion({
    animales: 20,
    sedesFijas: [fija(1, 4, 1), fija(2, 4, 5)],
    candidata: candidata(3, 2),
  });
  assert.deepEqual(ordenPorRecepcion(conFijas), { 3: 6 });
});

test("planearVinculacion: desempate por recepcion_id y recibido_at NULL al final", () => {
  const iguales = planearVinculacion({
    animales: 30,
    sedesVinculadas: [
      vinculada(9, 1, 1, { fechaIngreso: "2026-12-01", recibidoAt: "2026-12-01T10:00:00.000Z" }),
      vinculada(4, 1, 2, { fechaIngreso: "2026-12-01", recibidoAt: "2026-12-01T10:00:00.000Z" }),
    ],
    candidata: candidata(6, 1, { fechaIngreso: "2026-12-01", recibidoAt: "2026-12-01T10:00:00.000Z" }),
  });
  assert.deepEqual(iguales.vincular, [4, 6, 9]);

  const conNull = planearVinculacion({
    animales: 30,
    sedesVinculadas: [vinculada(1, 1, 1, { recibidoAt: null })],
    candidata: candidata(2, 1, { recibidoAt: "2026-12-01T23:00:00.000Z" }),
  });
  assert.deepEqual(conNull.vincular, [2, 1]);
});

test("planearVinculacion R3: las sedes fijas jamás se reordenan y consumen primero", () => {
  // Fija con fecha posterior y orden 1; una vinculada y una candidata más tempranas no la adelantan.
  const F = fija(7, 6, 1, "calculada", { fechaIngreso: "2026-12-02" });
  const V = vinculada(1, 3, 2, { fechaIngreso: "2026-12-01" });
  const C = candidata(2, 3, { fechaIngreso: "2026-11-30" });
  const plan = planearVinculacion({ animales: 10, sedesFijas: [F], sedesVinculadas: [V], candidata: C });

  assert.ok(!("7" in ordenPorRecepcion(plan)), "la fija no aparece en el plan de orden");
  // Solo quedan 4 animales para las vinculadas: entra la de fecha más temprana (C=3) y V (3) excede.
  assert.deepEqual(plan.vincular, [2]);
  assert.deepEqual(plan.excede, [1]);
  assert.equal(plan.restantes, 1);
  // Reasigna los slots que ya ocupaban (2) más uno nuevo (max+1 = 3).
  assert.deepEqual(ordenPorRecepcion(plan), { 2: 2, 1: 3 });
});

test("planearVinculacion: las vinculadas se reasignan a los slots que ya ocupaban más uno nuevo", () => {
  const A = vinculada(1, 2, 3, { fechaIngreso: "2026-12-02" });
  const B = vinculada(2, 2, 7, { fechaIngreso: "2026-12-03" });
  const C = candidata(3, 2, { fechaIngreso: "2026-12-01" });
  const plan = planearVinculacion({ animales: 20, sedesFijas: [fija(9, 1, 5)], sedesVinculadas: [A, B], candidata: C });
  // Slots: 3 y 7 (los suyos) + 8 (max global 7, +1).
  assert.deepEqual(ordenPorRecepcion(plan), { 3: 3, 1: 7, 2: 8 });
});

test("planearVinculacion D2: una fija bloqueada por exceso sin liberar no consume; liberada sí", () => {
  const sinLiberar = planearVinculacion({
    animales: 10,
    sedesFijas: [excedida(1, 4, 1)],
    sedesVinculadas: [vinculada(2, 6, 2)],
  });
  // 4 animales de la excedida NO cuentan: sobra capacidad y se libera.
  assert.deepEqual(sinLiberar.liberadas, [1]);

  const liberada = planearVinculacion({
    animales: 10,
    sedesFijas: [excedida(1, 4, 1, { liberadaAt: "2026-12-02T10:00:00.000Z" })],
    sedesVinculadas: [vinculada(2, 6, 2)],
  });
  assert.deepEqual(liberada.liberadas, []);
  assert.equal(liberada.restantes, 0);
});

test("planearVinculacion B-S5: al subir los animales una excedida cabe y sale en liberadas (sin consumir antes)", () => {
  const A = vinculada(1, 4, 1);
  const B = vinculada(2, 5, 2);
  const C = excedida(3, 3, 3);
  // animales 10: C no cabe (restan 1).
  const antes = planearVinculacion({ animales: 10, sedesFijas: [C], sedesVinculadas: [A, B] });
  assert.deepEqual(antes.liberadas, []);
  assert.equal(antes.restantes, 1);
  // animales 12: restan 3 y C se libera.
  const despues = planearVinculacion({ animales: 12, sedesFijas: [C], sedesVinculadas: [A, B] });
  assert.deepEqual(despues.liberadas, [3]);
  assert.equal(despues.restantes, 0);
});

test("planearVinculacion: entradas inválidas se rechazan", () => {
  assert.throws(() => planearVinculacion({ animales: 0, candidata: candidata(1, 1) }), /animales/i);
  assert.throws(() => planearVinculacion({ animales: 5, candidata: candidata(1, 0) }), /animales/i);
  assert.throws(() => planearVinculacion({ animales: 5, candidata: candidata(1, 1.5) }), /animales/i);
  assert.throws(
    () => planearVinculacion({ animales: 5, sedesVinculadas: [vinculada(1, 1, 1)], candidata: candidata(1, 1) }),
    /duplicad/i,
  );
});
