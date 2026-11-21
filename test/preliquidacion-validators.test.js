import test from "node:test";
import assert from "node:assert/strict";

import { validators } from "../src/middleware/validators.js";

// preliqDinero: número o texto numérico no negativo. Se prueba a través de
// guardarConfigPreliquidacion ({ servicio_por_animal }) y guardarGastosPreliquidacion.

function correr(validador, body) {
  const req = { body };
  let error;
  validador(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

const config = (valor) => correr(validators.guardarConfigPreliquidacion, { servicio_por_animal: valor });

test("preliqDinero: acepta texto numérico entero y decimal", () => {
  assert.equal(config("1500000").error, undefined);
  assert.equal(config("12.5").error, undefined);
});

test("preliqDinero: acepta números", () => {
  assert.equal(config(1500000).error, undefined);
  assert.equal(config(0).error, undefined);
});

test("preliqDinero: rechaza texto no numérico y vacío", () => {
  assert.ok(config("abc").error);
  assert.ok(config("").error);
  assert.ok(config("12.").error);
  assert.ok(config("d").error);
});

test("preliqDinero: rechaza negativos", () => {
  assert.ok(config(-1).error);
  assert.ok(config("-5").error);
});

test("guardarGastosPreliquidacion: el valor de cada fila pasa por preliqDinero", () => {
  const ok = correr(validators.guardarGastosPreliquidacion, {
    filas: [{ concepto: "Transporte", valor: "1500000", signo: 1 }],
  });
  assert.equal(ok.error, undefined);
  const mal = correr(validators.guardarGastosPreliquidacion, {
    filas: [{ concepto: "Transporte", valor: "abc", signo: 1 }],
  });
  assert.ok(mal.error);
});
