import test from "node:test";
import assert from "node:assert/strict";

import { revisarCodigosTabla, conflictoConGuardados } from "../src/shared/plantillaCodigoTabla.js";

test("revisarCodigosTabla: nombra los cortes sin Orden prov.", () => {
  const r = revisarCodigosTabla([
    { codigo_tabla: 201, descripcion: "Pierna Pulpa" },
    { codigo_tabla: null, descripcion: "Cueros" },
    { descripcion: "Garras" },
  ]);
  assert.equal(r.status, 400);
  assert.equal(r.codigo, "ORDEN_PROV_FALTANTE");
  assert.match(r.mensaje, /Cueros, Garras/);
  assert.doesNotMatch(r.mensaje, /Pierna Pulpa/);
});

test("revisarCodigosTabla: detecta números repetidos en el envío", () => {
  const r = revisarCodigosTabla([
    { codigo_tabla: 257, descripcion: "Mota" },
    { codigo_tabla: "257", descripcion: "Lobanillo" },
    { codigo_tabla: 258, descripcion: "Cabeza" },
  ]);
  assert.equal(r.codigo, "ORDEN_PROV_REPETIDO");
  assert.match(r.mensaje, /257 \(Mota, Lobanillo\)/);
});

test("revisarCodigosTabla: 0 es un número válido si no se repite", () => {
  assert.equal(revisarCodigosTabla([{ codigo_tabla: 0, descripcion: "A" }, { codigo_tabla: 1, descripcion: "B" }]), null);
});

test("conflictoConGuardados: ignora las filas que vienen en el mismo envío", () => {
  const filas = [{ id: 7, codigo_tabla: 201, descripcion: "Pierna Pulpa" }];
  assert.equal(conflictoConGuardados(filas, [{ id: 7, codigo_tabla: 201, descripcion: "Pierna Pulpa", activo: true }]), null);
});

test("conflictoConGuardados: avisa si el número lo tiene un corte desactivado o sacado de la grilla", () => {
  const filas = [
    { codigo_tabla: 257, descripcion: "Cueros" },
    { codigo_tabla: 258, descripcion: "Garras" },
  ];
  const r = conflictoConGuardados(filas, [
    { id: 90, codigo_tabla: 257, descripcion: "Tocino viejo", activo: false },
    { id: 91, codigo_tabla: 258, descripcion: "Garra vieja", activo: true },
  ]);
  assert.equal(r.status, 409);
  assert.equal(r.codigo, "ORDEN_PROV_EN_USO");
  assert.match(r.mensaje, /257 de Cueros ya lo tiene Tocino viejo \(desactivado\)/);
  assert.match(r.mensaje, /258 de Garras ya lo tiene Garra vieja \(que sacaste de la grilla\)/);
});
