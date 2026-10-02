import test from "node:test";
import assert from "node:assert/strict";

import { validators } from "../src/middleware/validators.js";

// La FORMA de lo que acepta el reenvío de vísceras de la liquidación. Si hace
// falta la confirmación de que el documento viejo se borró en SIESA, lo decide
// el modelo según el estado de cada recepción.

function correr(body) {
  const req = { body };
  let error;
  validators.reenviarVisceras(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("reenviar vísceras: acepta ids como número o texto y la confirmación booleana", () => {
  const { error, body } = correr({
    recepcion_ids: ["12", 13],
    eliminado_en_siesa: true,
    por: "admin@merkahorro.com",
    motivo: "  Corregí el Mondongo ",
  });
  assert.equal(error, undefined);
  assert.deepEqual(body.recepcion_ids, [12, 13]);
  assert.equal(body.eliminado_en_siesa, true);
  assert.equal(body.motivo, "Corregí el Mondongo");
});

test("reenviar vísceras: sin recepciones es 400", () => {
  assert.equal(correr({}).error.status ?? correr({}).error.statusCode, 400);
  assert.equal(correr({ recepcion_ids: [] }).error.statusCode ?? correr({ recepcion_ids: [] }).error.status, 400);
});

test("reenviar vísceras: la confirmación tiene que ser un booleano, no el texto «true»", () => {
  const { error } = correr({ recepcion_ids: [1], eliminado_en_siesa: "true" });
  assert.ok(error);
  assert.match(error.message, /eliminado_en_siesa/);
});

test("reenviar vísceras: un id inválido se rechaza", () => {
  assert.ok(correr({ recepcion_ids: [0] }).error);
  assert.ok(correr({ recepcion_ids: ["abc"] }).error);
});
