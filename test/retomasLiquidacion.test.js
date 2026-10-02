import test from "node:test";
import assert from "node:assert/strict";

import {
  armarFilasRetomas,
  leerNumero,
  totalKilosRetomas,
  totalRetomas,
  VALOR_TOTAL_MAXIMO,
  validarFilasRetomas,
  valorRetoma,
} from "../src/shared/retomasLiquidacion.js";
import { calcularValorGasto } from "../src/shared/gastos.js";
import { calcularCosteo } from "../src/shared/costeo.js";
import { validators } from "../src/middleware/validators.js";

const CATALOGO = [
  { id: 1, nombre: "Cabeza", precio: 6000, unidad: "KL", orden: 1 },
  { id: 2, nombre: "Tocino Grasa", precio: 2500, unidad: "KL", orden: 2 },
  { id: 3, nombre: "Garra", precio: 600, unidad: "KL", orden: 3 },
];

// ─── Valor ─────────────────────────────────────────────────────────────────

test("valor = kilos × precio, con el mismo redondeo que el gasto Peso × Precio KL", () => {
  assert.equal(valorRetoma({ kilos: 12.5, precio: 6000 }), 75000);
  const rara = { kilos: 120.5, precio: 16800.333 };
  assert.equal(
    valorRetoma(rara),
    calcularValorGasto({ peso: rara.kilos, precio_kilo: rara.precio, valor: 0 }),
  );
});

test("sin kilos o sin precio el valor es 0", () => {
  assert.equal(valorRetoma({ kilos: 0, precio: 6000 }), 0);
  assert.equal(valorRetoma({ kilos: 10, precio: 0 }), 0);
  assert.equal(valorRetoma({}), 0);
});

test("acepta strings numéricos (lo que manda un input)", () => {
  assert.equal(valorRetoma({ kilos: "10", precio: "2500" }), 25000);
});

test("el total suma los valores y los kilos", () => {
  const filas = [
    { kilos: 10, precio: 6000 },
    { kilos: 4.5, precio: 2500 },
    { kilos: 0, precio: 600 },
  ];
  assert.equal(totalRetomas(filas), 71250);
  assert.equal(totalKilosRetomas(filas), 14.5);
  assert.equal(totalRetomas([]), 0);
});

test("leerNumero: vacío es 0, basura es NaN (no 0)", () => {
  assert.equal(leerNumero(""), 0);
  assert.equal(leerNumero(null), 0);
  assert.equal(leerNumero(undefined), 0);
  assert.equal(leerNumero(" 3.5 "), 3.5);
  assert.ok(Number.isNaN(leerNumero("abc")));
  assert.ok(Number.isNaN(leerNumero(Infinity)));
  assert.ok(Number.isNaN(leerNumero({})));
});

// ─── Armar filas ───────────────────────────────────────────────────────────

test("sin nada guardado: todo el catálogo con 0 kilos y el precio del catálogo", () => {
  const filas = armarFilasRetomas({ catalogo: CATALOGO });
  assert.equal(filas.length, 3);
  for (const f of filas) {
    assert.equal(f.kilos, 0);
    assert.equal(f.valor, 0);
    assert.equal(f.guardada, false);
    assert.equal(f.activo, true);
  }
  assert.deepEqual(
    filas.map((f) => f.precio),
    [6000, 2500, 600],
  );
  assert.deepEqual(
    filas.map((f) => f.precio_catalogo),
    [6000, 2500, 600],
  );
});

test("una guardada conserva SU precio aunque el catálogo haya cambiado", () => {
  const filas = armarFilasRetomas({
    catalogo: [{ ...CATALOGO[0], precio: 7000 }, CATALOGO[1], CATALOGO[2]],
    guardadas: [
      { vicera_item_id: 1, nombre: "Cabeza", kilos: 10, precio: 6500, precio_catalogo: 6000, orden: 1 },
    ],
  });
  const cabeza = filas.find((f) => f.vicera_item_id === 1);
  assert.equal(cabeza.kilos, 10);
  assert.equal(cabeza.precio, 6500);
  assert.equal(cabeza.valor, 65000);
  assert.equal(cabeza.guardada, true);
  // Editable: se compara contra el catálogo VIGENTE.
  assert.equal(cabeza.precio_catalogo, 7000);
});

test("congelada: se compara contra el precio de catálogo que se guardó", () => {
  const filas = armarFilasRetomas({
    catalogo: [{ ...CATALOGO[0], precio: 7000 }],
    guardadas: [
      { vicera_item_id: 1, nombre: "Cabeza", kilos: 10, precio: 6000, precio_catalogo: 6000, orden: 1 },
    ],
    congelada: true,
  });
  assert.equal(filas[0].precio_catalogo, 6000);
});

test("una guardada de un ítem dado de baja sigue apareciendo (activo: false)", () => {
  const filas = armarFilasRetomas({
    catalogo: [CATALOGO[0]],
    guardadas: [
      { vicera_item_id: 9, nombre: "Cola", unidad: "KL", kilos: 3, precio: 1000, precio_catalogo: 900, orden: 5 },
    ],
  });
  const cola = filas.find((f) => f.vicera_item_id === 9);
  assert.ok(cola);
  assert.equal(cola.activo, false);
  assert.equal(cola.valor, 3000);
  assert.equal(totalRetomas(filas), 3000);
});

test("las filas salen por `orden`", () => {
  const filas = armarFilasRetomas({
    catalogo: [CATALOGO[2], CATALOGO[0], CATALOGO[1]],
  });
  assert.deepEqual(
    filas.map((f) => f.nombre),
    ["Cabeza", "Tocino Grasa", "Garra"],
  );
});

// ─── Validar ───────────────────────────────────────────────────────────────

const PERMITIDOS = new Set(["1", "2", "3"]);

test("valida y normaliza: kilos a 3 decimales, precio a 2", () => {
  const r = validarFilasRetomas(
    [{ vicera_item_id: "1", kilos: "10.12345", precio: 6000.456 }],
    PERMITIDOS,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.filas, [{ vicera_item_id: 1, kilos: 10.123, precio: 6000.46 }]);
});

test("vacíos cuentan como 0", () => {
  const r = validarFilasRetomas([{ vicera_item_id: 2, kilos: "", precio: null }], PERMITIDOS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.filas, [{ vicera_item_id: 2, kilos: 0, precio: 0 }]);
});

test("rechaza negativos", () => {
  assert.equal(validarFilasRetomas([{ vicera_item_id: 1, kilos: -1, precio: 5 }], PERMITIDOS).ok, false);
  assert.equal(validarFilasRetomas([{ vicera_item_id: 1, kilos: 1, precio: -5 }], PERMITIDOS).ok, false);
});

test("rechaza lo que no es número (no lo vuelve 0)", () => {
  const r = validarFilasRetomas([{ vicera_item_id: 1, kilos: "diez", precio: 5 }], PERMITIDOS);
  assert.equal(r.ok, false);
  assert.match(r.errores[0], /kilos/);
});

test("rechaza ítems fuera del catálogo y repetidos", () => {
  assert.equal(validarFilasRetomas([{ vicera_item_id: 99, kilos: 1, precio: 5 }], PERMITIDOS).ok, false);
  const rep = validarFilasRetomas(
    [
      { vicera_item_id: 1, kilos: 1, precio: 5 },
      { vicera_item_id: 1, kilos: 2, precio: 5 },
    ],
    PERMITIDOS,
  );
  assert.equal(rep.ok, false);
  assert.match(rep.errores[0], /repetida/);
});

test("rechaza valores fuera de rango (ceros de más)", () => {
  assert.equal(validarFilasRetomas([{ vicera_item_id: 1, kilos: 1e12, precio: 5 }], PERMITIDOS).ok, false);
});

test("filas que no son lista no pasan", () => {
  assert.equal(validarFilasRetomas(undefined, PERMITIDOS).ok, false);
});

// ─── Costeo: el gasto derivado RESTA ───────────────────────────────────────

test("el gasto derivado (signo -1) resta del costo real, como el Excel de cerdo", () => {
  const total = totalRetomas([{ kilos: 10, precio: 6000 }]); // 60.000
  const { totalGastos, costoReal } = calcularCosteo({
    items: [{ cantidad: 100, costo_base: 10000 }],
    gastos: [
      { concepto: "Valor de la carne", valor: 800000, signo: 1 },
      { concepto: "Retomas", valor: total, signo: -1 },
    ],
  });
  assert.equal(totalGastos, 740000);
  assert.equal(costoReal, 740000);
});

// ─── Validador del PUT ─────────────────────────────────────────────────────

function correr(body) {
  const req = { body };
  let error;
  validators.guardarRetomas(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("PUT retomas: acepta {por, filas} y el id llega como número", () => {
  const { error, body } = correr({
    por: "admin@merkahorro.com",
    filas: [{ vicera_item_id: "1", kilos: "12.5", precio: 6000 }],
  });
  assert.equal(error, undefined);
  assert.equal(body.filas[0].vicera_item_id, 1);
  assert.equal(body.filas[0].kilos, "12.5");
});

test("PUT retomas: sin filas queda en lista vacía (borra todo)", () => {
  const { error, body } = correr({});
  assert.equal(error, undefined);
  assert.deepEqual(body.filas, []);
});

test("PUT retomas: rechaza una retoma sin id válido", () => {
  assert.ok(correr({ filas: [{ vicera_item_id: 0, kilos: 1, precio: 1 }] }).error);
  assert.ok(correr({ filas: [{ kilos: 1, precio: 1 }] }).error);
});

// ─── Tope del total (cabe en NUMERIC(16,2)) ─────────────────────────────────

test("rechaza un total que desborda la columna aunque cada campo respete su tope", () => {
  const r = validarFilasRetomas(
    [{ vicera_item_id: 1, kilos: 999_999_999, precio: 99_999_999_999 }],
    PERMITIDOS,
  );
  assert.equal(r.ok, false);
  assert.match(r.errores[0], /total de las retomas/);
});

test("rechaza cuando es la SUMA de filas la que pasa el tope", () => {
  const mitad = Math.floor(VALOR_TOTAL_MAXIMO / 2) + 1;
  const r = validarFilasRetomas(
    [
      { vicera_item_id: 1, kilos: 1, precio: mitad },
      { vicera_item_id: 2, kilos: 1, precio: mitad },
    ],
    PERMITIDOS,
  );
  assert.equal(r.ok, false);
});

test("un total justo en el tope se acepta", () => {
  const r = validarFilasRetomas(
    [{ vicera_item_id: 1, kilos: 1, precio: 99_999_999_999 }],
    PERMITIDOS,
  );
  assert.equal(r.ok, true);
});
