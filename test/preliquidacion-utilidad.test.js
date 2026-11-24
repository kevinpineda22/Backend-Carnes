import test from "node:test";
import assert from "node:assert/strict";

import { costearSede } from "../src/shared/preliquidacionCosteo.js";
import { utilidadSede } from "../src/shared/utilidad.js";
import { aCentavos, roundHalfAwayFromZero } from "../src/shared/preliquidacionCosteo.js";
import { calcularCosteo } from "../src/shared/costeo.js";

/**
 * Fixtures: los renglones de la hoja `Plantilla` del archivo de cerdo usado en
 * test/costeo.test.js (costo teórico 29.012.236,00).
 */
const ITEMS_CERDO = [
  { codigo_item: "15139", descripcion: "Cañon de Cerdo", costo_base: 16800, cantidad: 201.57 },
  { codigo_item: "15150", descripcion: "Costilla de Cerdo", costo_base: 16500, cantidad: 225.6 },
  { codigo_item: "15202", descripcion: "Tocino Carnudo", costo_base: 18000, cantidad: 369.46 },
  { codigo_item: "15154", descripcion: "Espinazo", costo_base: 5500, cantidad: 94.1 },
  { codigo_item: "15174", descripcion: "Ossobuco", costo_base: 6500, cantidad: 84.9 },
  { codigo_item: "15182", descripcion: "Pezuña", costo_base: 5500, cantidad: 57.9 },
  { codigo_item: "15183", descripcion: "Pierna De Cerdo", costo_base: 14000, cantidad: 537.01 },
  { codigo_item: "18041", descripcion: "Empella", costo_base: 4500, cantidad: 23.2 },
  { codigo_item: "15166", descripcion: "Brazuelo", costo_base: 13500, cantidad: 245.2 },
  { codigo_item: "18024", descripcion: "Cabeza De Cañon", costo_base: 14000, cantidad: 125.37 },
  { codigo_item: "15177", descripcion: "Papada", costo_base: 13000, cantidad: 90.57 },
];
const COSTO_TEORICO_CERDO_CENT = 2901223600n; // 29.012.236,00

const ITEMS_RES = [
  { codigo_item: "R1", descripcion: "Lomo", costo_base: 61000, cantidad: 100 },
  { codigo_item: "R2", descripcion: "Pulpa", costo_base: 30000, cantidad: 200.5 },
];
const COSTO_TEORICO_RES_CENT = aCentavos(61000 * 100 + 30000 * 200.5); // 12.115.000,00

// ─── utilidadSede (forma cerrada) ───────────────────────────────────────────

test("utilidadSede res: costo teórico - gasto de sede + vísceras", () => {
  const u = utilidadSede({
    especie: "res",
    costoTeoricoCent: 1_000_000_00n,
    gastoSedeCent: 900_000_00n,
    valorVicerasCent: 50_000_00n,
    valorRetomasCent: 999_00n, // se ignora en res
  });
  assert.equal(u, 150_000_00n);
});

test("utilidadSede cerdo: usa retomas y descarta vísceras", () => {
  const u = utilidadSede({
    especie: "cerdo",
    costoTeoricoCent: 1_000_000_00n,
    gastoSedeCent: 900_000_00n,
    valorVicerasCent: 50_000_00n, // se ignora en cerdo
    valorRetomasCent: 20_000_00n,
  });
  assert.equal(u, 120_000_00n);
});

test("utilidadSede: vísceras/retomas por defecto 0 y especie desconocida lanza", () => {
  assert.equal(
    utilidadSede({ especie: "res", costoTeoricoCent: 500n, gastoSedeCent: 200n }),
    300n,
  );
  assert.throws(() => utilidadSede({ especie: "pollo", costoTeoricoCent: 1n, gastoSedeCent: 0n }));
});

// ─── costearSede ────────────────────────────────────────────────────────────

test("C-S9 cerdo: la utilidad suma retomas y no vísceras", () => {
  const r = costearSede({
    items: ITEMS_CERDO,
    gastoSedeCent: 2_651_288_371n, // 26.512.883,71
    especie: "cerdo",
    valorVicerasCent: 777_00n, // debe ignorarse
    valorRetomasCent: 100_000_000n, // 1.000.000,00
  });
  assert.equal(r.costoTeoricoCent, COSTO_TEORICO_CERDO_CENT);
  assert.equal(r.utilidadCent, 2_901_223_600n - 2_651_288_371n + 100_000_000n); // 349.935.229
  assert.deepEqual(r.bloqueos, []);
});

test("C-S9 res: la utilidad suma vísceras y no retomas", () => {
  const r = costearSede({
    items: ITEMS_RES,
    gastoSedeCent: 10_000_000_00n,
    especie: "res",
    valorVicerasCent: 300_000_00n,
    valorRetomasCent: 999_00n, // debe ignorarse
  });
  assert.equal(r.costoTeoricoCent, COSTO_TEORICO_RES_CENT);
  assert.equal(r.utilidadCent, COSTO_TEORICO_RES_CENT - 10_000_000_00n + 300_000_00n);
});

test("C-S4: las vísceras no entran al prorrateo, solo a la utilidad", () => {
  const sin = costearSede({ items: ITEMS_RES, gastoSedeCent: 10_000_000_00n, especie: "res", valorVicerasCent: 0n });
  const con = costearSede({ items: ITEMS_RES, gastoSedeCent: 10_000_000_00n, especie: "res", valorVicerasCent: 400_000_00n });

  // Cambia la utilidad (y por ende el servicio de compra), pero el costo teórico no.
  assert.equal(con.costoTeoricoCent, sin.costoTeoricoCent);
  assert.equal(con.utilidadCent, sin.utilidadCent + 400_000_00n);
  // El único gasto del prorrateo es gasto de sede + servicio de compra.
  assert.equal(Math.round(con.costeoFinal.totalGastos * 100), Number(10_000_000_00n + con.servicioCompraCent));
  assert.equal(con.costeoFinal.valorViceras, 0);
});

test("C-S5: servicio de compra = utilidad / 2 una sola vez, mitad hacia afuera del cero", () => {
  const r = costearSede({
    items: ITEMS_CERDO,
    gastoSedeCent: 2_651_288_371n,
    especie: "cerdo",
    valorRetomasCent: 100_000_000n,
  });
  // 349.935.229 / 2 = 174.967.614,5 -> 174.967.615
  assert.equal(r.servicioCompraCent, 174_967_615n);
  assert.equal(r.servicioCompraCent, roundHalfAwayFromZero(r.utilidadCent, 2n));
  // El gasto del costeo final es gasto de sede + servicio de compra, en pesos.
  assert.equal(r.costeoFinal.totalGastos, 28_262_559.86);
  // Una sola pasada: cuadra contra calcularCosteo directo.
  const directo = calcularCosteo({
    items: ITEMS_CERDO,
    gastos: [{ valor: 28_262_559.86 }],
    bonificacionViceras: false,
  });
  assert.deepEqual(r.costeoFinal.items, directo.items);
});

test("C-S5: recalcular con las mismas entradas da exactamente lo mismo", () => {
  const entrada = {
    items: ITEMS_CERDO,
    gastoSedeCent: 2_651_288_371n,
    especie: "cerdo",
    valorRetomasCent: 100_000_000n,
  };
  const a = costearSede(entrada);
  const b = costearSede(entrada);
  assert.equal(a.servicioCompraCent, b.servicioCompraCent);
  assert.deepEqual(a.costeoFinal, b.costeoFinal);
  assert.deepEqual(a.plan, b.plan);
});

test("C-S5: servicio de compra negativo también redondea hacia afuera del cero", () => {
  // utilidad = 1.000,00 (costo teórico) - 1.000,03 de gasto = -0,03 -> -1,5 centavos -> -2
  const items = [{ codigo_item: "X", costo_base: 10, cantidad: 100 }];
  const r = costearSede({ items, gastoSedeCent: 100_003n, especie: "res" });
  assert.equal(r.utilidadCent, -3n);
  assert.equal(r.servicioCompraCent, -2n);
});

test("C-S7: utilidad negativa bloquea con utilidad_negativa", () => {
  const r = costearSede({
    items: ITEMS_RES,
    gastoSedeCent: COSTO_TEORICO_RES_CENT + 1_00n, // gasto mayor al costo teórico
    especie: "res",
  });
  assert.equal(r.utilidadCent, -1_00n);
  assert.equal(r.bloqueos.length, 1);
  assert.equal(r.bloqueos[0].motivo, "utilidad_negativa");
});

test("C-S8: utilidad cero no bloquea y el servicio de compra es 0", () => {
  const r = costearSede({ items: ITEMS_RES, gastoSedeCent: COSTO_TEORICO_RES_CENT, especie: "res" });
  assert.equal(r.utilidadCent, 0n);
  assert.equal(r.servicioCompraCent, 0n);
  assert.deepEqual(r.bloqueos, []);
});

test("factor_anula_costos solo cuenta en la pasada final y bloquea con costeo_invalido", () => {
  // Gasto de sede negativo (saldo a favor) igual al costo teórico: el gasto final
  // (gasto + servicio de compra) queda en 0 y el factor en 1.
  const items = [{ codigo_item: "X", costo_base: 1000, cantidad: 10 }]; // 10.000,00
  const r = costearSede({ items, gastoSedeCent: -1_000_000n, especie: "res" });
  assert.equal(r.utilidadCent, 2_000_000n);
  assert.equal(r.servicioCompraCent, 1_000_000n);
  assert.ok(r.costeoFinal.advertencias.some((a) => a.codigo === "factor_anula_costos"));
  assert.deepEqual(r.bloqueos.map((b) => b.motivo), ["costeo_invalido"]);
});

test("una sola pasada final: bonificacionViceras=false y el factor se calcula con gasto + servicio", () => {
  const r = costearSede({
    items: ITEMS_RES,
    gastoSedeCent: 10_000_000_00n,
    especie: "res",
    valorVicerasCent: 300_000_00n,
  });
  assert.equal(r.costeoFinal.valorViceras, 0);
  assert.equal(r.costeoFinal.costoReal, r.costeoFinal.totalGastos);
});

test("plan: valores NUMERIC en texto listos para el RPC", () => {
  const r = costearSede({
    items: ITEMS_CERDO,
    gastoSedeCent: 2_651_288_371n,
    especie: "cerdo",
    valorRetomasCent: 100_000_000n,
  });
  assert.equal(r.plan.gasto_sede, "26512883.71");
  assert.equal(r.plan.utilidad, "3499352.29");
  assert.equal(r.plan.servicio_compra, "1749676.15");
  assert.equal(r.plan.valor_viceras, "0.00");
  assert.equal(r.plan.valor_retomas, "1000000.00");
});

test("costearSede: gasto no entero o especie inválida lanza", () => {
  assert.throws(() => costearSede({ items: ITEMS_RES, gastoSedeCent: 10.5, especie: "res" }));
  assert.throws(() => costearSede({ items: ITEMS_RES, gastoSedeCent: 10n, especie: "pollo" }));
});
