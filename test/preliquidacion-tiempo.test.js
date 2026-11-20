import test from "node:test";
import assert from "node:assert/strict";

import {
  corteBogota,
  esPrecorte,
  ventanaFin,
  enVentana,
  debeLiquidar,
  corridaPerdida,
  ventanaVencida,
} from "../src/shared/preliquidacionTiempo.js";

// Bogotá es UTC-5 fijo (sin horario de verano). 21:30 Bogotá = 02:30 UTC del día siguiente.
const iso = (d) => d.toISOString();

// ─── corteBogota ───────────────────────────────────────────────────────────

test("corteBogota: 21:30 Bogotá de la fecha es 02:30 UTC del día siguiente", () => {
  assert.equal(iso(corteBogota("2026-11-20")), "2026-11-21T02:30:00.000Z");
});

test("corteBogota: respeta una hora distinta y cruza fin de mes y de año", () => {
  assert.equal(iso(corteBogota("2026-11-20", "08:05")), "2026-11-20T13:05:00.000Z");
  assert.equal(iso(corteBogota("2026-12-31")), "2027-01-01T02:30:00.000Z");
  assert.equal(iso(corteBogota("2026-02-28")), "2026-03-01T02:30:00.000Z");
});

test("corteBogota: rechaza fechas y horas mal formadas", () => {
  for (const f of [undefined, null, "", "2026-13-01", "2026-02-30", "20/11/2026", 5]) {
    assert.throws(() => corteBogota(f), /fecha/i, `fecha ${JSON.stringify(f)}`);
  }
  for (const h of ["25:00", "9:5", "21:60", ""]) {
    assert.throws(() => corteBogota("2026-11-20", h), /hora/i, `hora ${JSON.stringify(h)}`);
  }
});

// ─── esPrecorte ────────────────────────────────────────────────────────────

test("esPrecorte: D1 20:59 / 21:30 / 21:31 Bogotá (el borde 21:30 cuenta como precorte)", () => {
  const base = { fechaPrimerIngreso: "2026-11-20", liquidadaAt: null };
  assert.equal(esPrecorte({ ...base, servicioAt: new Date("2026-11-21T01:59:00.000Z") }), true); // 20:59
  assert.equal(esPrecorte({ ...base, servicioAt: new Date("2026-11-21T02:30:00.000Z") }), true); // 21:30
  assert.equal(esPrecorte({ ...base, servicioAt: new Date("2026-11-21T02:31:00.000Z") }), false); // 21:31
});

test("esPrecorte: bordes de desplazamiento UTC entre 19:00 y 23:59 Bogotá", () => {
  const base = { fechaPrimerIngreso: "2026-11-20", liquidadaAt: null };
  assert.equal(esPrecorte({ ...base, servicioAt: new Date("2026-11-21T00:00:00.000Z") }), true); // 19:00
  assert.equal(esPrecorte({ ...base, servicioAt: new Date("2026-11-21T04:59:00.000Z") }), false); // 23:59
  // Un servicio anterior al primer ingreso es precorte.
  assert.equal(esPrecorte({ ...base, servicioAt: new Date("2026-11-20T03:00:00.000Z") }), true);
});

test("esPrecorte: false si ya hay liquidadaAt; true si no hay fechaPrimerIngreso", () => {
  const servicioAt = new Date("2026-11-20T15:00:00.000Z");
  assert.equal(
    esPrecorte({ servicioAt, fechaPrimerIngreso: "2026-11-20", liquidadaAt: new Date("2026-11-21T03:00:00.000Z") }),
    false,
  );
  assert.equal(esPrecorte({ servicioAt, fechaPrimerIngreso: null, liquidadaAt: null }), true);
  assert.equal(esPrecorte({ servicioAt, fechaPrimerIngreso: undefined, liquidadaAt: undefined }), true);
});

// ─── ventanaFin / enVentana ────────────────────────────────────────────────

test("ventanaFin: 2 días calendario Bogotá, hasta 23:59:59.999 del segundo día", () => {
  assert.equal(iso(ventanaFin("2026-11-20")), "2026-11-22T04:59:59.999Z"); // 21-nov 23:59:59.999 Bogotá
});

test("ventanaFin: dias configurable y cruce de mes/año", () => {
  assert.equal(iso(ventanaFin("2026-11-20", 1)), "2026-11-21T04:59:59.999Z");
  assert.equal(iso(ventanaFin("2026-11-20", 3)), "2026-11-23T04:59:59.999Z");
  assert.equal(iso(ventanaFin("2026-12-31")), "2027-01-02T04:59:59.999Z");
});

test("ventanaFin: dias inválido se rechaza", () => {
  for (const d of [0, -1, 1.5, "2", NaN]) {
    assert.throws(() => ventanaFin("2026-11-20", d), /dias/i);
  }
});

test("enVentana: el último milisegundo entra, el siguiente no; acepta fecha o instante", () => {
  const fin = ventanaFin("2026-11-20");
  assert.equal(enVentana({ ingreso: "2026-11-20", ventanaFin: fin }), true);
  assert.equal(enVentana({ ingreso: "2026-11-21", ventanaFin: fin }), true);
  assert.equal(enVentana({ ingreso: "2026-11-22", ventanaFin: fin }), false);
  assert.equal(enVentana({ ingreso: new Date("2026-11-22T04:59:59.999Z"), ventanaFin: fin }), true);
  assert.equal(enVentana({ ingreso: new Date("2026-11-22T05:00:00.000Z"), ventanaFin: fin }), false);
});

test("enVentana: sin ventanaFin (preliquidación no iniciada) todo ingreso entra", () => {
  assert.equal(enVentana({ ingreso: "2026-11-20", ventanaFin: null }), true);
});

// ─── debeLiquidar ──────────────────────────────────────────────────────────

test("debeLiquidar: D1 20:59 no, 21:30 sí, 21:31 sí (corte inclusivo)", () => {
  const preliq = { fecha_primer_ingreso: "2026-11-20", liquidada_at: null };
  assert.equal(debeLiquidar({ preliq, ahora: new Date("2026-11-21T01:59:00.000Z") }), false);
  assert.equal(debeLiquidar({ preliq, ahora: new Date("2026-11-21T02:30:00.000Z") }), true);
  assert.equal(debeLiquidar({ preliq, ahora: new Date("2026-11-21T02:31:00.000Z") }), true);
});

test("debeLiquidar: false sin fecha_primer_ingreso o ya liquidada", () => {
  const ahora = new Date("2026-11-25T00:00:00.000Z");
  assert.equal(debeLiquidar({ preliq: { fecha_primer_ingreso: null, liquidada_at: null }, ahora }), false);
  assert.equal(
    debeLiquidar({ preliq: { fecha_primer_ingreso: "2026-11-20", liquidada_at: "2026-11-21T03:00:00Z" }, ahora }),
    false,
  );
});

// ─── corridaPerdida ────────────────────────────────────────────────────────

const PRELIQ = { id: 7, fecha_primer_ingreso: "2026-11-20", liquidada_at: null };
const CORTE = new Date("2026-11-21T02:30:00.000Z");
const min = (m) => new Date(CORTE.getTime() + m * 60_000);
const corrida = (extra) => ({ estado: "ok", dry_run: false, preliquidacion_ids: [7], terminada_at: min(5), ...extra });

test("corridaPerdida: no antes de corte+60 min aunque no haya corridas", () => {
  assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [], ahora: min(60) }), false);
  assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [], ahora: min(10) }), false);
});

test("corridaPerdida: pasado corte+60 sin corrida ok se marca perdida", () => {
  assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [], ahora: min(61) }), true);
});

test("corridaPerdida: una corrida ok no dry-run de la preliquidación, terminada tras el corte, la cubre", () => {
  assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [corrida()], ahora: min(61) }), false);
});

test("corridaPerdida: ignora dry_run, estado distinto de ok, otra preliquidación y corridas anteriores al corte", () => {
  const ahora = min(61);
  for (const c of [
    corrida({ dry_run: true }),
    corrida({ estado: "error" }),
    corrida({ estado: "en_curso" }),
    corrida({ preliquidacion_ids: [8] }),
    corrida({ terminada_at: new Date(CORTE.getTime() - 1) }),
  ]) {
    assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [c], ahora }), true, JSON.stringify(c));
  }
});

test("corridaPerdida: la corrida ok debe ser reciente (>= max(corte, ahora-60min))", () => {
  const ahora = min(180);
  assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [corrida()], ahora }), true);
  assert.equal(corridaPerdida({ preliq: PRELIQ, corridas: [corrida({ terminada_at: min(125) })], ahora }), false);
});

test("corridaPerdida: false si ya está liquidada o no tiene fecha_primer_ingreso", () => {
  const ahora = min(600);
  assert.equal(corridaPerdida({ preliq: { ...PRELIQ, liquidada_at: "2026-11-21T03:00:00Z" }, corridas: [], ahora }), false);
  assert.equal(corridaPerdida({ preliq: { ...PRELIQ, fecha_primer_ingreso: null }, corridas: [], ahora }), false);
});

// ─── ventanaVencida ────────────────────────────────────────────────────────

test("ventanaVencida: vencida, abierta, con restantes y sin aviso previo", () => {
  const preliq = { estado: "abierta", ventana_fin: "2026-11-22T04:59:59.999Z", restantes: 3, aviso_ventana_at: null };
  assert.equal(ventanaVencida({ preliq, ahora: new Date("2026-11-22T05:00:00.000Z") }), true);
  assert.equal(ventanaVencida({ preliq, ahora: new Date("2026-11-22T04:59:59.999Z") }), false);
});

test("ventanaVencida: no si cerrada/anulada, sin restantes, ya avisada o sin ventana", () => {
  const ahora = new Date("2026-11-23T00:00:00.000Z");
  const base = { estado: "abierta", ventana_fin: "2026-11-22T04:59:59.999Z", restantes: 3, aviso_ventana_at: null };
  for (const extra of [
    { estado: "cerrada" },
    { estado: "anulada" },
    { restantes: 0 },
    { aviso_ventana_at: "2026-11-22T06:00:00Z" },
    { ventana_fin: null },
  ]) {
    assert.equal(ventanaVencida({ preliq: { ...base, ...extra }, ahora }), false, JSON.stringify(extra));
  }
});
