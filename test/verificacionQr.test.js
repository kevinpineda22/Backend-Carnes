import test from "node:test";
import assert from "node:assert/strict";

import { evaluarQr } from "../src/shared/verificacionQr.js";

// La regla que decide si se abre una recepción. Si esto se rompe, se puede
// cargar carne en una sede sin estar parado frente a su sticker.

const COPACABANA = { id: 3, nombre: "Copacabana Principal", activo: true };

test("sin sede pedida, un token válido ES la sede", () => {
  assert.deepEqual(evaluarQr(COPACABANA, null), { estado: "ok", sede: COPACABANA });
  assert.equal(evaluarQr(COPACABANA, undefined).estado, "ok");
});

test("con sede pedida (front viejo), tiene que coincidir", () => {
  assert.equal(evaluarQr(COPACABANA, 3).estado, "ok");
  assert.equal(evaluarQr(COPACABANA, "3").estado, "ok");
  const r = evaluarQr(COPACABANA, 8);
  assert.equal(r.estado, "sede_distinta");
  // El mensaje le dice al recibidor cuál es la sede real.
  assert.equal(r.sede.nombre, "Copacabana Principal");
});

test("un 0 pedido no se trata como 'sin sede': no coincide", () => {
  // Si alguien cambiara `!= null` por un chequeo de verdad-falsedad, un 0
  // saltearía la comparación. El validador ya rechaza el 0; esto es la red.
  assert.equal(evaluarQr(COPACABANA, 0).estado, "sede_distinta");
});

test("token que no existe: desconocido, sin sede", () => {
  assert.deepEqual(evaluarQr(null, null), { estado: "desconocido", sede: null });
  assert.equal(evaluarQr(null, 3).estado, "desconocido");
});

test("sede inactiva: no abre, pida o no pida sede", () => {
  const baja = { ...COPACABANA, activo: false };
  assert.equal(evaluarQr(baja, null).estado, "sede_inactiva");
  assert.equal(evaluarQr(baja, 3).estado, "sede_inactiva");
});
