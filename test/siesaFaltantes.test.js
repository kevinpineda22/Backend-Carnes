import test from "node:test";
import assert from "node:assert/strict";

import {
  parsearFaltantes,
  soloFaltantes,
  armarAjusteFaltante,
  subirCantidadPorFaltante,
  faltantesQueNoBajaron,
  cantidadHaciaArriba,
  formatDecimal,
  referenciaAjusteFaltante,
  TIPO_AJUSTE_FALTANTE,
} from "../src/shared/siesaFaltantes.js";
import { esperaParaEnvio, LIMITE_FUNCION_MS } from "../src/shared/siesaAjusteVisceras.js";
import {
  DOCUMENTO_AJUSTE_FALTANTE,
  bloqueoAjusteFaltante,
} from "../src/config/siesa.js";

// El rechazo REAL de SIESA al ajuste de vísceras de la liquidación 10 (29/09/2026).
const RESPUESTA_REAL = {
  codigo: 1,
  detalle: [
    {
      f_nivel: "0",
      f_valor: "Item:0015187Bodega:00201",
      f_detalle:
        "Movto Inventario: Item sin cantidad disponible Faltante Inv.: -1.998000 Faltante Adic.: 0.0000",
      f_version: "1",
      f_tipo_reg: "470",
      f_nro_linea: "0",
      f_subtipo_reg: "1",
    },
  ],
  mensaje: "Error al importar el plano",
};

const detalle = (f_valor, f_detalle) => ({ f_valor, f_detalle });
const FALTANTE = (item, bodega, n) =>
  detalle(`Item:${item}Bodega:${bodega}`, `Movto Inventario: Item sin cantidad disponible Faltante Inv.: ${n} Faltante Adic.: 0.0000`);

// Movimientos del ajuste de vísceras (lo que se rechazó).
const CEI = [
  { ITEM: "15187", BODEGA: "00201", "C.O MOVIMIENTO": "002", UNIDAD_MEDIDA: "KL", CANTIDAD: "2.247", COSTO_PROMEDIO: "27500", UNIDAD_NEGOCIO: "003" },
  { ITEM: "15188", BODEGA: "00201", "C.O MOVIMIENTO": "002", UNIDAD_MEDIDA: "UND", CANTIDAD: "5.33", COSTO_PROMEDIO: "11000", UNIDAD_NEGOCIO: "003" },
  { ITEM: "15187", BODEGA: "00301", "C.O MOVIMIENTO": "003", UNIDAD_MEDIDA: "KL", CANTIDAD: "2.247", COSTO_PROMEDIO: "27500", UNIDAD_NEGOCIO: "003" },
];

const CONFIG = { ...DOCUMENTO_AJUSTE_FALTANTE, idDocumento: "999999", nombreDocumento: "X" };

// ─── parsearFaltantes ───────────────────────────────────────────────────────

test("parsearFaltantes: el error real de SIESA da el ítem sin ceros, la bodega y el faltante en positivo", () => {
  assert.deepEqual(parsearFaltantes(RESPUESTA_REAL), [
    { item: "15187", bodega: "00201", faltante: 1.998 },
  ]);
});

test("parsearFaltantes: acepta el arreglo `detalle` suelto", () => {
  assert.equal(parsearFaltantes(RESPUESTA_REAL.detalle).length, 1);
});

test("parsearFaltantes: el ítem concatenado con su código repetido usa los primeros 7 caracteres", () => {
  const r = parsearFaltantes([FALTANTE("00050645064", "PV001", "-3.000000")]);
  assert.deepEqual(r, [{ item: "5064", bodega: "PV001", faltante: 3 }]);
});

test("parsearFaltantes: ítem con extensión alfanumérica (0001705A-0001705)", () => {
  const r = parsearFaltantes([FALTANTE("0001705A-0001705", "PV001", "-1.5")]);
  assert.equal(r[0].item, "1705");
});

test("parsearFaltantes: varios ítems y bodegas", () => {
  const r = parsearFaltantes([
    FALTANTE("0015187", "00201", "-1.998000"),
    FALTANTE("0015188", "00201", "-2.000000"),
    FALTANTE("0015187", "00301", "-0.500000"),
  ]);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((f) => `${f.bodega}/${f.item}`), ["00201/15187", "00201/15188", "00301/15187"]);
});

test("parsearFaltantes: ignora los detalles que no son un faltante", () => {
  const r = parsearFaltantes([
    detalle("Item:0015187Bodega:00201", "Movto Inventario: Item sin cantidad disponible Faltante Inv.: -1.998000 Faltante Adic.: 0.0000"),
    detalle("Item:0099999Bodega:00201", "El ítem no existe"),
    detalle("", "Advertencia: costo distinto"),
  ]);
  assert.equal(r.length, 1);
});

test("parsearFaltantes: un faltante de 0 no es un faltante", () => {
  assert.deepEqual(parsearFaltantes([FALTANTE("0015187", "00201", "0.000000")]), []);
});

test("parsearFaltantes: el mismo ítem y bodega repetido no se suma, queda el mayor", () => {
  const r = parsearFaltantes([
    FALTANTE("0015187", "00201", "-1.000000"),
    FALTANTE("0015187", "00201", "-2.500000"),
  ]);
  assert.deepEqual(r, [{ item: "15187", bodega: "00201", faltante: 2.5 }]);
});

test("parsearFaltantes: respuestas raras no revientan", () => {
  for (const r of [null, undefined, {}, "texto", { detalle: "no es arreglo" }, { detalle: [null, {}] }]) {
    assert.deepEqual(parsearFaltantes(r), []);
  }
});

// ─── soloFaltantes ──────────────────────────────────────────────────────────

test("soloFaltantes: el rechazo real es solo un faltante", () => {
  assert.equal(soloFaltantes(RESPUESTA_REAL), true);
});

test("soloFaltantes: con otro error mezclado no se compensa", () => {
  const r = {
    detalle: [
      FALTANTE("0015187", "00201", "-1.998000"),
      detalle("Item:0099999Bodega:00201", "El ítem no existe"),
    ],
  };
  assert.equal(soloFaltantes(r), false);
});

test("soloFaltantes: las advertencias no cuentan, pero sin ningún faltante tampoco", () => {
  const conAdvertencia = { detalle: [FALTANTE("0015187", "00201", "-1"), detalle("", "Advertencia: x")] };
  assert.equal(soloFaltantes(conAdvertencia), true);
  assert.equal(soloFaltantes({ detalle: [detalle("", "Advertencia: x")] }), false);
  assert.equal(soloFaltantes({ detalle: [] }), false);
  assert.equal(soloFaltantes(null), false);
});

// ─── números ────────────────────────────────────────────────────────────────

test("formatDecimal: los decimales pedidos, sin relleno (como la CEA y la CEI)", () => {
  assert.equal(formatDecimal(1.998, 3), "1.998");
  assert.equal(formatDecimal(2, 2), "2.00");
  assert.equal(formatDecimal(27500, 0), "27500");
  assert.equal(formatDecimal(null, 3), "0.000");
});

test("cantidadHaciaArriba: KL a milésimas, UND a centésimas, sin ruido de coma flotante", () => {
  assert.equal(cantidadHaciaArriba(1.998, "KL"), 1.998);
  assert.equal(cantidadHaciaArriba(1.9981, "KL"), 1.999);
  assert.equal(cantidadHaciaArriba(0.0001, "KL"), 0.001);
  assert.equal(cantidadHaciaArriba(1.3, "UND"), 1.3);
  assert.equal(cantidadHaciaArriba(0.661, "UND"), 0.67);
  assert.equal(cantidadHaciaArriba(2, "UND"), 2);
  assert.equal(cantidadHaciaArriba(4.000000001, "UND"), 4);
});

// ─── armarAjusteFaltante ────────────────────────────────────────────────────

const faltantesReales = parsearFaltantes(RESPUESTA_REAL);
const armar = (faltantes = faltantesReales, extra = {}) =>
  armarAjusteFaltante({
    faltantes,
    movimientosCei: CEI,
    config: CONFIG,
    fecha: "20260927",
    liquidacionId: 10,
    ...extra,
  });

test("ajuste por faltante: el caso real (ítem 15187, bodega 00201, 1,998 KL) con las variables del conector 257784", () => {
  const { documentos, bloqueos } = armar();
  assert.deepEqual(bloqueos, []);
  assert.equal(documentos.length, 1);
  const { payload } = documentos[0];
  assert.deepEqual(payload.Documentos, [
    { CONSECUTIVO_DOCTO: "105", FECHA_DOCTO: "20260927", BODEGA: "00201" },
  ]);
  assert.deepEqual(payload.Movimientos, [
    {
      consec_docto: "105",
      nro_registro: "1",
      BODEGA: "00201",
      "C.O MOVIMIENTO": "002",
      UNIDAD_MEDIDA: "KL",
      CANTIDAD: "1.998",
      COSTO_PROMEDIO: "27500",
      ITEM: "15187",
      UNIDAD_NEGOCIO: "003",
    },
  ]);
});

test("ajuste por faltante: no viajan claves del conector de siesa-pos-sync (motivo, naturaleza, C.O.)", () => {
  const { payload } = armar().documentos[0];
  const claves = [...Object.keys(payload.Documentos[0]), ...Object.keys(payload.Movimientos[0])];
  for (const k of ["f470_id_motivo", "ind_naturaleza", "C.O.", "f350_id_co", "f470_consec_docto"]) {
    assert.ok(!claves.includes(k), k);
  }
});

test("ajuste por faltante: UN documento POR BODEGA, cada cabecera con la suya", () => {
  const { documentos } = armar([
    { item: "15187", bodega: "00301", faltante: 0.5 },
    { item: "15187", bodega: "00201", faltante: 1.998 },
    { item: "15188", bodega: "00201", faltante: 1.2 },
  ]);
  assert.equal(documentos.length, 2);
  assert.deepEqual(documentos.map((d) => d.bodega), ["00201", "00301"]);
  const d201 = documentos[0].payload;
  assert.equal(d201.Documentos[0].BODEGA, "00201");
  assert.equal(d201.Movimientos.length, 2);
  assert.ok(d201.Movimientos.every((m) => m.BODEGA === "00201"));
  assert.deepEqual(d201.Movimientos.map((m) => m.nro_registro), ["1", "2"]);
  assert.equal(documentos[1].payload.Documentos[0].BODEGA, "00301");
  assert.equal(documentos[1].payload.Movimientos[0]["C.O MOVIMIENTO"], "003");
});

test("ajuste por faltante: UND va con 2 decimales, sin inflar al entero", () => {
  const { documentos } = armar([{ item: "15188", bodega: "00201", faltante: 1.2 }]);
  const m = documentos[0].payload.Movimientos[0];
  assert.equal(m.UNIDAD_MEDIDA, "UND");
  assert.equal(m.CANTIDAD, "1.20");
  assert.equal(m.COSTO_PROMEDIO, "11000");
});

test("ajuste por faltante: el costo es el de la víscera de ESA bodega en el ajuste rechazado", () => {
  const cei = [
    { ...CEI[0], BODEGA: "00201", COSTO_PROMEDIO: "27500" },
    { ...CEI[2], BODEGA: "00301", COSTO_PROMEDIO: "30000" },
  ];
  const { documentos } = armarAjusteFaltante({
    faltantes: [
      { item: "15187", bodega: "00201", faltante: 1 },
      { item: "15187", bodega: "00301", faltante: 1 },
    ],
    movimientosCei: cei,
    config: CONFIG,
    fecha: "20260927",
    liquidacionId: 10,
  });
  assert.equal(documentos[0].payload.Movimientos[0].COSTO_PROMEDIO, "27500");
  assert.equal(documentos[1].payload.Movimientos[0].COSTO_PROMEDIO, "30000");
});

test("ajuste por faltante: un ítem que no es víscera de esa bodega BLOQUEA, no adivina costo", () => {
  const { documentos, bloqueos } = armar([{ item: "99999", bodega: "00201", faltante: 1 }]);
  assert.equal(documentos.length, 0);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /ítem 99999 en la bodega 00201.*no es una víscera de este ajuste/);
});

test("ajuste por faltante: el ítem existe pero en OTRA bodega también bloquea", () => {
  const { bloqueos } = armar([{ item: "15188", bodega: "00301", faltante: 1 }]);
  assert.equal(bloqueos.length, 1);
  assert.match(bloqueos[0], /bodega 00301/);
});

test("ajuste por faltante: una bodega buena y una mala: bloquea (todo o nada)", () => {
  const { bloqueos } = armar([
    { item: "15187", bodega: "00201", faltante: 1 },
    { item: "99999", bodega: "00301", faltante: 1 },
  ]);
  assert.equal(bloqueos.length, 1);
});

test("ajuste por faltante: sin costo en el renglón bloquea", () => {
  const { bloqueos } = armarAjusteFaltante({
    faltantes: faltantesReales,
    movimientosCei: [{ ...CEI[0], COSTO_PROMEDIO: "0" }],
    config: CONFIG,
    fecha: "20260927",
    liquidacionId: 10,
  });
  assert.match(bloqueos[0], /no tiene costo/);
});

test("ajuste por faltante: sin fecha o sin CO de documento bloquea", () => {
  assert.match(armar(faltantesReales, { fecha: "" }).bloqueos[0], /no tiene fecha/);
  assert.match(
    armar(faltantesReales, { config: { ...CONFIG, coDocumento: "" } }).bloqueos[0],
    /coDocumento/,
  );
});

test("ajuste por faltante: sin faltantes no hay documento", () => {
  const { documentos, bloqueos } = armar([]);
  assert.equal(documentos.length, 0);
  assert.deepEqual(bloqueos, ["No hay faltantes que compensar."]);
});

test("ajuste por faltante: el resumen trae referencia, renglones y valor", () => {
  const { resumen } = armar().documentos[0];
  assert.equal(resumen.tipo, TIPO_AJUSTE_FALTANTE);
  assert.equal(resumen.referencia, "TF L10 00201");
  assert.equal(resumen.renglones, 1);
  assert.equal(resumen.totalKilos, 1.998);
  assert.equal(resumen.totalValor, 54945);
  assert.equal(resumen.bodega, "00201");
});

// ─── Referencias ────────────────────────────────────────────────────────────

test("referencia: cabe en 12 y dos bodegas nunca comparten", () => {
  const bodegas = ["00201", "00301", "00401", "00501", "PV001", "01101", "10201"];
  const refs = bodegas.map((b) => referenciaAjusteFaltante(10, b));
  assert.equal(new Set(refs).size, bodegas.length);
  for (const r of refs) assert.ok(r.length <= 12, r);
  assert.equal(referenciaAjusteFaltante(10, "00201"), "TF L10 00201");
});

test("referencia: con una liquidación de más dígitos pasa a la compacta SIN cortar la bodega", () => {
  const r1 = referenciaAjusteFaltante(1234, "00201");
  const r2 = referenciaAjusteFaltante(1234, "00301");
  assert.equal(r1, "F1234-00201");
  assert.ok(r1.length <= 12 && r2.length <= 12);
  assert.notEqual(r1, r2);
  assert.match(r1, /00201$/);
});

test("referencia: liquidaciones distintas, referencias distintas", () => {
  assert.notEqual(referenciaAjusteFaltante(10, "00201"), referenciaAjusteFaltante(11, "00201"));
  assert.notEqual(referenciaAjusteFaltante(1234, "00201"), referenciaAjusteFaltante(1235, "00201"));
});

// ─── Reintento: anterior + faltante ─────────────────────────────────────────

test("reintento: si el ajuste vuelve con faltante se SUMA a lo que ya se mandaba", () => {
  const doc = armar().documentos[0]; // 1,998
  // SIESA: mandamos 1,998 y todavía falta 0,500 → 2,498 (no 0,500).
  const r = subirCantidadPorFaltante({
    documento: doc,
    faltantes: [{ item: "15187", bodega: "00201", faltante: 0.5 }],
    config: CONFIG,
    liquidacionId: 10,
  });
  assert.equal(r.cambios[0].anterior, 1.998);
  assert.equal(r.cambios[0].nueva, 2.498);
  assert.equal(r.documento.payload.Movimientos[0].CANTIDAD, "2.498");
  // El resto del documento no cambia.
  assert.equal(r.documento.payload.Documentos[0].BODEGA, "00201");
  assert.equal(r.documento.resumen.referencia, doc.resumen.referencia);
});

test("reintento: UND suma a centésimas (1 + 0,4 = 1,4)", () => {
  const doc = armar([{ item: "15188", bodega: "00201", faltante: 1 }]).documentos[0];
  const r = subirCantidadPorFaltante({
    documento: doc,
    faltantes: [{ item: "15188", bodega: "00201", faltante: 0.4 }],
    config: CONFIG,
    liquidacionId: 10,
  });
  assert.equal(r.cambios[0].nueva, 1.4);
});

test("reintento: un faltante de un ítem que no está en el ajuste no encaja y no se inventa", () => {
  const doc = armar().documentos[0];
  const r = subirCantidadPorFaltante({
    documento: doc,
    faltantes: [{ item: "99999", bodega: "00201", faltante: 1 }],
    config: CONFIG,
    liquidacionId: 10,
  });
  assert.equal(r.documento, null);
  assert.equal(r.noAplicables.length, 1);
});

test("reintento: el documento original no se muta", () => {
  const doc = armar().documentos[0];
  const antes = JSON.stringify(doc.payload);
  subirCantidadPorFaltante({
    documento: doc,
    faltantes: [{ item: "15187", bodega: "00201", faltante: 1 }],
    config: CONFIG,
    liquidacionId: 10,
  });
  assert.equal(JSON.stringify(doc.payload), antes);
});

// ─── ¿Sirvió compensar? ─────────────────────────────────────────────────────

test("faltantesQueNoBajaron: si el faltante bajó, todo bien", () => {
  const antes = [{ item: "15187", bodega: "00201", faltante: 1.998 }];
  assert.deepEqual(faltantesQueNoBajaron(antes, [{ item: "15187", bodega: "00201", faltante: 0.5 }]), []);
});

test("faltantesQueNoBajaron: si sigue igual o peor, el ajuste no está sumando", () => {
  const antes = [{ item: "15187", bodega: "00201", faltante: 1.998 }];
  const igual = faltantesQueNoBajaron(antes, [{ item: "15187", bodega: "00201", faltante: 1.998 }]);
  const peor = faltantesQueNoBajaron(antes, [{ item: "15187", bodega: "00201", faltante: 3.996 }]);
  assert.equal(igual.length, 1);
  assert.equal(peor.length, 1);
  assert.deepEqual(peor[0], { item: "15187", bodega: "00201", antes: 1.998, ahora: 3.996 });
});

test("faltantesQueNoBajaron: un faltante nuevo (otro ítem) no cuenta, y sin ronda previa no hay nada", () => {
  const antes = [{ item: "15187", bodega: "00201", faltante: 1 }];
  assert.deepEqual(faltantesQueNoBajaron(antes, [{ item: "15188", bodega: "00201", faltante: 5 }]), []);
  assert.deepEqual(faltantesQueNoBajaron(null, antes), []);
});

// ─── Configuración y tiempo ─────────────────────────────────────────────────

test("el ajuste por faltante usa el conector propio de carnes (257784), no el de siesa-pos-sync", () => {
  assert.equal(DOCUMENTO_AJUSTE_FALTANTE.idDocumento, "257784");
  assert.equal(DOCUMENTO_AJUSTE_FALTANTE.nombreDocumento, "AJUSTE_DESARROLLO_CARNES_ERRORES");
  assert.notEqual(DOCUMENTO_AJUSTE_FALTANTE.idDocumento, "241913");
  assert.equal(DOCUMENTO_AJUSTE_FALTANTE.motivo, "03");
});

test("con el conector configurado no hay bloqueo de configuración", () => {
  assert.equal(bloqueoAjusteFaltante(), null);
});

test("esperaParaEnvio: recorta la espera al límite de la función y no arranca sin el mínimo", () => {
  const p = { maxEsperaMs: 240_000, minimoMs: 60_000 };
  assert.equal(esperaParaEnvio(10_000, p), 240_000);
  assert.equal(esperaParaEnvio(100_000, p), LIMITE_FUNCION_MS - 100_000);
  assert.equal(esperaParaEnvio(225_000, p), 60_000);
  assert.equal(esperaParaEnvio(225_001, p), null);
  // Una compensación (mínimo 30 s) arranca más tarde que el reenvío del ajuste.
  assert.equal(esperaParaEnvio(250_000, { maxEsperaMs: 90_000, minimoMs: 30_000 }), 35_000);
  assert.equal(esperaParaEnvio(256_000, { maxEsperaMs: 90_000, minimoMs: 30_000 }), null);
});
