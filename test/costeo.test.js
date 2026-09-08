import test from "node:test";
import assert from "node:assert/strict";

import { calcularCosteo, repartirPorSede } from "../src/shared/costeo.js";

/**
 * Los números de este archivo NO son inventados: salen de los Excel que el admin
 * usa hoy, celda por celda. Si un cambio en `costeo.js` los mueve, movió la
 * plata que se le manda a SIESA.
 *
 *   · Cerdo → "1. Principal.xlsm", hoja `Plantilla`
 *   · Res   → "01 Septiembre 2026.xlsx", hoja `Datos `
 */

/** `ITEMS` + `Plantilla`!D15:F25 del archivo de cerdo, tal cual. */
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

/** `Plantilla`!G6 = D9*D10 = 12902.4 × 2054.88 — el único gasto cargado. */
const GASTOS_CERDO = [
  { concepto: "Valor de la carne", valor: 26512883.712, signo: 1 },
];

test("cerdo: reproduce el costeo del Excel celda por celda", () => {
  const r = calcularCosteo({ items: ITEMS_CERDO, gastos: GASTOS_CERDO });

  // `Plantilla`!F26 — SUBTOTAL(109, F15:F25)
  assert.equal(r.cantidadTotal, 2054.88);
  // `Plantilla`!G26 — SUM(G15:G25)
  assert.equal(r.costoTeorico, 29012236);
  // `Plantilla`!G11 — SUM(G6:G8) - G9
  assert.equal(r.costoReal, 26512883.71);
  // `Plantilla`!I11 — (I7/G26)*100%
  assert.ok(Math.abs(r.factor - 0.08614821305052113) < 1e-9, `factor = ${r.factor}`);

  // `Plantilla`!H15 y !I15 — Cañon de Cerdo
  const canon = r.items[0];
  assert.ok(Math.abs(canon.costo_ajustado - 15352.710020751245) < 0.001);
  assert.ok(Math.abs(canon.costo_total - 3094645.7588828285) < 0.01);

  // `Plantilla`!I25 — Papada, el último renglón
  const papada = r.items.at(-1);
  assert.ok(Math.abs(papada.costo_total - 1075978.2324721857) < 0.01);

  assert.deepEqual(r.advertencias, []);
});

test("cerdo: la suma de los renglones cierra contra el costo real", () => {
  const r = calcularCosteo({ items: ITEMS_CERDO, gastos: GASTOS_CERDO });

  // El prorrateo es exacto por construcción: lo único que separa la suma del
  // costo real es el redondeo a dos decimales de cada renglón.
  assert.ok(Math.abs(r.residuo) <= 1, `residuo = ${r.residuo}`);
});

test("retomas: un gasto con signo -1 baja el costo real", () => {
  const base = calcularCosteo({ items: ITEMS_CERDO, gastos: GASTOS_CERDO });
  const conRetoma = calcularCosteo({
    items: ITEMS_CERDO,
    gastos: [...GASTOS_CERDO, { concepto: "Retomas", valor: 1_000_000, signo: -1 }],
  });

  assert.equal(conRetoma.costoReal, base.costoReal - 1_000_000);
  // Menos costo real ⇒ factor más grande ⇒ cada corte más barato.
  assert.ok(conRetoma.factor > base.factor);
  assert.ok(conRetoma.items[0].costo_ajustado < base.items[0].costo_ajustado);
});

test("un gasto sin signo suma (default 1)", () => {
  const r = calcularCosteo({
    items: ITEMS_CERDO,
    gastos: [{ concepto: "Fletes", valor: 500_000 }],
  });
  assert.equal(r.costoReal, 500_000);
});

test("vísceras: solo descuentan con la bonificación encendida", () => {
  const viceras = [
    { nombre: "Viceras", cantidad: 25.4, precio: 17000 },
    { nombre: "Mondongo", cantidad: 16.8, precio: 18000 },
  ];
  const esperado = 25.4 * 17000 + 16.8 * 18000; // 733 000

  const apagado = calcularCosteo({ items: ITEMS_CERDO, gastos: GASTOS_CERDO, viceras });
  assert.equal(apagado.valorViceras, 0);

  const encendido = calcularCosteo({
    items: ITEMS_CERDO,
    gastos: GASTOS_CERDO,
    viceras,
    bonificacionViceras: true,
  });
  assert.equal(encendido.valorViceras, esperado);
  assert.equal(encendido.costoReal, apagado.costoReal - esperado);
});

test("sin gastos cargados el factor da 1 y AVISA en vez de mandar ceros", () => {
  // Este es el estado real del archivo de res hoy: `Datos `!P16 vacío, así que
  // toda la columna G de cada hoja de sede está en cero y nada lo dice.
  const r = calcularCosteo({ items: ITEMS_CERDO, gastos: [] });

  assert.equal(r.factor, 1);
  assert.equal(r.items[0].costo_ajustado, 0);
  assert.ok(r.advertencias.some((a) => a.codigo === "factor_anula_costos"));
});

test("sin cantidades no divide por cero", () => {
  const r = calcularCosteo({
    items: [{ codigo_item: "15139", costo_base: 16800, cantidad: 0 }],
    gastos: GASTOS_CERDO,
  });

  assert.equal(r.factor, 0);
  assert.equal(r.costoPromedioKilo, 0);
  assert.ok(r.advertencias.some((a) => a.codigo === "costo_teorico_cero"));
  // Factor 0 ⇒ el costo ajustado es el precio de lista, no NaN ni 0.
  assert.equal(r.items[0].costo_ajustado, 16800);
});

test("costo real por encima del teórico encarece los cortes y avisa", () => {
  const r = calcularCosteo({
    items: ITEMS_CERDO,
    gastos: [{ concepto: "Ganado", valor: 35_000_000 }],
  });

  assert.ok(r.factor < 0);
  assert.ok(r.items[0].costo_ajustado > 16800);
  assert.ok(r.advertencias.some((a) => a.codigo === "costo_real_supera_teorico"));
});

test("las cantidades aceptan decimales sin perderlos", () => {
  const r = calcularCosteo({
    items: [{ codigo_item: "15139", costo_base: 10000, cantidad: 12.345 }],
    gastos: [{ concepto: "Ganado", valor: 123450 }],
  });

  assert.equal(r.cantidadTotal, 12.345);
  assert.equal(r.costoTeorico, 123450);
  assert.equal(r.factor, 0);
  assert.equal(r.items[0].costo_total, 123450);
});

test("valores basura (null, undefined, texto) se leen como 0, no como NaN", () => {
  const r = calcularCosteo({
    items: [
      { codigo_item: "A", costo_base: null, cantidad: undefined },
      { codigo_item: "B", costo_base: "20000", cantidad: "3" },
    ],
    gastos: [{ concepto: "Ganado", valor: "60000" }],
  });

  assert.equal(r.costoTeorico, 60000);
  assert.equal(r.costoReal, 60000);
  assert.ok(Number.isFinite(r.items[0].costo_total));
  assert.equal(r.items[0].costo_total, 0);
});

test("res: el reparto por sede reproduce los % de participación del Excel", () => {
  // `Datos `!fila 41 (kilos) y fila 42 (% participación) del archivo de res.
  const recepciones = [
    { sede_id: "Villahermosa", cantidad: 388.22 },
    { sede_id: "Parque", cantidad: 260.79 },
    { sede_id: "Lopez", cantidad: 133.5 },
  ];

  const [villa, parque, lopez] = repartirPorSede(recepciones, 10_000_000);

  assert.ok(Math.abs(villa.participacion - 0.496121455316865) < 1e-12);
  assert.ok(Math.abs(parque.participacion - 0.3332736961827964) < 1e-12);
  assert.ok(Math.abs(lopez.participacion - 0.17060484850033866) < 1e-12);

  // El reparto no puede crear ni perder plata.
  const suma = villa.valorFactura + parque.valorFactura + lopez.valorFactura;
  assert.ok(Math.abs(suma - 10_000_000) < 0.01);
});

test("res: una sede sin kilos no se lleva parte de la factura", () => {
  const r = repartirPorSede(
    [
      { sede_id: "Villahermosa", cantidad: 100 },
      { sede_id: "Llano", cantidad: 0 },
    ],
    5_000_000,
  );

  assert.equal(r[1].participacion, 0);
  assert.equal(r[1].valorFactura, 0);
  assert.equal(r[0].valorFactura, 5_000_000);
});

test("reparto sin kilos en ninguna sede no explota", () => {
  const r = repartirPorSede([{ sede_id: "Llano", cantidad: 0 }], 5_000_000);
  assert.equal(r[0].participacion, 0);
  assert.equal(r[0].valorFactura, 0);
});
