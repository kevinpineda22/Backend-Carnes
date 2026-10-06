import test from "node:test";
import assert from "node:assert/strict";

import { COLUMNAS_RECEPCION, COLUMNAS_FIRMA_RECIBIDOR } from "../src/shared/recepcionColumnas.js";

const nombres = (lista) => lista.split(",").map((c) => c.trim());

test("la lectura corriente de recepciones NO trae la firma ni la cédula del recibidor", () => {
  const corriente = nombres(COLUMNAS_RECEPCION);
  for (const privada of ["firma_data", "recibidor_cedula", "*"]) {
    assert.ok(!corriente.includes(privada), `no debe incluir ${privada}`);
  }
});

test("la lectura corriente conserva las columnas que usan las pantallas", () => {
  const corriente = nombres(COLUMNAS_RECEPCION);
  for (const c of ["id", "estado", "sede_id", "liquidacion_id", "recibido_por", "iniciado_at", "updated_at"]) {
    assert.ok(corriente.includes(c), `falta ${c}`);
  }
});

test("las columnas del recibidor y la firma solo salen por la lectura del admin", () => {
  const admin = nombres(COLUMNAS_FIRMA_RECIBIDOR);
  assert.deepEqual(admin, ["recibidor_id", "recibidor_cedula", "recibidor_nombre", "recibidor_otro", "firma_data"]);
  assert.equal(nombres(COLUMNAS_RECEPCION).filter((c) => admin.includes(c)).length, 0);
});
