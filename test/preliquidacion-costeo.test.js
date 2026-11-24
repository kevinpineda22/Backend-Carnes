import test from "node:test";
import assert from "node:assert/strict";

import {
  aCentavos,
  centavosATexto,
  roundHalfAwayFromZero,
  montoSedes,
  gastoTotal,
  desbloqueaServicioCero,
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

// ─── gastoTotal (1.5) ──────────────────────────────────────────────────────

const pesos = (texto) => aCentavos(texto);
const BASE = { animalEnPie: "9000000", servicioPrecorte: null, servicioPorAnimal: "50000", animales: 10, gastos: [], saldos: [] };

test("gastoTotal A-S1: servicio vacío usa servicio_por_animal x animales", () => {
  const r = gastoTotal(BASE);
  assert.equal(r.servicioAplicadoCent, pesos("500000"));
  assert.equal(r.gastoTotalCent, pesos("9500000"));
  assert.equal(r.costoPorAnimalCent, pesos("950000"));
  assert.equal(r.bloqueo, undefined);
  assert.deepEqual(r.saldoIds, []);
});

test("gastoTotal A-S5: el servicio real precorte manda sobre el predeterminado", () => {
  const r = gastoTotal({ ...BASE, servicioPrecorte: "700000" });
  assert.equal(r.servicioAplicadoCent, pesos("700000"));
  assert.equal(r.gastoTotalCent, pesos("9700000"));
});

test("gastoTotal C-S6: servicio vacío con predeterminado 50.000 y 10 animales aporta 500.000", () => {
  const r = gastoTotal({ ...BASE, animalEnPie: "9500000" });
  assert.equal(r.servicioAplicadoCent, pesos("500000"));
  assert.equal(r.gastoTotalCent, pesos("10000000"));
  assert.equal(r.costoPorAnimalCent, pesos("1000000"));
});

test("gastoTotal C-S10: saldo pendiente +200.000 sube el total a 10.200.000 (1.020.000 por animal)", () => {
  const r = gastoTotal({ ...BASE, animalEnPie: "9500000", saldos: [{ id: 11, valor: "200000", estado: "pendiente" }] });
  assert.equal(r.gastoTotalCent, pesos("10200000"));
  assert.equal(r.costoPorAnimalCent, pesos("1020000"));
  assert.deepEqual(r.saldoIds, [11]);
});

test("gastoTotal E-S3: 9.000.000 + 500.000 + saldo 200.000 = 9.700.000", () => {
  const r = gastoTotal({ ...BASE, saldos: [{ id: 3, valor: "200000", estado: "pendiente" }] });
  assert.equal(r.gastoTotalCent, pesos("9700000"));
});

test("gastoTotal E-S2: saldo negativo (-100.000) reduce el gasto total", () => {
  const r = gastoTotal({ ...BASE, saldos: [{ id: 4, valor: "-100000", estado: "pendiente" }] });
  assert.equal(r.gastoTotalCent, pesos("9400000"));
  assert.deepEqual(r.saldoIds, [4]);
});

test("gastoTotal: solo suman los saldos pendientes; los demás estados se ignoran y no entran a saldoIds", () => {
  const saldos = [
    { id: 1, valor: "200000", estado: "pendiente" },
    { id: 2, valor: "999999", estado: "aplicado" },
    { id: 3, valor: "999999", estado: "movido" },
    { id: 4, valor: "999999", estado: "descartado" },
    { id: 5, valor: "-50000", estado: "pendiente" },
  ];
  const r = gastoTotal({ ...BASE, saldos });
  assert.equal(r.gastoTotalCent, pesos("9650000"));
  assert.deepEqual(r.saldoIds, [1, 5]);
});

test("gastoTotal: gastos manuales respetan el signo (+1 suma, -1 resta)", () => {
  const gastos = [
    { concepto: "Transporte", valor: "120000.50", signo: 1 },
    { concepto: "Descuento", valor: "20000.25", signo: -1 },
  ];
  const r = gastoTotal({ ...BASE, gastos });
  assert.equal(r.gastoTotalCent, pesos("9600000.25"));
});

test("gastoTotal: bloqueo servicio_cero cuando no hay servicio real ni predeterminado", () => {
  const r = gastoTotal({ ...BASE, servicioPorAnimal: "0" });
  assert.equal(r.bloqueo, "servicio_cero");
  assert.equal(r.servicioAplicadoCent, 0n);
  const conCero = gastoTotal({ ...BASE, servicioPrecorte: "0", servicioPorAnimal: "0" });
  assert.equal(conCero.bloqueo, "servicio_cero");
});

test("gastoTotal: costo por animal es solo de despliegue y redondea half-away en centavos", () => {
  const r = gastoTotal({ animalEnPie: "10000001", servicioPrecorte: "0.01", servicioPorAnimal: "1", animales: 3 });
  assert.equal(r.gastoTotalCent, pesos("10000001.01"));
  assert.equal(r.costoPorAnimalCent, roundHalfAwayFromZero(r.gastoTotalCent, 3n));
});

test("gastoTotal: la salida sirve como p_plan de carnes_preliq_liquidar (NUMERIC como texto)", () => {
  const r = gastoTotal({ ...BASE, saldos: [{ id: 9, valor: "200000", estado: "pendiente" }] });
  assert.deepEqual(r.plan, {
    servicio_aplicado: "500000.00",
    gasto_total: "9700000.00",
    costo_por_animal: "970000.00",
    saldo_ids: [9],
  });
});

test("gastoTotal: animales inválidos se rechazan", () => {
  for (const animales of [0, -1, 2.5, "10", null]) {
    assert.throws(() => gastoTotal({ ...BASE, animales }), /animales/i);
  }
});

// ─── desbloqueaServicioCero (1.5) ──────────────────────────────────────────

test("desbloqueaServicioCero: solo sin liquidar, sin servicio precorte y con predeterminado 0", () => {
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: null, servicioPorAnimal: "0" }), true);
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: "0", servicioPorAnimal: "0" }), true);
  assert.equal(desbloqueaServicioCero({ liquidadaAt: "2026-11-21T03:00:00Z", servicioPrecorte: null, servicioPorAnimal: "0" }), false);
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: "700000", servicioPorAnimal: "0" }), false);
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: null, servicioPorAnimal: "50000" }), false);
});

// ─── M3: servicio_precorte <= 0 se trata como no cargado (1.6) ─────────────

test("M3: precorte 0 con servicio_por_animal > 0 usa el predeterminado (antes quedaba bloqueada sin salida)", () => {
  const r = gastoTotal({ ...BASE, servicioPrecorte: "0" });
  assert.equal(r.servicioAplicadoCent, pesos("500000"));
  assert.equal(r.gastoTotalCent, pesos("9500000"));
  assert.equal(r.bloqueo, undefined);
});

test("M3: precorte negativo con servicio_por_animal > 0 también usa el predeterminado", () => {
  const r = gastoTotal({ ...BASE, servicioPrecorte: "-1" });
  assert.equal(r.servicioAplicadoCent, pesos("500000"));
  assert.equal(r.bloqueo, undefined);
});

test("M3: tabla precorte {null,0,>0,<0} x por_animal {0,>0}: gastoTotal y desbloqueaServicioCero coinciden", () => {
  const precortes = [null, "0", "700000", "-5"];
  const porAnimales = ["0", "50000"];
  const esperado = {
    // clave: `${precorte}|${porAnimal}` -> servicio aplicado en pesos (0 = bloqueada)
    "null|0": "0",
    "0|0": "0",
    "700000|0": "700000",
    "-5|0": "0",
    "null|50000": "500000",
    "0|50000": "500000",
    "700000|50000": "700000",
    "-5|50000": "500000",
  };
  for (const servicioPrecorte of precortes) {
    for (const servicioPorAnimal of porAnimales) {
      const clave = `${servicioPrecorte}|${servicioPorAnimal}`;
      const g = gastoTotal({ ...BASE, servicioPrecorte, servicioPorAnimal });
      const desbloquea = desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte, servicioPorAnimal });
      assert.equal(g.servicioAplicadoCent, pesos(esperado[clave]), `servicio aplicado ${clave}`);
      const bloqueada = g.bloqueo === "servicio_cero";
      assert.equal(bloqueada, g.servicioAplicadoCent === 0n, `bloqueo ${clave}`);
      // Sin callejón: bloqueada por gastoTotal <=> un servicio real la desbloquea.
      assert.equal(desbloquea, bloqueada, `paridad ${clave}`);
    }
  }
});

test("M3: desbloqueaServicioCero trata precorte negativo como no cargado", () => {
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: "-5", servicioPorAnimal: "0" }), true);
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: "0", servicioPorAnimal: "50000" }), false);
});

test("M3: un predeterminado negativo no es un servicio válido: bloquea y se puede desbloquear", () => {
  const g = gastoTotal({ ...BASE, servicioPorAnimal: "-10" });
  assert.equal(g.servicioAplicadoCent, 0n);
  assert.equal(g.bloqueo, "servicio_cero");
  assert.equal(desbloqueaServicioCero({ liquidadaAt: null, servicioPrecorte: null, servicioPorAnimal: "-10" }), true);
});
