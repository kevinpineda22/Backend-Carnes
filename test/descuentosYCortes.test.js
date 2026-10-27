import test from "node:test";
import assert from "node:assert/strict";

import {
  aplicarDescuento,
  parsearPorcentaje,
  pctEfectivo,
  resumenRecepcion,
  validarRenglon,
} from "../src/shared/proveedorValores.js";
import { armarEntradaProveedor, armarNotaCreditoProveedor } from "../src/shared/siesaProveedor.js";
import { decimal } from "../src/shared/siesaEntrada.js";
import { DOCUMENTO_CARNES, DOCUMENTO_NOTA_CREDITO_PROVEEDOR } from "../src/config/siesa.js";
import { MENSAJE_DESCUENTO, planearDescuentoGlobal, planearGuardado } from "../src/shared/guardadoProveedor.js";
import { itemsConDevuelto } from "../src/shared/adminProveedor.js";
import { armarFilaProveedor } from "../src/shared/historialRecibidor.js";
import { armarConfirmacion } from "../src/shared/confirmacionRecepcion.js";
import {
  busquedaValida,
  buscarCorteExacto,
  claveCorte,
  elegirCorte,
  normalizarBusqueda,
  unirCatalogo,
} from "../src/shared/catalogoCortes.js";
import {
  ORDEN_BASE_ADICIONALES,
  decidirQuitarAdicional,
  planearCorteAdicional,
  resultadoQuitarAdicional,
} from "../src/shared/cortesAdicionales.js";
import { planearCorteManual } from "../src/shared/plantillaProveedor.js";
import { validators } from "../src/middleware/validators.js";

// Descuentos dinámicos (global + por corte) y cortes agregados a mano: la regla de
// negocio confirmada es que el porcentaje del renglón REEMPLAZA al global (no se
// apilan) y que `0` en el renglón significa "sin descuento".

const CONFIG = { ...DOCUMENTO_CARNES };
const CONFIG_NC = {
  ...DOCUMENTO_NOTA_CREDITO_PROVEEDOR,
  idDocumento: "999999",
  nombreDocumento: "NOTA_CREDITO_PROVEEDOR_PRUEBA",
  tipoDocto: "NCP",
};

const RECEPCION = {
  id: 12,
  proveedor_nit: "800197463",
  proveedor_sucursal: "001",
  proveedor_razon_social: "POLLOS EL BUCANERO SA",
  factura: "FE-00123",
  factura_siesa: null,
  bodega_siesa: "B07",
  codigo_co: "07",
  fecha_recepcion: "2026-09-30",
  sede_id: 9,
  sede: { id: 9, nombre: "Lopez" },
  descuento_pct: 5,
};

const renglon = (id, extra = {}) => ({
  id,
  codigo_item: String(15000 + id),
  descripcion_item: `ITEM ${id}`,
  unidad: "KL",
  equivalencia: "",
  cantidad: 100,
  valor_unitario: 20000,
  valor_total: 2000000,
  valor_fuente: "unitario",
  cantidad_devuelta: 0,
  motivo_devolucion: null,
  descuento_pct: null,
  ...extra,
});

// ─── pctEfectivo ───────────────────────────────────────────────────────────

test("pctEfectivo: el porcentaje del renglón REEMPLAZA al global (no se suman)", () => {
  assert.equal(pctEfectivo({ descuento_pct: 10 }, { descuento_pct: 5 }), 10);
  assert.equal(pctEfectivo({ descuento_pct: "2.5" }, { descuento_pct: "5.00" }), 2.5);
});

test("pctEfectivo: sin porcentaje propio (null, undefined, vacío) usa el global", () => {
  for (const propio of [null, undefined, "", "  "]) {
    assert.equal(pctEfectivo({ descuento_pct: propio }, { descuento_pct: 5 }), 5, JSON.stringify(propio));
  }
  assert.equal(pctEfectivo(null, { descuento_pct: "5.00" }), 5);
  assert.equal(pctEfectivo({}, { descuento_pct: 5 }), 5);
});

test("pctEfectivo: 0 en el renglón significa SIN descuento aunque haya global", () => {
  assert.equal(pctEfectivo({ descuento_pct: 0 }, { descuento_pct: 5 }), 0);
  assert.equal(pctEfectivo({ descuento_pct: "0" }, { descuento_pct: 5 }), 0);
});

test("pctEfectivo: sin global ni propio es 0; un propio inválido cae al global", () => {
  assert.equal(pctEfectivo({}, {}), 0);
  assert.equal(pctEfectivo(undefined, undefined), 0);
  assert.equal(pctEfectivo({ descuento_pct: "abc" }, { descuento_pct: 5 }), 5);
  assert.equal(pctEfectivo({ descuento_pct: -3 }, { descuento_pct: 5 }), 5);
  assert.equal(pctEfectivo({ descuento_pct: null }, { descuento_pct: "x" }), 0);
});

// ─── parsearPorcentaje ─────────────────────────────────────────────────────

test("parsearPorcentaje: 0 <= p < 100 con hasta 2 decimales, coma o punto", () => {
  const validos = [
    [0, 0],
    ["0", 0],
    [5, 5],
    ["5", 5],
    ["5,5", 5.5],
    ["5.25", 5.25],
    [99.99, 99.99],
    ["99,99", 99.99],
    [" 7 ", 7],
  ];
  for (const [entrada, esperado] of validos) assert.equal(parsearPorcentaje(entrada), esperado, String(entrada));
});

test("parsearPorcentaje: rechaza fuera de rango, más de 2 decimales y basura", () => {
  const invalidos = [100, "100", 150, -1, "-1", "5.123", 5.123, "abc", "", "  ", "5%", "1.000", null, undefined, NaN, Infinity, {}, "5,"];
  for (const entrada of invalidos) assert.equal(parsearPorcentaje(entrada), null, String(entrada));
});

// ─── resumenRecepcion con descuentos mixtos ────────────────────────────────

test("resumenRecepcion: global + propio por renglón, cada uno redondeado por línea", () => {
  const items = [
    renglon(1), // 2.000.000 al global 5 % → 1.900.000
    renglon(2, { valor_total: 1001, cantidad: 1, descuento_pct: 10 }), // 1001 al 10 % → 901
    renglon(3, { valor_total: 1001, cantidad: 1, descuento_pct: 0 }), // exento → 1001
  ];
  const r = resumenRecepcion(items, { descuentoPct: 5 });
  assert.equal(r.total, 1900000 + 901 + 1001);
  assert.equal(r.subtotal, 2000000 + 1001 + 1001);
  assert.equal(r.descuento, r.subtotal - r.total);
  assert.equal(r.descuento_pct, 5);
  assert.equal(r.descuento_variable, true);
});

test("resumenRecepcion: sin porcentajes propios no marca descuento_variable", () => {
  const r = resumenRecepcion([renglon(1), renglon(2)], { descuentoPct: 5 });
  assert.equal("descuento_variable" in r, false);
  assert.equal(r.total, 3800000);
});

test("resumenRecepcion: global 0 con descuento solo en un renglón agrega subtotal y descuento", () => {
  const r = resumenRecepcion([renglon(1), renglon(2, { descuento_pct: 10 })], { descuentoPct: 0 });
  assert.equal(r.total, 2000000 + 1800000);
  assert.equal(r.subtotal, 4000000);
  assert.equal(r.descuento, 200000);
  assert.equal(r.descuento_pct, 0);
  assert.equal(r.descuento_variable, true);
});

test("resumenRecepcion: el descuento de lo devuelto usa el porcentaje efectivo del renglón", () => {
  const r = resumenRecepcion(
    [renglon(1, { cantidad_devuelta: 10, motivo_devolucion: "x", descuento_pct: 10 })],
    { descuentoPct: 5 },
  );
  // 10 de 100 sobre 2.000.000 = 200.000 → al 10 % (no al 5 %) = 180.000.
  assert.equal(r.total_devuelto, 180000);
});

test("resumenRecepcion: un renglón sin cantidad no cuenta aunque tenga porcentaje propio", () => {
  const r = resumenRecepcion([renglon(1), renglon(2, { cantidad: 0, valor_total: null, descuento_pct: 50 })], {
    descuentoPct: 5,
  });
  assert.equal(r.renglones, 1);
  assert.equal("descuento_variable" in r, false);
});

// ─── SIESA: entrada y nota crédito con descuentos mixtos ───────────────────

test("entrada SIESA: cada VALOR_BRUTO lleva SU porcentaje efectivo (propio reemplaza, 0 exime, null usa el global)", () => {
  const items = [
    renglon(1), // global 5 % → 1.900.000
    renglon(2, { descuento_pct: 10 }), // 10 % → 1.800.000 (no 15 %)
    renglon(3, { descuento_pct: 0 }), // sin descuento → 2.000.000
  ];
  const { payload, resumen, bloqueos } = armarEntradaProveedor({ recepcion: RECEPCION, items, config: CONFIG });
  assert.deepEqual(bloqueos, []);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.VALOR_BRUTO),
    [decimal(1900000, 0), decimal(1800000, 0), decimal(2000000, 0)],
  );
  assert.equal(resumen.totalValor, 5700000);
});

test("entrada SIESA: lo que viaja coincide con el resumen que ve el recibidor", () => {
  const items = [renglon(1, { valor_total: 1001, cantidad: 1, valor_unitario: 1001 }), renglon(2, { descuento_pct: 12.5 })];
  const { resumen } = armarEntradaProveedor({ recepcion: RECEPCION, items, config: CONFIG });
  assert.equal(resumen.totalValor, resumenRecepcion(items, { descuentoPct: 5 }).total);
});

test("entrada SIESA: un porcentaje propio con global 0 también descuenta", () => {
  const { payload } = armarEntradaProveedor({
    recepcion: { ...RECEPCION, descuento_pct: 0 },
    items: [renglon(1), renglon(2, { descuento_pct: 10 })],
    config: CONFIG,
  });
  assert.deepEqual(
    payload.Movimientos.map((m) => m.VALOR_BRUTO),
    [decimal(2000000, 0), decimal(1800000, 0)],
  );
});

test("entrada SIESA: un renglón con porcentaje propio inválido bloquea el envío", () => {
  const { bloqueos } = armarEntradaProveedor({
    recepcion: RECEPCION,
    items: [renglon(1, { descuento_pct: 100 })],
    config: CONFIG,
  });
  assert.ok(bloqueos.some((b) => /descuento/i.test(b)), bloqueos.join(" | "));
});

test("nota crédito SIESA: lo devuelto se descuenta con el porcentaje efectivo de cada renglón", () => {
  const dev = { cantidad_devuelta: 10, motivo_devolucion: "Mal estado" };
  const items = [
    renglon(1, dev), // 200.000 al global 5 % → 190.000
    renglon(2, { ...dev, descuento_pct: 10 }), // 200.000 al 10 % → 180.000
    renglon(3, { ...dev, descuento_pct: 0 }), // 200.000 sin descuento
    renglon(4), // sin devolución: no viaja
  ];
  const { payload, resumen, bloqueos } = armarNotaCreditoProveedor({ recepcion: RECEPCION, items, config: CONFIG_NC });
  assert.deepEqual(bloqueos, []);
  assert.deepEqual(
    payload.Movimientos.map((m) => m.VALOR_BRUTO),
    [decimal(190000, 0), decimal(180000, 0), decimal(200000, 0)],
  );
  assert.equal(resumen.totalValor, 570000);
  assert.equal(resumen.totalValor, resumenRecepcion(items, { descuentoPct: 5 }).total_devuelto);
});

// ─── Cortes adicionales en SIESA ───────────────────────────────────────────

test("entrada y nota crédito SIESA incluyen los cortes adicionales como cualquier otro renglón", () => {
  const adicional = renglon(9, {
    origen: "adicional",
    equivalencia_id: null,
    seccion: "",
    codigo_item: "20999",
    cantidad_devuelta: 5,
    motivo_devolucion: "Golpeado",
    descuento_pct: 20,
  });
  const entrada = armarEntradaProveedor({ recepcion: RECEPCION, items: [renglon(1), adicional], config: CONFIG });
  assert.deepEqual(entrada.bloqueos, []);
  assert.equal(entrada.payload.Movimientos.length, 2);
  assert.equal(entrada.payload.Movimientos[1].ITEM, "20999");
  assert.equal(entrada.payload.Movimientos[1].VALOR_BRUTO, decimal(1600000, 0)); // 2.000.000 al 20 %

  const nc = armarNotaCreditoProveedor({ recepcion: RECEPCION, items: [renglon(1), adicional], config: CONFIG_NC });
  assert.deepEqual(nc.bloqueos, []);
  assert.equal(nc.payload.Movimientos.length, 1);
  assert.equal(nc.payload.Movimientos[0].ITEM, "20999");
  assert.equal(nc.payload.Movimientos[0].VALOR_BRUTO, decimal(80000, 0)); // 5 de 100 = 100.000 al 20 %
});

// ─── Validación del renglón ────────────────────────────────────────────────

test("validarRenglon: el porcentaje propio debe ser de 0 a menos de 100 con 2 decimales", () => {
  assert.deepEqual(validarRenglon(renglon(1, { descuento_pct: 10 })), []);
  assert.deepEqual(validarRenglon(renglon(1, { descuento_pct: 0 })), []);
  assert.deepEqual(validarRenglon(renglon(1, { descuento_pct: null })), []);
  for (const malo of [100, -1, 5.123, "abc"]) {
    const errores = validarRenglon(renglon(1, { descuento_pct: malo }));
    assert.ok(errores.some((e) => /descuento/i.test(e)), `${malo}: ${errores.join(" | ")}`);
  }
});

// ─── Autoguardado: descuentos ──────────────────────────────────────────────

const AHORA = "2026-09-30T15:00:00.000Z";
const plan = (items, entradas) => planearGuardado({ items, entradas, por: "r@merkahorro.com", ahora: AHORA });
const baseItem = (extra = {}) => ({
  id: 1,
  codigo_item: "1234",
  unidad: "KL",
  cantidad: 0,
  valor_unitario: null,
  valor_total: null,
  valor_fuente: null,
  cantidad_devuelta: 0,
  motivo_devolucion: null,
  descuento_pct: null,
  updated_at: "2026-09-30T14:00:00.123456+00:00",
  ...extra,
});

test("guardado: un porcentaje propio válido se escribe (coma o punto, número o texto)", () => {
  for (const [entrada, esperado] of [["10", 10], ["7,5", 7.5], [12.25, 12.25], ["0", 0]]) {
    const p = plan([baseItem()], [{ id: 1, descuento_pct: entrada }]);
    assert.equal(p.actualizaciones[0].cambios.descuento_pct, esperado, String(entrada));
    assert.deepEqual(p.rechazos, []);
  }
});

test("guardado: null o vacío QUITA el porcentaje propio (vuelve al global)", () => {
  for (const vacio of [null, "", "  "]) {
    const p = plan([baseItem({ descuento_pct: "10.00" })], [{ id: 1, descuento_pct: vacio }]);
    assert.equal(p.actualizaciones[0].cambios.descuento_pct, null, JSON.stringify(vacio));
  }
});

test("guardado: sin cambio de porcentaje no hay escritura (10 vs '10.00' es lo mismo)", () => {
  assert.equal(plan([baseItem({ descuento_pct: "10.00" })], [{ id: 1, descuento_pct: 10 }]).actualizaciones.length, 0);
  assert.equal(plan([baseItem()], [{ id: 1, descuento_pct: null }]).actualizaciones.length, 0);
  assert.equal(plan([baseItem()], [{ id: 1 }]).actualizaciones.length, 0);
});

test("guardado: un porcentaje propio inválido se rechaza solo a él y vuelve en pendientes", () => {
  for (const malo of ["100", 100, "-5", "abc", "5.123", 150]) {
    const p = plan([baseItem(), baseItem({ id: 2 })], [
      { id: 1, descuento_pct: malo },
      { id: 2, cantidad: "3" },
    ]);
    assert.equal(p.rechazos[0].tipo, "descuento_invalido", String(malo));
    assert.equal(p.rechazos[0].item_id, 1);
    assert.equal(p.actualizaciones.find((a) => a.id === 1), undefined);
    assert.equal(p.actualizaciones.find((a) => a.id === 2).cambios.cantidad, 3); // lo demás se guarda
  }
});

test("guardado: el descuento global se valida igual (rango, decimales) y no cambia si es el mismo", () => {
  assert.deepEqual(planearDescuentoGlobal({ actual: "5.00", entrada: undefined }), { cambio: null, rechazo: null });
  assert.deepEqual(planearDescuentoGlobal({ actual: "5.00", entrada: "5" }), { cambio: null, rechazo: null });
  assert.deepEqual(planearDescuentoGlobal({ actual: "5.00", entrada: "7,5" }), { cambio: 7.5, rechazo: null });
  assert.deepEqual(planearDescuentoGlobal({ actual: 5, entrada: 0 }), { cambio: 0, rechazo: null });
  // Vacío en el global es 0: sin descuento.
  assert.deepEqual(planearDescuentoGlobal({ actual: 5, entrada: "" }), { cambio: 0, rechazo: null });
  assert.deepEqual(planearDescuentoGlobal({ actual: 5, entrada: null }), { cambio: 0, rechazo: null });
  assert.deepEqual(planearDescuentoGlobal({ actual: 0, entrada: "  " }), { cambio: null, rechazo: null });
  for (const malo of [100, "100", -1, "abc", 5.123]) {
    const r = planearDescuentoGlobal({ actual: 5, entrada: malo });
    assert.equal(r.cambio, null, String(malo));
    assert.equal(r.rechazo.tipo, "descuento_invalido");
    assert.equal(r.rechazo.item_id, null);
    assert.equal(r.rechazo.mensaje, MENSAJE_DESCUENTO);
  }
});

// ─── Admin, historial y correo ─────────────────────────────────────────────

test("admin: cada renglón trae su porcentaje efectivo y su valor devuelto neto", () => {
  const dev = { cantidad_devuelta: 10, motivo_devolucion: "x" };
  const items = itemsConDevuelto([renglon(1, dev), renglon(2, { ...dev, descuento_pct: 10 })], { descuentoPct: 5 });
  assert.deepEqual(
    items.map((i) => [i.descuento_pct_efectivo, i.valor_devuelto]),
    [[5, 190000], [10, 180000]],
  );
});

test("historial: el total de la fila usa los porcentajes por renglón", () => {
  const fila = armarFilaProveedor({
    cabecera: { id: 1, descuento_pct: "5.00", sede: { nombre: "Lopez" } },
    items: [renglon(1), renglon(2, { descuento_pct: 10 })],
  });
  assert.equal(fila.total, 1900000 + 1800000);
  assert.equal(fila.descuento_pct, 5);
});

test("correo: con descuentos por corte muestra la columna Desc. y la etiqueta sin porcentaje único", () => {
  const items = [renglon(1), renglon(2, { descuento_pct: 10 }), renglon(3, { descuento_pct: 0 })];
  const resumen = resumenRecepcion(items, { descuentoPct: 5 });
  const correo = armarConfirmacion(
    "proveedor",
    { id: 1, recibido_por: "r@merkahorro.com", descuento_pct: 5, sede: { nombre: "Lopez" } },
    items,
    resumen,
  );
  assert.match(correo.html, /Desc\./);
  assert.match(correo.html, />5%</);
  assert.match(correo.html, />10%</);
  assert.match(correo.html, />—</);
  assert.doesNotMatch(correo.html, /Descuento \(/);
});

test("correo: con descuento global único conserva la etiqueta con su porcentaje", () => {
  const items = [renglon(1)];
  const correo = armarConfirmacion(
    "proveedor",
    { id: 1, recibido_por: "r@merkahorro.com", descuento_pct: 5, sede: { nombre: "Lopez" } },
    items,
    resumenRecepcion(items, { descuentoPct: 5 }),
  );
  assert.match(correo.html, /Descuento \(5%\)/);
});

test("aplicarDescuento sigue redondeando por renglón con el porcentaje efectivo", () => {
  assert.equal(aplicarDescuento(1001, pctEfectivo({ descuento_pct: 10 }, { descuento_pct: 5 })), 901);
});

// ─── Catálogo de cortes ────────────────────────────────────────────────────

test("normalizarBusqueda: deja letras, números y . - / ; quita comodines y separadores del filtro", () => {
  assert.equal(normalizarBusqueda("  pollo,(entero)%_* "), "pollo entero");
  assert.equal(normalizarBusqueda("15134"), "15134");
  assert.equal(normalizarBusqueda("Ñandú 1/2-kg."), "Ñandú 1/2-kg.");
  assert.equal(normalizarBusqueda(null), "");
  assert.equal(normalizarBusqueda("x".repeat(100)).length, 60);
});

test("busquedaValida: mínimo 2 caracteres ya saneados", () => {
  assert.equal(busquedaValida("a"), false);
  assert.equal(busquedaValida(" a% "), false);
  assert.equal(busquedaValida("ab"), true);
});

const FUENTES = {
  plantilla: [
    { codigo_item: "15167", descripcion: "CARNE PARA MOLER" },
    { codigo_item: "15167", descripcion: "COGOTE" },
  ],
  viceras: [
    { codigo_item: "30010", nombre: "Hígado", unidad: "KL" },
    { codigo_item: "30011", nombre: "Riñón", unidad: "UND" },
    { codigo_item: null, nombre: "Entrañita", unidad: "KL" },
  ],
  equivalencias: [
    { codigo_item: "15167", descripcion_item: "MOLIDA", unidad: "KL" },
    { codigo_item: "15167", descripcion_item: "MOLIDA UND", unidad: "UND" },
    { codigo_item: "20412", descripcion_item: "CHORIZO X UND", unidad: "UND" },
    { codigo_item: "20412", descripcion_item: "CHORIZO X UND", unidad: "UND" },
    { codigo_item: "99999", descripcion_item: "LIBRAS", unidad: "LB" },
  ],
};

test("unirCatalogo: une las fuentes, quita repetidos (gana la de mayor prioridad) y descarta unidades inválidas", () => {
  const lista = unirCatalogo(FUENTES);
  const claves = lista.map(claveCorte);
  assert.equal(new Set(claves).size, claves.length);
  assert.ok(claves.includes("15167|KL") && claves.includes("15167|UND") && claves.includes("20412|UND"));
  assert.ok(!claves.some((c) => c.startsWith("99999")));
  assert.ok(!lista.some((c) => c.descripcion_item === "Entrañita")); // sin código
  assert.equal(lista.find((c) => claveCorte(c) === "15167|KL").descripcion_item, "CARNE PARA MOLER");
  assert.equal(lista.find((c) => claveCorte(c) === "30011|UND").unidad, "UND");
});

test("unirCatalogo: con búsqueda, el código exacto va primero y respeta el límite", () => {
  const lista = unirCatalogo(FUENTES, { q: "20412" });
  assert.equal(lista[0].codigo_item, "20412");
  assert.equal(unirCatalogo(FUENTES, { q: "a", limite: 2 }).length, 2);
});

test("buscarCorteExacto: encuentra por código + unidad y devuelve null si no existe", () => {
  assert.equal(buscarCorteExacto(FUENTES, { codigo_item: " 20412 ", unidad: "und" }).descripcion_item, "CHORIZO X UND");
  assert.equal(buscarCorteExacto(FUENTES, { codigo_item: "20412", unidad: "KL" }), null);
  assert.equal(buscarCorteExacto(FUENTES, { codigo_item: "00000", unidad: "KL" }), null);
});

test("elegirCorte: lo que se guarda es el código y la descripción que se vieron en la búsqueda", () => {
  // Buscar «cogote» muestra la fila COGOTE (15167·KL); el catálogo completo dedupe a «CARNE PARA MOLER».
  const visto = unirCatalogo({ plantilla: [FUENTES.plantilla[1]] }, { q: "cogote" })[0];
  assert.equal(visto.descripcion_item, "COGOTE");
  const guardado = elegirCorte(FUENTES, visto);
  assert.equal(guardado.codigo_item, visto.codigo_item);
  assert.equal(guardado.descripcion_item, visto.descripcion_item);
  assert.equal(guardado.unidad, visto.unidad);
});

test("elegirCorte: sin descripción, o con una que no existe en el catálogo, gana la de mayor prioridad", () => {
  assert.equal(elegirCorte(FUENTES, { codigo_item: "15167", unidad: "KL" }).descripcion_item, "CARNE PARA MOLER");
  assert.equal(
    elegirCorte(FUENTES, { codigo_item: "15167", unidad: "KL", descripcion_item: "INVENTADA" }).descripcion_item,
    "CARNE PARA MOLER",
  );
  // Una descripción de OTRA unidad no sirve: la llave es código + unidad.
  assert.equal(
    elegirCorte(FUENTES, { codigo_item: "15167", unidad: "KL", descripcion_item: "MOLIDA UND" }).descripcion_item,
    "CARNE PARA MOLER",
  );
});

test("elegirCorte: respeta código recortado, unidad normalizada y devuelve null si el corte no existe", () => {
  const c = elegirCorte(FUENTES, { codigo_item: " 15167 ", unidad: "kg", descripcion_item: " MOLIDA " });
  assert.deepEqual(c, { codigo_item: "15167", descripcion_item: "MOLIDA", unidad: "KL" });
  assert.equal(elegirCorte(FUENTES, { codigo_item: "00000", unidad: "KL", descripcion_item: "X" }), null);
});

// ─── Cortes adicionales ────────────────────────────────────────────────────

const CORTE = { codigo_item: "20999", descripcion_item: "CORTE NUEVO", unidad: "KL" };

test("planearCorteAdicional: crea un renglón sin sección, sin equivalencia y marcado como adicional", () => {
  const p = planearCorteAdicional({ recepcionId: 7, items: [renglon(1, { seccion: "despresado", origen: "plantilla" })], corte: CORTE });
  assert.equal(p.ok, true);
  assert.deepEqual(p.fila, {
    recepcion_id: 7,
    equivalencia_id: null,
    codigo_item: "20999",
    descripcion_item: "CORTE NUEVO",
    unidad: "KL",
    equivalencia: "",
    orden: ORDEN_BASE_ADICIONALES,
    seccion: "",
    origen: "adicional",
  });
});

test("planearCorteAdicional: los adicionales van después de la plantilla y en el orden en que se agregan", () => {
  const items = [renglon(1), renglon(2, { origen: "adicional", codigo_item: "1" })];
  const p = planearCorteAdicional({ recepcionId: 7, items, corte: CORTE });
  assert.equal(p.fila.orden, ORDEN_BASE_ADICIONALES + 1);
});

test("planearCorteAdicional: rechaza un corte que ya está en la recepción, en cualquier sección", () => {
  const enPlantilla = renglon(1, { codigo_item: "20999", seccion: "sin_despresar", origen: "plantilla" });
  const a = planearCorteAdicional({ recepcionId: 7, items: [enPlantilla], corte: CORTE });
  assert.equal(a.ok, false);
  assert.equal(a.status, 409);
  assert.equal(a.codigo, "CORTE_YA_EXISTE");
  assert.match(a.mensaje, /lista de la recepción/);

  const enAdicionales = renglon(2, { codigo_item: "20999", origen: "adicional" });
  const b = planearCorteAdicional({ recepcionId: 7, items: [enAdicionales], corte: CORTE });
  assert.equal(b.ok, false);
  assert.match(b.mensaje, /cortes adicionales/);
});

test("planearCorteAdicional: el mismo código en otra unidad SÍ se puede agregar", () => {
  const p = planearCorteAdicional({ recepcionId: 7, items: [renglon(1, { codigo_item: "20999", unidad: "UND" })], corte: CORTE });
  assert.equal(p.ok, true);
});

test("decidirQuitarAdicional: solo se quita un adicional; la plantilla y lo inexistente se rechazan", () => {
  assert.deepEqual(decidirQuitarAdicional(renglon(1, { origen: "adicional" })), { ok: true });
  const plantilla = decidirQuitarAdicional(renglon(1, { origen: "plantilla" }));
  assert.equal(plantilla.ok, false);
  assert.equal(plantilla.status, 409);
  const ninguno = decidirQuitarAdicional(undefined);
  assert.equal(ninguno.ok, false);
  assert.equal(ninguno.status, 404);
});

// ─── "Agregar corte" a la plantilla del proveedor ──────────────────────────

const existentePlantilla = (id, codigo, unidad, equivalencia, activo = true, orden = id) => ({
  id,
  codigo_item: codigo,
  descripcion_item: `ITEM ${codigo}`,
  unidad,
  equivalencia,
  orden,
  activo,
});

test("planearCorteManual: crea la fila al final de la plantilla, sin equivalencia", () => {
  const p = planearCorteManual({
    existentes: [existentePlantilla(1, "100", "KL", "A", true, 1), existentePlantilla(2, "101", "KL", "", false, 7)],
    corte: CORTE,
  });
  assert.equal(p.accion, "crear");
  assert.deepEqual(p.fila, {
    codigo_item: "20999",
    descripcion_item: "CORTE NUEVO",
    unidad: "KL",
    equivalencia: "",
    orden: 8,
    activo: true,
  });
});

test("planearCorteManual: rechaza el duplicado activo (con cualquier equivalencia)", () => {
  for (const equivalencia of ["", "Otro nombre"]) {
    const p = planearCorteManual({ existentes: [existentePlantilla(1, "20999", "KL", equivalencia)], corte: CORTE });
    assert.equal(p.accion, "duplicado", equivalencia);
  }
});

test("planearCorteManual: el mismo código en otra unidad no es duplicado", () => {
  const p = planearCorteManual({ existentes: [existentePlantilla(1, "20999", "UND", "")], corte: CORTE });
  assert.equal(p.accion, "crear");
});

test("planearCorteManual: una fila inactiva con la llave exacta se reactiva en vez de chocar con el UNIQUE", () => {
  const p = planearCorteManual({ existentes: [existentePlantilla(5, "20999", "KL", "", false, 3)], corte: CORTE });
  assert.equal(p.accion, "reactivar");
  assert.equal(p.id, 5);
  assert.equal(p.orden, 4);
});

test("planearCorteManual: una inactiva con otra equivalencia no se reutiliza: se crea una nueva", () => {
  const p = planearCorteManual({ existentes: [existentePlantilla(5, "20999", "KL", "Vieja", false)], corte: CORTE });
  assert.equal(p.accion, "crear");
});

test("planearCorteManual: plantilla vacía arranca en orden 1", () => {
  assert.equal(planearCorteManual({ existentes: [], corte: CORTE }).fila.orden, 1);
});

// ─── Validadores ───────────────────────────────────────────────────────────

const CORREO = "recibidor@merkahorro.com";

/** Corre un middleware de validación y devuelve `{ error, body, datos }`. */
function correr(middleware, entrada, fuente = "body") {
  const req = { [fuente]: entrada };
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body, datos: req.datosValidados };
}

test("validador buscarCortes: sanea el texto y exige 2 caracteres", () => {
  const ok = correr(validators.buscarCortes, { q: "  pollo,(x) " }, "query");
  assert.equal(ok.error, undefined);
  assert.equal(ok.datos.q, "pollo x");
  assert.equal(correr(validators.buscarCortes, { q: "a" }, "query").error?.statusCode, 400);
  assert.equal(correr(validators.buscarCortes, { q: "%_" }, "query").error?.statusCode, 400);
  assert.equal(correr(validators.buscarCortes, {}, "query").error?.statusCode, 400);
  assert.equal(correr(validators.buscarCortes, { q: "pollo", limite: "500" }, "query").error?.statusCode, 400);
});

test("validador agregarCorteProveedor: código (texto o número) y unidad KL/UND", () => {
  const ok = correr(validators.agregarCorteProveedor, { por: CORREO, codigo_item: 15134, unidad: "kg" });
  assert.equal(ok.error, undefined);
  assert.equal(ok.body.codigo_item, "15134");
  assert.equal(ok.body.unidad, "KL");
  const malos = [
    { por: CORREO, unidad: "KL" },
    { por: CORREO, codigo_item: "  ", unidad: "KL" },
    { por: CORREO, codigo_item: "1", unidad: "LB" },
    { por: CORREO, codigo_item: "1" },
    { por: CORREO, codigo_item: "1".repeat(21), unidad: "KL" },
    { por: "no-es-correo", codigo_item: "1", unidad: "KL" },
  ];
  for (const body of malos) assert.equal(correr(validators.agregarCorteProveedor, body).error?.statusCode, 400, JSON.stringify(body));
});

test("validadores de agregar corte: la descripción es opcional y se recorta", () => {
  const body = { editado_por: CORREO, codigo_item: "20999", unidad: "KL", descripcion_item: "  COGOTE " };
  assert.equal(correr(validators.agregarCorteAdicional, body).body.descripcion_item, "COGOTE");
  assert.equal(correr(validators.agregarCorteAdicional, { ...body, descripcion_item: 5 }).error?.statusCode, 400);
  assert.equal(correr(validators.agregarCorteProveedor, { por: CORREO, codigo_item: "1", unidad: "KL" }).error, undefined);
  // La búsqueda devuelve null en filas sin descripción y el cliente lo reenvía tal cual.
  assert.equal(correr(validators.agregarCorteAdicional, { ...body, descripcion_item: null }).error, undefined);
  assert.equal(correr(validators.agregarCorteProveedor, { por: CORREO, codigo_item: "1", unidad: "KL", descripcion_item: null }).error, undefined);
  assert.equal(correr(validators.agregarCorteAdicional, { ...body, descripcion_item: "x".repeat(1001) }).error?.statusCode, 400);
});

test("elegirCorte: una descripción cortada en 160 que termina en espacio sigue coincidiendo", () => {
  const larga = `${"A".repeat(159)} RESTO`;
  const fuentes = { plantilla: [{ codigo_item: "777", descripcion: larga }] };
  const visto = unirCatalogo(fuentes, {})[0];
  assert.equal(visto.descripcion_item, "A".repeat(159));
  assert.equal(elegirCorte(fuentes, visto).descripcion_item, visto.descripcion_item);
});

test("validador agregarCorteAdicional: pide quién edita, código y unidad", () => {
  assert.equal(correr(validators.agregarCorteAdicional, { editado_por: CORREO, codigo_item: "20999", unidad: "UND" }).error, undefined);
  assert.equal(correr(validators.agregarCorteAdicional, { codigo_item: "20999", unidad: "UND" }).error?.statusCode, 400);
});

test("validador corteAdicionalParams: ids positivos", () => {
  const ok = correr(validators.corteAdicionalParams, { id: "4", item_id: "9" }, "params");
  assert.deepEqual([ok.error, ok.datos], [undefined, { id: 4, item_id: 9 }]);
  assert.equal(correr(validators.corteAdicionalParams, { id: "4", item_id: "0" }, "params").error?.statusCode, 400);
  assert.equal(correr(validators.corteAdicionalParams, { id: "x", item_id: "1" }, "params").error?.statusCode, 400);
});

test("validador guardar: acepta descuento global y por renglón como texto, número o null", () => {
  const { error, body } = correr(validators.guardarRecepcionProveedor, {
    editado_por: CORREO,
    descuento_pct: "7,5",
    items: [
      { id: 1, descuento_pct: 10 },
      { id: 2, descuento_pct: "" },
      { id: 3, descuento_pct: null },
      { id: 4 },
    ],
  });
  assert.equal(error, undefined);
  assert.equal(body.descuento_pct, "7,5");
  assert.equal(body.items[0].descuento_pct, 10);
  assert.equal(body.items[2].descuento_pct, null);
});

test("validador guardar: rechaza un descuento que no es texto ni número", () => {
  const { error } = correr(validators.guardarRecepcionProveedor, {
    editado_por: CORREO,
    items: [{ id: 1, descuento_pct: { pct: 5 } }],
  });
  assert.equal(error?.statusCode, 400);
});

// ─── Quitar atómico (función SQL) y descripción larga ──────────────────────

test("resultadoQuitarAdicional: traduce cada código de la función SQL a su HTTP", () => {
  assert.deepEqual(resultadoQuitarAdicional("ok"), { ok: true });
  const casos = [
    ["no_borrador", 409, "RECEPCION_NO_BORRADOR"],
    ["no_adicional", 409, "CORTE_DE_PLANTILLA"],
    ["no_recepcion", 404, "RECEPCION_NO_ENCONTRADA"],
    ["no_item", 404, "CORTE_NO_ENCONTRADO"],
    ["algo_raro", 500, "RESPUESTA_INESPERADA"],
    [null, 500, "RESPUESTA_INESPERADA"],
  ];
  for (const [codigo, status, esperado] of casos) {
    const r = resultadoQuitarAdicional(codigo);
    assert.equal(r.ok, false, String(codigo));
    assert.equal(r.status, status, String(codigo));
    assert.equal(r.codigo, esperado, String(codigo));
  }
});

test("unirCatalogo: la descripción se trunca a 160 caracteres (VARCHAR(160))", () => {
  const [c] = unirCatalogo({ equivalencias: [{ codigo_item: "1", descripcion_item: "x".repeat(300), unidad: "KL" }] });
  assert.equal(c.descripcion_item.length, 160);
});
