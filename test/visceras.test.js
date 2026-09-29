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
  descuentaEnLiquidacion,
  ajustarCantidadAUnidad,
  decimalesDeUnidad,
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

test("vaASiesa: una víscera nunca va, con o sin código, con o sin bloque", () => {
  assert.equal(vaASiesa({ tipo: "vicera", cantidad: 5, codigo_item: "15159" }), false);
  assert.equal(vaASiesa({ tipo: "vicera", cantidad: 5, codigo_item: null }), false);
  assert.equal(
    vaASiesa({ tipo: "vicera", cantidad: 49.94, codigo_item: "15159", bloque: "informativo" }),
    false,
  );
});

test("vaASiesa: cualquier otro tipo no va", () => {
  assert.equal(vaASiesa({ tipo: "otra-cosa", cantidad: 5, codigo_item: "111" }), false);
  assert.equal(vaASiesa(undefined), false);
});

// ─── descuentaEnLiquidacion (sql/017) ───────────────────────────────────────

test("descuentaEnLiquidacion: bloque 'bonificacion' descuenta", () => {
  assert.equal(descuentaEnLiquidacion({ bloque: "bonificacion" }), true);
});

test("descuentaEnLiquidacion: bloque 'informativo' NO descuenta", () => {
  assert.equal(descuentaEnLiquidacion({ bloque: "informativo" }), false);
});

test("descuentaEnLiquidacion: sin bloque (renglón de antes de sql/017) se trata como 'bonificacion'", () => {
  assert.equal(descuentaEnLiquidacion({ bloque: null }), true);
  assert.equal(descuentaEnLiquidacion({ bloque: undefined }), true);
  assert.equal(descuentaEnLiquidacion({}), true);
});

// ─── Decimales por unidad (SIESA rechazó 5,333 UND el 29/09/2026) ─────────

test("UND se trunca a dos decimales, como lo definió el encargado", () => {
  assert.equal(ajustarCantidadAUnidad(5.333, "UND"), 5.33);
  assert.equal(ajustarCantidadAUnidad(2.667, "UND"), 2.66);
  assert.equal(ajustarCantidadAUnidad(14.667, "UND"), 14.66);
});

test("truncar no convierte 4,000 en 3,99 por el ruido de coma flotante", () => {
  // 1,33333 × 3 = 3,99999: se redondea a 3 decimales ANTES de truncar.
  assert.equal(cantidadPorNovillo(1.33333, 3, "UND"), 4);
  assert.equal(cantidadPorNovillo(1.33333, 4, "UND"), 5.33);
  assert.equal(cantidadPorNovillo(1.33333, 2, "UND"), 2.66);
  assert.equal(cantidadPorNovillo(1.33333, 11, "UND"), 14.66);
});

test("KL y sin unidad siguen con tres decimales", () => {
  assert.equal(cantidadPorNovillo(4.16167, 3, "KL"), 12.485);
  assert.equal(cantidadPorNovillo(4.16167, 3), 12.485);
  assert.equal(decimalesDeUnidad("KL"), 3);
  assert.equal(decimalesDeUnidad(undefined), 3);
  assert.equal(decimalesDeUnidad("UND"), 2);
});

test("recalcularVicerasPorNovillo usa la unidad de cada renglón", () => {
  const [rinon, higado] = recalcularVicerasPorNovillo(
    [
      { tipo: "vicera", factor_novillo: 1.33333, unidad: "UND", cantidad: 0 },
      { tipo: "vicera", factor_novillo: 4.16167, unidad: "KL", cantidad: 0 },
    ],
    4,
  );
  assert.equal(rinon.cantidad, 5.33);
  assert.equal(higado.cantidad, 16.647);
});
