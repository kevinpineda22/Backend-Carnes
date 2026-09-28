import test from "node:test";
import assert from "node:assert/strict";

import { calcularValorGasto } from "../src/shared/gastos.js";

test("con peso y precio_kilo calcula el valor y redondea a 2 decimales", () => {
  const valor = calcularValorGasto({ peso: 120.5, precio_kilo: 16800.333, valor: 999 });
  assert.equal(valor, redondearEsperado(120.5 * 16800.333));

  function redondearEsperado(n) {
    return Number(n.toFixed(2));
  }
});

test("sin peso ni precio_kilo respeta el valor tipeado a mano", () => {
  assert.equal(calcularValorGasto({ valor: 500000 }), 500000);
});

test("con solo peso (sin precio_kilo) respeta el valor tipeado a mano", () => {
  assert.equal(calcularValorGasto({ peso: 100, valor: 500000 }), 500000);
});

test("con solo precio_kilo (sin peso) respeta el valor tipeado a mano", () => {
  assert.equal(calcularValorGasto({ precio_kilo: 16800, valor: 500000 }), 500000);
});

test("peso o precio_kilo en 0 no dispara el cálculo", () => {
  assert.equal(calcularValorGasto({ peso: 0, precio_kilo: 16800, valor: 123 }), 123);
  assert.equal(calcularValorGasto({ peso: 100, precio_kilo: 0, valor: 123 }), 123);
});

test("peso y precio_kilo null se tratan como ausentes", () => {
  assert.equal(calcularValorGasto({ peso: null, precio_kilo: null, valor: 250 }), 250);
});

test("valor tipeado ausente sin peso/precio da 0, no NaN", () => {
  assert.equal(calcularValorGasto({}), 0);
});
