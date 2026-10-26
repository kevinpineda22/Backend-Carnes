import test from "node:test";
import assert from "node:assert/strict";

import { ivaDeLinea, aplicarDescuento, resumenRecepcion } from "../src/shared/proveedorValores.js";
import {
  conSnapshotIva,
  consolidarItems,
  construirSnapshots,
  evaluarCompletitud,
  filaDesdeConnekta,
  huellaFila,
  normalizarCodigoGrupo,
  normalizarCodigoItem,
  planearRefrescoIva,
} from "../src/shared/gruposImpositivos.js";
import { renglonesDesdePlantilla } from "../src/shared/aperturaProveedor.js";
import { planearCorteAdicional } from "../src/shared/cortesAdicionales.js";
import { armarFilaProveedor } from "../src/shared/historialRecibidor.js";
import { armarConfirmacion } from "../src/shared/confirmacionRecepcion.js";
import { ejecutarConsulta, traerTodasLasPaginas } from "../src/services/connekta.service.js";

// IVA por renglón desde el grupo impositivo de SIESA. El valor que digita el
// recibidor es ANTES de IVA; el IVA se calcula sobre el neto (ya descontado), por
// renglón, y `valor_total` en la base sigue siendo el bruto.

const renglon = (id, extra = {}) => ({
  id,
  cantidad: 10,
  unidad: "KL",
  valor_total: 100000,
  cantidad_devuelta: 0,
  descuento_pct: null,
  iva_pct: null,
  ...extra,
});

// ─── ivaDeLinea ────────────────────────────────────────────────────────────

test("ivaDeLinea: 0, 5 y 19 %", () => {
  assert.equal(ivaDeLinea(100000, 0), 0);
  assert.equal(ivaDeLinea(100000, 5), 5000);
  assert.equal(ivaDeLinea(100000, 19), 19000);
});

test("ivaDeLinea: redondea a pesos enteros", () => {
  assert.equal(ivaDeLinea(1001, 19), 190); // 190,19
  assert.equal(ivaDeLinea(1003, 19), 191); // 190,57
  assert.equal(ivaDeLinea(10, 5), 1); // 0,5 -> 1
  assert.equal(ivaDeLinea(9, 5), 0); // 0,45
});

test("ivaDeLinea: iva_pct sin dato, vacío, inválido o negativo no suma", () => {
  for (const p of [null, undefined, "", "  ", "abc", -5, NaN]) {
    assert.equal(ivaDeLinea(100000, p), 0, String(p));
  }
});

test("ivaDeLinea: acepta el porcentaje como texto de la base (NUMERIC llega '19.00')", () => {
  assert.equal(ivaDeLinea(100000, "19.00"), 19000);
});

// ─── resumenRecepcion con IVA ──────────────────────────────────────────────

test("resumenRecepcion: sin IVA en ningún renglón el resumen queda como siempre", () => {
  const r = resumenRecepcion([renglon(1), renglon(2)]);
  assert.equal("iva" in r, false);
  assert.equal("total_con_iva" in r, false);
  assert.equal(r.total, 200000);
});

test("resumenRecepcion: IVA 5 y 19 % mezclados", () => {
  const r = resumenRecepcion([renglon(1, { iva_pct: 5 }), renglon(2, { iva_pct: 19 }), renglon(3, { iva_pct: 0 })]);
  assert.equal(r.total, 300000);
  assert.equal(r.iva, 5000 + 19000);
  assert.equal(r.total_con_iva, 324000);
});

test("resumenRecepcion: el IVA se calcula sobre el neto con el descuento global", () => {
  const r = resumenRecepcion([renglon(1, { valor_total: 1001, iva_pct: 19 })], { descuentoPct: 10 });
  const neto = aplicarDescuento(1001, 10); // 901
  assert.equal(r.total, neto);
  assert.equal(r.iva, Math.round((neto * 19) / 100)); // 171
  assert.equal(r.total_con_iva, neto + 171);
  assert.equal(r.subtotal, 1001);
  assert.equal(r.descuento, 100);
});

test("resumenRecepcion: descuento propio del renglón reemplaza al global y el IVA lo sigue", () => {
  const r = resumenRecepcion(
    [
      renglon(1, { iva_pct: 19 }), // global 5 % -> 95.000
      renglon(2, { iva_pct: 19, descuento_pct: 10 }), // 10 % -> 90.000
      renglon(3, { iva_pct: 19, descuento_pct: 0 }), // sin descuento -> 100.000
    ],
    { descuentoPct: 5 },
  );
  assert.equal(r.total, 95000 + 90000 + 100000);
  assert.equal(r.iva, 18050 + 17100 + 19000);
  assert.equal(r.total_con_iva, r.total + r.iva);
});

test("resumenRecepcion: el IVA se suma renglón por renglón (cada uno redondeado)", () => {
  // 3 renglones de 1001 al 19 %: 190 cada uno = 570 (no round(3003 × 19 %) = 571)
  const r = resumenRecepcion([1, 2, 3].map((id) => renglon(id, { valor_total: 1001, iva_pct: 19 })));
  assert.equal(r.iva, 570);
  assert.equal(r.total_con_iva, 3003 + 570);
});

test("resumenRecepcion: un renglón con iva_pct NULL aporta 0 y no rompe", () => {
  const r = resumenRecepcion([renglon(1, { iva_pct: 19 }), renglon(2, { iva_pct: null })]);
  assert.equal(r.iva, 19000);
  assert.equal(r.total_con_iva, 219000);
});

test("resumenRecepcion: renglones sin cantidad no suman IVA ni lo activan", () => {
  const r = resumenRecepcion([renglon(1, { cantidad: 0, valor_total: null, iva_pct: 19 }), renglon(2)]);
  assert.equal("iva" in r, false);
});

test("resumenRecepcion: cortes adicionales (origen adicional) llevan IVA igual que los de plantilla", () => {
  const r = resumenRecepcion([
    renglon(1, { iva_pct: 0 }),
    renglon(2, { origen: "adicional", iva_pct: 19, descuento_pct: 10 }),
  ]);
  assert.equal(r.iva, Math.round(90000 * 0.19));
  assert.equal(r.total_con_iva, 100000 + 90000 + 17100);
});

// ─── Historial y correo ────────────────────────────────────────────────────

test("armarFilaProveedor: trae iva y total_con_iva; sin IVA el total es el mismo", () => {
  const cabecera = { id: 1, descuento_pct: 0 };
  const con = armarFilaProveedor({ cabecera, items: [renglon(1, { iva_pct: 19 })] });
  assert.equal(con.total, 100000);
  assert.equal(con.iva, 19000);
  assert.equal(con.total_con_iva, 119000);
  const sin = armarFilaProveedor({ cabecera, items: [renglon(1)] });
  assert.equal(sin.iva, 0);
  assert.equal(sin.total_con_iva, 100000);
});

test("confirmación por correo: muestra IVA y total a pagar solo si hay IVA", () => {
  const recepcion = { id: 9, recibido_por: "recibidor@ejemplo.com", proveedor_razon_social: "Prov", factura: "F1", sede: { nombre: "Sede" }, fecha_recepcion: "2026-10-01" };
  const items = [renglon(1, { iva_pct: 19, descripcion_item: "Corte" })];
  const con = armarConfirmacion("proveedor", recepcion, items, resumenRecepcion(items));
  assert.match(con.html, /Total a pagar/);
  const itemsSin = [renglon(1, { descripcion_item: "Corte" })];
  const sin = armarConfirmacion("proveedor", recepcion, itemsSin, resumenRecepcion(itemsSin));
  assert.doesNotMatch(sin.html, /Total a pagar/);
});

// ─── Normalización ─────────────────────────────────────────────────────────

test("normalizarCodigoGrupo: recorta y rellena a 4", () => {
  assert.equal(normalizarCodigoGrupo("007 "), "0007");
  assert.equal(normalizarCodigoGrupo(7), "0007");
  assert.equal(normalizarCodigoGrupo("0001"), "0001");
  assert.equal(normalizarCodigoGrupo("1900"), "1900");
});

test("normalizarCodigoGrupo: vacío o fuera de forma no se adivina", () => {
  for (const v of [null, undefined, "", "  ", "12345", "1 9", "a-b"]) assert.equal(normalizarCodigoGrupo(v), null, String(v));
});

test("normalizarCodigoItem: el número de Connekta pasa a texto", () => {
  assert.equal(normalizarCodigoItem(90), "90");
  assert.equal(normalizarCodigoItem(" 1234 "), "1234");
  assert.equal(normalizarCodigoItem(null), null);
  assert.equal(normalizarCodigoItem(""), null);
});

test("filaDesdeConnekta: toma CodigoItem, IdGrupoImpositivo y DescItem", () => {
  const f = filaDesdeConnekta({
    LineaRegistro: 44,
    Cia: 1,
    CodigoItem: 90,
    Referencia: "A-0000090",
    DescItem: "  AZUCAR  ",
    IdGrupo: "54",
    IdGrupoImpositivo: "0001",
    GrupoImpositivo: "SIN IVA",
  });
  assert.deepEqual(f, { codigo_item: "90", grupo_impositivo: "0001", descripcion_item: "AZUCAR" });
  assert.equal(filaDesdeConnekta({ DescItem: "x" }), null);
  assert.equal(filaDesdeConnekta(null), null);
  assert.equal(filaDesdeConnekta({ CodigoItem: 5, IdGrupoImpositivo: null }).grupo_impositivo, null);
});

// ─── Consolidar y completitud ──────────────────────────────────────────────

test("consolidarItems: una fila por ítem; sin grupo no pisa a con grupo; cuenta repetidas, conflictos e inválidas", () => {
  const { filas, invalidas, repetidas, conflictos } = consolidarItems([
    { CodigoItem: 1, IdGrupoImpositivo: "1900" },
    { CodigoItem: 1, IdGrupoImpositivo: "1900" }, // repetida
    { CodigoItem: 2, IdGrupoImpositivo: null },
    { CodigoItem: 2, IdGrupoImpositivo: "0500" }, // completa al anterior
    { CodigoItem: 3, IdGrupoImpositivo: "0000" },
    { CodigoItem: 3, IdGrupoImpositivo: "1900" }, // conflicto: gana el primero
    { DescItem: "sin código" }, // inválida
  ]);
  const por = Object.fromEntries(filas.map((f) => [f.codigo_item, f.grupo_impositivo]));
  assert.deepEqual(por, { 1: "1900", 2: "0500", 3: "0000" });
  assert.equal(filas.length, 3);
  assert.equal(invalidas, 1);
  assert.equal(repetidas, 3);
  assert.equal(conflictos, 1);
});

test("huellaFila: dos filas con las mismas columnas son la misma sin importar el orden de las llaves", () => {
  assert.equal(huellaFila({ a: 1, b: " x " }), huellaFila({ b: "x", a: "1" }));
  assert.notEqual(huellaFila({ a: 1 }), huellaFila({ a: 2 }));
});

test("evaluarCompletitud: filas repetidas que compensan el conteo bruto NO pasan", () => {
  // Connekta declara 1000; llegaron 1000 filas crudas pero solo 900 distintas.
  const r = evaluarCompletitud({ totalDeclarado: 1000, distintas: 900 });
  assert.equal(r.ok, false);
  assert.match(r.mensaje, /no se escribió nada/);
});

test("evaluarCompletitud: completo, casi completo y sin total declarado", () => {
  assert.equal(evaluarCompletitud({ totalDeclarado: 1000, distintas: 1000 }).ok, true);
  assert.equal(evaluarCompletitud({ totalDeclarado: 1000, distintas: 995 }).ok, true);
  assert.equal(evaluarCompletitud({ totalDeclarado: 0, distintas: 10 }).ok, true);
  assert.equal(evaluarCompletitud({ totalDeclarado: 0, distintas: 0 }).ok, false);
});

// ─── Snapshot ──────────────────────────────────────────────────────────────

const ITEMS = [
  { codigo_item: "10", grupo_impositivo: "1900" },
  { codigo_item: "20", grupo_impositivo: "0000" },
  { codigo_item: "30", grupo_impositivo: "9999" }, // grupo que la tabla no conoce
  { codigo_item: "40", grupo_impositivo: null },
];
const GRUPOS = [
  { codigo: "1900", iva_pct: "19.00" },
  { codigo: "0000", iva_pct: 0 },
];

test("construirSnapshots: tarifa, 0 %, grupo desconocido, sin grupo y ítem ausente", () => {
  const s = construirSnapshots(["10", "20", "30", "40", "50"], ITEMS, GRUPOS);
  assert.deepEqual(s.get("10"), { grupo_impositivo: "1900", iva_pct: 19 });
  assert.deepEqual(s.get("20"), { grupo_impositivo: "0000", iva_pct: 0 }); // 0 % es dato, no "sin dato"
  assert.deepEqual(s.get("30"), { grupo_impositivo: "9999", iva_pct: null });
  assert.deepEqual(s.get("40"), { grupo_impositivo: null, iva_pct: null });
  assert.deepEqual(s.get("50"), { grupo_impositivo: null, iva_pct: null });
});

test("conSnapshotIva: los renglones de la plantilla nacen con grupo e IVA de su ítem", () => {
  const filas = renglonesDesdePlantilla(
    [
      { id: 1, codigo_item: "10", unidad: "KL" },
      { id: 2, codigo_item: "50", unidad: "KL" },
    ],
    77,
  );
  const [con, sin] = conSnapshotIva(filas, construirSnapshots(["10", "50"], ITEMS, GRUPOS));
  assert.equal(con.iva_pct, 19);
  assert.equal(con.grupo_impositivo, "1900");
  assert.equal(sin.iva_pct, null);
  assert.equal(sin.grupo_impositivo, null);
});

test("conSnapshotIva: un corte adicional también lleva el snapshot", () => {
  const plan = planearCorteAdicional({ recepcionId: 5, items: [], corte: { codigo_item: "10", descripcion_item: "X", unidad: "KL" } });
  assert.equal(plan.ok, true);
  const [fila] = conSnapshotIva([plan.fila], construirSnapshots(["10"], ITEMS, GRUPOS));
  assert.equal(fila.origen, "adicional");
  assert.equal(fila.iva_pct, 19);
});

test("planearRefrescoIva: solo los renglones SIN dato, agrupados por grupo y tarifa", () => {
  const snapshots = construirSnapshots(["10", "20", "30", "50"], ITEMS, GRUPOS);
  const plan = planearRefrescoIva(
    [
      { id: 1, codigo_item: "10", grupo_impositivo: null, iva_pct: null },
      { id: 2, codigo_item: "10", grupo_impositivo: null, iva_pct: null },
      { id: 3, codigo_item: "20", grupo_impositivo: null, iva_pct: null },
      { id: 4, codigo_item: "10", grupo_impositivo: "1900", iva_pct: 19 }, // ya tiene dato
      { id: 5, codigo_item: "20", grupo_impositivo: "0000", iva_pct: 0 }, // 0 % ya es dato
      { id: 6, codigo_item: "50", grupo_impositivo: null, iva_pct: null }, // sigue sin respuesta
      { id: 7, codigo_item: "30", grupo_impositivo: null, iva_pct: null }, // grupo desconocido: queda el grupo, sin tarifa
    ],
    snapshots,
  );
  const porGrupo = Object.fromEntries(plan.map((g) => [g.grupo_impositivo, { ids: g.ids, iva_pct: g.iva_pct }]));
  assert.deepEqual(porGrupo, {
    1900: { ids: [1, 2], iva_pct: 19 },
    "0000": { ids: [3], iva_pct: 0 },
    9999: { ids: [7], iva_pct: null },
  });
});

// ─── Cliente de Connekta ───────────────────────────────────────────────────

const CONEXION = { url: "https://ejemplo.test/api/connekta/v3", idCompania: "7375", conniKey: "k", conniToken: "t" };
const SIN_ESPERA = async () => {};

function respuesta(status, cuerpo) {
  const texto = typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo);
  return { ok: status >= 200 && status < 300, status, text: async () => texto };
}

const OK = (datos, extra = {}) =>
  respuesta(200, { codigo: 0, detalle: { Datos: datos, total_registros: 3, "página_actual": 1, "total_páginas": 2, ...extra } });

test("ejecutarConsulta: arma la URL, manda las credenciales y lee la página", async () => {
  let visto;
  const fetchFn = async (url, opciones) => {
    visto = { url, opciones };
    return OK([{ CodigoItem: 1 }]);
  };
  const r = await ejecutarConsulta("merkahorro_items_dev_recibo_machado", 2, 1000, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA });
  assert.match(visto.url, /^https:\/\/ejemplo\.test\/api\/connekta\/v3\/ejecutarconsulta\?/);
  assert.match(visto.url, /idCompania=7375/);
  assert.match(visto.url, /descripcion=merkahorro_items_dev_recibo_machado/);
  assert.match(visto.url, /paginacion=numPag%3D2%7CtamPag%3D1000/);
  assert.equal(visto.opciones.headers.conniKey, "k");
  assert.equal(visto.opciones.headers.conniToken, "t");
  assert.deepEqual(r, { datos: [{ CodigoItem: 1 }], total: 3, pagina: 1, totalPaginas: 2 });
});

test("ejecutarConsulta: reintenta un 500 (deadlock) y después responde", async () => {
  let llamadas = 0;
  const fetchFn = async () => (++llamadas < 3 ? respuesta(500, { detalle: "deadlock" }) : OK([]));
  const r = await ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA });
  assert.equal(llamadas, 3);
  assert.deepEqual(r.datos, []);
});

test("ejecutarConsulta: un 401 no se reintenta", async () => {
  let llamadas = 0;
  const fetchFn = async () => (llamadas++, respuesta(401, { detalle: "no autorizado" }));
  await assert.rejects(
    ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA }),
    (e) => e.statusCode === 502 && /HTTP 401/.test(e.message),
  );
  assert.equal(llamadas, 1);
});

test("ejecutarConsulta: agotados los reintentos lanza con la página que falló", async () => {
  const fetchFn = async () => {
    throw new Error("socket cortado");
  };
  await assert.rejects(
    ejecutarConsulta("q", 7, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA }),
    (e) => e.statusCode === 502 && /página 7/.test(e.message) && /socket cortado/.test(e.message),
  );
});

test("ejecutarConsulta: 'No se encontraron registros' es una página vacía", async () => {
  const fetchFn = async () => respuesta(400, { detalle: "No se encontraron registros" });
  const r = await ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA });
  assert.deepEqual(r.datos, []);
});

test("ejecutarConsulta: un 200 con codigo distinto de 0 es un fallo y no se reintenta", async () => {
  let llamadas = 0;
  const fetchFn = async () => (llamadas++, respuesta(200, { codigo: 1, mensaje: "Consulta inexistente" }));
  await assert.rejects(ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA }), /Consulta inexistente/);
  assert.equal(llamadas, 1);
});

// ─── Presupuesto de tiempo (deadline) ──────────────────────────────────────

test("ejecutarConsulta: con el límite ya vencido no llama a la red y lanza SYNC_TIEMPO_AGOTADO", async () => {
  let llamadas = 0;
  const fetchFn = async () => (llamadas++, OK([]));
  await assert.rejects(
    ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA, limiteAbsoluto: 1000, ahora: () => 5000 }),
    (e) => e.statusCode === 504 && e.codigo === "SYNC_TIEMPO_AGOTADO",
  );
  assert.equal(llamadas, 0);
});

test("ejecutarConsulta: deja de reintentar cuando el límite se vence entre intentos", async () => {
  let reloj = 0;
  let llamadas = 0;
  const fetchFn = async () => (llamadas++, respuesta(500, { detalle: "deadlock" }));
  const dormir = async (ms) => {
    reloj += ms;
  };
  await assert.rejects(
    ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir, limiteAbsoluto: 1500, ahora: () => reloj }),
    (e) => e.codigo === "SYNC_TIEMPO_AGOTADO",
  );
  assert.ok(llamadas >= 1 && llamadas < 4, `llamadas=${llamadas}`);
});

test("ejecutarConsulta: el timeout de cada intento es min(60 s, lo que queda)", async () => {
  const fetchFn = (url, { signal }) =>
    new Promise((_, rechazar) => signal.addEventListener("abort", () => rechazar(Object.assign(new Error("abortado"), { name: "AbortError" }))));
  const inicio = Date.now();
  await assert.rejects(
    ejecutarConsulta("q", 1, 10, { fetchFn, conexion: CONEXION, dormir: SIN_ESPERA, limiteAbsoluto: inicio + 1200 }),
    (e) => e.codigo === "SYNC_TIEMPO_AGOTADO" || /sin respuesta en/.test(e.message),
  );
  assert.ok(Date.now() - inicio < 5000, "no debió esperar los 60 s");
});

test("traerTodasLasPaginas: revisa el límite antes de la página 1", async () => {
  let llamadas = 0;
  const ejecutar = async () => (llamadas++, { datos: [], total: 0, pagina: 1, totalPaginas: 1 });
  await assert.rejects(
    traerTodasLasPaginas("q", 1000, 100, { ejecutar, ahora: () => 500 }),
    (e) => e.statusCode === 504 && e.codigo === "SYNC_TIEMPO_AGOTADO",
  );
  assert.equal(llamadas, 0);
});

test("traerTodasLasPaginas: pasa el límite a cada llamada y corta si se vence a mitad", async () => {
  let reloj = 0;
  const limites = [];
  const ejecutar = async (_d, p, _t, op) => {
    limites.push(op.limiteAbsoluto);
    reloj += 40;
    return { datos: [{ p }], total: 5, pagina: p, totalPaginas: 5 };
  };
  await assert.rejects(
    traerTodasLasPaginas("q", 1000, 100, { ejecutar, ahora: () => reloj, concurrencia: 1 }),
    (e) => e.codigo === "SYNC_TIEMPO_AGOTADO",
  );
  assert.ok(limites.length >= 2 && limites.length < 5);
  assert.ok(limites.every((l) => l === 100));
});

test("traerTodasLasPaginas: dentro del presupuesto junta todas las páginas", async () => {
  const ejecutar = async (_d, p) => ({ datos: [{ p }], total: 3, pagina: p, totalPaginas: 3 });
  const r = await traerTodasLasPaginas("q", 1000, Date.now() + 60_000, { ejecutar });
  assert.equal(r.crudas.length, 3);
  assert.equal(r.totalDeclarado, 3);
});
