import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizarFiltrosTransformaciones,
  ultimaCorridaPorFecha,
} from "../src/shared/transformacionesFiltros.js";

test("sin filtros: entorno PROD y límite 100", () => {
  assert.deepEqual(normalizarFiltrosTransformaciones({}), { entorno: "PROD", limite: 100 });
  assert.deepEqual(normalizarFiltrosTransformaciones(undefined), { entorno: "PROD", limite: 100 });
});

test("acepta filtros válidos y los normaliza", () => {
  const f = normalizarFiltrosTransformaciones({
    entorno: "qa",
    fecha_desde: "2026-01-01",
    fecha_hasta: "2026-01-31",
    status: "error",
    tipo_dto: "csa",
    co: "  001 ",
  });
  assert.deepEqual(f, {
    entorno: "QA",
    fecha_desde: "2026-01-01",
    fecha_hasta: "2026-01-31",
    status: "ERROR",
    tipo_dto: "CSA",
    co: "001",
    limite: 100,
  });
});

test("limite: se recorta entre 1 y 500", () => {
  assert.equal(normalizarFiltrosTransformaciones({ limite: "9999" }).limite, 500);
  assert.equal(normalizarFiltrosTransformaciones({ limite: "0" }).limite, 1);
  assert.equal(normalizarFiltrosTransformaciones({ limite: "-5" }).limite, 1);
  assert.equal(normalizarFiltrosTransformaciones({ limite: "250" }).limite, 250);
});

test("rechaza entorno, fecha, status, tipo_dto y limite inválidos con 400", () => {
  const casos = [
    { entorno: "DEV" },
    { fecha_desde: "2026-13-01" },
    { fecha_hasta: "31/01/2026" },
    { fecha_desde: "2026-02-30" },
    { fecha_desde: "2026-02-10", fecha_hasta: "2026-02-01" },
    { status: "PENDIENTE" },
    { tipo_dto: "XXX" },
    { limite: "abc" },
  ];
  for (const query of casos) {
    assert.throws(
      () => normalizarFiltrosTransformaciones(query),
      (e) => e.statusCode === 400,
      JSON.stringify(query),
    );
  }
});

test("valores vacíos se tratan como ausentes", () => {
  assert.deepEqual(
    normalizarFiltrosTransformaciones({ status: "", co: "  ", fecha_desde: "" }),
    { entorno: "PROD", limite: 100 },
  );
});

test("ultimaCorridaPorFecha: deja la corrida más reciente por (entorno, fecha)", () => {
  const filas = [
    { id: 1, entorno: "PROD", fecha: "2026-10-22", resultado: "ERROR_FATAL", created_at: "2026-10-22T22:00:00Z" },
    { id: 2, entorno: "PROD", fecha: "2026-10-22", resultado: "PROCESADO", created_at: "2026-10-23T01:00:00Z" },
    { id: 3, entorno: "PROD", fecha: "2026-10-23", resultado: "SIN_VENTAS", created_at: "2026-10-23T22:00:00Z" },
    { id: 4, entorno: "QA", fecha: "2026-10-22", resultado: "SIN_VENTAS", created_at: "2026-10-22T22:00:00Z" },
  ];
  const r = ultimaCorridaPorFecha(filas);
  assert.equal(r.length, 3);
  assert.equal(r.find((x) => x.entorno === "PROD" && x.fecha === "2026-10-22").id, 2);
  assert.deepEqual(r.map((x) => x.fecha), ["2026-10-23", "2026-10-22", "2026-10-22"]);
});

test("ultimaCorridaPorFecha: desempata por id y tolera entradas vacías", () => {
  const mismo = "2026-10-22T22:00:00Z";
  const r = ultimaCorridaPorFecha([
    { id: 5, entorno: "PROD", fecha: "2026-10-22", created_at: mismo },
    { id: 9, entorno: "PROD", fecha: "2026-10-22", created_at: mismo },
    { id: 7, entorno: "PROD", fecha: "2026-10-22", created_at: mismo },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 9);
  assert.deepEqual(ultimaCorridaPorFecha([]), []);
  assert.deepEqual(ultimaCorridaPorFecha(undefined), []);
});
