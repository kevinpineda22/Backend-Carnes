import test from "node:test";
import assert from "node:assert/strict";

import {
  armarEntradaLiquidacion,
  referenciaLiquidacion,
  sufijoDocumento,
  fechaDocto,
  agruparPorFecha,
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

test("referenciaLiquidacion: TC OFI + L + id", () => {
  assert.equal(referenciaLiquidacion(12), "TC OFI L12");
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
  assert.equal(resumen.referencia, "TC OFI L6");
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
  assert.equal(d.PENDIENTE, "TC OFI L6");
  assert.match(d.NOTAS, /ENTRADA OFICIAL - LIQUIDACION #6 - TC OFI L6/);
  assert.equal(d.FECHA, "20260923");
  assert.equal(d.NIT, "70329554");
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

// ─── Una CEA por fecha de ingreso (sql/033) ─────────────────────────────────

const armarLiq = (recepciones, extra = {}) =>
  armarEntradaLiquidacion({
    liquidacionId: 6,
    recepciones,
    consecutivo: 63,
    config: CONFIG,
    ...extra,
  });

test("fechas distintas: UNA CEA por fecha, cada una con su FECHA y solo sus renglones", () => {
  const despues = { ...LOPEZ, fecha_ingreso: "2026-09-24" };
  const antes = { ...BARBOSA, fecha_ingreso: "2026-09-21" };
  // La más antigua no va primera: no depende del orden de las recepciones.
  const { bloqueos, documentos, porSede } = armarLiq([despues, antes]);

  assert.deepEqual(bloqueos, []);
  assert.equal(documentos.length, 2);
  assert.deepEqual(
    documentos.map((d) => d.payload.Documentos[0].FECHA),
    ["20260921", "20260924"],
  );
  assert.deepEqual(documentos.map((d) => d.fecha), ["20260921", "20260924"]);

  // Barbosa (21/09) trae 2 renglones; Lopez (24/09), 1. Nada se mezcla.
  assert.deepEqual(documentos.map((d) => d.payload.Movimientos.length), [2, 1]);
  assert.deepEqual(documentos[0].recepcion_ids, [2]);
  assert.deepEqual(documentos[1].recepcion_ids, [8]);
  assert.deepEqual(
    documentos[0].payload.Movimientos.map((m) => m.BODEGA),
    ["00201", "00201"],
  );
  assert.deepEqual(documentos[1].payload.Movimientos.map((m) => m.BODEGA), ["00801"]);

  // Cada documento se numera desde 1, con el mismo consecutivo.
  assert.deepEqual(documentos[1].payload.Movimientos.map((m) => m.NRO_REGISTRO), ["1"]);
  assert.equal(documentos[0].payload.Documentos[0].CONSECUTIVO_DOCTO, "63");
  assert.equal(documentos[1].payload.Documentos[0].CONSECUTIVO_DOCTO, "63");
  assert.equal(documentos[1].payload.Movimientos[0].NRO_DOCTO, "63");

  // El desglose por sede sigue completo.
  assert.equal(porSede.length, 2);
});

test("fechas distintas: referencia distinta por documento (dos letras derivadas de la fecha), cabe en 12", () => {
  const despues = { ...LOPEZ, fecha_ingreso: "2026-09-24" };
  const antes = { ...BARBOSA, fecha_ingreso: "2026-09-21" };
  const { documentos } = armarLiq([despues, antes]);

  assert.deepEqual(
    documentos.map((d) => d.resumen.referencia),
    ["TC OFI L6KD", "TC OFI L6KG"],
  );
  for (const d of documentos) {
    const cab = d.payload.Documentos[0];
    assert.equal(cab.PENDIENTE, d.resumen.referencia);
    assert.ok(cab.PENDIENTE.length <= 12);
    assert.ok(cab.NOTAS.endsWith(d.resumen.referencia));
  }
  // La fecha y la posición quedan escritas en las notas.
  assert.match(documentos[0].payload.Documentos[0].NOTAS, /LIQUIDACION #6 - INGRESO 20260921 \(1\/2\)/);
  assert.match(documentos[1].payload.Documentos[0].NOTAS, /LIQUIDACION #6 - INGRESO 20260924 \(2\/2\)/);

  // Con liquidaciones de 4 dígitos pasa a la forma compacta, sin cortar la letra.
  const grande = armarEntradaLiquidacion({
    liquidacionId: 1234,
    recepciones: [despues, antes],
    consecutivo: 1,
    config: CONFIG,
  });
  assert.deepEqual(
    grande.documentos.map((d) => d.resumen.referencia),
    ["TCOL1234KD", "TCOL1234KG"],
  );
});

test("dos sedes con la MISMA fecha: un solo documento con las dos", () => {
  const { documentos, payload, resumen } = armarLiq([BARBOSA, LOPEZ]);
  assert.equal(documentos.length, 1);
  assert.equal(documentos[0].payload.Movimientos.length, 3);
  assert.deepEqual(documentos[0].recepcion_ids, [2, 8]);
  // Sin sufijo: la referencia de siempre.
  assert.equal(resumen.referencia, "TC OFI L6");
  assert.equal(payload, documentos[0].payload);
});

test("una sola fecha: el payload es EXACTAMENTE el de antes de partir por fecha", () => {
  const { payload, resumen } = armarLiq([BARBOSA, LOPEZ]);
  assert.deepEqual(payload.Documentos, [
    {
      TIPO_DOCTO: "CEA",
      CONSECUTIVO_DOCTO: "63",
      FECHA: "20260923",
      NIT: "70329554",
      SUCURSAL: "001",
      PENDIENTE: "TC OFI L6",
      NOTAS: "TALLER DE CARNES - ENTRADA OFICIAL - LIQUIDACION #6 - TC OFI L6",
    },
  ]);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.NRO_REGISTRO),
    ["1", "2", "3"],
  );
  assert.equal(resumen.fecha, "20260923");
  assert.equal(resumen.sedes, 2);
  assert.equal(resumen.renglones, 3);
});

test("un bloqueo en UNA fecha frena todo (top-level) y se nombra en su documento", () => {
  const despues = {
    ...LOPEZ,
    fecha_ingreso: "2026-09-24",
    sede: { ...LOPEZ.sede, bodega_siesa: null },
  };
  const antes = { ...BARBOSA, fecha_ingreso: "2026-09-21" };
  const { bloqueos, documentos } = armarLiq([antes, despues]);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /Lopez: .*bodega/);
  assert.deepEqual(documentos[0].bloqueos, []);
  assert.equal(documentos[1].bloqueos.length, 1);
});

test("la configuración faltante va en cada documento, una vez", () => {
  const despues = { ...LOPEZ, fecha_ingreso: "2026-09-24" };
  const { bloqueos, documentos } = armarLiq([BARBOSA, despues], {
    config: { ...CONFIG, nit: "" },
  });
  assert.equal(bloqueos.filter((b) => /Falta configurar/.test(b)).length, 1);
  for (const d of documentos) {
    assert.equal(d.bloqueos.filter((b) => /Falta configurar/.test(b)).length, 1);
  }
});

test("una recepción sin fecha arma su propio documento, bloqueado, al final", () => {
  const sinFecha = { ...LOPEZ, fecha_ingreso: null };
  const { bloqueos, documentos } = armarLiq([sinFecha, BARBOSA]);
  assert.equal(documentos.length, 2);
  assert.equal(documentos[1].fecha, null);
  assert.equal(documentos[1].payload.Documentos[0].FECHA, "");
  assert.ok(bloqueos.some((b) => /Lopez: .*fecha de ingreso/.test(b)));
});

test("sin recepciones: un documento vacío (para que payload exista) y el bloqueo", () => {
  const r = armarLiq([]);
  assert.equal(r.documentos.length, 1);
  assert.deepEqual(r.payload.Movimientos, []);
  assert.equal(r.payload.Documentos[0].FECHA, "");
});

test("sufijoDocumento / fechaDocto / agruparPorFecha", () => {
  // Una sola fecha: sin sufijo. Varias: dos letras que salen de la FECHA, no de la posición.
  assert.equal(sufijoDocumento("20260921", 1), "");
  assert.equal(sufijoDocumento("20260921", 3), "KD");
  assert.equal(sufijoDocumento("20260924", 3), "KG");
  assert.equal(sufijoDocumento("20260101", 2), "AA");
  assert.equal(sufijoDocumento("20251231", 2), "ZZ");
  assert.equal(sufijoDocumento(null, 2), "XX");
  // Estable: no depende de cuántas ni cuáles otras fechas haya.
  assert.equal(sufijoDocumento("20260921", 2), sufijoDocumento("20260921", 5));
  assert.equal(referenciaLiquidacion(12, "KD"), "TC OFI L12KD");
  assert.equal(referenciaLiquidacion(12, "KD").length, 12);
  assert.equal(fechaDocto("20260921"), "2026-09-21");
  assert.equal(fechaDocto(""), null);
  assert.equal(fechaDocto("2026-09-21"), null);

  const g = agruparPorFecha([
    { id: 1, fecha_ingreso: "2026-09-24" },
    { id: 2, fecha_ingreso: null },
    { id: 3, fecha_ingreso: "2026-09-21" },
    { id: 4, fecha_ingreso: "2026-09-24T10:00:00Z" },
  ]);
  assert.deepEqual(g.map((x) => x.fecha), ["20260921", "20260924", null]);
  assert.deepEqual(g[1].recepciones.map((r) => r.id), [1, 4]);
});
