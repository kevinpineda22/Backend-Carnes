import { test } from "node:test";
import assert from "node:assert/strict";

import { cambiosDeFila } from "../src/shared/plantillaCambios.js";

const enBase = {
  codigo_tabla: 25,
  codigo_item: "15216",
  descripcion: "REPELE INDUSTRIAL",
  costo_base: 14000,
  orden: 25,
  activo: true,
  nombre_desposte: null,
};

test("una fila sin cambios no produce UPDATE", () => {
  const delCliente = { ...enBase, costo_base: "14000", codigo_tabla: "25", nombre_desposte: "" };
  assert.deepEqual(cambiosDeFila(delCliente, enBase), {});
});

test("solo viaja la columna que cambió", () => {
  const delCliente = { ...enBase, costo_base: "15000" };
  assert.deepEqual(cambiosDeFila(delCliente, enBase), { costo_base: "15000" });
});

test("vaciar un texto cuenta como cambio", () => {
  const base = { ...enBase, nombre_desposte: "REPELE INDUSTRIAL" };
  assert.deepEqual(cambiosDeFila({ nombre_desposte: "" }, base), { nombre_desposte: "" });
});

test("dar de baja o reactivar cuenta como cambio", () => {
  assert.deepEqual(cambiosDeFila({ activo: false }, enBase), { activo: false });
  assert.deepEqual(cambiosDeFila({ activo: true }, { ...enBase, activo: false }), { activo: true });
});

test("un cambio de texto se compara como texto, no como número", () => {
  assert.deepEqual(cambiosDeFila({ codigo_item: "015216" }, enBase), { codigo_item: "015216" });
});

test("sin fila en la base se manda todo", () => {
  assert.deepEqual(cambiosDeFila({ costo_base: 1 }, undefined), { costo_base: 1 });
});
