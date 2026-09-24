import test from "node:test";
import assert from "node:assert/strict";

import {
  armarEntradaLiquidacion,
  referenciaLiquidacion,
} from "../src/shared/siesaEntrada.js";

// La oficial consolidada: una CEA con los renglones de todas las sedes.

const CONFIG = {
  tipoDocto: "CEA",
  nit: "70329554",
  sucursal: "001",
  unidadMedida: "KL",
  unidadNegocio: "003",
  decimalesValor: 0,
  decimalesCantidad: 3,
};

const recepcion = (id, nombre, bodega, co, items, fecha = "2026-09-23") => ({
  id,
  fecha_ingreso: fecha,
  sede_id: id,
  sede: { id, nombre, codigo_co: co, bodega_siesa: bodega },
  items,
});

const carne = (codigo, cantidad, base, ajustado) => ({
  tipo: "carne",
  codigo_item: codigo,
  descripcion: `Corte ${codigo}`,
  cantidad,
  costo_base: base,
  costo_ajustado: ajustado,
});

const BARBOSA = recepcion(2, "Carnes Barbosa", "00201", "02", [
  carne("15139", 10, 16800, 15099),
  carne("15150", 5, 16500, 14830),
]);
const LOPEZ = recepcion(8, "Lopez", "00801", "08", [carne("15139", 4, 16800, 15099)]);

test("referenciaLiquidacion: L + id + O", () => {
  assert.equal(referenciaLiquidacion(12), "L12O");
});

test("una sola cabecera, con los movimientos de todas las sedes numerados de corrido", () => {
  const { payload, resumen, bloqueos } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, LOPEZ],
    consecutivo: 63,
    config: CONFIG,
  });

  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos.length, 1);
  assert.equal(payload.Movimientos.length, 3);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.NRO_REGISTRO),
    ["1", "2", "3"],
  );
  // Todos los movimientos apuntan a la MISMA cabecera.
  assert.ok(payload.Movimientos.every((m) => m.NRO_DOCTO === "63"));
  assert.equal(resumen.referencia, "L6O");
  assert.equal(resumen.sedes, 2);
});

test("cada movimiento conserva la bodega y el CO de su sede", () => {
  const { payload } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, LOPEZ],
    consecutivo: 63,
    config: CONFIG,
  });
  const [m1, m2, m3] = payload.Movimientos;
  assert.equal(m1.BODEGA, "00201");
  assert.equal(m1.CO_MOVIMIENTO, "002");
  assert.equal(m2.BODEGA, "00201");
  assert.equal(m3.BODEGA, "00801");
  assert.equal(m3.CO_MOVIMIENTO, "008");
});

test("sale con el costo liquidado, no el base", () => {
  const { payload, resumen } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, LOPEZ],
    consecutivo: 63,
    config: CONFIG,
  });
  // 10 × 15099
  assert.equal(payload.Movimientos[0].VALOR_BRUTO, "150990");
  // 10×15099 + 5×14830 + 4×15099
  assert.equal(resumen.totalValor, 150990 + 74150 + 60396);
});

test("la cabecera lleva su propia referencia en PENDIENTE y en las notas", () => {
  const { payload } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, LOPEZ],
    consecutivo: 63,
    config: CONFIG,
  });
  const d = payload.Documentos[0];
  assert.equal(d.PENDIENTE, "L6O");
  assert.match(d.NOTAS, /ENTRADA OFICIAL L6O/);
  assert.equal(d.FECHA, "20260923");
  assert.equal(d.NIT, "70329554");
});

test("fechas distintas entre recepciones: se bloquea, no se elige una", () => {
  const otraFecha = { ...LOPEZ, fecha_ingreso: "2026-09-24" };
  const { bloqueos, payload } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, otraFecha],
    consecutivo: 63,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /fechas distintas/.test(b)), JSON.stringify(bloqueos));
  assert.equal(payload.Documentos[0].FECHA, "");
});

test("una sede con bloqueo frena el documento entero y se nombra", () => {
  const sinBodega = { ...LOPEZ, sede: { ...LOPEZ.sede, bodega_siesa: null } };
  const { bloqueos } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, sinBodega],
    consecutivo: 63,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => b.startsWith("Lopez:") && /bodega/.test(b)), JSON.stringify(bloqueos));
});

test("una sede sin costear frena el documento: nunca sale al costo base", () => {
  const sinCostear = recepcion(8, "Lopez", "00801", "08", [carne("15139", 4, 16800, null)]);
  const { bloqueos } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, sinCostear],
    consecutivo: 63,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /costo ajustado/.test(b)), JSON.stringify(bloqueos));
});

test("la configuración faltante se dice una vez, no una por sede", () => {
  const { bloqueos } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [BARBOSA, LOPEZ],
    consecutivo: 63,
    config: { ...CONFIG, nit: "" },
  });
  assert.equal(bloqueos.filter((b) => /Falta configurar/.test(b)).length, 1);
});

test("sin recepciones: se bloquea", () => {
  const { bloqueos } = armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones: [],
    consecutivo: 63,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /no tiene recepciones/.test(b)));
});
