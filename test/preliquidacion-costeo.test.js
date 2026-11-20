import test from "node:test";
import assert from "node:assert/strict";

import {
  aCentavos,
  centavosATexto,
  roundHalfAwayFromZero,
  montoSedes,
} from "../src/shared/preliquidacionCosteo.js";

// ─── aCentavos ─────────────────────────────────────────────────────────────

test("aCentavos: parsea texto NUMERIC de Postgres sin pasar por float", () => {
  assert.equal(aCentavos("10000000.01"), 1000000001n);
  assert.equal(aCentavos("0"), 0n);
  assert.equal(aCentavos("12"), 1200n);
  assert.equal(aCentavos("12.5"), 1250n);
  assert.equal(aCentavos(".5"), 50n);
  assert.equal(aCentavos("-1234.56"), -123456n);
  assert.equal(aCentavos("+7.10"), 710n);
  assert.equal(aCentavos("  42.00  "), 4200n);
});

test("aCentavos: valores grandes no pierden precisión (más allá de 2^53)", () => {
  assert.equal(aCentavos("99999999999999.99"), 9999999999999999n);
  assert.equal(aCentavos("123456789012345678.90"), 12345678901234567890n);
  assert.equal(aCentavos("-99999999999999.99"), -9999999999999999n);
});

test("aCentavos: más de dos decimales redondea half-away-from-zero por el tercer dígito", () => {
  assert.equal(aCentavos("0.004"), 0n);
  assert.equal(aCentavos("0.005"), 1n);
  assert.equal(aCentavos("-0.005"), -1n);
  assert.equal(aCentavos("-0.004"), 0n);
  assert.equal(aCentavos("1.2349999"), 123n);
  assert.equal(aCentavos("1.2350001"), 124n);
});

test("aCentavos: acepta números finitos y bigint; rechaza basura", () => {
  assert.equal(aCentavos(10), 1000n);
  assert.equal(aCentavos(0.1), 10n);
  assert.equal(aCentavos(-2.5), -250n);
  assert.equal(aCentavos(5n), 500n);
  for (const malo of [undefined, null, "", "  ", "abc", "1,5", "1e3", "--1", NaN, Infinity, {}, []]) {
    assert.throws(() => aCentavos(malo), /valor monetario/i, `debió rechazar ${String(malo)}`);
  }
});

// ─── centavosATexto ────────────────────────────────────────────────────────

test("centavosATexto: ida y vuelta con aCentavos, siempre dos decimales", () => {
  assert.equal(centavosATexto(1000000001n), "10000000.01");
  assert.equal(centavosATexto(0n), "0.00");
  assert.equal(centavosATexto(5n), "0.05");
  assert.equal(centavosATexto(-5n), "-0.05");
  assert.equal(centavosATexto(-123456n), "-1234.56");
  assert.equal(centavosATexto(9999999999999999n), "99999999999999.99");
  assert.equal(centavosATexto(aCentavos("-77.30")), "-77.30");
});

// ─── roundHalfAwayFromZero ─────────────────────────────────────────────────

test("roundHalfAwayFromZero: mitades se alejan de cero, en ambos signos", () => {
  assert.equal(roundHalfAwayFromZero(5n, 2n), 3n); // 2.5
  assert.equal(roundHalfAwayFromZero(-5n, 2n), -3n); // -2.5
  assert.equal(roundHalfAwayFromZero(5n, -2n), -3n);
  assert.equal(roundHalfAwayFromZero(-5n, -2n), 3n);
  assert.equal(roundHalfAwayFromZero(1n, 2n), 1n); // 0.5
  assert.equal(roundHalfAwayFromZero(-1n, 2n), -1n);
});

test("roundHalfAwayFromZero: fuera de la mitad redondea al más cercano", () => {
  assert.equal(roundHalfAwayFromZero(1n, 3n), 0n);
  assert.equal(roundHalfAwayFromZero(2n, 3n), 1n);
  assert.equal(roundHalfAwayFromZero(-1n, 3n), 0n);
  assert.equal(roundHalfAwayFromZero(-2n, 3n), -1n);
  assert.equal(roundHalfAwayFromZero(9n, 3n), 3n); // exacto
  assert.equal(roundHalfAwayFromZero(0n, 7n), 0n);
});

test("roundHalfAwayFromZero: divisor cero se rechaza", () => {
  assert.throws(() => roundHalfAwayFromZero(1n, 0n), /divisor/i);
});

// ─── montoSedes ────────────────────────────────────────────────────────────

const sede = (sedeId, animales, extra = {}) => ({ sedeId, animales, ...extra });
const suma = (filas) => filas.reduce((acc, f) => acc + f.gastoSedeCent, 0n);

test("montoSedes C-S1: vinculación completa suma exactamente el gasto total", () => {
  const filas = montoSedes([sede(1, 4), sede(2, 6)], { gastoTotalCent: aCentavos("1000000"), animales: 10 });
  assert.deepEqual(
    filas.map((f) => [f.sedeId, f.gastoSedeCent]),
    [
      [1, 40000000n],
      [2, 60000000n],
    ],
  );
  assert.equal(suma(filas), aCentavos("1000000"));
});

test("montoSedes C-S3: 10.000.001 entre 3 animales por redondeo acumulado, sin perder un centavo", () => {
  const gastoTotalCent = aCentavos("10000001");
  const filas = montoSedes([sede(1, 1), sede(2, 1), sede(3, 1)], { gastoTotalCent, animales: 3 });
  assert.deepEqual(
    filas.map((f) => f.gastoSedeCent),
    [333333367n, 333333366n, 333333367n],
  );
  assert.deepEqual(
    filas.map((f) => f.acumulado),
    [1, 2, 3],
  );
  assert.equal(suma(filas), gastoTotalCent);
});

test("montoSedes: vinculación parcial suma round(vinculados x gasto / animales)", () => {
  const gastoTotalCent = aCentavos("10000001");
  const filas = montoSedes([sede(1, 1), sede(2, 1)], { gastoTotalCent, animales: 3 });
  assert.equal(suma(filas), roundHalfAwayFromZero(2n * gastoTotalCent, 3n));
  assert.equal(suma(filas), 666666733n);
});

test("montoSedes: gasto negativo (saldos a favor) es simétrico y exacto", () => {
  const gastoTotalCent = aCentavos("-10000001");
  const filas = montoSedes([sede(1, 1), sede(2, 1), sede(3, 1)], { gastoTotalCent, animales: 3 });
  assert.deepEqual(
    filas.map((f) => f.gastoSedeCent),
    [-333333367n, -333333366n, -333333367n],
  );
  assert.equal(suma(filas), gastoTotalCent);
});

test("montoSedes: valores grandes sin deriva de float", () => {
  const gastoTotalCent = aCentavos("99999999999999.99");
  const filas = montoSedes([sede(1, 7), sede(2, 11), sede(3, 13)], { gastoTotalCent, animales: 31 });
  assert.equal(suma(filas), gastoTotalCent);
  assert.ok(filas.every((f) => typeof f.gastoSedeCent === "bigint"));
});

test("montoSedes: las sedes bloqueadas no consumen ni reciben monto", () => {
  const filas = montoSedes([sede(1, 4), sede(2, 3, { bloqueada: true }), sede(3, 6)], {
    gastoTotalCent: aCentavos("1000000"),
    animales: 10,
  });
  assert.deepEqual(
    filas.map((f) => f.sedeId),
    [1, 3],
  );
  assert.deepEqual(
    filas.map((f) => f.gastoSedeCent),
    [40000000n, 60000000n],
  );
});

test("montoSedes: el orden de entrada es el orden de vinculación (el redondeo depende de él)", () => {
  // 1 centavo entre 2 animales: la mitad se aleja de cero y la lleva la primera sede vinculada.
  const opciones = { gastoTotalCent: 1n, animales: 2 };
  const porId = (filas) => Object.fromEntries(filas.map((f) => [f.sedeId, f.gastoSedeCent]));
  assert.deepEqual(porId(montoSedes([sede(1, 1), sede(2, 1)], opciones)), { 1: 1n, 2: 0n });
  assert.deepEqual(porId(montoSedes([sede(2, 1), sede(1, 1)], opciones)), { 1: 0n, 2: 1n });
});

test("montoSedes: es determinista (misma entrada, misma salida)", () => {
  const entrada = [sede(1, 3), sede(2, 5), sede(3, 2)];
  const opciones = { gastoTotalCent: aCentavos("7654321.09"), animales: 10 };
  assert.deepEqual(montoSedes(entrada, opciones), montoSedes(entrada, opciones));
});

test("montoSedes: una sede enviada conserva su monto aunque el gasto total cambie", () => {
  const gastoTotalCent = aCentavos("10000001");
  const original = montoSedes([sede(1, 1), sede(2, 1), sede(3, 1)], { gastoTotalCent, animales: 3 });
  // El gasto total sube; la sede 1 ya se envió con su monto original y no se mueve.
  const nuevoGasto = aCentavos("12000000");
  const filas = montoSedes(
    [sede(1, 1, { gastoSedeCentFijo: original[0].gastoSedeCent }), sede(2, 1), sede(3, 1)],
    { gastoTotalCent: nuevoGasto, animales: 3 },
  );
  assert.equal(filas[0].gastoSedeCent, original[0].gastoSedeCent);
  // Las no enviadas absorben la diferencia: el total de la vinculación completa sigue exacto.
  assert.equal(suma(filas), nuevoGasto);
});

test("montoSedes: sin cambios en el gasto, las enviadas coinciden con el cálculo puro", () => {
  const gastoTotalCent = aCentavos("10000001");
  const original = montoSedes([sede(1, 1), sede(2, 1), sede(3, 1)], { gastoTotalCent, animales: 3 });
  const filas = montoSedes(
    [sede(1, 1, { gastoSedeCentFijo: original[0].gastoSedeCent }), sede(2, 1), sede(3, 1)],
    { gastoTotalCent, animales: 3 },
  );
  assert.deepEqual(filas, original);
});

test("montoSedes: entradas inválidas se rechazan", () => {
  const ok = { gastoTotalCent: 100n, animales: 3 };
  assert.throws(() => montoSedes([sede(1, 1)], { ...ok, animales: 0 }), /animales/i);
  assert.throws(() => montoSedes([sede(1, 1)], { ...ok, animales: 2.5 }), /animales/i);
  assert.throws(() => montoSedes([sede(1, 0)], ok), /animales/i);
  assert.throws(() => montoSedes([sede(1, 4)], ok), /excede/i);
  assert.throws(() => montoSedes([sede(1, 1)], { ...ok, gastoTotalCent: 1.5 }), /gastoTotalCent/);
  assert.deepEqual(montoSedes([], ok), []);
});
