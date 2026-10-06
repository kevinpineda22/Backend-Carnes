import test from "node:test";
import assert from "node:assert/strict";

import { validators } from "../src/middleware/validators.js";

// La FORMA que acepta el cierre de una recepción de talleres. El contenido (cédula,
// nombre, que la firma sea un PNG) y que sean obligatorios se prueba en
// finalizarProveedor.test.js: es la misma regla que usa el modelo de talleres.

const CORREO = "recibidor@merkahorro.com";

function correr(body) {
  const req = { body };
  let error;
  validators.finalizar(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("finalizar talleres: acepta recibidor de la lista y Otro; el id llega como número", () => {
  const lista = correr({
    recibido_por: CORREO,
    recibidor: { id: "4" },
    firma_data: "data:image/png;base64,AAAA",
  });
  assert.equal(lista.error, undefined);
  assert.equal(lista.body.recibidor.id, 4);
  assert.equal(lista.body.firma_data, "data:image/png;base64,AAAA");

  const otro = correr({
    recibido_por: CORREO,
    recibidor: { otro: true, nombre: "Pedro Pérez", cedula: 1020304050 },
    firma_data: "x",
  });
  assert.equal(otro.error, undefined);
  assert.equal(otro.body.recibidor.otro, true);
});

test("finalizar talleres: sigue aceptando un cuerpo sin recibidor (el modelo lo exige)", () => {
  assert.equal(correr({}).error, undefined);
  assert.equal(correr({ recibido_por: CORREO }).error, undefined);
});

test("finalizar talleres: tipos imposibles son 400", () => {
  const malos = [
    { recibido_por: "yo" },
    { recibido_por: CORREO, recibidor: { id: "abc" } },
    { recibido_por: CORREO, recibidor: { id: 0 } },
    { recibido_por: CORREO, recibidor: { otro: "si" } },
    { recibido_por: CORREO, recibidor: { cedula: { x: 1 } } },
    { recibido_por: CORREO, firma_data: 12345 },
  ];
  for (const body of malos) {
    assert.equal(correr(body).error?.statusCode, 400, JSON.stringify(body));
  }
});
