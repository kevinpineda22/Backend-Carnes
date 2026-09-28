import test from "node:test";
import assert from "node:assert/strict";

import {
  cantidadPorNovillo,
  esViceraPorFactor,
  recalcularVicerasPorNovillo,
  esProducto,
  esVicera,
  tieneCodigoSiesa,
  vaASiesa,
} from "../src/shared/visceras.js";

test("cantidadPorNovillo: factor × novillos, redondeado a 3 decimales", () => {
  assert.equal(cantidadPorNovillo(4.16167, 12), 49.94);
  assert.equal(cantidadPorNovillo(1.33333, 12), 16);
  assert.equal(cantidadPorNovillo(0.56167, 7), 3.932);
});

test("cantidadPorNovillo: sin factor o sin novillos da 0, no NaN", () => {
  assert.equal(cantidadPorNovillo(null, 12), 0);
  assert.equal(cantidadPorNovillo(undefined, 12), 0);
  assert.equal(cantidadPorNovillo(4.16167, 0), 0);
  assert.equal(cantidadPorNovillo(4.16167, null), 0);
  assert.equal(cantidadPorNovillo(NaN, 12), 0);
});

test("esViceraPorFactor: solo vísceras con factor_novillo cargado (no null/undefined)", () => {
  assert.equal(esViceraPorFactor({ tipo: "vicera", factor_novillo: 1.33333 }), true);
  assert.equal(esViceraPorFactor({ tipo: "vicera", factor_novillo: 0 }), true); // 0 es un factor válido
  assert.equal(esViceraPorFactor({ tipo: "vicera", factor_novillo: null }), false);
  assert.equal(esViceraPorFactor({ tipo: "vicera", factor_novillo: undefined }), false);
  assert.equal(esViceraPorFactor({ tipo: "vicera" }), false);
  assert.equal(esViceraPorFactor({ tipo: "carne", factor_novillo: 1 }), false);
});

test("recalcularVicerasPorNovillo: recalcula SOLO las vísceras con factor, deja el resto igual", () => {
  const items = [
    { id: 1, tipo: "carne", cantidad: 10, factor_novillo: null },
    { id: 2, tipo: "vicera", descripcion: "Mondongo", cantidad: 7, factor_novillo: null }, // tipeada
    { id: 3, tipo: "vicera", descripcion: "Higado", cantidad: 0, factor_novillo: 4.16167 },
    { id: 4, tipo: "vicera", descripcion: "Riñon", cantidad: 0, factor_novillo: 1.33333 },
  ];

  const recalculado = recalcularVicerasPorNovillo(items, 12);

  assert.equal(recalculado.find((i) => i.id === 1).cantidad, 10); // carne, sin tocar
  assert.equal(recalculado.find((i) => i.id === 2).cantidad, 7); // tipeada, sin tocar
  assert.equal(recalculado.find((i) => i.id === 3).cantidad, 49.94); // 4.16167 × 12
  assert.equal(recalculado.find((i) => i.id === 4).cantidad, 16); // 1.33333 × 12
});

test("recalcularVicerasPorNovillo: con novillos en 0, las de factor quedan en 0", () => {
  const items = [{ id: 1, tipo: "vicera", cantidad: 49.94, factor_novillo: 4.16167 }];
  const recalculado = recalcularVicerasPorNovillo(items, 0);
  assert.equal(recalculado[0].cantidad, 0);
});

test("esProducto / esVicera", () => {
  assert.equal(esProducto({ tipo: "carne" }), true);
  assert.equal(esProducto({ tipo: "adicional" }), true);
  assert.equal(esProducto({ tipo: "vicera" }), false);
  assert.equal(esVicera({ tipo: "vicera" }), true);
  assert.equal(esVicera({ tipo: "carne" }), false);
});

test("tieneCodigoSiesa", () => {
  assert.equal(tieneCodigoSiesa({ codigo_item: "15159" }), true);
  assert.equal(tieneCodigoSiesa({ codigo_item: "  " }), false);
  assert.equal(tieneCodigoSiesa({ codigo_item: null }), false);
  assert.equal(tieneCodigoSiesa({}), false);
});

test("vaASiesa: producto con cantidad va, CON o SIN código (el bloqueo es de siesaEntrada, no de acá)", () => {
  assert.equal(vaASiesa({ tipo: "carne", cantidad: 5, codigo_item: "111" }), true);
  assert.equal(vaASiesa({ tipo: "carne", cantidad: 5, codigo_item: null }), true);
  assert.equal(vaASiesa({ tipo: "adicional", cantidad: 2, codigo_item: null }), true);
});

test("vaASiesa: producto sin cantidad no va", () => {
  assert.equal(vaASiesa({ tipo: "carne", cantidad: 0, codigo_item: "111" }), false);
});

test("vaASiesa: víscera va SOLO con código y cantidad > 0", () => {
  assert.equal(vaASiesa({ tipo: "vicera", cantidad: 5, codigo_item: "15159" }), true);
  assert.equal(vaASiesa({ tipo: "vicera", cantidad: 5, codigo_item: null }), false);
  assert.equal(vaASiesa({ tipo: "vicera", cantidad: 0, codigo_item: "15159" }), false);
});

test("vaASiesa: cualquier otro tipo no va", () => {
  assert.equal(vaASiesa({ tipo: "otra-cosa", cantidad: 5, codigo_item: "111" }), false);
  assert.equal(vaASiesa(undefined), false);
});
