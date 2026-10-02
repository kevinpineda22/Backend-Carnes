import test from "node:test";
import assert from "node:assert/strict";

import {
  TOPE_COLUMNAS_CARGA,
  TOPE_FILAS_CARGA,
  filasAGuardar,
  idsADesactivarDelPlan,
  planearCargaPlantilla,
  resumenParaRespuesta,
  validarFormaFilas,
} from "../src/shared/plantillaProveedor.js";
import { validators } from "../src/middleware/validators.js";

// El contenido de cada fila lo juzga el normalizador (equivalenciasProveedor.test.js).
// Acá se prueba lo que agrega la carga del admin: comparar con lo existente, la
// regla de desactivación, el tope y la forma del body.

const ENC = ["Item", "Desc. item", "U.M.", "Equivalencia", "Proveedor", "Sucursal"];
const PROVEEDOR = { nit: "902004611", sucursal: "001" };
const fila = (item, desc, um, eq, nit = "902004611      ", suc = "001") => [item, desc, um, eq, nit, suc];

// Existente tal como lo devuelve la base.
let secuencia = 100;
const existente = (item, unidad, equivalencia, extra = {}) => ({
  id: ++secuencia,
  codigo_item: String(item),
  descripcion_item: `ITEM ${item}`,
  unidad,
  equivalencia,
  orden: 1,
  activo: true,
  ...extra,
});

const hoja = (...filas) => [ENC, ...filas];

// ─── Comparación con lo existente ──────────────────────────────────────────

test("sin filas existentes todo es nuevo y el orden es el de la hoja", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(15171, "ITEM 15171", "KL", "MORRILLO"), fila(15141, "ITEM 15141", "KG", "CHATA")),
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.aplicable, true);
  assert.deepEqual(
    plan.filas.map((f) => [f.codigo_item, f.unidad, f.equivalencia, f.orden, f.estado]),
    [
      ["15171", "KL", "MORRILLO", 1, "nueva"],
      ["15141", "KL", "CHATA", 2, "nueva"], // KG se homologa a KL
    ],
  );
  assert.equal(plan.resumen.nuevas, 2);
  assert.equal(plan.resumen.actualizadas, 0);
  assert.equal(plan.resumen.sin_cambios, 0);
  assert.deepEqual(plan.a_desactivar, []);
  assert.equal(plan.desactivacion_omitida, null);
});

test("fila idéntica a la existente: sin cambios; no se reescribe", () => {
  const e = existente(15171, "KL", "MORRILLO");
  const plan = planearCargaPlantilla({
    filas: hoja(fila(15171, "ITEM 15171", "KL", "MORRILLO")),
    existentes: [e],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.filas[0].estado, "sin_cambios");
  assert.deepEqual(plan.filas[0].cambios, []);
  assert.deepEqual(filasAGuardar(plan, 4), []);
});

test("cambia la descripción o el orden: actualizada, con el detalle de qué cambió", () => {
  const a = existente(15171, "KL", "MORRILLO", { orden: 1 });
  const b = existente(15141, "KL", "CHATA", { orden: 2 });
  const plan = planearCargaPlantilla({
    filas: hoja(
      fila(15171, "MORRILLO NUEVO", "KL", "MORRILLO"), // descripción distinta
      fila(15141, "ITEM 15141", "KL", "CHATA"), // misma descripción, mismo orden 2
    ),
    existentes: [a, b],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.filas[0].estado, "actualizada");
  assert.deepEqual(plan.filas[0].cambios, ["descripcion"]);
  assert.equal(plan.filas[1].estado, "sin_cambios");

  const soloOrden = planearCargaPlantilla({
    filas: hoja(fila(15141, "ITEM 15141", "KL", "CHATA")), // ahora es la primera: orden 1
    existentes: [b],
    proveedor: PROVEEDOR,
  });
  assert.equal(soloOrden.filas[0].estado, "actualizada");
  assert.deepEqual(soloOrden.filas[0].cambios, ["orden"]);
});

test("una fila desactivada que vuelve a venir se reactiva (no choca con el UNIQUE)", () => {
  const e = existente(15171, "KL", "MORRILLO", { activo: false });
  const plan = planearCargaPlantilla({
    filas: hoja(fila(15171, "ITEM 15171", "KL", "MORRILLO")),
    existentes: [e],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.filas[0].estado, "actualizada");
  assert.deepEqual(plan.filas[0].cambios, ["reactivada"]);
  const [guardar] = filasAGuardar(plan, 4);
  assert.equal(guardar.activo, true);
  // Una inactiva que no viene tampoco se "desactiva" otra vez.
  const otra = existente(99999, "KL", "OTRA", { activo: false });
  const plan2 = planearCargaPlantilla({
    filas: hoja(fila(15171, "ITEM 15171", "KL", "MORRILLO")),
    existentes: [e, otra],
    proveedor: PROVEEDOR,
  });
  assert.deepEqual(plan2.a_desactivar, []);
});

test("la llave es (item, unidad, equivalencia): cambiar la equivalencia es una fila nueva y la vieja se desactiva", () => {
  const vieja = existente(15171, "KL", "MORRILLO VIEJO");
  const plan = planearCargaPlantilla({
    filas: hoja(fila(15171, "ITEM 15171", "KL", "MORRILLO NUEVO")),
    existentes: [vieja],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.filas[0].estado, "nueva");
  assert.deepEqual(idsADesactivarDelPlan(plan), [vieja.id]);
  assert.equal(plan.resumen.a_desactivar, 1);
  assert.deepEqual(plan.a_desactivar[0], {
    id: vieja.id,
    codigo_item: "15171",
    descripcion_item: "ITEM 15171",
    unidad: "KL",
    equivalencia: "MORRILLO VIEJO",
  });
});

test("'Sin equivalencia' (celda vacía) es una fila válida y se cuenta", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(15151, "PECHUGA CAMPO KILO", "KL", null), fila(15152, "OTRA", "KL", "X")),
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.filas[0].equivalencia, "");
  assert.equal(plan.resumen.sin_equivalencia, 1);
  assert.equal(plan.aplicable, true);
});

test("filasAGuardar: solo nuevas y actualizadas, con proveedor_id y activo true", () => {
  const igual = existente(1, "KL", "A", { orden: 1 });
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "ITEM 1", "KL", "A"), fila(2, "ITEM 2", "UND", "B")),
    existentes: [igual],
    proveedor: PROVEEDOR,
  });
  assert.deepEqual(filasAGuardar(plan, 7), [
    {
      proveedor_id: 7,
      codigo_item: "2",
      descripcion_item: "ITEM 2",
      unidad: "UND",
      equivalencia: "B",
      orden: 2,
      activo: true,
    },
  ]);
});

// ─── Rechazadas y la regla de seguridad ────────────────────────────────────

test("unidad fuera de KL/UND: rechazada con número de fila de Excel y motivo", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "KL", "X"), fila(2, "B", "LB", "Y"), fila(3, "C", "UN", "Z")),
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.rechazadas.length, 1);
  assert.equal(plan.rechazadas[0].fila, 3); // encabezado = 1, la de LB = fila 3
  assert.match(plan.rechazadas[0].motivo, /LB/);
  assert.equal(plan.resumen.unidades_invalidas, 1);
  // UN se homologa a UND y sigue siendo válida.
  assert.deepEqual(plan.filas.map((f) => f.unidad), ["KL", "UND"]);
  assert.equal(plan.aplicable, true);
});

test("con filas rechazadas NO se desactiva nada, pero se informa cuántas quedaron sin desactivar", () => {
  const vieja = existente(99, "KL", "VIEJA");
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "KL", "X"), fila(2, "B", "LB", "Y")),
    existentes: [vieja],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.rechazadas.length, 1);
  assert.deepEqual(plan.a_desactivar, []);
  assert.deepEqual(idsADesactivarDelPlan(plan), []);
  assert.equal(plan.resumen.a_desactivar, 0);
  assert.equal(plan.resumen.a_desactivar_omitidas, 1);
  assert.match(plan.desactivacion_omitida, /rechazadas/);
  // Lo válido sí se guarda.
  assert.equal(filasAGuardar(plan, 4).length, 1);
});

test("una hoja sin ninguna fila válida no es aplicable y no desactiva nada", () => {
  const vieja = existente(99, "KL", "VIEJA");
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "LB", "X"), fila(2, "B", "CJ", "Y")),
    existentes: [vieja],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.aplicable, false);
  assert.match(plan.motivo_no_aplicable, /ninguna fila válida/);
  assert.deepEqual(plan.a_desactivar, []);
  assert.equal(plan.resumen.a_desactivar_omitidas, 1);
  assert.equal(plan.rechazadas.length, 2);
});

test("hoja sin encabezado Item/U.M.: no ok, con el error del normalizador", () => {
  const plan = planearCargaPlantilla({
    filas: [["Codigo", "Nombre"], [1, "A"]],
    existentes: [existente(1, "KL", "A")],
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.aplicable, false);
  assert.match(plan.errores[0], /Item.*U\.M\./);
  assert.equal(plan.filas.length, 0);
  assert.deepEqual(plan.a_desactivar, []);
});

test("columnas por NOMBRE de encabezado: U.M. al final y sin Equivalencia (Bucanero)", () => {
  const plan = planearCargaPlantilla({
    filas: [
      ["Item", "Desc. item", "Proveedor", "Sucursal", "U.M."],
      [15300, "PECHUGA", "800000001", "001", "KL"],
      [15301, "MUSLO", "800000001", "001", "KL"],
    ],
    proveedor: { nit: "800000001", sucursal: "001" },
  });
  assert.equal(plan.aplicable, true);
  assert.equal(plan.resumen.sin_equivalencia, 2);
  assert.deepEqual(plan.advertencias, []);
});

test("duplicadas dentro de la hoja se descartan (se queda la primera) y se cuentan", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "KL", "X"), fila(1, "A otra", "KL", "X"), fila(2, "B", "KL", "Y")),
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.resumen.duplicadas, 1);
  assert.equal(plan.filas.length, 2);
  assert.equal(plan.filas[0].descripcion_item, "A");
});

// ─── Advertencia de proveedor equivocado ───────────────────────────────────

test("la hoja trae otro NIT que el del proveedor elegido: advertencia (no bloquea)", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "KL", "X", "800000001", "001")),
    proveedor: PROVEEDOR,
  });
  assert.equal(plan.aplicable, true);
  assert.equal(plan.advertencias.length, 1);
  assert.match(plan.advertencias[0], /800000001\/001/);
  assert.match(plan.advertencias[0], /902004611\/001/);
});

test("el NIT de la hoja coincide (aunque traiga relleno): sin advertencia", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "KL", "X", "902004611      ")),
    proveedor: PROVEEDOR,
  });
  assert.deepEqual(plan.advertencias, []);
});

test("si algún renglón trae el NIT del proveedor no se avisa (hay NIT sucios en el Excel real)", () => {
  const plan = planearCargaPlantilla({
    filas: hoja(fila(1, "A", "KL", "X", "902004611"), fila(2, "B", "KL", "Y", "1035425099", "002")),
    proveedor: PROVEEDOR,
  });
  assert.deepEqual(plan.advertencias, []);
});

// ─── Tope y forma ──────────────────────────────────────────────────────────

test("validarFormaFilas: arreglo de arreglos de valores simples, con tope de filas y columnas", () => {
  assert.equal(validarFormaFilas([["a", 1, null, true]]).ok, true);
  assert.equal(validarFormaFilas("x").ok, false);
  assert.equal(validarFormaFilas([]).ok, false);
  assert.equal(validarFormaFilas(["a"]).ok, false);
  assert.equal(validarFormaFilas([[{ a: 1 }]]).ok, false);
  assert.equal(validarFormaFilas([[[1]]]).ok, false);
  assert.equal(validarFormaFilas([new Array(TOPE_COLUMNAS_CARGA + 1).fill("x")]).ok, false);

  const justo = Array.from({ length: TOPE_FILAS_CARGA }, () => ["x"]);
  assert.equal(validarFormaFilas(justo).ok, true);
  const pasado = validarFormaFilas([...justo, ["x"]]);
  assert.equal(pasado.ok, false);
  assert.match(pasado.mensaje, new RegExp(String(TOPE_FILAS_CARGA)));
});

test("una forma inválida devuelve un plan no ok con el mensaje (sin lanzar)", () => {
  const plan = planearCargaPlantilla({ filas: "no", existentes: [existente(1, "KL", "A")] });
  assert.equal(plan.ok, false);
  assert.equal(plan.aplicable, false);
  assert.deepEqual(plan.a_desactivar, []);
  assert.equal(plan.errores.length, 1);
});

test("datos pegados al tope: advertencia de hoja posiblemente cortada", () => {
  const filas = [ENC];
  for (let i = 0; i < TOPE_FILAS_CARGA - 1; i++) filas.push(fila(1000 + i, "D", "KL", `E${i}`));
  const plan = planearCargaPlantilla({ filas, proveedor: PROVEEDOR });
  assert.equal(filas.length, TOPE_FILAS_CARGA);
  assert.equal(plan.aplicable, true);
  assert.ok(plan.advertencias.some((a) => /tope de lectura/.test(a)));
});

test("resumenParaRespuesta no arrastra el detalle fila por fila", () => {
  const plan = planearCargaPlantilla({ filas: hoja(fila(1, "A", "KL", "X")), proveedor: PROVEEDOR });
  const r = resumenParaRespuesta(plan);
  assert.deepEqual(Object.keys(r).sort(), ["advertencias", "desactivacion_omitida", "rechazadas", "resumen"]);
});

// ─── Validador del body (PUT /proveedores/:id/plantilla) ───────────────────

function correr(body) {
  const req = { body };
  let error;
  validators.cargarPlantillaProveedor(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

const CORREO = "admin@merkahorro.com";

test("body: aplicar es false por defecto (sin él es solo vista previa)", () => {
  const { error, body } = correr({ por: CORREO, filas: hoja(fila(1, "A", "KL", "X")) });
  assert.equal(error, undefined);
  assert.equal(body.aplicar, false);
});

test("body: aplicar solo acepta un booleano real", () => {
  const filas = hoja(fila(1, "A", "KL", "X"));
  assert.equal(correr({ por: CORREO, filas, aplicar: true }).body.aplicar, true);
  for (const mal of ["true", 1, "1", null]) {
    const { error } = correr({ por: CORREO, filas, aplicar: mal });
    assert.equal(error.statusCode, 400, `aplicar=${JSON.stringify(mal)}`);
  }
});

test("body: pide un correo válido de quien carga", () => {
  const filas = hoja(fila(1, "A", "KL", "X"));
  assert.equal(correr({ filas }).error.statusCode, 400);
  assert.equal(correr({ por: "no-es-correo", filas }).error.statusCode, 400);
});

test("body: sin filas, vacías o más del tope: 400 con mensaje claro", () => {
  assert.match(correr({ por: CORREO }).error.message, /Falta la hoja/);
  assert.match(correr({ por: CORREO, filas: [] }).error.message, /vacía/);
  const pasado = Array.from({ length: TOPE_FILAS_CARGA + 1 }, () => ["x"]);
  const { error } = correr({ por: CORREO, filas: pasado });
  assert.equal(error.statusCode, 400);
  assert.match(error.message, new RegExp(`más de ${TOPE_FILAS_CARGA} filas`));
});

test("body: filas deben ser arreglos de celdas simples", () => {
  assert.equal(correr({ por: CORREO, filas: ["no"] }).error.statusCode, 400);
  const celdaMala = correr({ por: CORREO, filas: [[{ a: 1 }]] });
  assert.equal(celdaMala.error.statusCode, 400);
  assert.match(celdaMala.error.message, /celda que no es válida/);
  const ancha = correr({ por: CORREO, filas: [new Array(TOPE_COLUMNAS_CARGA + 1).fill("x")] });
  assert.equal(ancha.error.statusCode, 400);
  // null (celda vacía), números y booleanos pasan.
  assert.equal(correr({ por: CORREO, filas: [[null, 1, "x", false]] }).error, undefined);
});
