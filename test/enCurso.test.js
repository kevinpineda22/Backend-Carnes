import test from "node:test";
import assert from "node:assert/strict";

import { armarFilaEnCurso, contarRenglones, LIMITE_EN_CURSO } from "../src/shared/enCurso.js";

test("contarRenglones: cuenta solo cantidades mayores a cero, venga número o texto", () => {
  assert.deepEqual(contarRenglones([{ cantidad: 5 }, { cantidad: "2.5" }, { cantidad: 0 }, { cantidad: null }, {}]), {
    renglones_con_cantidad: 2,
    renglones_total: 5,
  });
  assert.deepEqual(contarRenglones(), { renglones_con_cantidad: 0, renglones_total: 0 });
  assert.equal(contarRenglones([{ cantidad: "abc" }, { cantidad: -1 }]).renglones_con_cantidad, 0);
});

test("armarFilaEnCurso: da forma a la fila y no filtra firma ni cédula", () => {
  const fila = armarFilaEnCurso({
    cabecera: {
      id: 7,
      proveedor_id: 3,
      proveedor_razon_social: "Bucanero SAS",
      factura: "FE-12",
      sede_id: 2,
      sede: { id: 2, nombre: "Centro", codigo_co: "001" },
      recibido_por: "ana@x.co",
      abierto_at: "2026-10-23T10:00:00Z",
      updated_at: "2026-10-23T11:00:00Z",
      firma_data: "x",
      recibidor_cedula: "1",
    },
    items: [{ cantidad: 1 }, { cantidad: 0 }],
  });
  assert.deepEqual(fila, {
    id: 7,
    proveedor_id: 3,
    proveedor_razon_social: "Bucanero SAS",
    factura: "FE-12",
    sede: { id: 2, nombre: "Centro" },
    recibido_por: "ana@x.co",
    recibidor_nombre: null,
    abierto_at: "2026-10-23T10:00:00Z",
    updated_at: "2026-10-23T11:00:00Z",
    renglones_con_cantidad: 1,
    renglones_total: 2,
  });
});

test("armarFilaEnCurso: sin sede embebida usa sede_id; sin fechas cae a la que haya", () => {
  const fila = armarFilaEnCurso({ cabecera: { id: 1, sede_id: 9, updated_at: "2026-10-23T11:00:00Z" } });
  assert.deepEqual(fila.sede, { id: 9, nombre: null });
  assert.equal(fila.abierto_at, "2026-10-23T11:00:00Z");
  assert.equal(fila.renglones_total, 0);
  assert.equal(LIMITE_EN_CURSO, 50);
});
