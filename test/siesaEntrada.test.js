import test from "node:test";
import assert from "node:assert/strict";

import {
  armarEntradaDirecta,
  referenciaEnvio,
  fechaSiesa,
  coMovimiento,
  TIPO_ENVIO,
} from "../src/shared/siesaEntrada.js";

/** Configuración completa, como va a estar en el .env. Valores de ejemplo. */
const CONFIG = {
  tipoDocto: "EDA",
  nit: "890900000",
  sucursal: "001",
  unidadMedida: "KL",
  unidadNegocio: "01",
  decimalesValor: 0,
  decimalesCantidad: 3,
};

/** La recepción de López, con dos renglones reales y uno adicional. */
const RECEPCION = {
  id: 23,
  fecha_ingreso: "2026-09-16",
  sede_id: 9,
  sede: { id: 9, nombre: "Lopez", codigo_co: "07", bodega_siesa: "B07" },
};

const ITEMS = [
  { tipo: "carne", codigo_item: "15167", descripcion: "CARNE PARA MOLER", cantidad: 4.49, costo_base: 23000, costo_ajustado: 21150.5 },
  { tipo: "carne", codigo_item: "15197", descripcion: "TABLA", cantidad: 14.19, costo_base: 30000, costo_ajustado: 27587.6 },
  { tipo: "carne", codigo_item: "15147", descripcion: "COPETE", cantidad: 0, costo_base: 26244, costo_ajustado: null },
  { tipo: "vicera", codigo_item: null, descripcion: "Mondongo", cantidad: 3, costo_base: 18000 },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

test("referenciaEnvio: legible, TC + INI/OFI + recepción, cabe en 12 caracteres", () => {
  assert.equal(referenciaEnvio(23, TIPO_ENVIO.INICIAL), "TC INI R23");
  assert.equal(referenciaEnvio(23, TIPO_ENVIO.OFICIAL), "TC OFI R23");
  // Hasta la #9999 entra legible.
  assert.equal(referenciaEnvio(9999, TIPO_ENVIO.INICIAL), "TC INI R9999");
  assert.ok(referenciaEnvio(999999999999, TIPO_ENVIO.OFICIAL).length <= 12);
});

test("referenciaEnvio: pasada la #9999 se compacta sin comerse dígitos", () => {
  assert.equal(referenciaEnvio(12345, TIPO_ENVIO.INICIAL), "TCIR12345");
  assert.notEqual(referenciaEnvio(12345, TIPO_ENVIO.INICIAL), referenciaEnvio(12346, TIPO_ENVIO.INICIAL));
});

test("fechaSiesa: AAAAMMDD, y null si no hay fecha", () => {
  assert.equal(fechaSiesa("2026-09-16"), "20260916");
  assert.equal(fechaSiesa("2026-09-16T10:00:00Z"), "20260916");
  assert.equal(fechaSiesa(null), null);
  assert.equal(fechaSiesa("basura"), null);
});

test("coMovimiento: el CO de la sede en 3 caracteres", () => {
  assert.equal(coMovimiento("07"), "007");
  assert.equal(coMovimiento("001"), "001");
  assert.equal(coMovimiento(" 3 "), "003");
  assert.equal(coMovimiento(""), null);
});

// ─── Entrada inicial ────────────────────────────────────────────────────────

test("inicial: cabecera con las seis variables del conector", () => {
  const { payload, bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: ITEMS,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1001,
    config: CONFIG,
  });

  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos.length, 1);
  const d = payload.Documentos[0];
  assert.equal(d.TIPO_DOCTO, "EDA");
  assert.equal(d.CONSECUTIVO_DOCTO, "1001");
  assert.equal(d.FECHA, "20260916");
  assert.equal(d.NIT, "890900000");
  assert.equal(d.SUCURSAL, "001");
  assert.equal(d.PENDIENTE, "TC INI R23");
  assert.match(d.NOTAS, /ENTRADA INICIAL/);
  assert.match(d.NOTAS, /TC INI R23/);
  assert.match(d.NOTAS, /RECEPCION #23/);
});

test("inicial: un movimiento por renglón con cantidad, al costo base", () => {
  const { payload, resumen } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: ITEMS,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1001,
    config: CONFIG,
  });

  // COPETE está en 0 y Mondongo es víscera sin código: no van.
  assert.equal(payload.Movimientos.length, 2);

  const m = payload.Movimientos[0];
  assert.equal(m.TIPO_DOCTO, "EDA");
  assert.equal(m.NRO_DOCTO, "1001"); // enlaza con la cabecera
  assert.equal(m.NRO_REGISTRO, "1");
  assert.equal(m.BODEGA, "B07");
  assert.equal(m.CO_MOVIMIENTO, "007");
  assert.equal(m.UNIDAD_MEDIDA, "KL");
  assert.equal(m.ITEM, "15167");
  assert.equal(m.UNIDAD_NEGOCIO, "01");
  assert.equal(m.CANTIDAD, "4.490");
  // VALOR_BRUTO = cantidad × costo base = 4.49 × 23000
  assert.equal(m.VALOR_BRUTO, "103270");

  assert.equal(payload.Movimientos[1].NRO_REGISTRO, "2");
  assert.equal(payload.Movimientos[1].VALOR_BRUTO, "425700"); // 14.19 × 30000

  assert.equal(resumen.renglones, 2);
  assert.equal(resumen.totalKilos, 18.68);
  assert.equal(resumen.totalValor, 528970);
  // La sección Descuentos NO se manda: con `[]` el conector responde 400.
  assert.equal("Descuentos" in payload, false);
});

// ─── Entrada oficial ────────────────────────────────────────────────────────

test("oficial: precio = costo ajustado, PENDIENTE apunta a la inicial", () => {
  const { payload, resumen, bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: ITEMS,
    tipo: TIPO_ENVIO.OFICIAL,
    consecutivo: 1002,
    config: CONFIG,
    referenciaInicial: "R23I",
  });

  assert.deepEqual(bloqueos, []);
  const d = payload.Documentos[0];
  assert.equal(d.PENDIENTE, "R23I"); // quien anula lee esto
  assert.match(d.NOTAS, /ENTRADA OFICIAL/);
  assert.match(d.NOTAS, /TC OFI R23/);

  // 4.49 × 21150.5 = 94965.745 → 94966, al peso: la moneda no tiene centavos.
  assert.equal(payload.Movimientos[0].VALOR_BRUTO, "94966");
  assert.equal(resumen.referenciaInicial, "R23I");
});

test("oficial: sin costo ajustado se bloquea — no se manda el precio de lista como real", () => {
  const sinCostear = ITEMS.map((i) => ({ ...i, costo_ajustado: null }));
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: sinCostear,
    tipo: TIPO_ENVIO.OFICIAL,
    consecutivo: 1002,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /costo ajustado/.test(b)), JSON.stringify(bloqueos));
});

// ─── Bloqueos ───────────────────────────────────────────────────────────────

test("un renglón con cantidad y sin código bloquea el envío", () => {
  const items = [
    ...ITEMS,
    { tipo: "adicional", codigo_item: null, descripcion: "Corte raro", cantidad: 2, costo_base: 1000 },
  ];
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: CONFIG,
  });
  const b = bloqueos.find((x) => /sin código/.test(x));
  assert.ok(b);
  assert.match(b, /Corte raro/);
});

test("sin bodega en la sede, no se manda", () => {
  const recepcion = { ...RECEPCION, sede: { ...RECEPCION.sede, bodega_siesa: null } };
  const { bloqueos } = armarEntradaDirecta({
    recepcion,
    items: ITEMS,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /bodega/.test(b)));
});

test("sin configuración de SIESA, dice exactamente qué falta", () => {
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: ITEMS,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: { tipoDocto: "EDA" },
  });
  const b = bloqueos.find((x) => /Falta configurar/.test(x));
  assert.match(b, /nit/);
  assert.match(b, /sucursal/);
  assert.match(b, /unidadMedida/);
  assert.match(b, /unidadNegocio/);
  assert.doesNotMatch(b, /tipoDocto/);
});

test("el payload tiene exactamente la forma del conector", () => {
  const { payload } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: ITEMS,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: CONFIG,
  });
  assert.deepEqual(Object.keys(payload), ["Documentos", "Movimientos"]);
  assert.deepEqual(Object.keys(payload.Movimientos[0]), [
    "TIPO_DOCTO",
    "NRO_DOCTO",
    "NRO_REGISTRO",
    "BODEGA",
    "CO_MOVIMIENTO",
    "UNIDAD_MEDIDA",
    "CANTIDAD",
    "VALOR_BRUTO",
    "ITEM",
    "UNIDAD_NEGOCIO",
  ]);
});

test("oficial: todos los renglones al costo base se bloquea — el factor no se aplicó", () => {
  const alBase = ITEMS.map((i) => ({ ...i, costo_ajustado: i.costo_base }));
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: alBase,
    tipo: TIPO_ENVIO.OFICIAL,
    consecutivo: 1002,
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /igual al costo base/.test(b)), JSON.stringify(bloqueos));
});

test("inicial: al costo base es lo esperado, no se bloquea", () => {
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: ITEMS,
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1001,
    config: CONFIG,
  });
  assert.ok(!bloqueos.some((b) => /costo base/.test(b)), JSON.stringify(bloqueos));
});

// ─── Vísceras (sql/016) ─────────────────────────────────────────────────────

/** Higado: víscera CON código, factor por novillo, unidad KL. */
const HIGADO = {
  tipo: "vicera",
  codigo_item: "15159",
  descripcion: "Higado",
  cantidad: 8.323,
  costo_base: 18000,
  unidad: "KL",
  factor_novillo: 4.16167,
};

/** Lengua: víscera CON código, UND, tipeada (sin factor). */
const LENGUA = {
  tipo: "vicera",
  codigo_item: "15192",
  descripcion: "Lengua",
  cantidad: 3,
  costo_base: 20000,
  unidad: "UND",
};

/** Vísceras (el genérico): sin código en el catálogo hoy. */
const VICERAS_SIN_CODIGO = {
  tipo: "vicera",
  codigo_item: null,
  descripcion: "Viceras",
  cantidad: 5,
  costo_base: 17000,
  unidad: "KL",
};

test("víscera con código va a SIESA con su unidad y al costo_base, en la inicial", () => {
  const { payload, bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: [HIGADO, LENGUA],
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: CONFIG,
  });

  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos.length, 2);

  const higado = payload.Movimientos.find((m) => m.ITEM === "15159");
  assert.equal(higado.UNIDAD_MEDIDA, "KL");
  assert.equal(higado.CANTIDAD, "8.323");
  assert.equal(higado.VALOR_BRUTO, String(Math.round(8.323 * 18000)));

  const lengua = payload.Movimientos.find((m) => m.ITEM === "15192");
  assert.equal(lengua.UNIDAD_MEDIDA, "UND");
  assert.equal(lengua.VALOR_BRUTO, String(3 * 20000));
});

test("víscera con código va al costo_base también en la OFICIAL: no se prorratea", () => {
  // Ni Higado ni Lengua traen `costo_ajustado` — no existe para vísceras.
  const { payload, bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: [HIGADO, LENGUA],
    tipo: TIPO_ENVIO.OFICIAL,
    consecutivo: 2,
    config: CONFIG,
    referenciaInicial: "R23I",
  });

  assert.deepEqual(bloqueos, []);
  const higado = payload.Movimientos.find((m) => m.ITEM === "15159");
  assert.equal(higado.VALOR_BRUTO, String(Math.round(8.323 * 18000)));
});

test("víscera SIN código no se manda, y NO bloquea el resto del documento", () => {
  const { payload, bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: [HIGADO, VICERAS_SIN_CODIGO],
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: CONFIG,
  });

  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos.length, 1);
  assert.equal(payload.Movimientos[0].ITEM, "15159");
});

test("un producto sin código sigue bloqueando aunque haya vísceras con código", () => {
  const productoSinCodigo = {
    tipo: "carne",
    codigo_item: null,
    descripcion: "Corte sin homologar",
    cantidad: 2,
    costo_base: 20000,
  };
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: [HIGADO, productoSinCodigo],
    tipo: TIPO_ENVIO.INICIAL,
    consecutivo: 1,
    config: CONFIG,
  });
  const b = bloqueos.find((x) => /sin código/.test(x));
  assert.ok(b, JSON.stringify(bloqueos));
  assert.match(b, /Corte sin homologar/);
  // La víscera con código no aparece en el reclamo: no le falta nada.
  assert.doesNotMatch(b, /Higado/);
});

test("oficial: una recepción de solo vísceras (al costo de lista siempre) no bloquea por 'factor no aplicado'", () => {
  const { bloqueos } = armarEntradaDirecta({
    recepcion: RECEPCION,
    items: [HIGADO, LENGUA],
    tipo: TIPO_ENVIO.OFICIAL,
    consecutivo: 1,
    config: CONFIG,
  });
  assert.ok(!bloqueos.some((b) => /igual al costo base/.test(b)), JSON.stringify(bloqueos));
});
