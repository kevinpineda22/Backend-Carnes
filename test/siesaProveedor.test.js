import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TIPO_ENVIO_PROVEEDOR,
  armarEntradaProveedor,
  armarNotaCreditoProveedor,
  referenciaProveedor,
  referenciaNotaCreditoProveedor,
  consecutivoEntradaProveedor,
  consecutivoNotaCreditoProveedor,
} from "../src/shared/siesaProveedor.js";
import { decimal, notasDocumento } from "../src/shared/siesaEntrada.js";
import {
  DOCUMENTO_CARNES,
  DOCUMENTO_NOTA_CREDITO_PROVEEDOR,
  bloqueoNotaCreditoProveedor,
  faltantesSiesa,
} from "../src/config/siesa.js";

/** Config de la CEA, como la de Talleres (el tercero NO sale de acá: es el proveedor). */
const CONFIG = { ...DOCUMENTO_CARNES };

/** Una nota crédito con el conector ya configurado (valores de ejemplo, el real no existe). */
const CONFIG_NC = {
  ...DOCUMENTO_NOTA_CREDITO_PROVEEDOR,
  idDocumento: "999999",
  nombreDocumento: "NOTA_CREDITO_PROVEEDOR_PRUEBA",
  tipoDocto: "NCP",
};

const RECEPCION = {
  id: 12,
  proveedor_nit: "900123456",
  proveedor_sucursal: "001",
  proveedor_razon_social: "NUTRESA S.A.S.",
  factura: "FE-00123",
  factura_siesa: null,
  bodega_siesa: "B07",
  codigo_co: "07",
  fecha_recepcion: "2026-09-30",
  sede_id: 9,
  sede: { id: 9, nombre: "Lopez" },
};

/** Renglón válido de KL: 100 kg a $20.000 el kilo, con 10 kg devueltos. */
const KILOS = {
  id: 1,
  codigo_item: "15167",
  descripcion_item: "CARNE PARA MOLER",
  unidad: "KL",
  equivalencia: "Molida",
  cantidad: 100,
  valor_unitario: 20000,
  valor_total: 2000000,
  valor_fuente: "unitario",
  cantidad_devuelta: 10,
  motivo_devolucion: "Mal estado",
};

/** Renglón válido de UND: 12 unidades a $5.500. */
const UNIDADES = {
  id: 2,
  codigo_item: "20412",
  descripcion_item: "CHORIZO X UND",
  unidad: "UND",
  equivalencia: "Chorizo",
  cantidad: 12,
  valor_unitario: 5500,
  valor_total: 66000,
  valor_fuente: "unitario",
  cantidad_devuelta: 0,
};

const armar = (over = {}) =>
  armarEntradaProveedor({
    recepcion: RECEPCION,
    items: [KILOS, UNIDADES],
    config: CONFIG,
    ...over,
  });

const armarNC = (over = {}) =>
  armarNotaCreditoProveedor({
    recepcion: RECEPCION,
    items: [KILOS, UNIDADES],
    config: CONFIG_NC,
    ...over,
  });

// ─── Referencias y consecutivos ─────────────────────────────────────────────

test("tipos de envío: caben en la columna tipo (VARCHAR(20)) y son los de sql/023", () => {
  assert.equal(TIPO_ENVIO_PROVEEDOR.ENTRADA, "entrada_proveedor");
  assert.equal(TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO, "nc_proveedor");
  const sql = readFileSync(new URL("../sql/023_siesa_proveedor.sql", import.meta.url), "utf8");
  for (const tipo of Object.values(TIPO_ENVIO_PROVEEDOR)) {
    assert.ok(tipo.length <= 20, `${tipo} no cabe en VARCHAR(20)`);
    assert.ok(sql.includes(`'${tipo}'`), `sql/023 no conoce ${tipo}`);
  }
  // Los de siempre se conservan en el CHECK nuevo.
  for (const tipo of ["inicial", "oficial", "ajuste_visceras", "ajuste_faltante"]) {
    assert.ok(sql.includes(`'${tipo}'`), `sql/023 perdió ${tipo}`);
  }
});

test("referenciaProveedor / referenciaNotaCreditoProveedor: legibles y de hasta 12 caracteres", () => {
  assert.equal(referenciaProveedor(12), "TC PRV R12");
  assert.equal(referenciaNotaCreditoProveedor(12), "TC PRV N12");
  assert.equal(referenciaProveedor(9999), "TC PRV R9999");
  assert.equal(referenciaNotaCreditoProveedor(9999), "TC PRV N9999");
});

test("referencias: pasada la #9999 se compactan sin comerse dígitos", () => {
  assert.equal(referenciaProveedor(12345), "TCPR12345");
  assert.equal(referenciaNotaCreditoProveedor(12345), "TCPN12345");
  assert.notEqual(referenciaProveedor(12345), referenciaProveedor(12346));
  assert.ok(referenciaProveedor(999999999999).length <= 12);
  assert.ok(referenciaNotaCreditoProveedor(999999999999).length <= 12);
});

test("consecutivos: id × 10 + 4 (entrada) y + 6 (nota crédito), distintos entre sí", () => {
  assert.equal(consecutivoEntradaProveedor(12), 124);
  assert.equal(consecutivoNotaCreditoProveedor(12), 126);
  assert.notEqual(consecutivoEntradaProveedor(12), consecutivoNotaCreditoProveedor(12));
  // Cabe en 8 dígitos hasta la recepción #99.999.999.
  assert.ok(String(consecutivoNotaCreditoProveedor(99999999)).length <= 9);
});

// ─── La entrada: payload ────────────────────────────────────────────────────

test("entrada: payload completo de una recepción de dos renglones (KL y UND)", () => {
  const { payload, resumen, bloqueos } = armar();
  assert.deepEqual(bloqueos, []);

  assert.deepEqual(payload, {
    Documentos: [
      {
        TIPO_DOCTO: "CEA",
        CONSECUTIVO_DOCTO: "124",
        FECHA: "20260930",
        NIT: "900123456",
        SUCURSAL: "001",
        PENDIENTE: "FE-00123",
        NOTAS: "TC PRV R12 - RECIBO PROVEEDOR FACT FE-00123 Lopez - NUTRESA S.A.S.",
      },
    ],
    Movimientos: [
      {
        TIPO_DOCTO: "CEA",
        NRO_DOCTO: "124",
        NRO_REGISTRO: "1",
        BODEGA: "B07",
        CO_MOVIMIENTO: "007",
        UNIDAD_MEDIDA: "KL",
        CANTIDAD: "100.000",
        VALOR_BRUTO: "2000000",
        ITEM: "15167",
        UNIDAD_NEGOCIO: "003",
      },
      {
        TIPO_DOCTO: "CEA",
        NRO_DOCTO: "124",
        NRO_REGISTRO: "2",
        BODEGA: "B07",
        CO_MOVIMIENTO: "007",
        UNIDAD_MEDIDA: "UND",
        CANTIDAD: "12.00",
        VALOR_BRUTO: "66000",
        ITEM: "20412",
        UNIDAD_NEGOCIO: "003",
      },
    ],
  });

  assert.deepEqual(resumen, {
    tipo: "entrada_proveedor",
    referencia: "TC PRV R12",
    pendiente: "FE-00123",
    renglones: 2,
    totalKilos: 100,
    totalUnidades: 12,
    totalValor: 2066000,
    sede: "Lopez",
    fecha: "2026-09-30",
  });
});

test("entrada: la clave Descuentos NO viaja, ni vacía", () => {
  const { payload } = armar();
  assert.equal("Descuentos" in payload, false);
  assert.deepEqual(Object.keys(payload).sort(), ["Documentos", "Movimientos"]);
});

test("entrada: el tercero es el proveedor (NIT recortado), no el frigorífico de Talleres", () => {
  const { payload } = armar({
    recepcion: { ...RECEPCION, proveedor_nit: " 900123456 ", proveedor_sucursal: "002" },
  });
  assert.equal(payload.Documentos[0].NIT, "900123456");
  assert.equal(payload.Documentos[0].SUCURSAL, "002");
  assert.notEqual(payload.Documentos[0].NIT, DOCUMENTO_CARNES.nit);
});

test("entrada: lleva la cantidad y el valor FACTURADOS completos aunque haya devolución", () => {
  const { payload } = armar();
  const kilos = payload.Movimientos[0];
  // 100 facturados, 10 devueltos: la entrada dice 100.
  assert.equal(kilos.CANTIDAD, "100.000");
  assert.equal(kilos.VALOR_BRUTO, "2000000");
});

test("entrada: solo viajan los renglones con cantidad > 0, numerados de corrido", () => {
  const cero = { ...UNIDADES, id: 3, codigo_item: "99999", cantidad: 0, valor_unitario: null, valor_total: null, valor_fuente: null };
  const { payload, resumen, bloqueos } = armar({ items: [cero, KILOS, UNIDADES] });
  assert.deepEqual(bloqueos, []);
  assert.deepEqual(payload.Movimientos.map((m) => [m.NRO_REGISTRO, m.ITEM]), [
    ["1", "15167"],
    ["2", "20412"],
  ]);
  assert.equal(resumen.renglones, 2);
});

test("entrada: un renglón sin equivalencia se manda con su Item como cualquier otro", () => {
  const sinEquivalencia = { ...KILOS, equivalencia: "" };
  const { payload, bloqueos } = armar({ items: [sinEquivalencia] });
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos.length, 1);
  assert.equal(payload.Movimientos[0].ITEM, "15167");
  assert.equal(payload.Movimientos[0].VALOR_BRUTO, "2000000");
});

test("entrada: la fecha es la de la recepción (AAAAMMDD) y el CO va en 3 caracteres", () => {
  const { payload } = armar({ recepcion: { ...RECEPCION, fecha_recepcion: "2026-10-01", codigo_co: "1" } });
  assert.equal(payload.Documentos[0].FECHA, "20261001");
  assert.equal(payload.Movimientos[0].CO_MOVIMIENTO, "001");
});

// ─── La entrada: cantidades y unidades ──────────────────────────────────────

test("entrada: UND con 2 decimales y KL con 3, tal como se guardaron", () => {
  const kilos = { ...KILOS, cantidad: 10.5, valor_unitario: 20000, valor_total: 210000, cantidad_devuelta: 0, motivo_devolucion: null };
  const und = { ...UNIDADES, cantidad: 2.66, valor_unitario: 5500, valor_total: 14630 };
  const { payload, bloqueos } = armar({ items: [kilos, und] });
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos[0].CANTIDAD, "10.500");
  assert.equal(payload.Movimientos[1].CANTIDAD, "2.66");
});

test("entrada: una UND con 3 decimales (sin ajustar al guardar) bloquea, no se manda a SIESA distinta de lo cobrado", () => {
  const und = { ...UNIDADES, cantidad: 2.667, valor_unitario: 5500, valor_total: 14669 };
  const { bloqueos } = armar({ items: [und] });
  assert.ok(bloqueos.some((b) => /decimales/i.test(b)), bloqueos.join(" | "));
});

test("entrada: KG se normaliza a KL en UNIDAD_MEDIDA", () => {
  const kg = { ...KILOS, unidad: "kg", cantidad_devuelta: 0, motivo_devolucion: null };
  const { payload, bloqueos } = armar({ items: [kg] });
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos[0].UNIDAD_MEDIDA, "KL");
});

test("entrada: una unidad fuera de KL/UND bloquea", () => {
  const libras = { ...KILOS, unidad: "LB", cantidad_devuelta: 0, motivo_devolucion: null };
  const { bloqueos } = armar({ items: [libras] });
  assert.ok(bloqueos.some((b) => b.includes("LB") && /unidad/i.test(b)), bloqueos.join(" | "));
  // Nombra el renglón.
  assert.ok(bloqueos.some((b) => b.includes("Molida")));
});

test("entrada: el valor sale en pesos enteros aunque la config no traiga decimalesValor", () => {
  const { payload } = armar({ config: { tipoDocto: "CEA", unidadNegocio: "003" } });
  assert.equal(payload.Movimientos[0].VALOR_BRUTO, "2000000");
});

// ─── La entrada: la factura en PENDIENTE ────────────────────────────────────

test("entrada: una factura de 12 caracteres cabe en PENDIENTE", () => {
  const { payload, bloqueos } = armar({ recepcion: { ...RECEPCION, factura: "FE-123456789" } });
  assert.equal("FE-123456789".length, 12);
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos[0].PENDIENTE, "FE-123456789");
});

test("entrada: una factura de 13 caracteres BLOQUEA y no se recorta", () => {
  const factura = "FE-1234567890";
  assert.equal(factura.length, 13);
  const { payload, bloqueos } = armar({ recepcion: { ...RECEPCION, factura } });
  const bloqueo = bloqueos.find((b) => b.includes(factura));
  assert.ok(bloqueo, bloqueos.join(" | "));
  assert.match(bloqueo, /13 caracteres/);
  assert.match(bloqueo, /No se recorta/);
  // El documento nunca queda con una referencia cortada.
  assert.equal(payload.Documentos[0].PENDIENTE, factura);
});

test("entrada: factura_siesa manda sobre factura y destraba la factura larga", () => {
  const larga = { ...RECEPCION, factura: "FE-1234567890-A", factura_siesa: "FE-1234567" };
  const { payload, bloqueos } = armar({ recepcion: larga });
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos[0].PENDIENTE, "FE-1234567");
  assert.ok(payload.Documentos[0].NOTAS.includes("FACT FE-1234567 "));
});

test("entrada: factura_siesa manda aunque la factura original sea corta", () => {
  const { payload } = armar({ recepcion: { ...RECEPCION, factura_siesa: "FE123" } });
  assert.equal(payload.Documentos[0].PENDIENTE, "FE123");
});

test("entrada: factura_siesa vacía o en blanco cae en la factura original", () => {
  for (const vacia of ["", "   ", null]) {
    const { payload } = armar({ recepcion: { ...RECEPCION, factura_siesa: vacia } });
    assert.equal(payload.Documentos[0].PENDIENTE, "FE-00123");
  }
});

test("entrada: sin factura bloquea", () => {
  const { bloqueos } = armar({ recepcion: { ...RECEPCION, factura: "  " } });
  assert.ok(bloqueos.includes("La recepción no tiene factura."));
});

// ─── La entrada: NOTAS ──────────────────────────────────────────────────────

test("entrada: las NOTAS arrancan con la referencia propia, luego factura y sede, luego la razón social", () => {
  const { payload } = armar();
  assert.equal(
    payload.Documentos[0].NOTAS,
    "TC PRV R12 - RECIBO PROVEEDOR FACT FE-00123 Lopez - NUTRESA S.A.S.",
  );
  assert.ok(payload.Documentos[0].NOTAS.startsWith(referenciaProveedor(12)));
});

test("entrada: con razón social y sede enormes las NOTAS se acotan a 255 y NO pierden la referencia", () => {
  const { payload } = armar({
    recepcion: {
      ...RECEPCION,
      proveedor_razon_social: "RAZON SOCIAL MUY LARGA ".repeat(40),
      sede: { id: 9, nombre: "SEDE ".repeat(80) },
    },
  });
  const notas = payload.Documentos[0].NOTAS;
  assert.ok(notas.length <= 255);
  assert.ok(notas.startsWith("TC PRV R12 - RECIBO PROVEEDOR FACT FE-00123"));
});

// ─── La entrada: bloqueos ───────────────────────────────────────────────────

test("entrada: falta bodega, centro de operación, NIT o fecha → bloqueos que lo dicen", () => {
  const { bloqueos } = armar({
    recepcion: {
      ...RECEPCION,
      bodega_siesa: null,
      codigo_co: "",
      proveedor_nit: "  ",
      fecha_recepcion: null,
    },
  });
  assert.ok(bloqueos.some((b) => /NIT del proveedor/.test(b)));
  assert.ok(bloqueos.some((b) => /bodega de SIESA/.test(b) && b.includes("Lopez")));
  assert.ok(bloqueos.some((b) => /centro de operación/.test(b)));
  assert.ok(bloqueos.some((b) => /fecha de recepción/.test(b)));
});

test("entrada: falta configuración del documento → bloqueo", () => {
  const { bloqueos } = armar({ config: { ...CONFIG, tipoDocto: "" } });
  assert.ok(bloqueos.some((b) => b.startsWith("Falta configurar en SIESA") && b.includes("tipoDocto")));
});

test("entrada: sin renglones con cantidad bloquea", () => {
  const { bloqueos, payload } = armar({ items: [{ ...UNIDADES, cantidad: 0, valor_unitario: null, valor_total: null, valor_fuente: null }] });
  assert.ok(bloqueos.some((b) => /al menos un renglón/.test(b)));
  assert.equal(payload.Movimientos.length, 0);
});

test("entrada: re-corre validarRecepcion completa: 800 KL sin confirmar bloquea", () => {
  const enorme = {
    ...KILOS,
    cantidad: 850,
    valor_unitario: 20000,
    valor_total: 17000000,
    cantidad_devuelta: 0,
    motivo_devolucion: null,
  };
  const { bloqueos } = armar({ items: [enorme] });
  assert.ok(bloqueos.some((b) => /800 KL/.test(b)), bloqueos.join(" | "));

  const confirmada = { ...enorme, exceso_confirmado_cantidad: 850 };
  assert.deepEqual(armar({ items: [confirmada] }).bloqueos, []);
});

test("entrada: valor sin confirmar fuera de rango, renglón sin valor y sin código de item bloquean", () => {
  const barato = { ...KILOS, valor_unitario: 20, valor_total: 2000, cantidad_devuelta: 0, motivo_devolucion: null };
  assert.ok(armar({ items: [barato] }).bloqueos.some((b) => /fuera del rango/.test(b)));

  const sinValor = { ...KILOS, valor_unitario: null, valor_total: null, valor_fuente: null, cantidad_devuelta: 0, motivo_devolucion: null };
  assert.ok(armar({ items: [sinValor] }).bloqueos.some((b) => /Falta el valor/.test(b)));

  const sinItem = { ...KILOS, codigo_item: "", cantidad_devuelta: 0, motivo_devolucion: null };
  assert.ok(armar({ items: [sinItem] }).bloqueos.some((b) => /código de item/.test(b)));
});

test("entrada: no muta la recepción ni los renglones", () => {
  const recepcion = structuredClone(RECEPCION);
  const items = structuredClone([KILOS, UNIDADES]);
  const copia = structuredClone({ recepcion, items });
  armarEntradaProveedor({ recepcion, items, config: CONFIG });
  assert.deepEqual({ recepcion, items }, copia);
});

// ─── La nota crédito ────────────────────────────────────────────────────────

test("nota crédito: con el conector real (258258) no hay bloqueos y NO manda TIPO_DOCTO (CDP es fijo en el conector)", () => {
  const { bloqueos, payload } = armarNotaCreditoProveedor({
    recepcion: RECEPCION,
    items: [KILOS, UNIDADES],
    config: DOCUMENTO_NOTA_CREDITO_PROVEEDOR,
  });
  assert.deepEqual(bloqueos, []);
  assert.equal("TIPO_DOCTO" in payload.Documentos[0], false);
  assert.equal("TIPO_DOCTO" in payload.Movimientos[0], false);
  assert.equal(payload.Movimientos.length, 1);
});

test("nota crédito: sin config ({}) también bloquea por el conector", () => {
  const { bloqueos } = armarNotaCreditoProveedor({ recepcion: RECEPCION, items: [KILOS, UNIDADES] });
  assert.match(bloqueos[0], /Conector de nota crédito no configurado/);
});

test("nota crédito: lleva SOLO lo devuelto, con el valor proporcional", () => {
  const { payload, resumen, bloqueos } = armarNC();
  assert.deepEqual(bloqueos, []);

  assert.deepEqual(payload, {
    Documentos: [
      {
        CONSECUTIVO_DOCTO: "126",
        FECHA: "20260930",
        NIT: "900123456",
        SUCURSAL: "001",
        NOTAS: "TC PRV N12 - DEVOLUCION PROVEEDOR FACT FE-00123 Lopez ENTRADA TC PRV R12 - NUTRESA S.A.S.",
        DOCTO_REFERENCIA: "FE-00123",
      },
    ],
    Movimientos: [
      {
        NRO_DOCTO: "126",
        NRO_REGISTRO: "1",
        BODEGA: "B07",
        CO_MOVIMIENTO: "007",
        UNIDAD_MEDIDA: "KL",
        // 10 de 100 KL devueltos: 10 KL y el 10 % de $2.000.000.
        CANTIDAD: "10.000",
        VALOR_BRUTO: "200000",
        ITEM: "15167",
        UNIDAD_NEGOCIO: "003",
      },
    ],
  });

  assert.equal(resumen.tipo, "nc_proveedor");
  assert.equal(resumen.referencia, "TC PRV N12");
  assert.equal(resumen.referenciaEntrada, "TC PRV R12");
  assert.equal(resumen.renglones, 1);
  assert.equal(resumen.totalKilos, 10);
  assert.equal(resumen.totalValor, 200000);
});

test("nota crédito: sin Descuentos", () => {
  assert.equal("Descuentos" in armarNC().payload, false);
});

test("nota crédito: una devolución en UND usa los decimales de UND", () => {
  const und = { ...UNIDADES, cantidad_devuelta: 2.5, motivo_devolucion: "Roto" };
  const { payload, bloqueos } = armarNC({ items: [und] });
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Movimientos[0].UNIDAD_MEDIDA, "UND");
  assert.equal(payload.Movimientos[0].CANTIDAD, "2.50");
  // 66.000 × 2,5 ÷ 12 = 13.750.
  assert.equal(payload.Movimientos[0].VALOR_BRUTO, "13750");
});

test("nota crédito: sin renglones devueltos bloquea", () => {
  const { bloqueos } = armarNC({ items: [{ ...KILOS, cantidad_devuelta: 0, motivo_devolucion: null }, UNIDADES] });
  assert.ok(bloqueos.some((b) => /no tiene renglones devueltos/.test(b)));
});

test("nota crédito: una devolución mayor a lo recibido o sin motivo bloquea", () => {
  const demasiado = { ...KILOS, cantidad_devuelta: 150 };
  assert.ok(armarNC({ items: [demasiado] }).bloqueos.some((b) => /no puede superar/.test(b)));
  const sinMotivo = { ...KILOS, motivo_devolucion: "" };
  assert.ok(armarNC({ items: [sinMotivo] }).bloqueos.some((b) => /motivo/.test(b)));
});

test("nota crédito: la factura de más de 12 caracteres también bloquea y no se recorta", () => {
  const factura = "FE-1234567890";
  const { bloqueos, payload } = armarNC({ recepcion: { ...RECEPCION, factura } });
  assert.ok(bloqueos.some((b) => b.includes(factura) && /No se recorta/.test(b)));
  assert.equal(payload.Documentos[0].DOCTO_REFERENCIA, factura);
});

test("nota crédito: factura_siesa también es la referencia de la nota", () => {
  const { payload, bloqueos } = armarNC({ recepcion: { ...RECEPCION, factura: "FE-1234567890-A", factura_siesa: "FE123" } });
  assert.deepEqual(bloqueos, []);
  assert.equal(payload.Documentos[0].DOCTO_REFERENCIA, "FE123");
});

// ─── Configuración ──────────────────────────────────────────────────────────

test("config: DOCUMENTO_NOTA_CREDITO_PROVEEDOR apunta al conector 258258 de devoluciones", () => {
  assert.equal(DOCUMENTO_NOTA_CREDITO_PROVEEDOR.idDocumento, "258258");
  assert.equal(DOCUMENTO_NOTA_CREDITO_PROVEEDOR.nombreDocumento, "DEVOLUCIONES_DEV_CARNES");
  assert.equal(DOCUMENTO_NOTA_CREDITO_PROVEEDOR.tipoDocto, "CDP");
  assert.equal(DOCUMENTO_NOTA_CREDITO_PROVEEDOR.unidadNegocio, "003");
  assert.equal(DOCUMENTO_NOTA_CREDITO_PROVEEDOR.decimalesValor, 0);
  assert.equal(bloqueoNotaCreditoProveedor(), null);
});

test("config: sin conector bloquea con un mensaje que dice dónde ponerlo", () => {
  const mensaje = bloqueoNotaCreditoProveedor({ unidadNegocio: "003" });
  assert.match(mensaje, /idDocumento/);
  assert.match(mensaje, /nombreDocumento/);
  assert.match(mensaje, /tipoDocto/);
  assert.match(mensaje, /DOCUMENTO_NOTA_CREDITO_PROVEEDOR/);
});

test("config: con idDocumento, nombreDocumento y tipoDocto el bloqueo desaparece; con uno solo nombra el que falta", () => {
  assert.equal(bloqueoNotaCreditoProveedor(CONFIG_NC), null);
  const parcial = bloqueoNotaCreditoProveedor({ ...CONFIG_NC, nombreDocumento: " " });
  assert.match(parcial, /nombreDocumento/);
  assert.doesNotMatch(parcial, /idDocumento/);
});

test("Talleres intacto: DOCUMENTO_CARNES no cambió y la nota crédito no se cuela en faltantesSiesa", () => {
  assert.equal(DOCUMENTO_CARNES.idDocumento, "256783");
  assert.equal(DOCUMENTO_CARNES.nombreDocumento, "ENTRADA_DIRECTA_ALMACEN");
  assert.equal(DOCUMENTO_CARNES.tipoDocto, "CEA");
  assert.equal(DOCUMENTO_CARNES.nit, "70329554");
  assert.equal(DOCUMENTO_CARNES.decimalesValor, 0);
  assert.equal(faltantesSiesa().some((f) => /NOTA_CREDITO|idDocumento \(src/.test(f)), false);
});

test("siesaEntrada: los helpers exportados se comportan igual que siempre", () => {
  assert.equal(decimal(1234.5, 0), "1235");
  assert.equal(decimal(10.5, 3), "10.500");
  assert.equal(decimal("x", 2), "0.00");
  assert.equal(notasDocumento("A", "B", "C"), "A - B - C");
  assert.equal(notasDocumento("A", "", "C"), "A - C");
  assert.equal(notasDocumento("A".repeat(300), "B", "C").length, 255);
});
