import test from "node:test";
import assert from "node:assert/strict";

import {
  armarAjusteVisceras,
  armarViscerasRecepcion,
  compararViscerasEnviadas,
  decidirViscerasRecepcion,
  viscerasSinCambios,
  ESTADO_VISCERAS,
  referenciaViscerasRecepcion,
  consecutivoViscerasRecepcion,
  TIPO_VISCERAS_RECEPCION,
  referenciaAjusteVisceras,
  coberturaOficial,
  viscerasEnCea,
  esperaParaSede,
  armarAjusteViscerasLiquidacion,
  consecutivoAjusteLiquidacion,
  referenciaAjusteLiquidacion,
  guardaAjustesPorSede,
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

// ─── El documento consolidado de la liquidación ─────────────────────────────

const sedeRec = (id, nombre, co, bodega, items, extra = {}) => ({
  id,
  fecha_ingreso: "2026-09-27",
  sede_id: id,
  sede: { id, nombre, codigo_co: co, bodega_siesa: bodega },
  items,
  ...extra,
});

const LLANO = sedeRec(12, "Girardota Llano", "04", "00401", [
  viscera("Mondongo", "15168", 20, 18000),
  viscera("Riñon", "15188", 4, 11000, "UND"),
  viscera("Vísceras", null, 9, 1000),
]);
const BARBOSA = sedeRec(13, "Carnes Barbosa", "05", "00501", [
  viscera("Mondongo", "15168", 26, 18000),
  viscera("Riñon", "15188", 5.333, 11000, "UND"),
]);
const SIN_VISCERAS = sedeRec(14, "Sin vísceras", "07", "00701", [carne("15139", 10, 16800)]);

const armarLiq = (recepciones = [LLANO, BARBOSA], config = CONFIG, extra = {}) =>
  armarAjusteViscerasLiquidacion({ liquidacionId: 10, recepciones, config, ...extra });

test("consolidado: UNA cabecera con la BODEGA vacía, y el consecutivo de la liquidación", () => {
  const { payload, bloqueos } = armarLiq();
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos.length, 1);
  assert.deepEqual(payload.Documentos[0], {
    CONSECUTIVO_DOCTO: "104",
    FECHA_DOCTO: "20260927",
    BODEGA: "",
  });
});

test("consolidado: los movimientos de todas las sedes, numerados de corrido", () => {
  const { payload, resumen } = armarLiq();
  assert.equal(payload.Movimientos.length, 4);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.NRO_REGISTRO),
    ["1", "2", "3", "4"],
  );
  // Todos apuntan a la MISMA cabecera.
  assert.ok(payload.Movimientos.every((m) => m.NRO_DOCTO === "104"));
  assert.equal(resumen.renglones, 4);
  assert.equal(resumen.sedes, 2);
});

test("consolidado: cada movimiento conserva la bodega y el CO de SU sede", () => {
  const { payload } = armarLiq();
  const [m1, m2, m3, m4] = payload.Movimientos;
  assert.equal(m1.BODEGA, "00401");
  assert.equal(m1["C.O MOVIMIENTO"], "004");
  assert.equal(m2.BODEGA, "00401");
  assert.equal(m3.BODEGA, "00501");
  assert.equal(m3["C.O MOVIMIENTO"], "005");
  assert.equal(m4.BODEGA, "00501");
  assert.ok(payload.Movimientos.every((m) => m["C.O."] === "001"));
});

test("consolidado: Riñón 5,333 UND sale como 5.33 y 4 UND como 4.00", () => {
  const { payload } = armarLiq();
  const rinones = payload.Movimientos.filter((m) => m.ITEM === "15188");
  assert.deepEqual(
    rinones.map((m) => m.CANTIDAD),
    ["4.00", "5.33"],
  );
  assert.ok(rinones.every((m) => m.UNIDAD_MEDIDA === "UND"));
});

test("consolidado: total valor y kilos suman las sedes (kilos solo de lo que se pesa)", () => {
  const { resumen } = armarLiq();
  // Llano: 20×18000 + 4×11000 = 404.000; Barbosa: 26×18000 + 5,33×11000 = 526.630
  assert.equal(resumen.totalValor, 930630);
  assert.equal(resumen.totalKilos, 46);
});

test("consolidado: una sede sin vísceras no aporta ni bloquea", () => {
  const { payload, bloqueos, resumen, porSede } = armarLiq([LLANO, SIN_VISCERAS, BARBOSA]);
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos.length, 4);
  assert.equal(resumen.sedes, 2);
  assert.equal(porSede.length, 3);
  assert.equal(porSede.find((s) => s.recepcion_id === 14).vacio, true);
});

test("consolidado: lo que sin código no viaja queda dicho en el resumen", () => {
  const { resumen } = armarLiq();
  assert.deepEqual(resumen.sinCodigo, ["Vísceras"]);
});

test("consolidado, TODO O NADA: el bloqueo de UNA sede bloquea el documento", () => {
  const sinBodega = sedeRec(13, "Carnes Barbosa", "05", null, BARBOSA.items);
  const { bloqueos } = armarLiq([LLANO, sinBodega]);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /Carnes Barbosa.*bodega/);
});

test("consolidado: sin CO, sin costo y sin fecha, cada uno con el nombre de la sede", () => {
  const sinCo = sedeRec(13, "Carnes Barbosa", "", "00501", BARBOSA.items);
  assert.match(armarLiq([LLANO, sinCo]).bloqueos[0], /centro de operación/);

  const sinCosto = sedeRec(13, "Carnes Barbosa", "05", "00501", [viscera("Bofe", "15134", 2, 0)]);
  const b = armarLiq([LLANO, sinCosto]).bloqueos;
  assert.equal(b.length, 1);
  assert.match(b[0], /^Carnes Barbosa: 1 víscera\(s\) sin costo: Bofe/);

  const sinFecha = sedeRec(13, "Carnes Barbosa", "05", "00501", BARBOSA.items, {
    fecha_ingreso: null,
  });
  assert.match(
    armarLiq([LLANO, sinFecha]).bloqueos[0],
    /Carnes Barbosa: La recepción no tiene fecha/,
  );
});

test("consolidado: la configuración que falta se dice UNA vez, no una por sede", () => {
  const { bloqueos } = armarLiq([LLANO, BARBOSA], { decimalesValor: 0, coDocumento: "" });
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /coDocumento, unidadNegocio/);
});

test("consolidado: fechas distintas entre las sedes que aportan bloquean (misma regla de la CEA)", () => {
  const otraFecha = sedeRec(13, "Carnes Barbosa", "05", "00501", BARBOSA.items, {
    fecha_ingreso: "2026-09-28",
  });
  const { bloqueos } = armarLiq([LLANO, otraFecha]);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /fechas distintas \(20260927, 20260928\)/);
});

test("consolidado: la fecha de una sede SIN vísceras no cuenta", () => {
  const otraFecha = sedeRec(14, "Sin vísceras", "07", "00701", [carne("15139", 10, 16800)], {
    fecha_ingreso: "2026-09-30",
  });
  const { bloqueos, payload } = armarLiq([LLANO, otraFecha]);
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos[0].FECHA_DOCTO, "20260927");
});

test("consolidado: sin recepciones bloquea; sin ninguna víscera, vacío y sin bloqueos", () => {
  const nada = armarLiq([]);
  assert.equal(nada.vacio, true);
  assert.deepEqual(nada.bloqueos, ["La liquidación no tiene recepciones."]);

  const solo = armarLiq([SIN_VISCERAS]);
  assert.equal(solo.vacio, true);
  assert.deepEqual(solo.bloqueos, []);
  assert.equal(solo.payload.Movimientos.length, 0);
});

test("consolidado: recepcion_ids son las que aportan renglones", () => {
  assert.deepEqual(armarLiq([LLANO, SIN_VISCERAS, BARBOSA]).recepcion_ids, [12, 13]);
});

test("consolidado: los renglones traen sede y recepción, para el desglose", () => {
  const { renglones } = armarLiq();
  assert.equal(renglones.length, 4);
  assert.deepEqual([...new Set(renglones.map((r) => r.recepcion_id))], [12, 13]);
  assert.equal(renglones[0].sede, "Girardota Llano");
});

test("consolidado: el payload no lleva Descuentos, y la cabecera tiene solo tres claves", () => {
  const { payload } = armarLiq();
  assert.deepEqual(Object.keys(payload), ["Documentos", "Movimientos"]);
  assert.deepEqual(Object.keys(payload.Documentos[0]), [
    "CONSECUTIVO_DOCTO",
    "FECHA_DOCTO",
    "BODEGA",
  ]);
});

test("consecutivo del consolidado: id × 10 + 4, distinto de los de la CEA (+1, +2, +3)", () => {
  assert.equal(consecutivoAjusteLiquidacion(10), 104);
  assert.equal(
    armarLiq([LLANO], CONFIG, { consecutivo: 777 }).payload.Documentos[0].CONSECUTIVO_DOCTO,
    "777",
  );
  // Con id 99999 sigue cabiendo en 8 dígitos.
  assert.ok(String(consecutivoAjusteLiquidacion(99999)).length <= 8);
  // La CEA consolidada de la liquidación 10 usa 103 (`id × 10 + 3`).
  assert.notEqual(consecutivoAjusteLiquidacion(10), 10 * 10 + 3);
});

test("referencia del consolidado: TC VIS L + liquidación, y cabe en 12", () => {
  assert.equal(referenciaAjusteLiquidacion(10), "TC VIS L10");
  assert.equal(referenciaAjusteLiquidacion(9999), "TC VIS L9999");
  assert.equal(referenciaAjusteLiquidacion(9999).length, 12);
  assert.equal(armarLiq().resumen.referencia, "TC VIS L10");
});

test("referencia del consolidado: pasada la #9999 cae a la compacta sin cortar dígitos", () => {
  assert.equal(referenciaAjusteLiquidacion(12345), "TCVL12345");
  assert.ok(referenciaAjusteLiquidacion(123456789).length <= 12);
  assert.notEqual(referenciaAjusteLiquidacion(12345), referenciaAjusteLiquidacion(12346));
  // Y no se confunde con la de una recepción con el mismo número.
  assert.notEqual(referenciaAjusteLiquidacion(12), referenciaAjusteVisceras(12));
});

// ─── El guardia contra los ajustes por sede de antes ────────────────────────

const previo = (recepcion_id, estado, referencia = `TC VIS R${recepcion_id}`) => ({
  id: recepcion_id * 100,
  recepcion_id,
  estado,
  referencia,
});
const NOMBRES = new Map([
  [12, "Girardota Llano"],
  [13, "Carnes Barbosa"],
]);

test("guardia: un ajuste por sede ok bloquea, con la sede y la referencia", () => {
  const { bloqueos, vigentes } = guardaAjustesPorSede([previo(12, "ok")], NOMBRES);
  assert.equal(vigentes.length, 1);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /Girardota Llano \(TC VIS R12, en SIESA\)/);
  assert.match(bloqueos[0], /Se anuló en SIESA/);
  assert.match(bloqueos[0], /dos veces/);
});

test("guardia: enviando y sin_confirmar también bloquean", () => {
  const { bloqueos } = guardaAjustesPorSede(
    [previo(12, "enviando"), previo(13, "sin_confirmar")],
    NOMBRES,
  );
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /enviándose/);
  assert.match(bloqueos[0], /sin confirmar/);
});

test("guardia: error y anulado no bloquean (ya no ocupan el lugar)", () => {
  const { bloqueos, vigentes } = guardaAjustesPorSede(
    [previo(12, "anulado"), previo(13, "error")],
    NOMBRES,
  );
  assert.deepEqual(bloqueos, []);
  assert.equal(vigentes.length, 0);
});

test("guardia: el envío consolidado (sin recepción) no cuenta como uno por sede", () => {
  const consolidado = { id: 1, recepcion_id: null, estado: "ok", referencia: "TC VIS L10" };
  assert.deepEqual(guardaAjustesPorSede([consolidado], NOMBRES).bloqueos, []);
});

test("guardia: sin filas no bloquea; una sede sin nombre conocido se nombra por su recepción", () => {
  assert.deepEqual(guardaAjustesPorSede([], NOMBRES).bloqueos, []);
  const { bloqueos } = guardaAjustesPorSede([previo(99, "ok")], NOMBRES);
  assert.match(bloqueos[0], /Recepción #99 \(TC VIS R99, en SIESA\)/);
});

test("guardia: con cuatro ok (#12 a #15) los nombra a todos en un solo mensaje", () => {
  const nombres = new Map([
    [12, "Llano"],
    [13, "Carnes Barbosa"],
    [14, "Super Barbosa"],
    [15, "San Juan"],
  ]);
  const { bloqueos } = guardaAjustesPorSede(
    [12, 13, 14, 15].map((id) => previo(id, "ok")),
    nombres,
  );
  assert.equal(bloqueos.length, 1);
  for (const n of ["Llano", "Carnes Barbosa", "Super Barbosa", "San Juan"]) {
    assert.match(bloqueos[0], new RegExp(n));
  }
});

// ─── El CEI de una recepción al cerrarla (visceras_recepcion) ───────────────

test("el CEI de la recepción usa su propia referencia, consecutivo y tipo", () => {
  const { payload, resumen, vacio } = armarViscerasRecepcion({
    recepcion: recepcion(),
    items: ITEMS,
    config: CONFIG,
  });
  assert.equal(TIPO_VISCERAS_RECEPCION, "visceras_recepcion");
  assert.equal(vacio, false);
  assert.equal(resumen.referencia, "TC VISC R12");
  assert.notEqual(resumen.referencia, referenciaAjusteVisceras(12));
  assert.equal(consecutivoViscerasRecepcion(12), 127);
  assert.equal(payload.Documentos[0].CONSECUTIVO_DOCTO, "127");
  assert.ok(payload.Movimientos.every((m) => m.NRO_DOCTO === "127"));
  // Entra legible hasta 3 dígitos y pasa a la compacta sin cortar el número.
  assert.equal(referenciaViscerasRecepcion(999), "TC VISC R999");
  assert.equal(referenciaViscerasRecepcion(12345), "TCVC12345");
});

test("recepción sin vísceras con código y cantidad: vacío, nada que mandar", () => {
  const r = armarViscerasRecepcion({
    recepcion: recepcion(),
    items: [carne("15139", 10, 16800), viscera("Vísceras", "", 3, 1000)],
    config: CONFIG,
  });
  assert.equal(r.vacio, true);
  assert.equal(r.payload.Movimientos.length, 0);
});

const payloadDe = (items, r = recepcion()) => armarViscerasRecepcion({ recepcion: r, items, config: CONFIG }).payload;

test("compararViscerasEnviadas: payload idéntico no tiene cambio", () => {
  const r = compararViscerasEnviadas(payloadDe(ITEMS), payloadDe(ITEMS));
  assert.equal(r.cambio, false);
  assert.deepEqual(r.diferencias, []);
});

test("compararViscerasEnviadas: la tolerancia de cantidad no cuenta como cambio", () => {
  const a = payloadDe(ITEMS);
  const b = payloadDe([viscera("Mondongo", "20101", 33.3004, 6500), ITEMS[1]]);
  assert.equal(compararViscerasEnviadas(a, b).cambio, false);
  // CANTIDAD viaja con 3 decimales: 33.301 vs 33.3 pasa la tolerancia de 0,005.
  const c = payloadDe([viscera("Mondongo", "20101", 33.31, 6500), ITEMS[1]]);
  const dif = compararViscerasEnviadas(a, c);
  assert.equal(dif.cambio, true);
  assert.deepEqual(
    dif.diferencias.map((d) => [d.tipo, d.campo, d.item]),
    [["modificado", "cantidad", "20101"]],
  );
  assert.equal(dif.diferencias[0].antes, 33.3);
  assert.equal(dif.diferencias[0].ahora, 33.31);
});

test("compararViscerasEnviadas: detecta costo, renglón agregado y renglón quitado", () => {
  const a = payloadDe(ITEMS);
  const costo = compararViscerasEnviadas(a, payloadDe([viscera("Mondongo", "20101", 33.3, 7000), ITEMS[1]]));
  assert.deepEqual(
    costo.diferencias.map((d) => [d.tipo, d.campo]),
    [["modificado", "costo"]],
  );

  const agregado = compararViscerasEnviadas(a, payloadDe([...ITEMS, viscera("Hígado", "20103", 5, 9000)]), {
    descripciones: { 20103: "Hígado" },
  });
  assert.deepEqual(
    agregado.diferencias.map((d) => [d.tipo, d.item, d.descripcion]),
    [["agregado", "20103", "Hígado"]],
  );

  const quitado = compararViscerasEnviadas(a, payloadDe([ITEMS[0]]));
  assert.deepEqual(
    quitado.diferencias.map((d) => [d.tipo, d.item]),
    [["eliminado", "20102"]],
  );

  // Quedó sin ninguna víscera: todo eliminado.
  const nada = compararViscerasEnviadas(a, payloadDe([]));
  assert.equal(nada.cambio, true);
  assert.equal(nada.diferencias.length, 2);
});

test("compararViscerasEnviadas: cambia la bodega o la fecha del documento", () => {
  const a = payloadDe(ITEMS);
  const otraSede = recepcion({ sede: { id: 3, nombre: "Otra", codigo_co: "03", bodega_siesa: "00301" } });
  assert.ok(compararViscerasEnviadas(a, payloadDe(ITEMS, otraSede)).diferencias.some((d) => d.campo === "bodega"));
  const otraFecha = recepcion({ fecha_ingreso: "2026-09-24" });
  assert.ok(compararViscerasEnviadas(a, payloadDe(ITEMS, otraFecha)).diferencias.some((d) => d.tipo === "fecha"));
});

test("compararViscerasEnviadas: el mismo código repetido se empareja por cantidad", () => {
  const dos = [viscera("A", "20101", 2, 1000), viscera("B", "20101", 5, 1000)];
  const igual = [viscera("B", "20101", 5, 1000), viscera("A", "20101", 2, 1000)];
  assert.equal(compararViscerasEnviadas(payloadDe(dos), payloadDe(igual)).cambio, false);
  const cambia = compararViscerasEnviadas(payloadDe(dos), payloadDe([viscera("A", "20101", 2, 1000)]));
  assert.deepEqual(cambia.diferencias.map((d) => d.tipo), ["eliminado"]);
});

test("compararViscerasEnviadas: sin payload viejo, todo es agregado", () => {
  const r = compararViscerasEnviadas(null, payloadDe(ITEMS));
  assert.equal(r.cambio, true);
  assert.ok(r.diferencias.every((d) => d.tipo === "agregado"));
});

// ─── Qué le toca a cada recepción en la liquidación ─────────────────────────

const fila = (estado, items = ITEMS, extra = {}) => ({
  id: 1,
  estado,
  referencia: "TC VISC R12",
  payload: payloadDe(items),
  ...extra,
});
const armadoDe = (items) => armarViscerasRecepcion({ recepcion: recepcion(), items, config: CONFIG });

test("decidirViscerasRecepcion: ok y sin tocar es sin_cambios", () => {
  const d = decidirViscerasRecepcion({ armado: armadoDe(ITEMS), filas: [fila("ok")] });
  assert.equal(d.estado, ESTADO_VISCERAS.SIN_CAMBIOS);
  assert.deepEqual(d.diferencias, []);
});

test("decidirViscerasRecepcion: ok y el admin cambió algo es modificada, con las diferencias", () => {
  const cambiadas = [viscera("Mondongo", "20101", 40, 6500), ITEMS[1]];
  const d = decidirViscerasRecepcion({
    armado: armadoDe(cambiadas),
    filas: [fila("ok")],
    descripciones: { 20101: "Mondongo" },
  });
  assert.equal(d.estado, ESTADO_VISCERAS.MODIFICADA);
  assert.equal(d.vigente.referencia, "TC VISC R12");
  assert.equal(d.diferencias[0].descripcion, "Mondongo");
});

test("decidirViscerasRecepcion: dejar la recepción sin vísceras también es modificada", () => {
  const d = decidirViscerasRecepcion({ armado: armadoDe([carne("15139", 10, 16800)]), filas: [fila("ok")] });
  assert.equal(d.estado, ESTADO_VISCERAS.MODIFICADA);
});

test("decidirViscerasRecepcion: enviando y sin_confirmar son en_revision", () => {
  for (const e of ["enviando", "sin_confirmar"]) {
    assert.equal(
      decidirViscerasRecepcion({ armado: armadoDe(ITEMS), filas: [fila(e)] }).estado,
      ESTADO_VISCERAS.EN_REVISION,
    );
  }
});

test("decidirViscerasRecepcion: error o anulado (sin vigente) es pendiente; sin nada que mandar, sin_visceras", () => {
  for (const e of ["error", "anulado"]) {
    assert.equal(
      decidirViscerasRecepcion({ armado: armadoDe(ITEMS), filas: [fila(e)] }).estado,
      ESTADO_VISCERAS.PENDIENTE,
    );
  }
  assert.equal(decidirViscerasRecepcion({ armado: armadoDe(ITEMS), filas: [] }).estado, ESTADO_VISCERAS.PENDIENTE);
  assert.equal(decidirViscerasRecepcion({ armado: armadoDe([]), filas: [] }).estado, ESTADO_VISCERAS.SIN_VISCERAS);
});

test("decidirViscerasRecepcion: el vigente manda sobre un error más nuevo ya anulado en el historial", () => {
  const d = decidirViscerasRecepcion({
    armado: armadoDe(ITEMS),
    filas: [fila("error", ITEMS, { id: 3 }), fila("ok", ITEMS, { id: 2 })],
  });
  assert.equal(d.estado, ESTADO_VISCERAS.SIN_CAMBIOS);
  assert.equal(d.vigente.id, 2);
  assert.equal(d.ultimo.id, 3);
});

test("viscerasSinCambios: solo cuando nada necesita subirse y hay al menos una al día", () => {
  const E = ESTADO_VISCERAS;
  assert.equal(viscerasSinCambios([E.SIN_CAMBIOS, E.SIN_CAMBIOS]), true);
  assert.equal(viscerasSinCambios([E.SIN_CAMBIOS, E.SIN_VISCERAS]), true);
  assert.equal(viscerasSinCambios([E.SIN_CAMBIOS, E.MODIFICADA]), false);
  assert.equal(viscerasSinCambios([E.SIN_CAMBIOS, E.PENDIENTE]), false);
  assert.equal(viscerasSinCambios([E.SIN_CAMBIOS, E.EN_REVISION]), false);
  assert.equal(viscerasSinCambios([E.SIN_VISCERAS]), false);
  assert.equal(viscerasSinCambios([]), false);
});
