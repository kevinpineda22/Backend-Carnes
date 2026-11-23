// Liquidación alterna informativa (servicio tardío): real vs aplicado, por sede. Nunca se envía a SIESA.
import test from "node:test";
import assert from "node:assert/strict";

const { compararAlterna } = await import("../src/shared/preliquidacionAlterna.js");

const sede = (extra = {}) => ({ id: 1, orden: 1, animales: 4, estado: "calculada", gasto_sede: "3800000.00", ...extra });

// animales=10, gasto_total aplicado 9,500,000 (9,000,000 en pie + 500,000 de servicio) -> 950,000 por animal.
const sedesBase = () => [
  sede({ id: 1, orden: 1, animales: 4, gasto_sede: "3800000.00" }),
  sede({ id: 2, orden: 2, animales: 6, gasto_sede: "5700000.00" }),
];

test("E-S1: servicio real 700,000 contra 500,000 aplicado -> +200,000 repartido por sede", () => {
  const r = compararAlterna({ sedesCalculadas: sedesBase(), servicioReal: "700000", servicioAplicado: "500000.00", animales: 10 });
  assert.equal(r.hayAlterna, true);
  assert.equal(r.diferenciaCent, 20000000n);
  assert.deepEqual(
    r.porSede.map((s) => [s.sedeId, s.diferenciaCent, s.gastoSedeAplicadoCent, s.gastoSedeRealCent]),
    [
      [1, 8000000n, 380000000n, 388000000n],
      [2, 12000000n, 570000000n, 582000000n],
    ],
  );
  assert.equal(r.noAsignadaCent, 0n);
});

test("E-S2: servicio real menor (400,000 contra 500,000) -> diferencia negativa", () => {
  const r = compararAlterna({ sedesCalculadas: sedesBase(), servicioReal: 400000, servicioAplicado: "500000.00", animales: 10 });
  assert.equal(r.diferenciaCent, -10000000n);
  assert.deepEqual(r.porSede.map((s) => s.diferenciaCent), [-4000000n, -6000000n]);
});

test("las diferencias por sede suman la diferencia en centavos exactos (redondeo acumulado)", () => {
  const sedes = [1, 2, 3].map((n) => sede({ id: n, orden: n, animales: 1, gasto_sede: "3333333.33" }));
  const r = compararAlterna({ sedesCalculadas: sedes, servicioReal: "100.00", servicioAplicado: "0", animales: 3 });
  assert.equal(r.diferenciaCent, 10000n);
  assert.deepEqual(r.porSede.map((s) => s.diferenciaCent), [3333n, 3334n, 3333n]);
  assert.equal(r.porSede.reduce((a, s) => a + s.diferenciaCent, 0n), r.diferenciaCent);
});

test("vinculación parcial: lo no asignado queda aparte y todo suma la diferencia", () => {
  const sedes = [sede({ id: 1, orden: 1, animales: 4 }), sede({ id: 2, orden: 2, animales: 3 })];
  const r = compararAlterna({ sedesCalculadas: sedes, servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  assert.deepEqual(r.porSede.map((s) => s.diferenciaCent), [8000000n, 6000000n]);
  assert.equal(r.noAsignadaCent, 6000000n);
  assert.equal(r.porSede.reduce((a, s) => a + s.diferenciaCent, 0n) + r.noAsignadaCent, r.diferenciaCent);
});

test("cero sedes enviadas: se calcula sobre toda sede con gasto congelado, en cualquier estado no bloqueado", () => {
  const sedes = ["calculada", "lista_para_enviar", "error", "simulada", "enviada", "anulada"].map((estado, i) =>
    sede({ id: i + 1, orden: i + 1, animales: 1, estado, gasto_sede: "950000.00" }),
  );
  const r = compararAlterna({ sedesCalculadas: sedes, servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  assert.deepEqual(r.porSede.map((s) => s.sedeId), [1, 2, 3, 4, 5, 6]);
  const soloPendientes = compararAlterna({
    sedesCalculadas: sedes.slice(0, 1), servicioReal: "700000", servicioAplicado: "500000", animales: 10,
  });
  assert.equal(soloPendientes.porSede.length, 1);
  assert.equal(soloPendientes.porSede[0].diferenciaCent, 2000000n);
});

test("ignora sedes sin gasto congelado (vinculada) y bloqueadas; ordena por orden", () => {
  const sedes = [
    sede({ id: 3, orden: 3, animales: 2, gasto_sede: "1900000.00" }),
    sede({ id: 1, orden: 1, animales: 2, estado: "vinculada", gasto_sede: null }),
    sede({ id: 4, orden: 4, animales: 3, estado: "bloqueada", gasto_sede: null }),
    sede({ id: 2, orden: 2, animales: 2, gasto_sede: "1900000.00" }),
  ];
  const r = compararAlterna({ sedesCalculadas: sedes, servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  assert.deepEqual(r.porSede.map((s) => s.sedeId), [2, 3]);
  assert.deepEqual(r.porSede.map((s) => s.diferenciaCent), [4000000n, 4000000n]);
});

test("E-S7: servicio real igual al aplicado (cargado antes del corte) -> no hay alterna", () => {
  const r = compararAlterna({ sedesCalculadas: sedesBase(), servicioReal: "500000.00", servicioAplicado: "500000", animales: 10 });
  assert.equal(r.hayAlterna, false);
  assert.equal(r.diferenciaCent, 0n);
  assert.ok(r.porSede.every((s) => s.diferenciaCent === 0n));
});

test("sin sedes con gasto: la diferencia existe pero queda toda sin asignar", () => {
  const r = compararAlterna({ sedesCalculadas: [], servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  assert.equal(r.hayAlterna, true);
  assert.deepEqual(r.porSede, []);
  assert.equal(r.noAsignadaCent, 20000000n);
});

test("plan serializable para carnes_preliq_registrar_alterna (texto NUMERIC, sin BigInt)", () => {
  const r = compararAlterna({ sedesCalculadas: sedesBase(), servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  assert.deepEqual(r.plan, {
    servicio_real: "700000.00",
    servicio_aplicado: "500000.00",
    diferencia: "200000.00",
    no_asignada: "0.00",
    por_sede: [
      { sede_id: 1, gasto_sede_aplicado: "3800000.00", gasto_sede_real: "3880000.00", diferencia: "80000.00" },
      { sede_id: 2, gasto_sede_aplicado: "5700000.00", gasto_sede_real: "5820000.00", diferencia: "120000.00" },
    ],
  });
  assert.doesNotThrow(() => JSON.stringify(r.plan));
});

test("es determinista y no muta las sedes de entrada", () => {
  const sedes = sedesBase();
  const copia = JSON.parse(JSON.stringify(sedes));
  const a = compararAlterna({ sedesCalculadas: sedes, servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  const b = compararAlterna({ sedesCalculadas: sedes, servicioReal: "700000", servicioAplicado: "500000", animales: 10 });
  assert.deepEqual(a, b);
  assert.deepEqual(sedes, copia);
});

test("entradas inválidas fallan: servicio real ausente o animales no positivos", () => {
  assert.throws(() => compararAlterna({ sedesCalculadas: [], servicioReal: null, servicioAplicado: "1", animales: 10 }));
  assert.throws(() => compararAlterna({ sedesCalculadas: [], servicioReal: "1", servicioAplicado: "1", animales: 0 }));
});
