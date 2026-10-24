import test from "node:test";
import assert from "node:assert/strict";

import { normalizarFiltrosTransformaciones } from "../src/shared/transformacionesFiltros.js";

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
