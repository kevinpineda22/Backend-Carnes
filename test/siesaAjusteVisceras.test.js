import test from "node:test";
import assert from "node:assert/strict";

import {
  armarAjusteVisceras,
  referenciaAjusteVisceras,
  coberturaOficial,
  viscerasEnCea,
  esperaParaSede,
  LIMITE_FUNCION_MS,
  PRESUPUESTO_NUEVA_SEDE_MS,
  ESPERA_MINIMA_MS,
  TIPO_AJUSTE_VISCERAS,
} from "../src/shared/siesaAjusteVisceras.js";
import { DOCUMENTO_AJUSTE_VISCERAS } from "../src/config/siesa.js";

// El ajuste de vísceras (CEI): un documento por recepción, cantidades en la
// unidad de cada víscera, costo UNITARIO, y se CONTABILIZA al importar.

const CONFIG = {
  coDocumento: "001",
  unidadNegocio: "003",
  decimalesValor: 0,
};

const recepcion = (extra = {}) => ({
  id: 12,
  fecha_ingreso: "2026-09-23",
  sede_id: 2,
  sede: { id: 2, nombre: "Carnes Barbosa", codigo_co: "02", bodega_siesa: "00201" },
  ...extra,
});

const viscera = (descripcion, codigo, cantidad, costo, unidad = "KL", extra = {}) => ({
  tipo: "vicera",
  descripcion,
  codigo_item: codigo,
  cantidad,
  costo_base: costo,
  unidad,
  ...extra,
});

const carne = (codigo, cantidad, costo) => ({
  tipo: "carne",
  descripcion: `Corte ${codigo}`,
  codigo_item: codigo,
  cantidad,
  costo_base: costo,
  costo_ajustado: costo,
});

const ITEMS = [
  viscera("Mondongo", "20101", 33.3, 6500),
  viscera("Lengua", "20102", 4, 12000, "UND"),
  carne("15139", 10, 16800),
];

const armar = (items = ITEMS, r = recepcion(), config = CONFIG) =>
  armarAjusteVisceras({ recepcion: r, items, config });

test("solo las vísceras con código y cantidad; los cortes no entran", () => {
  const { payload, resumen, renglones, bloqueos, vacio } = armar();
  assert.deepEqual(bloqueos, []);
  assert.equal(vacio, false);
  assert.equal(payload.Movimientos.length, 2);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.ITEM),
    ["20101", "20102"],
  );
  assert.equal(renglones.length, 2);
  assert.equal(resumen.renglones, 2);
});

test("la cabecera lleva consecutivo, fecha y bodega, y las claves del movimiento son las del conector", () => {
  const { payload } = armar();
  // El consecutivo viaja aunque sea automático: SIESA rechazó el plano sin él
  // (29/09/2026, "f350_consec_docto no fue enviado"). TIPO_DOCTO sigue fijo en SIESA.
  assert.deepEqual(Object.keys(payload.Documentos[0]), ["CONSECUTIVO_DOCTO", "FECHA_DOCTO", "BODEGA"]);
  assert.equal(payload.Documentos[0].FECHA_DOCTO, "20260923");
  assert.equal(payload.Documentos[0].BODEGA, "00201");
  assert.deepEqual(Object.keys(payload.Movimientos[0]), [
    "NRO_DOCTO",
    "NRO_REGISTRO",
    "C.O.",
    "BODEGA",
    "C.O MOVIMIENTO",
    "UNIDAD_MEDIDA",
    "CANTIDAD",
    "COSTO_PROMEDIO",
    "ITEM",
    "UNIDAD_NEGOCIO",
  ]);
});

test('"C.O." es el del documento y "C.O MOVIMIENTO" el de la sede, como en la CEA', () => {
  const { payload } = armar();
  const m = payload.Movimientos[0];
  assert.equal(m["C.O."], "001");
  assert.equal(m["C.O MOVIMIENTO"], "002");
  assert.equal(m.BODEGA, "00201");
  assert.equal(m.UNIDAD_NEGOCIO, "003");
});

test("el config real del conector trae lo que el builder necesita", () => {
  assert.equal(DOCUMENTO_AJUSTE_VISCERAS.idDocumento, "257135");
  assert.equal(DOCUMENTO_AJUSTE_VISCERAS.nombreDocumento, "AJUSTE_INV_VISCERAS");
  assert.equal(DOCUMENTO_AJUSTE_VISCERAS.tipoDocto, "CEI");
  const { bloqueos, payload } = armar(ITEMS, recepcion(), DOCUMENTO_AJUSTE_VISCERAS);
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos[0]["C.O."], "001");
  assert.equal(payload.Movimientos[0].UNIDAD_NEGOCIO, "003");
});

test("cantidad con los decimales de la unidad: KL 3, UND 2", () => {
  const { payload } = armar();
  const [kl, und] = payload.Movimientos;
  assert.equal(kl.UNIDAD_MEDIDA, "KL");
  assert.equal(kl.CANTIDAD, "33.300");
  assert.equal(und.UNIDAD_MEDIDA, "UND");
  assert.equal(und.CANTIDAD, "4.00");
});

test("Riñón 5,333 UND se trunca a 5,33 (no 5,33 redondeado hacia arriba a 5,34)", () => {
  const { payload, renglones } = armar([viscera("Riñon", "20105", 5.333, 3000, "UND")]);
  assert.equal(payload.Movimientos[0].CANTIDAD, "5.33");
  assert.equal(renglones[0].cantidad, 5.33);
});

test("Riñón 2,667 UND también se trunca: 2,66", () => {
  const { payload } = armar([viscera("Riñon", "20105", 2.667, 3000, "UND")]);
  assert.equal(payload.Movimientos[0].CANTIDAD, "2.66");
});

test("3,99999 UND es 4 (se redondea a milésimas antes de truncar)", () => {
  const { payload } = armar([viscera("Riñon", "20105", 3.99999, 3000, "UND")]);
  assert.equal(payload.Movimientos[0].CANTIDAD, "4.00");
});

test("COSTO_PROMEDIO es el costo UNITARIO con los decimales de la moneda (0)", () => {
  const { payload } = armar();
  assert.equal(payload.Movimientos[0].COSTO_PROMEDIO, "6500");
  assert.equal(payload.Movimientos[1].COSTO_PROMEDIO, "12000");
});

test("el costo unitario se redondea al peso, y el valor sale de ESE costo", () => {
  const { payload, renglones, resumen } = armar([viscera("Mondongo", "20101", 10, 6500.6)]);
  assert.equal(payload.Movimientos[0].COSTO_PROMEDIO, "6501");
  assert.equal(renglones[0].costo_unitario, 6501);
  assert.equal(renglones[0].valor, 65010);
  assert.equal(resumen.totalValor, 65010);
});

test("total valor: cantidad ajustada × costo unitario; kilos solo de lo que se pesa", () => {
  const { resumen } = armar();
  // 33,3 × 6500 = 216.450 y 4 UND × 12.000 = 48.000
  assert.equal(resumen.totalValor, 264450);
  assert.equal(resumen.totalKilos, 33.3);
});

test("el valor de una víscera en UND usa la cantidad TRUNCADA, no la cruda", () => {
  const { resumen } = armar([viscera("Riñon", "20105", 5.333, 3000, "UND")]);
  assert.equal(resumen.totalValor, 15990);
});

test("una víscera sin unidad se trata como KL", () => {
  const { payload } = armar([viscera("Bofe", "20107", 2.5, 1000, undefined)]);
  assert.equal(payload.Movimientos[0].UNIDAD_MEDIDA, "KL");
  assert.equal(payload.Movimientos[0].CANTIDAD, "2.500");
});

test("sin código no se manda, no bloquea, y queda dicho en el resumen", () => {
  const { payload, bloqueos, resumen } = armar([
    viscera("Mondongo", "20101", 30, 6500),
    viscera("Vísceras", null, 12, 1000),
    viscera("Entrañita", "  ", 3, 1000),
  ]);
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos.length, 1);
  assert.deepEqual(resumen.sinCodigo, ["Vísceras", "Entrañita"]);
});

test("cantidad en cero no se manda, ni la que queda en cero al truncar (0,004 UND)", () => {
  const { payload } = armar([
    viscera("Mondongo", "20101", 0, 6500),
    viscera("Riñon", "20105", 0.004, 3000, "UND"),
    viscera("Bofe", "20107", 1, 1000),
  ]);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.ITEM),
    ["20107"],
  );
});

test("sin ninguna víscera para ajustar: vacío, nada que mandar, y no es un bloqueo", () => {
  const solo = armar([carne("15139", 10, 16800), viscera("Vísceras", null, 5, 1000)]);
  assert.equal(solo.vacio, true);
  assert.equal(solo.payload.Movimientos.length, 0);
  assert.equal(solo.resumen.renglones, 0);
  assert.deepEqual(solo.bloqueos, []);
  assert.equal(armar([]).vacio, true);
});

test("una sede vacía no se bloquea por bodega o fecha: no genera documento", () => {
  const { bloqueos, vacio } = armar(
    [],
    recepcion({ fecha_ingreso: null, sede: { nombre: "X" } }),
  );
  assert.equal(vacio, true);
  assert.deepEqual(bloqueos, []);
});

test("sin bodega bloquea y nombra la sede", () => {
  const r = recepcion({ sede: { id: 2, nombre: "Carnes Barbosa", codigo_co: "02", bodega_siesa: null } });
  const { bloqueos } = armar(ITEMS, r);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /Carnes Barbosa.*bodega/);
});

test("sin centro de operación bloquea", () => {
  const r = recepcion({ sede: { id: 2, nombre: "Carnes Barbosa", codigo_co: "", bodega_siesa: "00201" } });
  const { bloqueos } = armar(ITEMS, r);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /centro de operación/);
});

test("sin fecha de ingreso bloquea", () => {
  const { bloqueos } = armar(ITEMS, recepcion({ fecha_ingreso: null }));
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /fecha de ingreso/);
});

test("todo faltante suma su propio bloqueo", () => {
  const r = recepcion({ fecha_ingreso: "", sede: { nombre: "X" } });
  assert.equal(armar(ITEMS, r).bloqueos.length, 3);
});

test("una víscera con código y cantidad pero sin costo bloquea (se contabiliza)", () => {
  const { bloqueos } = armar([
    viscera("Mondongo", "20101", 30, 6500),
    viscera("Bofe", "20107", 2, 0),
    viscera("Corazon", "20106", 1, null),
  ]);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /2 víscera\(s\) sin costo: Bofe, Corazon/);
});

test("config sin coDocumento o unidadNegocio bloquea", () => {
  const { bloqueos } = armar(ITEMS, recepcion(), { decimalesValor: 0, coDocumento: "" });
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /coDocumento, unidadNegocio/);
});

test("el resumen lleva tipo, referencia, sede y fecha", () => {
  const { resumen } = armar();
  assert.equal(resumen.tipo, TIPO_AJUSTE_VISCERAS);
  assert.equal(resumen.tipo, "ajuste_visceras");
  assert.equal(resumen.referencia, "TC VIS R12");
  assert.equal(resumen.sede, "Carnes Barbosa");
  assert.equal(resumen.fecha, "2026-09-23");
});

test("referencia: TC VIS R + id, y cabe siempre en los 12 de VARCHAR(12)", () => {
  assert.equal(referenciaAjusteVisceras(20), "TC VIS R20");
  assert.equal(referenciaAjusteVisceras(9999), "TC VIS R9999");
  assert.equal(referenciaAjusteVisceras(9999).length, 12);
});

test("referencia: pasada la recepción #9999 cae a la forma compacta, sin cortar dígitos", () => {
  const r = referenciaAjusteVisceras(12345);
  assert.equal(r, "TCVR12345");
  assert.ok(r.length <= 12);
  // Distintas recepciones, distintas referencias.
  assert.notEqual(referenciaAjusteVisceras(12345), referenciaAjusteVisceras(12346));
});

test("el payload no lleva Descuentos", () => {
  const { payload } = armar();
  assert.deepEqual(Object.keys(payload), ["Documentos", "Movimientos"]);
});

// ─── Cobertura de la entrada oficial ────────────────────────────────────────

const IDS = [12, 13, 14];

test("la consolidada cubre SOLO las recepciones con las que salió", () => {
  const cub = coberturaOficial({
    ids: IDS,
    consolidada: { estado: "ok", recepcion_ids: [12, 13], payload: { Movimientos: [] } },
  });
  assert.deepEqual([...cub.keys()].sort(), [12, 13]);
  assert.equal(cub.has(14), false, "una recepción vinculada DESPUÉS no está en SIESA");
});

test("una consolidada que no está ok no cubre nada", () => {
  for (const estado of ["enviando", "sin_confirmar", "error", "anulado"]) {
    const cub = coberturaOficial({ ids: IDS, consolidada: { estado, recepcion_ids: IDS } });
    assert.equal(cub.size, 0, estado);
  }
  assert.equal(coberturaOficial({ ids: IDS }).size, 0);
});

test("una consolidada sin recepcion_ids (fila rara) no cubre nada", () => {
  assert.equal(coberturaOficial({ ids: IDS, consolidada: { estado: "ok" } }).size, 0);
});

test("una oficial por sede ok cubre exactamente su recepción", () => {
  const cub = coberturaOficial({
    ids: IDS,
    porSede: [{ recepcion_id: 13, payload: { Movimientos: [1] } }],
  });
  assert.deepEqual([...cub.keys()], [13]);
  assert.deepEqual(cub.get(13).payload, { Movimientos: [1] });
});

test("una oficial por sede de una recepción que NO es de la liquidación no cuenta", () => {
  assert.equal(coberturaOficial({ ids: IDS, porSede: [{ recepcion_id: 99 }] }).size, 0);
});

test("consolidada y por sede se combinan; la consolidada manda donde cubre", () => {
  const cub = coberturaOficial({
    ids: IDS,
    consolidada: { estado: "ok", recepcion_ids: [12], payload: "consolidada" },
    porSede: [
      { recepcion_id: 12, payload: "sede12" },
      { recepcion_id: 14, payload: "sede14" },
    ],
  });
  assert.equal(cub.get(12).payload, "consolidada");
  assert.equal(cub.get(14).payload, "sede14");
  assert.equal(cub.has(13), false);
});

// ─── Vísceras que una CEA vieja ya traía ────────────────────────────────────

const mov = (ITEM, BODEGA, CANTIDAD) => ({ ITEM, BODEGA, CANTIDAD, TIPO_DOCTO: "CEA" });

test("una CEA con la misma víscera (ítem, bodega y cantidad) se detecta", () => {
  const ya = viscerasEnCea({
    payload: { Movimientos: [mov("20101", "00201", "33.300"), mov("15139", "00201", "10.000")] },
    items: ITEMS,
    bodega: "00201",
  });
  assert.deepEqual(ya, ["Mondongo"]);
});

test("CEA solo de cortes: no detecta nada, aunque un corte comparta código con una víscera", () => {
  // 15187: FALDITA (corte) y Punta de falda (víscera) comparten código.
  const items = [viscera("Punta de falda", "15187", 1.685, 27500)];
  const ya = viscerasEnCea({
    payload: {
      Movimientos: [
        mov("15187", "00201", "4.670"),
        mov("15187", "00201", "5.720"),
        mov("15187", "00301", "1.685"), // misma cantidad, OTRA bodega
      ],
    },
    items,
    bodega: "00201",
  });
  assert.deepEqual(ya, []);
});

test("el mismo ítem en la misma bodega pero con otra cantidad no es la víscera", () => {
  const ya = viscerasEnCea({
    payload: { Movimientos: [mov("20101", "00201", "10.000")] },
    items: ITEMS,
    bodega: "00201",
  });
  assert.deepEqual(ya, []);
});

test("una CEA vieja con Riñón 5,333 UND se reconoce contra el 5,33 de hoy", () => {
  const ya = viscerasEnCea({
    payload: { Movimientos: [mov("20105", "00201", "5.333")] },
    items: [viscera("Riñon", "20105", 5.333, 3000, "UND")],
    bodega: "00201",
  });
  assert.deepEqual(ya, ["Riñon"]);
});

test("viscerasEnCea sin payload, sin movimientos o sin código no detecta nada", () => {
  assert.deepEqual(viscerasEnCea({ payload: null, items: ITEMS, bodega: "00201" }), []);
  assert.deepEqual(viscerasEnCea({ payload: { Movimientos: [] }, items: ITEMS }), []);
  assert.deepEqual(
    viscerasEnCea({
      payload: { Movimientos: [mov("", "00201", "12.000")] },
      items: [viscera("Vísceras", null, 12, 1000)],
      bodega: "00201",
    }),
    [],
  );
});

test("los cortes de la recepción no se confunden con vísceras", () => {
  const ya = viscerasEnCea({
    payload: { Movimientos: [mov("15139", "00201", "10.000")] },
    items: [carne("15139", 10, 16800)],
    bodega: "00201",
  });
  assert.deepEqual(ya, []);
});

// ─── Presupuesto de tiempo ──────────────────────────────────────────────────

test("esperaParaSede: al principio, la espera normal de SIESA", () => {
  assert.equal(esperaParaSede(0, 240_000), 240_000);
  assert.equal(esperaParaSede(5_000, 240_000), 240_000);
});

test("esperaParaSede: la espera se recorta para terminar antes del límite de la función", () => {
  // 285 s de límite: a los 40 s quedan 245 s, más que los 240 s normales.
  assert.equal(esperaParaSede(40_000, 240_000), 240_000);
  // Con una espera normal más larga, se recorta.
  assert.equal(esperaParaSede(30_000, 300_000), 255_000);
});

test("esperaParaSede: pasados 40 s desde el inicio no se arranca otra sede", () => {
  assert.equal(esperaParaSede(40_001, 240_000), null);
  assert.equal(esperaParaSede(120_000, 240_000), null);
});

test("esperaParaSede: con menos de 30 s de margen tampoco", () => {
  assert.equal(esperaParaSede(20_000, 40_000), 40_000);
  assert.equal(esperaParaSede(10_000, 20_000), null);
});

test("las constantes del presupuesto son las acordadas", () => {
  assert.equal(LIMITE_FUNCION_MS, 285_000);
  assert.equal(PRESUPUESTO_NUEVA_SEDE_MS, 40_000);
  assert.equal(ESPERA_MINIMA_MS, 30_000);
});

test("el plano lleva consecutivo y número de registro (f350/f470_consec_docto, f470_nro_registro)", () => {
  const { payload } = armarAjusteVisceras({
    recepcion: { id: 12, fecha_ingreso: "2026-09-27", sede: { nombre: "Llano", codigo_co: "00401", bodega_siesa: "00401" } },
    items: [
      { tipo: "vicera", codigo_item: "15159", descripcion: "Higado", cantidad: 12.485, costo_base: 18000, unidad: "KL" },
      { tipo: "vicera", codigo_item: "15192", descripcion: "Lengua", cantidad: 3, costo_base: 20000, unidad: "UND" },
    ],
    config: { coDocumento: "001", unidadNegocio: "003", decimalesValor: 0 },
  });
  assert.equal(payload.Documentos[0].CONSECUTIVO_DOCTO, "123");
  assert.deepEqual(payload.Movimientos.map((m) => m.NRO_DOCTO), ["123", "123"]);
  assert.deepEqual(payload.Movimientos.map((m) => m.NRO_REGISTRO), ["1", "2"]);
});
