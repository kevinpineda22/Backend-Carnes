// Saldo pendiente (C12): qué hacer con la diferencia de un servicio tardío y a qué preliquidación va.
import test from "node:test";
import assert from "node:assert/strict";

const { planearSaldo, elegirDestinoSaldo } = await import("../src/shared/preliquidacionSaldo.js");

const saldo = (extra = {}) => ({ id: 1, valor: "200000.00", estado: "pendiente", destino_preliquidacion_id: null, ...extra });

const abierta = (extra = {}) => ({
  id: 20, especie: "res", estado: "abierta", liquidada_at: null, created_at: "2026-11-25T10:00:00Z", ...extra,
});

test("sin saldos previos y diferencia distinta de cero -> crea el saldo (primer registro, sin ajuste de otro)", () => {
  const r = planearSaldo({ diferencia: "200000.00", saldosOrigen: [] });
  assert.deepEqual(r, { accion: "crear_ajuste", valor: "200000.00", valorCent: 20000000n, ajusteDeSaldoId: null, destinoId: null });
});

test("sin saldos previos y diferencia cero -> nada", () => {
  assert.equal(planearSaldo({ diferencia: "0", saldosOrigen: [] }).accion, "nada");
});

test("E-S2: la diferencia negativa genera un saldo negativo", () => {
  const r = planearSaldo({ diferencia: "-100000", saldosOrigen: [] });
  assert.equal(r.accion, "crear_ajuste");
  assert.equal(r.valor, "-100000.00");
});

test("pendiente existente: se actualiza en el lugar con la nueva diferencia", () => {
  const r = planearSaldo({ diferencia: "350000", saldosOrigen: [saldo({ id: 7, valor: "200000.00" })] });
  assert.equal(r.accion, "actualizar_pendiente");
  assert.equal(r.saldoId, 7);
  assert.equal(r.valor, "350000.00");
  assert.equal(r.descartar, false);
});

test("pendiente existente con el mismo valor -> nada (idempotente)", () => {
  assert.equal(planearSaldo({ diferencia: "200000", saldosOrigen: [saldo()] }).accion, "nada");
});

test("pendiente que queda en cero -> se actualiza a 0 y se marca para descartar", () => {
  const r = planearSaldo({ diferencia: "0", saldosOrigen: [saldo({ id: 7 })] });
  assert.equal(r.accion, "actualizar_pendiente");
  assert.equal(r.valor, "0.00");
  assert.equal(r.descartar, true);
});

test("aplicado: nunca se sobreescribe; se crea una fila de ajuste con diferencia - lo ya aplicado", () => {
  const r = planearSaldo({
    diferencia: "500000",
    saldosOrigen: [saldo({ id: 3, valor: "200000.00", estado: "aplicado", destino_preliquidacion_id: 9 })],
  });
  assert.equal(r.accion, "crear_ajuste");
  assert.equal(r.valor, "300000.00");
  assert.equal(r.ajusteDeSaldoId, 3);
});

test("aplicado + diferencia que vuelve al valor aplicado -> nada", () => {
  const r = planearSaldo({ diferencia: "200000", saldosOrigen: [saldo({ id: 3, estado: "aplicado", destino_preliquidacion_id: 9 })] });
  assert.equal(r.accion, "nada");
});

test("aplicado + nueva diferencia menor: el ajuste es negativo", () => {
  const r = planearSaldo({ diferencia: "50000", saldosOrigen: [saldo({ id: 3, estado: "aplicado", destino_preliquidacion_id: 9 })] });
  assert.equal(r.accion, "crear_ajuste");
  assert.equal(r.valor, "-150000.00");
});

test("aplicado + pendiente: el pendiente absorbe diferencia - aplicado", () => {
  const r = planearSaldo({
    diferencia: "500000",
    saldosOrigen: [
      saldo({ id: 3, valor: "200000.00", estado: "aplicado", destino_preliquidacion_id: 9 }),
      saldo({ id: 4, valor: "100000.00", estado: "pendiente", ajuste_de_saldo_id: 3 }),
    ],
  });
  assert.equal(r.accion, "actualizar_pendiente");
  assert.equal(r.saldoId, 4);
  assert.equal(r.valor, "300000.00");
});

test("las filas movido y descartado no cuentan como saldo vigente", () => {
  const r = planearSaldo({
    diferencia: "200000",
    saldosOrigen: [saldo({ id: 1, estado: "movido" }), saldo({ id: 2, estado: "descartado" }), saldo({ id: 5, estado: "pendiente", valor: "200000.00" })],
  });
  assert.equal(r.accion, "nada");
  const solo = planearSaldo({ diferencia: "200000", saldosOrigen: [saldo({ id: 1, estado: "movido" })] });
  assert.equal(solo.accion, "crear_ajuste");
  assert.equal(solo.ajusteDeSaldoId, null);
});

test("no muta las filas de entrada", () => {
  const filas = [saldo({ id: 3, estado: "aplicado" })];
  const copia = JSON.parse(JSON.stringify(filas));
  planearSaldo({ diferencia: "999", saldosOrigen: filas });
  assert.deepEqual(filas, copia);
});

test("destino: la abierta más antigua de la misma especie, sin liquidar y distinta del origen", () => {
  const abiertas = [
    abierta({ id: 31, created_at: "2026-11-27T10:00:00Z" }),
    abierta({ id: 30, created_at: "2026-11-26T10:00:00Z" }),
    abierta({ id: 29, created_at: "2026-11-25T10:00:00Z", liquidada_at: "2026-11-26T02:31:00Z" }),
    abierta({ id: 28, created_at: "2026-11-24T10:00:00Z", especie: "cerdo" }),
    abierta({ id: 27, created_at: "2026-11-23T10:00:00Z", estado: "cerrada" }),
    abierta({ id: 10, created_at: "2026-11-20T10:00:00Z" }), // es el origen
  ];
  assert.equal(elegirDestinoSaldo({ abiertas, origenId: 10, especie: "res" }), 30);
});

test("destino: sin candidata devuelve null (el saldo espera a que se cree una preliquidación)", () => {
  assert.equal(elegirDestinoSaldo({ abiertas: [], origenId: 10, especie: "res" }), null);
  assert.equal(elegirDestinoSaldo({ abiertas: [abierta({ id: 10 })], origenId: 10, especie: "res" }), null);
  assert.equal(elegirDestinoSaldo({ abiertas: [abierta({ id: 30, especie: "cerdo" })], origenId: 10, especie: "res" }), null);
});

test("destino: empate de created_at se resuelve por id menor", () => {
  const abiertas = [abierta({ id: 41 }), abierta({ id: 40 })];
  assert.equal(elegirDestinoSaldo({ abiertas, origenId: 10, especie: "res" }), 40);
});

test("planearSaldo con candidatas: la fila nueva lleva el destino; actualizar no lo cambia", () => {
  const abiertas = [abierta({ id: 30 })];
  const nuevo = planearSaldo({ diferencia: "200000", saldosOrigen: [], origenId: 10, especie: "res", abiertas });
  assert.equal(nuevo.destinoId, 30);
  const actualizar = planearSaldo({
    diferencia: "300000", saldosOrigen: [saldo({ id: 7, destino_preliquidacion_id: 30 })], origenId: 10, especie: "res", abiertas,
  });
  assert.equal(actualizar.accion, "actualizar_pendiente");
  assert.equal("destinoId" in actualizar, false);
});
