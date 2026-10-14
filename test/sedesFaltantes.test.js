import test from "node:test";
import assert from "node:assert/strict";

import {
  DIAS_MARGEN,
  armarSedesFaltantes,
  ventanaBusqueda,
} from "../src/shared/sedesFaltantes.js";

const LIQ = { id: 10, fecha: "2026-10-13" };
const SEDES = [
  { id: 1, nombre: "Copacabana" },
  { id: 2, nombre: "Girardota" },
];

// ─── Ventana ───────────────────────────────────────────────────────────────

test("ventana: cubre de la recepción más temprana a la más tardía, con margen", () => {
  const v = ventanaBusqueda({
    fecha: "2026-10-13",
    recepciones: [{ fecha_ingreso: "2026-10-13" }, { fecha_ingreso: "2026-10-15" }],
  });
  assert.equal(DIAS_MARGEN, 3);
  assert.deepEqual(v, { desde: "2026-10-10", hasta: "2026-10-18" });
});

test("ventana: una recepción anterior a la fecha de la liquidación corre el inicio", () => {
  const v = ventanaBusqueda({
    fecha: "2026-10-13",
    recepciones: [{ fecha_ingreso: "2026-10-11" }],
  });
  assert.deepEqual(v, { desde: "2026-10-08", hasta: "2026-10-16" });
});

test("ventana: cruza de mes sin problema", () => {
  const v = ventanaBusqueda({ fecha: "2026-10-30", recepciones: [] });
  assert.deepEqual(v, { desde: "2026-10-27", hasta: "2026-11-02" });
});

// ─── Elección por sede ─────────────────────────────────────────────────────

test("sede que recibió OTRO día de la entrega: aparece como cerrada sin vincular", () => {
  const [copa] = armarSedesFaltantes(LIQ, [SEDES[0]], [
    { id: 50, sede_id: 1, estado: "Aprobado", liquidacion_id: null, fecha_ingreso: "2026-10-15" },
  ]);
  assert.equal(copa.pista, "aprobada_sin_vincular");
  assert.equal(copa.recepcion_id, 50);
  assert.equal(copa.fecha_ingreso, "2026-10-15");
});

test("sin ninguna recepción en la ventana: sin_recepcion", () => {
  const res = armarSedesFaltantes(LIQ, SEDES, []);
  assert.deepEqual(
    res.map((s) => [s.sede_id, s.pista, s.recepcion_id]),
    [
      [1, "sin_recepcion", null],
      [2, "sin_recepcion", null],
    ],
  );
});

test("prefiere la cerrada sin vincular a una que ya está en otra liquidación", () => {
  const [copa] = armarSedesFaltantes(LIQ, [SEDES[0]], [
    { id: 40, sede_id: 1, estado: "Costeado", liquidacion_id: 9, fecha_ingreso: "2026-10-13" },
    { id: 41, sede_id: 1, estado: "Aprobado", liquidacion_id: null, fecha_ingreso: "2026-10-15" },
  ]);
  assert.equal(copa.pista, "aprobada_sin_vincular");
  assert.equal(copa.recepcion_id, 41);
});

test("a igual pista, la de fecha más cercana a la liquidación", () => {
  const [copa] = armarSedesFaltantes(LIQ, [SEDES[0]], [
    { id: 60, sede_id: 1, estado: "Aprobado", liquidacion_id: null, fecha_ingreso: "2026-10-10" },
    { id: 61, sede_id: 1, estado: "Aprobado", liquidacion_id: null, fecha_ingreso: "2026-10-14" },
  ]);
  assert.equal(copa.recepcion_id, 61);
});

test("en otra liquidación solo si no hay nada mejor", () => {
  const [copa] = armarSedesFaltantes(LIQ, [SEDES[0]], [
    { id: 70, sede_id: 1, estado: "Costeado", liquidacion_id: 9, fecha_ingreso: "2026-10-13" },
  ]);
  assert.equal(copa.pista, "en_otra_liquidacion");
  assert.equal(copa.liquidacion_id, 9);
});

test("borrador y rechazada conservan su pista", () => {
  const res = armarSedesFaltantes(LIQ, SEDES, [
    { id: 80, sede_id: 1, estado: "Borrador", liquidacion_id: null, fecha_ingreso: "2026-10-13" },
    { id: 81, sede_id: 2, estado: "Rechazado", liquidacion_id: null, fecha_ingreso: "2026-10-14" },
  ]);
  assert.deepEqual(
    res.map((s) => s.pista),
    ["en_curso", "rechazada"],
  );
});
