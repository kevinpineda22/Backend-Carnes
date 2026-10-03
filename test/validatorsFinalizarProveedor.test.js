import test from "node:test";
import assert from "node:assert/strict";

import { validators } from "../src/middleware/validators.js";

// La FORMA de lo que aceptan finalizar y la gestión de recibidores. El contenido
// (cédula, nombre, que la firma sea un PNG) se prueba en finalizarProveedor.test.js.

const CORREO = "recibidor@merkahorro.com";

function correr(middleware, body) {
  const req = { body };
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("finalizar: acepta recibidor de la lista y Otro; el id llega como número", () => {
  const lista = correr(validators.finalizarRecepcionProveedor, {
    recibido_por: CORREO,
    recibidor: { id: "4" },
    firma_data: "data:image/png;base64,AAAA",
  });
  assert.equal(lista.error, undefined);
  assert.equal(lista.body.recibidor.id, 4);

  const otro = correr(validators.finalizarRecepcionProveedor, {
    recibido_por: CORREO,
    recibidor: { otro: true, nombre: "Pedro Pérez", cedula: 1020304050 },
    firma_data: "x",
  });
  assert.equal(otro.error, undefined);
  assert.equal(otro.body.recibidor.otro, true);
  assert.equal(otro.body.recibidor.cedula, 1020304050);
});

test("finalizar: recibidor y firma son opcionales (un reintento sobre una firmada los ignora)", () => {
  const { error } = correr(validators.finalizarRecepcionProveedor, { recibido_por: CORREO });
  assert.equal(error, undefined);
});

test("finalizar: sin correo, o con tipos imposibles, es 400", () => {
  const malos = [
    {},
    { recibido_por: "yo" },
    { recibido_por: CORREO, recibidor: { id: "abc" } },
    { recibido_por: CORREO, recibidor: { id: 0 } },
    { recibido_por: CORREO, recibidor: { id: -3 } },
    { recibido_por: CORREO, recibidor: { otro: "si" } },
    { recibido_por: CORREO, recibidor: { cedula: { x: 1 } } },
    { recibido_por: CORREO, firma_data: 12345 },
  ];
  for (const body of malos) {
    const { error } = correr(validators.finalizarRecepcionProveedor, body);
    assert.equal(error?.statusCode, 400, JSON.stringify(body));
  }
});

test("finalizar: conserva el nombre del cliente junto a un id (el modelo lo ignora), sin romper", () => {
  const { error, body } = correr(validators.finalizarRecepcionProveedor, {
    recibido_por: CORREO,
    recibidor: { id: 4, nombre: "NOMBRE FALSO" },
  });
  assert.equal(error, undefined);
  assert.equal(body.recibidor.nombre, "NOMBRE FALSO");
});

test("crear recibidor: nombre y cédula obligatorios", () => {
  const ok = correr(validators.crearRecibidor, { cedula: "1.000.000", nombre: "Ana Gómez", orden: "20" });
  assert.equal(ok.error, undefined);
  assert.equal(ok.body.orden, 20);

  const sinOrden = correr(validators.crearRecibidor, { cedula: 1000000, nombre: "Ana Gómez" });
  assert.equal(sinOrden.error, undefined);

  for (const body of [
    {},
    { nombre: "Ana Gómez" },
    { cedula: "1000000" },
    { cedula: null, nombre: "Ana Gómez" },
    { cedula: "1000000", nombre: 5 },
    { cedula: "1000000", nombre: "Ana Gómez", orden: -1 },
    { cedula: "1000000", nombre: "Ana Gómez", orden: "x" },
  ]) {
    const { error } = correr(validators.crearRecibidor, body);
    assert.equal(error?.statusCode, 400, JSON.stringify(body));
  }
});

test("actualizar recibidor: al menos un campo; activo debe ser booleano", () => {
  for (const body of [{ activo: false }, { nombre: "Ana Gómez" }, { cedula: "1000000" }, { orden: 3 }, { orden: 0 }]) {
    const { error } = correr(validators.actualizarRecibidor, body);
    assert.equal(error, undefined, JSON.stringify(body));
  }
  for (const body of [{}, { orden: null }, { activo: "no" }, { activo: 1 }, { nombre: 7 }]) {
    const { error } = correr(validators.actualizarRecibidor, body);
    assert.equal(error?.statusCode, 400, JSON.stringify(body));
  }
});

test("finalizar: acepta proveedor_firmante opcional con documento texto o número", () => {
  const con = correr(validators.finalizarRecepcionProveedor, {
    recibido_por: CORREO,
    proveedor_firmante: { nombre: "Carlos Gómez", documento: 1020304050, firma_data: "x" },
  });
  assert.equal(con.error, undefined);
  assert.equal(con.body.proveedor_firmante.documento, 1020304050);
  assert.equal(correr(validators.finalizarRecepcionProveedor, { recibido_por: CORREO }).error, undefined);
});
