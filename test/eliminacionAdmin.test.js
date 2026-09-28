import test from "node:test";
import assert from "node:assert/strict";

import { ESTADOS } from "../src/shared/estados.js";
import {
  puedeEliminarRecepcion,
  puedeEliminarEnvio,
} from "../src/shared/eliminacionAdmin.js";

// ─── puedeEliminarRecepcion ─────────────────────────────────────────────────

test("un borrador no se elimina acá: se descarta", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.BORRADOR,
    liquidacion_id: null,
    envios: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /Descartar/);
});

test("costeado no se puede eliminar: ya movió plata", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.COSTEADO,
    liquidacion_id: null,
    envios: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /costeada/i);
});

test("enviado a SIESA no se puede eliminar: ya está en el ERP", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.ENVIADO_SIESA,
    liquidacion_id: null,
    envios: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /SIESA/);
});

test("vinculada a una liquidación: hay que desvincular primero", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: 7,
    envios: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /desvinc/i);
});

test("una oficial ok bloquea el borrado", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: null,
    envios: [{ tipo: "oficial", estado: "ok" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /oficial/i);
});

test("una oficial que falló (error) también bloquea: se intentó subir", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: null,
    envios: [{ tipo: "oficial", estado: "error" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /oficial/i);
});

test("una inicial sola (sin oficial) no bloquea por sí misma", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: null,
    envios: [{ tipo: "inicial", estado: "ok" }],
  });
  assert.equal(r.ok, true);
});

test("un envío enviando bloquea: puede que SIESA ya lo haya creado", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: null,
    envios: [{ tipo: "inicial", estado: "enviando" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sin resolver/i);
});

test("un envío sin_confirmar bloquea igual que enviando", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: null,
    envios: [{ tipo: "inicial", estado: "sin_confirmar" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sin resolver/i);
});

test("Aprobado sin liquidación, sin oficial y con la inicial en error: se puede eliminar", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.APROBADO,
    liquidacion_id: null,
    envios: [{ tipo: "inicial", estado: "error" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.motivo, null);
});

test("Rechazado también es elegible si no tiene envíos ni liquidación", () => {
  const r = puedeEliminarRecepcion({
    estado: ESTADOS.RECHAZADO,
    liquidacion_id: null,
    envios: [],
  });
  assert.equal(r.ok, true);
});

// ─── puedeEliminarEnvio ─────────────────────────────────────────────────────

test("un envío en error se puede borrar: nunca llegó a crear nada en SIESA", () => {
  const r = puedeEliminarEnvio({ estado: "error" });
  assert.equal(r.ok, true);
  assert.equal(r.motivo, null);
});

test("un envío ok no se borra: el documento existe en SIESA", () => {
  const r = puedeEliminarEnvio({ estado: "ok" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /SIESA/);
});

test("enviando y sin_confirmar se resuelven desde el panel, no se borran", () => {
  for (const estado of ["enviando", "sin_confirmar"]) {
    const r = puedeEliminarEnvio({ estado });
    assert.equal(r.ok, false, estado);
    assert.match(r.motivo, /panel/i, estado);
  }
});

test("anulado y duplicado tampoco se borran: son rastro de algo que ya pasó en SIESA", () => {
  for (const estado of ["anulado", "duplicado"]) {
    const r = puedeEliminarEnvio({ estado });
    assert.equal(r.ok, false, estado);
  }
});
