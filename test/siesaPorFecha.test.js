import test from "node:test";
import assert from "node:assert/strict";

import {
  planearDocumentosPorFecha,
  referenciasEnConflicto,
  oficialCompleta,
  decidirCierreOficial,
} from "../src/shared/siesaPorFecha.js";

// Qué falta mandar, qué estorba y cuándo se cierra la liquidación cuando la
// oficial sale un documento por fecha de ingreso (sql/033).

const doc = (fecha, ids) => ({ fecha, recepcion_ids: ids });
const fila = (estado, fechaIso, ids, extra = {}) => ({
  id: Math.floor(Math.random() * 1e6),
  estado,
  fecha_docto: fechaIso,
  recepcion_ids: ids,
  referencia: `TC OFI L6${fechaIso ?? ""}`,
  ...extra,
});

const DOCS = [doc("20260921", [2]), doc("20260924", [8])];

test("sin envíos: todo pendiente", () => {
  const p = planearDocumentosPorFecha({ documentos: DOCS, filas: [] });
  assert.equal(p.pendientes.length, 2);
  assert.equal(p.todosOk, false);
  assert.equal(p.parcial, false);
  assert.deepEqual(p.items.map((i) => i.estado), ["pendiente", "pendiente"]);
});

test("una fecha ya ok y la otra no: envío parcial, solo falta la segunda", () => {
  const p = planearDocumentosPorFecha({
    documentos: DOCS,
    filas: [fila("ok", "2026-09-21", [2])],
  });
  assert.deepEqual(p.pendientes.map((i) => i.fecha), ["20260924"]);
  assert.deepEqual(p.listos.map((i) => i.fecha), ["20260921"]);
  assert.equal(p.parcial, true);
  assert.equal(p.todosOk, false);
  assert.equal(p.enCurso.length, 0);
});

test("un error o un anulado no ocupan el lugar: la fecha sigue pendiente", () => {
  const p = planearDocumentosPorFecha({
    documentos: DOCS,
    filas: [fila("error", "2026-09-21", [2]), fila("anulado", "2026-09-24", [8])],
  });
  assert.equal(p.pendientes.length, 2);
});

test("enviando o sin confirmar: en curso, no se manda otra vez", () => {
  const p = planearDocumentosPorFecha({
    documentos: DOCS,
    filas: [fila("ok", "2026-09-21", [2]), fila("sin_confirmar", "2026-09-24", [8])],
  });
  assert.deepEqual(p.enCurso.map((i) => i.fecha), ["20260924"]);
  assert.equal(p.pendientes.length, 0);
  assert.equal(p.todosOk, false);
});

test("todos ok → todosOk (y se puede cerrar)", () => {
  const p = planearDocumentosPorFecha({
    documentos: DOCS,
    filas: [fila("ok", "2026-09-21", [2]), fila("ok", "2026-09-24", [8])],
  });
  assert.equal(p.todosOk, true);
  assert.equal(p.parcial, false);
  assert.equal(p.pendientes.length, 0);
});

test("el consolidado de antes de sql/033 (fecha_docto NULL) cubre todas las fechas", () => {
  const p = planearDocumentosPorFecha({
    documentos: DOCS,
    filas: [fila("ok", null, [2, 8])],
  });
  assert.equal(p.pendientes.length, 0);
  assert.equal(p.todosOk, true);
  assert.ok(p.items.every((i) => i.deLegado));
  // Y una recepción que cambió después no se compara contra él.
  assert.equal(p.desfasados.length, 0);
});

test("una sola fecha con el consolidado de antes: nada pendiente (compatibilidad)", () => {
  const p = planearDocumentosPorFecha({
    documentos: [doc("20260923", [2, 8])],
    filas: [fila("ok", null, [2, 8])],
  });
  assert.equal(p.todosOk, true);
  assert.equal(p.pendientes.length, 0);
});

test("una fila con una fecha que ya no existe es huérfana (hay que anularla a mano)", () => {
  const p = planearDocumentosPorFecha({
    documentos: [doc("20260921", [2]), doc("20260925", [8])],
    filas: [fila("ok", "2026-09-24", [8])],
  });
  assert.equal(p.huerfanos.length, 1);
  assert.deepEqual(p.pendientes.map((i) => i.fecha), ["20260921", "20260925"]);
});

test("una recepción vinculada después a una fecha ya enviada es un desfase", () => {
  const p = planearDocumentosPorFecha({
    documentos: [doc("20260921", [2, 9])],
    filas: [fila("ok", "2026-09-21", [2])],
  });
  assert.equal(p.desfasados.length, 1);
  // Con el mismo conjunto, en otro orden, no.
  const q = planearDocumentosPorFecha({
    documentos: [doc("20260921", [9, 2])],
    filas: [fila("ok", "2026-09-21", [2, 9])],
  });
  assert.equal(q.desfasados.length, 0);
  // Y se puede apagar la comparación (vísceras).
  const r = planearDocumentosPorFecha({
    documentos: [doc("20260921", [2, 9])],
    filas: [fila("ok", "2026-09-21", [2])],
    comparaRecepciones: false,
  });
  assert.equal(r.desfasados.length, 0);
});

test("oficialCompleta: solo cuando todo está ok y cubre todas las recepciones", () => {
  assert.equal(oficialCompleta([fila("ok", "2026-09-21", [2]), fila("ok", "2026-09-24", [8])], [2, 8]), true);
  // Falta una fecha.
  assert.equal(oficialCompleta([fila("ok", "2026-09-21", [2])], [2, 8]), false);
  // Una está en curso.
  assert.equal(
    oficialCompleta([fila("ok", "2026-09-21", [2]), fila("sin_confirmar", "2026-09-24", [8])], [2, 8]),
    false,
  );
  // El consolidado de antes, que cubre todo.
  assert.equal(oficialCompleta([fila("ok", null, [2, 8])], [2, 8]), true);
  // Anuladas no cuentan; sin filas, tampoco.
  assert.equal(oficialCompleta([fila("anulado", "2026-09-21", [2, 8])], [2, 8]), false);
  assert.equal(oficialCompleta([], [2, 8]), false);
  assert.equal(oficialCompleta([fila("ok", null, [2, 8])], []), false);
});

const res = (fecha, referencia, estado, error = null) => ({ fecha, referencia, estado, error });

test("decidirCierreOficial: todos ok → cerrar, sin error", () => {
  const d = decidirCierreOficial([
    res("20260921", "TC OFI L6A", "ok"),
    res("20260924", "TC OFI L6B", "ok"),
  ]);
  assert.equal(d.cerrar, true);
  assert.equal(d.error, null);
  assert.equal(d.representante.referencia, "TC OFI L6A");
});

test("decidirCierreOficial: uno falla → NO cerrar, lista cuál y qué entró", () => {
  const d = decidirCierreOficial([
    res("20260921", "TC OFI L6A", "ok"),
    res("20260924", "TC OFI L6B", "error", "Item sin cantidad"),
  ]);
  assert.equal(d.cerrar, false);
  assert.equal(d.representante.referencia, "TC OFI L6B");
  assert.match(d.error, /no se cerró: 1 de 2/);
  assert.match(d.error, /TC OFI L6B \(20260924\): Item sin cantidad/);
  assert.match(d.error, /Ya entraron: TC OFI L6A/);
  assert.deepEqual(d.ok.map((r) => r.referencia), ["TC OFI L6A"]);
});

test("decidirCierreOficial: sin confirmar, en curso o sin tiempo tampoco cierran", () => {
  for (const estado of ["sin_confirmar", "enviando", "pendiente"]) {
    const d = decidirCierreOficial([res("20260921", "A", "ok"), res("20260924", "B", estado)]);
    assert.equal(d.cerrar, false, estado);
    assert.ok(d.error, estado);
  }
});

test("decidirCierreOficial: con UN documento el error es el de SIESA, tal cual (como antes)", () => {
  const d = decidirCierreOficial([res("20260923", "TC OFI L6", "error", "SIESA dijo no")]);
  assert.equal(d.cerrar, false);
  assert.equal(d.error, "SIESA dijo no");
  assert.equal(decidirCierreOficial([res("20260923", "TC OFI L6", "sin_confirmar")]).error, null);
});

test("decidirCierreOficial: sin resultados no cierra", () => {
  assert.equal(decidirCierreOficial([]).cerrar, false);
});

test("consolidado de antes: una recepción de hoy que no trae es desfase (aunque no se compare exacto)", () => {
  const p = planearDocumentosPorFecha({
    documentos: [doc("20260921", [2]), doc("20260924", [8, 9])],
    filas: [fila("ok", null, [2, 8])],
    comparaRecepciones: false,
  });
  assert.equal(p.desfasados.length, 1);
  assert.equal(p.desfasados[0].fecha, "20260924");
  // Si sobran recepciones en el consolidado (se desvincularon), no es desfase.
  const q = planearDocumentosPorFecha({
    documentos: [doc("20260921", [2])],
    filas: [fila("ok", null, [2, 8])],
  });
  assert.equal(q.desfasados.length, 0);
  // Documentos de vísceras: los ids vienen dentro de armado.
  const v = planearDocumentosPorFecha({
    documentos: [{ fecha: "20260921", armado: { recepcion_ids: [2, 9] } }],
    filas: [fila("ok", null, [2])],
    comparaRecepciones: false,
  });
  assert.equal(v.desfasados.length, 1);
});

test("referenciasEnConflicto: pendiente repetida con otra pendiente o con un envío existente", () => {
  const item = (ref, envio = null) => ({ envio, documento: { resumen: { referencia: ref } } });
  assert.deepEqual(referenciasEnConflicto([item("A"), item("B")]), []);
  assert.deepEqual(referenciasEnConflicto([item("A"), item("A")]), ["A"]);
  assert.deepEqual(referenciasEnConflicto([item("A"), item("X", { referencia: "A" })]), ["A"]);
  // Dos ya enviados con la misma referencia (historia) no son un conflicto nuevo.
  assert.deepEqual(
    referenciasEnConflicto([item("A", { referencia: "Z" }), item("B", { referencia: "Z" })]),
    [],
  );
});
