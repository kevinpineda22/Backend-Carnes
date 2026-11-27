// Corte manual de la preliquidación: corte efectivo (manual o automático), reglas de validación y
// efecto en la ventana. Todo puro: sin reloj, sin base. Bogotá es UTC-5 fijo.
import test from "node:test";
import assert from "node:assert/strict";

import {
  corteDePreliquidacion,
  corteEfectivo,
  corridaPerdida,
  debeLiquidar,
  esPrecorte,
  finDiaBogota,
} from "../src/shared/preliquidacionTiempo.js";
import { MAX_DIAS_CORTE_MANUAL, formatoBogota, validarCorteManual } from "../src/shared/preliquidacionCorte.js";
import { planearVentana } from "../src/shared/preliquidacionVinculacion.js";
import { requiereAlternaTardia, requiereCorreccionSaldoTardio } from "../src/shared/preliquidacionAlterna.js";

const iso = (d) => d.toISOString();

// Primer ingreso 20-nov: corte automático 20-nov 21:30 Bogotá = 2026-11-21T02:30Z.
const AUTO = "2026-11-21T02:30:00.000Z";
const AHORA = new Date("2026-11-20T15:00:00.000Z"); // 10:00 Bogotá del 20-nov
const preliq = (extra = {}) => ({
  id: 7,
  estado: "abierta",
  fecha_primer_ingreso: "2026-11-20",
  liquidada_at: null,
  corte_manual: null,
  ...extra,
});

// ─── corte efectivo ────────────────────────────────────────────────────────

test("corteEfectivo: el manual gana; sin manual rige el automático; sin nada es null", () => {
  assert.equal(iso(corteEfectivo({ fechaPrimerIngreso: "2026-11-20" })), AUTO);
  assert.equal(
    iso(corteEfectivo({ fechaPrimerIngreso: "2026-11-20", corteManual: "2026-11-22T15:00:00+00:00" })),
    "2026-11-22T15:00:00.000Z",
  );
  assert.equal(corteEfectivo({ fechaPrimerIngreso: null, corteManual: null }), null);
  assert.equal(corteEfectivo(), null);
});

test("corteDePreliquidacion lee corte_manual y fecha_primer_ingreso de la fila", () => {
  assert.equal(iso(corteDePreliquidacion(preliq())), AUTO);
  assert.equal(iso(corteDePreliquidacion(preliq({ corte_manual: "2026-11-21T19:00:00Z" }))), "2026-11-21T19:00:00.000Z");
  assert.equal(corteDePreliquidacion(preliq({ fecha_primer_ingreso: null })), null);
});

test("finDiaBogota: 23:59:59.999 Bogotá del día del instante (cruza la medianoche UTC)", () => {
  assert.equal(iso(finDiaBogota(new Date("2026-11-21T02:30:00.000Z"))), "2026-11-21T04:59:59.999Z"); // 20-nov 21:30 Bogotá
  assert.equal(iso(finDiaBogota(new Date("2026-11-21T05:00:00.000Z"))), "2026-11-22T04:59:59.999Z"); // 21-nov 00:00 Bogotá
  assert.equal(iso(finDiaBogota(new Date("2026-11-21T04:59:59.999Z"))), "2026-11-21T04:59:59.999Z");
  assert.equal(iso(finDiaBogota("2026-12-31T20:00:00.000Z")), "2027-01-01T04:59:59.999Z"); // fin de año
});

test("debeLiquidar usa el corte efectivo: un manual futuro retiene aunque pasara el automático", () => {
  const manual = preliq({ corte_manual: "2026-11-21T19:00:00.000Z" }); // 21-nov 14:00 Bogotá
  const pasadoElAutomatico = new Date("2026-11-21T03:00:00.000Z");
  assert.equal(debeLiquidar({ preliq: preliq(), ahora: pasadoElAutomatico }), true);
  assert.equal(debeLiquidar({ preliq: manual, ahora: pasadoElAutomatico }), false);
  assert.equal(debeLiquidar({ preliq: manual, ahora: new Date("2026-11-21T19:00:00.000Z") }), true, "inclusive");
});

test("debeLiquidar usa el corte efectivo: un manual anterior al automático adelanta la liquidación", () => {
  const manual = preliq({ corte_manual: "2026-11-20T20:00:00.000Z" }); // 20-nov 15:00 Bogotá
  const ahora = new Date("2026-11-20T20:00:01.000Z");
  assert.equal(debeLiquidar({ preliq: preliq(), ahora }), false);
  assert.equal(debeLiquidar({ preliq: manual, ahora }), true);
});

test("esPrecorte: con corte manual el servicio es precorte hasta ese instante", () => {
  const base = { fechaPrimerIngreso: "2026-11-20", liquidadaAt: null };
  const servicioAt = new Date("2026-11-21T03:00:00.000Z"); // después del automático
  assert.equal(esPrecorte({ ...base, servicioAt }), false);
  assert.equal(esPrecorte({ ...base, servicioAt, corteManual: "2026-11-21T19:00:00.000Z" }), true);
  assert.equal(esPrecorte({ ...base, servicioAt, corteManual: "2026-11-21T19:00:00.000Z", liquidadaAt: "2026-11-21T19:01:00Z" }), false);
  assert.equal(esPrecorte({ servicioAt, fechaPrimerIngreso: null, liquidadaAt: null }), true);
});

test("corridaPerdida mide los 60 min desde el corte efectivo, no desde el automático", () => {
  const manual = preliq({ corte_manual: "2026-11-21T19:00:00.000Z" });
  const ahora = new Date("2026-11-21T19:30:00.000Z"); // 30 min tras el manual, 17 h tras el automático
  assert.equal(corridaPerdida({ preliq: preliq(), corridas: [], ahora }), true);
  assert.equal(corridaPerdida({ preliq: manual, corridas: [], ahora }), false);
  assert.equal(corridaPerdida({ preliq: manual, corridas: [], ahora: new Date("2026-11-21T20:01:00.000Z") }), true);
});

// ─── alterna tardía ────────────────────────────────────────────────────────

test("alterna tardía: un servicio entre el corte automático y el manual no es tardío", () => {
  const datos = {
    servicio: "600000",
    servicioAt: "2026-11-21T03:00:00.000Z",
    servicioAplicado: "500000",
    fechaPrimerIngreso: "2026-11-20",
    liquidadaAt: "2026-11-21T19:05:00.000Z",
  };
  assert.equal(requiereAlternaTardia(datos), true);
  assert.equal(requiereAlternaTardia({ ...datos, corteManual: "2026-11-21T19:00:00.000Z" }), false);
  assert.equal(requiereAlternaTardia({ ...datos, servicioAt: "2026-11-21T19:00:01.000Z", corteManual: "2026-11-21T19:00:00.000Z" }), true);
  const igual = { ...datos, servicio: "500000" };
  assert.equal(requiereCorreccionSaldoTardio(igual), true);
  assert.equal(requiereCorreccionSaldoTardio({ ...igual, corteManual: "2026-11-21T19:00:00.000Z" }), false);
});

// ─── ventana con corte manual ──────────────────────────────────────────────

test("planearVentana: un corte manual posterior alarga la ventana hasta el fin de su día", () => {
  const sin = planearVentana({ fechaPrimerIngreso: "2026-11-20", liquidadaAt: null, fechaIngreso: "2026-11-20" });
  assert.equal(iso(sin.ventanaFin), "2026-11-22T04:59:59.999Z");
  const largo = planearVentana({
    fechaPrimerIngreso: "2026-11-20", liquidadaAt: null, fechaIngreso: "2026-11-20", corteManual: "2026-11-23T15:00:00.000Z",
  });
  assert.equal(iso(largo.ventanaFin), "2026-11-24T04:59:59.999Z");
  assert.equal(largo.cambia, false);
});

test("planearVentana: un corte manual anterior no acorta la ventana", () => {
  const r = planearVentana({
    fechaPrimerIngreso: "2026-11-20", liquidadaAt: null, fechaIngreso: "2026-11-20", corteManual: "2026-11-20T20:00:00.000Z",
  });
  assert.equal(iso(r.ventanaFin), "2026-11-22T04:59:59.999Z");
});

// ─── validarCorteManual ────────────────────────────────────────────────────

test("validar: un corte futuro con desfase es válido y devuelve el plan (corte, automático, ventana)", () => {
  const r = validarCorteManual({ corte: "2026-11-21T14:00:00-05:00", preliq: preliq(), ahora: AHORA });
  assert.equal(r.ok, true);
  assert.equal(iso(r.corteManual), "2026-11-21T19:00:00.000Z");
  assert.equal(iso(r.corteAutomatico), AUTO);
  assert.equal(iso(r.corteEfectivo), "2026-11-21T19:00:00.000Z");
  assert.equal(iso(r.ventanaFin), "2026-11-22T04:59:59.999Z");
});

test("validar: el corte manual alarga la ventana cuando cae después de su fin", () => {
  const r = validarCorteManual({ corte: "2026-11-23T10:00:00-05:00", preliq: preliq(), ahora: AHORA });
  assert.equal(r.ok, true);
  assert.equal(iso(r.ventanaFin), "2026-11-24T04:59:59.999Z");
});

test("validar: null restablece el automático mientras éste siga en el futuro", () => {
  const r = validarCorteManual({ corte: null, preliq: preliq({ corte_manual: "2026-11-23T15:00:00Z" }), ahora: AHORA });
  assert.equal(r.ok, true);
  assert.equal(r.corteManual, null);
  assert.equal(iso(r.corteEfectivo), AUTO);
  assert.equal(iso(r.ventanaFin), "2026-11-22T04:59:59.999Z");
});

test("validar: restablecer cuando el automático ya pasó es 409 (no liquidar de golpe)", () => {
  const r = validarCorteManual({
    corte: null,
    preliq: preliq({ corte_manual: "2026-11-23T15:00:00Z" }),
    ahora: new Date("2026-11-21T03:00:00.000Z"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.estado, 409);
  assert.equal(r.codigo, "corte_automatico_pasado");
  assert.match(r.mensaje, /20\/11\/2026 21:30/);
});

test("validar: un corte pasado o igual a ahora es 422 corte_pasado", () => {
  for (const corte of ["2026-11-20T09:00:00-05:00", "2026-11-20T10:00:00-05:00"]) {
    const r = validarCorteManual({ corte, preliq: preliq(), ahora: AHORA });
    assert.equal(r.ok, false, corte);
    assert.equal(r.estado, 422);
    assert.equal(r.codigo, "corte_pasado");
    assert.match(r.mensaje, /futuras/);
  }
});

test("validar: tope de 7 días después del corte automático (inclusive)", () => {
  assert.equal(MAX_DIAS_CORTE_MANUAL, 7);
  assert.equal(validarCorteManual({ corte: "2026-11-28T02:30:00Z", preliq: preliq(), ahora: AHORA }).ok, true);
  const r = validarCorteManual({ corte: "2026-11-28T02:31:00Z", preliq: preliq(), ahora: AHORA });
  assert.equal(r.ok, false);
  assert.equal(r.estado, 422);
  assert.equal(r.codigo, "corte_excede_limite");
  assert.match(r.mensaje, /27\/11\/2026 21:30/);
});

test("validar: exige ISO con desfase; un instante sin zona o basura es 422 corte_invalido", () => {
  for (const corte of ["2026-11-21T14:00:00", "2026-11-21", "mañana", "", 12345, {}, "2026-13-40T10:00:00Z", "2026-02-31T10:00:00Z"]) {
    const r = validarCorteManual({ corte, preliq: preliq(), ahora: AHORA });
    assert.equal(r.ok, false, JSON.stringify(corte));
    assert.equal(r.estado, 422);
    assert.equal(r.codigo, "corte_invalido");
  }
  // Los desfases Z, +00:00 y -05:00 y los milisegundos se aceptan.
  for (const corte of ["2026-11-21T19:00:00Z", "2026-11-21T19:00:00.000+00:00", "2026-11-21T14:00-05:00"]) {
    assert.equal(validarCorteManual({ corte, preliq: preliq(), ahora: AHORA }).ok, true, corte);
  }
});

test("validar: solo mientras está abierta y sin liquidar, y con primer ingreso", () => {
  const corte = "2026-11-21T14:00:00-05:00";
  const liquidada = validarCorteManual({ corte, preliq: preliq({ liquidada_at: "2026-11-21T02:31:00Z" }), ahora: AHORA });
  assert.deepEqual([liquidada.ok, liquidada.estado, liquidada.codigo], [false, 409, "ya_liquidada"]);
  for (const estado of ["cerrada", "anulada"]) {
    const r = validarCorteManual({ corte, preliq: preliq({ estado }), ahora: AHORA });
    assert.deepEqual([r.ok, r.estado, r.codigo], [false, 409, "no_abierta"], estado);
  }
  const sinIngreso = validarCorteManual({ corte, preliq: preliq({ fecha_primer_ingreso: null }), ahora: AHORA });
  assert.deepEqual([sinIngreso.ok, sinIngreso.estado, sinIngreso.codigo], [false, 409, "corte_sin_primer_ingreso"]);
});

test("validar: si la ventana resultante dejaría fuera recepciones ya vinculadas, 409 con sus ids", () => {
  // Corte manual lejano abrió la ventana hasta el 24-nov; hay una recepción del 23-nov vinculada.
  const extendida = preliq({ corte_manual: "2026-11-23T15:00:00Z" });
  const sedes = [
    { recepcion_id: 101, recepcion: { fecha_ingreso: "2026-11-20" } },
    { recepcion_id: 102, recepcion: { fecha_ingreso: "2026-11-23" } },
  ];
  const restablecer = validarCorteManual({ corte: null, preliq: extendida, sedes, ahora: AHORA });
  assert.deepEqual([restablecer.ok, restablecer.estado, restablecer.codigo], [false, 409, "corte_deja_sedes_fuera"]);
  assert.match(restablecer.mensaje, /#102/);
  assert.doesNotMatch(restablecer.mensaje, /#101/);

  // Lo mismo al adelantar el corte a un día cuya ventana no alcanza.
  const adelantar = validarCorteManual({ corte: "2026-11-21T14:00:00-05:00", preliq: extendida, sedes, ahora: AHORA });
  assert.equal(adelantar.codigo, "corte_deja_sedes_fuera");

  // Un corte que sigue cubriendo la recepción es válido; también la forma `fechaIngreso`.
  const cubre = validarCorteManual({ corte: "2026-11-23T20:00:00-05:00", preliq: extendida, sedes, ahora: AHORA });
  assert.equal(cubre.ok, true);
  const camel = validarCorteManual({ corte: null, preliq: extendida, sedes: [{ recepcionId: 5, fechaIngreso: "2026-11-23" }], ahora: AHORA });
  assert.equal(camel.codigo, "corte_deja_sedes_fuera");
});

test("formatoBogota: dd/mm/aaaa hh:mm en hora de Bogotá", () => {
  assert.equal(formatoBogota(new Date("2026-11-21T02:30:00.000Z")), "20/11/2026 21:30");
  assert.equal(formatoBogota("2026-01-01T04:59:00.000Z"), "31/12/2025 23:59");
});
