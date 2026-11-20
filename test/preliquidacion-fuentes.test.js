import test from "node:test";
import assert from "node:assert/strict";

import { valorVicerasSede, valorRetomasSedes } from "../src/shared/preliquidacionFuentes.js";
import { consolidarLiquidacion } from "../src/shared/consolidado.js";
import { calcularCosteo } from "../src/shared/costeo.js";

// ─── valorVicerasSede ───────────────────────────────────────────────────────

const RECEPCION_RES = {
  id: 10,
  sede_id: 1,
  items: [
    { tipo: "carne", descripcion: "Lomo", cantidad: 100, costo_base: 61000 },
    // bloque bonificacion (o sin bloque) descuenta
    { tipo: "vicera", descripcion: "Mondongo", cantidad: 12.345, costo_base: 4500.5, bloque: "bonificacion" },
    { tipo: "vicera", descripcion: "Lengua", cantidad: 3, costo_base: 9000 }, // bloque undefined: descuenta
    // bloque informativo NO descuenta
    { tipo: "vicera", descripcion: "Hígado", cantidad: 50, costo_base: 7000, bloque: "informativo" },
  ],
};

test("valorVicerasSede: solo vísceras que descuentan, cantidad x costo_base en centavos", () => {
  // 12,345 x 4500,5 = 55.558,6725 ; 3 x 9000 = 27.000 ; total 82.558,6725 -> 82.558,67
  assert.equal(valorVicerasSede(RECEPCION_RES, "res"), 8255867n);
});

test("valorVicerasSede: paridad con consolidarLiquidacion/calcularCosteo (valorViceras)", () => {
  const consolidado = consolidarLiquidacion({
    recepciones: [{ ...RECEPCION_RES, sede: "Sede 1" }],
    gastos: [{ valor: 1_000_000, signo: 1 }],
    bonificacionViceras: true,
  });
  const valorEsperado = consolidado.sedes[0].costeo.valorViceras;
  const cent = valorVicerasSede(RECEPCION_RES, "res");
  assert.equal(Number(cent) / 100, valorEsperado);

  // y directo contra calcularCosteo con la misma lista
  const directo = calcularCosteo({
    items: RECEPCION_RES.items.filter((i) => i.tipo === "carne"),
    gastos: [{ valor: 1 }],
    viceras: RECEPCION_RES.items
      .filter((i) => i.tipo === "vicera" && i.bloque !== "informativo")
      .map((i) => ({ cantidad: i.cantidad, precio: i.costo_base })),
    bonificacionViceras: true,
  });
  assert.equal(Number(cent) / 100, directo.valorViceras);
});

test("valorVicerasSede: cerdo => 0 aunque haya renglones de víscera", () => {
  assert.equal(valorVicerasSede(RECEPCION_RES, "cerdo"), 0n);
});

test("valorVicerasSede: sin items o sin vísceras => 0", () => {
  assert.equal(valorVicerasSede({ items: [] }, "res"), 0n);
  assert.equal(valorVicerasSede({}, "res"), 0n);
  assert.equal(valorVicerasSede({ items: [{ tipo: "carne", cantidad: 1, costo_base: 1 }] }, "res"), 0n);
});

test("valorVicerasSede: no hay deriva de float con muchos renglones", () => {
  const items = Array.from({ length: 1000 }, () => ({ tipo: "vicera", cantidad: 0.1, costo_base: 0.3 }));
  // 1000 x 0.03 = 30.00 exacto
  assert.equal(valorVicerasSede({ items }, "res"), 3000n);
});

// ─── valorRetomasSedes ──────────────────────────────────────────────────────

const RETOMAS = [
  { nombre: "Retoma A", kilos: 10.5, precio: 3333.33 }, // 34.999,965
  { nombre: "Retoma B", kilos: 2, precio: 1000 }, // 2.000
];
// total = 34999.965 + 2000 = 36999.965 -> 3.699.997 centavos (36.999,97)

test("valorRetomasSedes: total = Σ kilos x precio y reparto acumulado suma exacto", () => {
  const sedes = [
    { sedeId: "a", animales: 3 },
    { sedeId: "b", animales: 3 },
    { sedeId: "c", animales: 4 },
  ];
  const r = valorRetomasSedes(RETOMAS, sedes, 10, { especie: "cerdo" });
  assert.equal(r.length, 3);
  const suma = r.reduce((a, x) => a + x.valorRetomasCent, 0n);
  assert.equal(suma, 3699997n); // vinculación completa => total exacto
  assert.deepEqual(r.map((x) => x.sedeId), ["a", "b", "c"]);
});

test("valorRetomasSedes: vinculación parcial reparte round(total x vinculados / animales)", () => {
  const sedes = [
    { sedeId: "a", animales: 3 },
    { sedeId: "b", animales: 3 },
  ];
  const r = valorRetomasSedes(RETOMAS, sedes, 10, { especie: "cerdo" });
  const suma = r.reduce((a, x) => a + x.valorRetomasCent, 0n);
  // round(3699997 x 6 / 10) = round(2219998.2) = 2219998
  assert.equal(suma, 2219998n);
});

test("valorRetomasSedes: res => 0 en todas las sedes", () => {
  const sedes = [{ sedeId: "a", animales: 5 }, { sedeId: "b", animales: 5 }];
  const r = valorRetomasSedes(RETOMAS, sedes, 10, { especie: "res" });
  assert.deepEqual(r.map((x) => x.valorRetomasCent), [0n, 0n]);
  assert.deepEqual(r.map((x) => x.sedeId), ["a", "b"]);
});

test("valorRetomasSedes: sin retomas => 0; sedes bloqueadas no reciben", () => {
  const sedes = [{ sedeId: "a", animales: 5 }, { sedeId: "x", animales: 5, bloqueada: true }, { sedeId: "b", animales: 5 }];
  assert.deepEqual(
    valorRetomasSedes([], sedes, 10, { especie: "cerdo" }).map((x) => x.valorRetomasCent),
    [0n, 0n],
  );
  const r = valorRetomasSedes(RETOMAS, sedes, 10, { especie: "cerdo" });
  assert.deepEqual(r.map((x) => x.sedeId), ["a", "b"]);
});

test("valorRetomasSedes: determinista (mismas entradas, mismo reparto)", () => {
  const sedes = [{ sedeId: "a", animales: 7 }, { sedeId: "b", animales: 3 }];
  assert.deepEqual(
    valorRetomasSedes(RETOMAS, sedes, 10, { especie: "cerdo" }),
    valorRetomasSedes(RETOMAS, sedes, 10, { especie: "cerdo" }),
  );
});
