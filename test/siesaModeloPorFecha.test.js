// Flujo de enviarOficial / enviarAjusteVisceras con supabase y SIESA FALSOS: nada sale a
// la red. Un documento por fecha de ingreso (sql/033): envío parcial, reintento, cierre.
//
// El select falso devuelve SOLO las columnas pedidas (como PostgREST): si el modelo
// olvida pedir una columna que la lógica necesita (p. ej. fecha_docto), el test falla.
// Usa mock.module: npm test corre con --experimental-test-module-mocks.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.CARNES_SIESA_ACTIVO = "true";
process.env.CONNEKTA_BASE_URL = "http://fake.invalid/api/connekta/v3";
process.env.CONNEKTA_ID_COMPANIA = "1";
process.env.CONNI_KEY = "k";
process.env.CONNI_TOKEN = "t";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

// ─── Base falsa ───
const db = {};
const reiniciar = () => {
  db.carnes_liquidaciones = [{ id: 6, estado: "Costeada", especie: "res", siesa_nit: null, siesa_sucursal: null }];
  const sede = (id, n, b, co) => ({ id, nombre: n, bodega_siesa: b, codigo_co: co });
  db.carnes_recepciones = [
    { id: 2, liquidacion_id: 6, estado: "Costeado", fecha_ingreso: "2026-09-21", sede_id: 2, sede: sede(2, "Barbosa", "00201", "02") },
    { id: 8, liquidacion_id: 6, estado: "Costeado", fecha_ingreso: "2026-09-24", sede_id: 8, sede: sede(8, "Lopez", "00801", "08") },
    { id: 9, liquidacion_id: 6, estado: "Costeado", fecha_ingreso: "2026-09-24", sede_id: 9, sede: sede(9, "Bello", "00901", "09") },
  ];
  const it = (r, cod, c) => ({ id: r * 100 + Number(cod), recepcion_id: r, tipo: "carne", orden: 1, codigo_item: String(cod), descripcion: `C${cod}`, cantidad: c, costo_base: 100, costo_ajustado: 90 });
  db.carnes_recepcion_items = [it(2, 1, 10), it(2, 2, 5), it(8, 1, 4), it(9, 1, 3)];
  seq = 0;
  // Las iniciales que el correo pide anular.
  db.carnes_siesa_envios = [2, 8, 9].map((r) => ({
    id: ++seq, tipo: "inicial", estado: "ok", recepcion_id: r, liquidacion_id: null,
    referencia: `TC INI R${r}`, total_kilos: 10, total_valor: 1000, enviado_at: "2026-09-20T00:00:00Z",
  }));
};
let seq = 0;
let hookInsert = null;

const VIG = ["enviando", "ok", "sin_confirmar"];
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.pay = null; this.ord = []; this.lim = null; this.cols = null; }
  select(cols) {
    // Sin "*" ni embebidos, solo esas columnas.
    const s = String(cols ?? "*");
    this.cols = s.includes("*") || s.includes("(") ? null : s.split(",").map((c) => c.trim());
    return this;
  }
  insert(p) { this.op = "insert"; this.pay = p; return this; }
  update(p) { this.op = "update"; this.pay = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v) && r[c] != null); return this; }
  neq(c, v) { this.f.push((r) => String(r[c]) !== String(v)); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c, a) { this.f.push((r) => r[c] != null && a.map(String).includes(String(r[c]))); return this; }
  lt(c, v) { this.f.push((r) => r[c] < v); return this; }
  overlaps(c, a) { this.f.push((r) => (r[c] || []).some((x) => a.map(Number).includes(Number(x)))); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; this.must = true; return this; }
  run() {
    const tabla = db[this.t] || [];
    let rows = tabla.filter((r) => this.f.every((g) => g(r)));
    if (this.op === "insert") {
      if (hookInsert) { const h = hookInsert; hookInsert = null; h(); }
      const nuevo = { id: ++seq, enviado_at: new Date().toISOString(), ...this.pay };
      const EN_VUELO = ["ajuste_visceras", "ajuste_faltante"];
      if (this.t === "carnes_siesa_envios" && EN_VUELO.includes(nuevo.tipo) && ["enviando", "sin_confirmar"].includes(nuevo.estado) &&
        tabla.some((r) => EN_VUELO.includes(r.tipo) && ["enviando", "sin_confirmar"].includes(r.estado) && r.liquidacion_id === nuevo.liquidacion_id && r.recepcion_id == null)) {
        return { data: null, error: { code: "23505", message: "dup en vuelo" } };
      }
      if (this.t === "carnes_siesa_envios" && VIG.includes(nuevo.estado) && nuevo.recepcion_id == null) {
        const choca = tabla.some((r) => VIG.includes(r.estado) && r.recepcion_id == null && r.tipo === nuevo.tipo &&
          r.liquidacion_id === nuevo.liquidacion_id &&
          ((r.fecha_docto ?? null) === (nuevo.fecha_docto ?? null)));
        if (choca) return { data: null, error: { code: "23505", message: "dup" } };
      }
      tabla.push(nuevo);
      return { data: nuevo, error: null };
    }
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.pay);
      return this.one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    }
    for (const [c, asc] of [...this.ord].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    if (this.lim != null) rows = rows.slice(0, this.lim);
    if (this.cols) {
      rows = rows.map((r) => Object.fromEntries(this.cols.filter((c) => c in r).map((c) => [c, r[c]])));
    }
    if (this.one) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
}
const supabaseFalso = { from: (t) => new Q(t) };

// ─── SIESA falso ───
let llamadas = [];
let guion = [];
const enviarASiesaFalso = async (payload, opts) => {
  llamadas.push({ payload, opts });
  const r = guion.shift() ?? { ok: true };
  return r.ok
    ? { ok: true, status: 200, respuesta: { ok: 1 }, error: null }
    : { ok: false, incierto: Boolean(r.incierto), status: r.incierto ? null : 400, respuesta: r.respuesta ?? { e: 1 }, error: r.error ?? "SIESA dijo no" };
};
let correos = [];
let errores = [];
let correoErrorLanza = false;

mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
mock.module(url("services/siesa.service.js"), {
  namedExports: { enviarASiesa: enviarASiesaFalso, TIMEOUT_INICIAL_MS: 90000, TIMEOUT_OFICIAL_MS: 240000 },
});
mock.module(url("services/notificaciones.service.js"), {
  namedExports: {
    notificarAnularIniciales: async (liq, iniciales, oficial) => { correos.push({ liq, iniciales, oficial }); return { success: true }; },
    notificarAnularInicial: async () => ({ success: true }),
    notificarErrorEnvioSiesa: async (envio, extra) => { errores.push({ envio, extra }); if (correoErrorLanza) throw new Error("SMTP caído"); return { success: true }; },
  },
});

const M = await import(url("models/SiesaEnvio.model.js"));
const ofi = () => db.carnes_siesa_envios.filter((f) => f.tipo === "oficial");
const nuevo = () => { reiniciar(); llamadas = []; guion = []; correos = []; errores = []; };

test("una sola fecha: un documento, como antes", async () => {
  nuevo();
  db.carnes_recepciones.forEach((r) => (r.fecha_ingreso = "2026-09-23"));
  const prev = await M.previsualizarOficial(6);
  assert.equal(prev.oficiales.length, 1);
  assert.equal(prev.documento.referencia, "TC OFI L6");
  assert.equal(prev.puedeEnviar, true);
  assert.equal(prev.oficial, null);

  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].payload.Documentos[0].PENDIENTE, "TC OFI L6");
  assert.equal(llamadas[0].payload.Documentos[0].FECHA, "20260923");
  assert.equal(llamadas[0].payload.Movimientos.length, 4);
  const filas = ofi();
  assert.equal(filas.length, 1);
  assert.equal(filas[0].fecha_docto, "2026-09-23");
  assert.deepEqual(filas[0].recepcion_ids, [2, 8, 9]);
  assert.equal(filas[0].consecutivo, 63);
  assert.equal(db.carnes_liquidaciones[0].estado, "Cerrada");
  assert.ok(db.carnes_recepciones.every((x) => x.estado === "Enviado_SIESA"));
  assert.equal(correos.length, 1);
  assert.equal(correos[0].oficial.referencia, "TC OFI L6");
  assert.equal(r.envios.length, 1);
});

test("dos fechas: dos documentos en orden, cada uno con su fila; cierra al final", async () => {
  nuevo();
  const prev = await M.previsualizarOficial(6);
  assert.deepEqual(prev.oficiales.map((o) => [o.fecha, o.referencia, o.sedes]), [
    ["2026-09-21", "TC OFI L6KD", 1],
    ["2026-09-24", "TC OFI L6KG", 2],
  ]);
  assert.equal(prev.documento.referencia, "TC OFI L6KD, TC OFI L6KG");
  assert.equal(prev.puedeEnviar, true);

  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, true);
  assert.deepEqual(llamadas.map((l) => l.payload.Documentos[0].FECHA), ["20260921", "20260924"]);
  assert.deepEqual(llamadas.map((l) => l.payload.Movimientos.length), [2, 2]);
  assert.deepEqual(ofi().map((f) => f.fecha_docto), ["2026-09-21", "2026-09-24"]);
  assert.deepEqual(ofi().map((f) => f.recepcion_ids), [[2], [8, 9]]);
  assert.equal(db.carnes_liquidaciones[0].estado, "Cerrada");
  assert.equal(correos.length, 1);
  assert.equal(correos[0].oficial.documentos, 2);
  assert.equal(correos[0].oficial.referencia, "TC OFI L6KD, TC OFI L6KG");
  assert.ok(ofi().every((f) => f.aviso_anulacion === true));
  // Con ambas ok, la previa ya lo refleja.
  const despues = await M.previsualizarOficial(6);
  assert.equal(despues.oficial.estado, "ok");
  assert.equal(despues.puedeEnviar, false);
});

test("la segunda falla: NO cierra, lista cada documento; el reintento manda solo la que falta", async () => {
  nuevo();
  guion = [{ ok: true }, { ok: false, error: "Item sin cantidad" }];
  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, false);
  assert.equal(llamadas.length, 2);
  assert.equal(r.envio.estado, "error");
  assert.match(r.envio.error, /1 de 2/);
  assert.deepEqual(r.envios.map((e) => e.estado), ["ok", "error"]);
  assert.equal(db.carnes_liquidaciones[0].estado, "Costeada");
  assert.ok(db.carnes_recepciones.every((x) => x.estado === "Costeado"));
  assert.equal(correos.length, 0);

  // Previa parcial: el front ve la ok como `oficial` y puede reintentar.
  const prev = await M.previsualizarOficial(6);
  assert.equal(prev.parcial, true);
  assert.equal(prev.oficial.estado, "ok");
  assert.equal(prev.puedeEnviar, true);

  // Reintento: solo la fecha 24.
  llamadas = [];
  const r2 = await M.enviarOficial(6, "admin");
  assert.equal(r2.cerrada, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].payload.Documentos[0].FECHA, "20260924");
  assert.equal(db.carnes_liquidaciones[0].estado, "Cerrada");
  assert.equal(correos.length, 1);
});

test("la primera falla: NO se postea la segunda fecha; queda pendiente en la respuesta", async () => {
  nuevo();
  guion = [{ ok: false, error: "rechazo A" }, { ok: true }];
  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, false);
  assert.equal(llamadas.length, 1);
  assert.deepEqual(r.envios.map((e) => e.estado), ["error", "pendiente"]);
  assert.match(r.envio.error, /rechazo A/);
  assert.equal(r.pendientes, 1);
  assert.equal(ofi().length, 1);
  // El reintento manda las dos (la primera quedó en error, no ocupa el lugar).
  llamadas = [];
  const r2 = await M.enviarOficial(6, "admin");
  assert.equal(r2.cerrada, true);
  assert.equal(llamadas.length, 2);
});

test("sin confirmar en una: no cierra, y no se reenvía mientras siga así", async () => {
  nuevo();
  guion = [{ ok: true }, { ok: false, incierto: true, error: "timeout" }];
  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, false);
  assert.equal(r.envio.estado, "sin_confirmar");
  await assert.rejects(() => M.enviarOficial(6, "admin"), /sin confirmar/);
});

test("un bloqueo en cualquier fecha frena TODO antes de mandar", async () => {
  nuevo();
  db.carnes_recepciones[1].sede.bodega_siesa = null;
  await assert.rejects(() => M.enviarOficial(6, "admin"), /bodega/);
  assert.equal(llamadas.length, 0);
  assert.equal(ofi().length, 0);
});

test("el consolidado de antes (fecha_docto NULL, ok) cubre todo: no se manda nada, solo cierra", async () => {
  nuevo();
  db.carnes_siesa_envios.push({
    id: ++seq, tipo: "oficial", estado: "ok", recepcion_id: null, liquidacion_id: 6,
    recepcion_ids: [2, 8, 9], fecha_docto: null, referencia: "TC OFI L6", enviado_at: new Date().toISOString(),
    payload: { Documentos: [{ NIT: "70329554", SUCURSAL: "001" }] },
  });
  const prev = await M.previsualizarOficial(6);
  assert.equal(prev.oficial.estado, "ok");
  assert.equal(prev.puedeEnviar, false);
  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, true);
  assert.equal(r.repetido, true);
  assert.equal(llamadas.length, 0);
  assert.equal(db.carnes_liquidaciones[0].estado, "Cerrada");
});

test("una fecha enviada con otro tercero bloquea las que faltan", async () => {
  nuevo();
  guion = [{ ok: true }, { ok: false }];
  await M.enviarOficial(6, "admin", "frigorifico");
  const otro = (await M.previsualizarOficial(6)).terceros.find((t) => t.id !== "frigorifico");
  if (otro) {
    const prev = await M.previsualizarOficial(6, otro.id);
    assert.equal(prev.puedeEnviar, false);
    assert.ok(prev.bloqueos.some((b) => /mismo tercero/.test(b)));
  }
});

test("anular: marca TODAS las oficiales vigentes y reabre la liquidación", async () => {
  nuevo();
  await M.enviarOficial(6, "admin");
  const a = await M.anularOficiales(6, { por: "admin", motivo: "x" });
  assert.equal(a.anulados.length, 2);
  assert.ok(ofi().every((f) => f.estado === "anulado"));
  assert.equal(db.carnes_liquidaciones[0].estado, "Costeada");
});

test("resolver: el último documento que entra dispara el correo; el primero no", async () => {
  nuevo();
  guion = [{ ok: false, incierto: true, error: "t" }, { ok: false, incierto: true, error: "t" }];
  await M.enviarOficial(6, "admin");
  const [a, b] = ofi();
  assert.deepEqual([a.estado, b.estado], ["sin_confirmar", "sin_confirmar"]);
  await M.resolver(a.id, { resultado: "ok", por: "admin" });
  assert.equal(correos.length, 0);
  await M.resolver(b.id, { resultado: "ok", por: "admin" });
  assert.equal(correos.length, 1);
  assert.equal(correos[0].oficial.documentos, 2);
});

// ─── Vísceras ───
const conVisceras = () => {
  nuevo();
  const v = (r, cod, c) => ({ id: 9000 + r * 10 + Number(cod), recepcion_id: r, tipo: "vicera", orden: 9, codigo_item: String(cod), descripcion: `V${cod}`, cantidad: c, costo_base: 500, unidad: "KL" });
  db.carnes_recepcion_items.push(v(2, 71, 3), v(8, 71, 2), v(9, 72, 4));
  db.carnes_liquidaciones[0].estado = "Cerrada";
  db.carnes_recepciones.forEach((r) => (r.estado = "Enviado_SIESA"));
  // Oficiales ok por fecha (las que cubren a cada sede).
  const ok = (fecha, ids) => ({ id: ++seq, tipo: "oficial", estado: "ok", recepcion_id: null, liquidacion_id: 6, recepcion_ids: ids, fecha_docto: fecha, referencia: "TC OFI L6", enviado_at: "2026-09-25T00:00:00Z", payload: { Movimientos: [] } });
  db.carnes_siesa_envios.push(ok("2026-09-21", [2]), ok("2026-09-24", [8, 9]));
};
const ajustes = () => db.carnes_siesa_envios.filter((f) => f.tipo === "ajuste_visceras");

test("vísceras: dos fechas → dos CEI, cada uno con su FECHA_DOCTO; reintento manda solo el faltante", async () => {
  conVisceras();
  const prev = await M.previsualizarAjusteVisceras(6);
  assert.deepEqual(prev.bloqueos, []);
  assert.deepEqual(prev.documentos.map((d) => [d.fecha, d.referencia, d.estado]), [
    ["2026-09-21", "TC VIS L6KD", "pendiente"],
    ["2026-09-24", "TC VIS L6KG", "pendiente"],
  ]);
  assert.equal(prev.puedeEnviar, true);
  assert.equal(prev.documento.referencia, "TC VIS L6KD, TC VIS L6KG");

  guion = [{ ok: true }, { ok: false, error: "rechazo" }];
  const r = await M.enviarAjusteVisceras(6, "admin");
  assert.equal(r.completo, false);
  assert.deepEqual(llamadas.map((l) => l.payload.Documentos[0].FECHA_DOCTO), ["20260921", "20260924"]);
  assert.deepEqual(ajustes().map((f) => [f.fecha_docto, f.estado]), [["2026-09-21", "ok"], ["2026-09-24", "error"]]);
  assert.deepEqual(ajustes().map((f) => f.recepcion_ids), [[2], [8, 9]]);

  const parcial = await M.previsualizarAjusteVisceras(6);
  assert.equal(parcial.parcial, true);
  assert.equal(parcial.pendiente, true);
  assert.equal(parcial.puedeEnviar, true);
  assert.equal(parcial.enviado, false);
  // La fecha 21 YA entró: la 24 no se da por cubierta (el select pide fecha_docto y recepcion_ids).
  assert.deepEqual(parcial.documentos.map((d) => d.estado), ["ok", "pendiente"]);

  llamadas = [];
  const r2 = await M.enviarAjusteVisceras(6, "admin");
  assert.equal(r2.completo, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].payload.Documentos[0].FECHA_DOCTO, "20260924");
  const fin = await M.previsualizarAjusteVisceras(6);
  assert.equal(fin.enviado, true);
});

test("vísceras: una sola fecha → un CEI con la referencia de siempre", async () => {
  conVisceras();
  db.carnes_recepciones.forEach((r) => (r.fecha_ingreso = "2026-09-23"));
  db.carnes_siesa_envios = db.carnes_siesa_envios.filter((f) => f.tipo !== "oficial");
  db.carnes_siesa_envios.push({ id: ++seq, tipo: "oficial", estado: "ok", recepcion_id: null, liquidacion_id: 6, recepcion_ids: [2, 8, 9], fecha_docto: "2026-09-23", referencia: "TC OFI L6", enviado_at: "2026-09-25T00:00:00Z", payload: { Movimientos: [] } });
  const r = await M.enviarAjusteVisceras(6, "admin");
  assert.equal(r.completo, true);
  assert.equal(llamadas.length, 1);
  assert.equal(ajustes()[0].referencia, "TC VIS L6");
  assert.equal(ajustes()[0].fecha_docto, "2026-09-23");
  assert.equal(llamadas[0].payload.Documentos[0].CONSECUTIVO_DOCTO, "64");
  assert.equal(r.documentos, undefined);
});

// ─── Consolidado de antes de sql/033 y recepciones vinculadas después ───

test("oficial legado (NULL) + una recepción vinculada después: se bloquea, no se cierra en falso", async () => {
  nuevo();
  db.carnes_siesa_envios.push({
    id: ++seq, tipo: "oficial", estado: "ok", recepcion_id: null, liquidacion_id: 6,
    recepcion_ids: [2, 8], fecha_docto: null, referencia: "TC OFI L6", enviado_at: new Date().toISOString(),
    payload: { Documentos: [{ NIT: "70329554", SUCURSAL: "001" }] },
  });
  // La 9 (24/09) se vinculó después: el consolidado no la trae.
  const prev = await M.previsualizarOficial(6);
  assert.ok(prev.bloqueos.some((b) => /otras recepciones/.test(b)));
  assert.equal(prev.puedeEnviar, false);
  await assert.rejects(() => M.enviarOficial(6, "admin"), /otras recepciones/);
  assert.equal(llamadas.length, 0);
  assert.equal(db.carnes_liquidaciones[0].estado, "Costeada");
  assert.ok(db.carnes_recepciones.every((x) => x.estado === "Costeado"));
});

test("ajuste legado (NULL) que no trae una recepción con vísceras vinculada después: bloquea", async () => {
  conVisceras();
  db.carnes_siesa_envios.push({
    id: ++seq, tipo: "ajuste_visceras", estado: "ok", recepcion_id: null, liquidacion_id: 6,
    recepcion_ids: [2, 8], fecha_docto: null, referencia: "TC VIS L6", enviado_at: new Date().toISOString(),
    payload: { Movimientos: [] },
  });
  const prev = await M.previsualizarAjusteVisceras(6);
  assert.equal(prev.enviado, false);
  assert.ok(prev.bloqueos.some((b) => /salió sin alguna/.test(b)));
  await assert.rejects(() => M.enviarAjusteVisceras(6, "admin"), /salió sin alguna/);
  assert.equal(llamadas.length, 0);
});

test("referencia pendiente igual a la de otro documento de la liquidación: se bloquea", async () => {
  nuevo();
  // Un envío vigente de otra fecha con la MISMA referencia que tendría la 21/09.
  db.carnes_siesa_envios.push({
    id: ++seq, tipo: "oficial", estado: "ok", recepcion_id: null, liquidacion_id: 6,
    recepcion_ids: [8, 9], fecha_docto: "2026-09-24", referencia: "TC OFI L6KD", enviado_at: new Date().toISOString(),
    payload: { Documentos: [{ NIT: "70329554", SUCURSAL: "001" }] },
  });
  const prev = await M.previsualizarOficial(6);
  assert.ok(prev.bloqueos.some((b) => /misma referencia/.test(b)));
  await assert.rejects(() => M.enviarOficial(6, "admin"), /misma referencia/);
  assert.equal(llamadas.length, 0);
});

test("la referencia de una fecha NO cambia si se vincula otra recepción más antigua", async () => {
  nuevo();
  const antes = (await M.previsualizarOficial(6)).oficiales.map((o) => [o.fecha, o.referencia]);
  db.carnes_recepciones.push({ id: 10, liquidacion_id: 6, estado: "Costeado", fecha_ingreso: "2026-09-10", sede_id: 2,
    sede: db.carnes_recepciones[0].sede });
  db.carnes_recepcion_items.push({ id: 5000, recepcion_id: 10, tipo: "carne", orden: 1, codigo_item: "1", descripcion: "C1", cantidad: 1, costo_base: 100, costo_ajustado: 90 });
  const despues = (await M.previsualizarOficial(6)).oficiales.map((o) => [o.fecha, o.referencia]);
  assert.equal(despues.length, 3);
  for (const par of antes) assert.ok(despues.some((d) => d[0] === par[0] && d[1] === par[1]));
});

// ─── Tercero, correo y candado en vuelo ───

test("envío parcial: la previa dice con qué tercero entraron las fechas ya enviadas", async () => {
  nuevo();
  guion = [{ ok: true }, { ok: false, error: "rechazo" }];
  await M.enviarOficial(6, "admin", "varios");
  const porDefecto = await M.previsualizarOficial(6);
  assert.equal(porDefecto.terceroEnviado, "varios");
  // Con el tercero por defecto (frigorífico) no se puede seguir...
  assert.equal(porDefecto.puedeEnviar, false);
  // ...y el front, que lo preselecciona, sí.
  const igual = await M.previsualizarOficial(6, "varios");
  assert.equal(igual.terceroEnviado, "varios");
  assert.equal(igual.puedeEnviar, true);
  assert.equal((await M.previsualizarOficial(6, "varios")).parcial, true);
});

test("sin envíos, terceroEnviado es null", async () => {
  nuevo();
  assert.equal((await M.previsualizarOficial(6)).terceroEnviado, null);
});

test("todo ok sin cerrar y sin correo (carrera perdida): quien cierra manda el aviso", async () => {
  nuevo();
  const ok = (fecha, ids, ref) => ({
    id: ++seq, tipo: "oficial", estado: "ok", recepcion_id: null, liquidacion_id: 6, recepcion_ids: ids,
    fecha_docto: fecha, referencia: ref, aviso_anulacion: false, enviado_at: new Date().toISOString(),
    renglones: 2, total_kilos: 1, total_valor: 1,
    payload: { Documentos: [{ NIT: "70329554", SUCURSAL: "001" }] },
  });
  db.carnes_siesa_envios.push(ok("2026-09-21", [2], "TC OFI L6KD"), ok("2026-09-24", [8, 9], "TC OFI L6KG"));
  const r = await M.enviarOficial(6, "admin");
  assert.equal(r.cerrada, true);
  assert.equal(llamadas.length, 0);
  assert.equal(correos.length, 1);
  assert.equal(correos[0].oficial.documentos, 2);
  assert.ok(ofi().every((f) => f.aviso_anulacion === true));
  // Un segundo clic con la liquidación ya cerrada no repite el correo.
  await M.enviarOficial(6, "admin");
  assert.equal(correos.length, 1);
});

test("vísceras 23505 por el candado en vuelo: se informa el envío que ocupa, no uno inventado", async () => {
  conVisceras();
  hookInsert = () => {
    db.carnes_siesa_envios.push({
      id: ++seq, tipo: "ajuste_faltante", estado: "enviando", recepcion_id: null, liquidacion_id: 6,
      referencia: "TC FAL X1", fecha_docto: null, enviado_at: new Date().toISOString(),
    });
  };
  const r = await M.enviarAjusteVisceras(6, "admin");
  assert.equal(r.completo, false);
  assert.equal(llamadas.length, 0);
  assert.equal(r.repetido, true);
  assert.equal(r.envio.referencia, "TC FAL X1");
  assert.match(r.envio.error, /TC FAL X1/);
});

// ─── Inicial parcial y aviso de error ───

const agregarAdicionalSinCodigo = (recepcionId) =>
  db.carnes_recepcion_items.push({
    id: 9000 + recepcionId, recepcion_id: recepcionId, tipo: "adicional", orden: 9,
    codigo_item: null, descripcion: "ASADURA DE CERDO", cantidad: 2, costo_base: 100,
  });

test("inicial con un producto sin código: sube el resto, guarda la novedad y no avisa error", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  agregarAdicionalSinCodigo(2);
  const fila = await M.enviarInicial(2, "recibidor");
  assert.equal(fila.estado, "ok");
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].payload.Movimientos.length, 2);
  assert.equal(fila.renglones, 2);
  assert.equal(fila.total_kilos, 15);
  assert.equal(
    fila.novedad,
    "1 renglón sin código de SIESA no se subió: ASADURA DE CERDO. Homologarlo antes de liquidar.",
  );
  assert.equal(db.carnes_siesa_envios[0].novedad, fila.novedad);
  assert.equal(errores.length, 0);
});

test("inicial sin novedad: la fila no lleva la clave novedad", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  const fila = await M.enviarInicial(8, "recibidor");
  assert.equal(fila.estado, "ok");
  assert.ok(!("novedad" in db.carnes_siesa_envios[0]));
  assert.equal(errores.length, 0);
});

test("inicial: si SIESA la rechaza, queda la novedad y se avisa el error por correo", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  agregarAdicionalSinCodigo(2);
  guion = [{ ok: false, error: "Item no existe" }];
  const fila = await M.enviarInicial(2, "recibidor");
  assert.equal(fila.estado, "error");
  assert.match(fila.novedad, /ASADURA DE CERDO/);
  assert.equal(errores.length, 1);
  assert.equal(errores[0].envio.estado, "error");
  assert.equal(errores[0].envio.error, "Item no existe");
  assert.equal(errores[0].envio.referencia, "TC INI R2");
  assert.equal(errores[0].extra.sede, "Barbosa");
});

test("inicial sin_confirmar: no se avisa por correo", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  guion = [{ ok: false, incierto: true, error: "timeout" }];
  const fila = await M.enviarInicial(8, "recibidor");
  assert.equal(fila.estado, "sin_confirmar");
  assert.equal(errores.length, 0);
});

test("inicial bloqueada (todos sin código): fila en error y aviso por correo, sin llamar a SIESA", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  db.carnes_recepcion_items = [];
  agregarAdicionalSinCodigo(9);
  const fila = await M.enviarInicial(9, "recibidor");
  assert.equal(fila.estado, "error");
  assert.equal(llamadas.length, 0);
  assert.match(fila.novedad, /ASADURA DE CERDO/);
  assert.equal(errores.length, 1);
  assert.match(errores[0].envio.error, /Ningún renglón tiene código/);
});

test("inicial ya vigente: no se intenta ni se avisa", async () => {
  nuevo();
  const fila = await M.enviarInicial(2, "recibidor");
  assert.equal(fila.repetido, true);
  assert.equal(llamadas.length, 0);
  assert.equal(errores.length, 0);
});

test("si el correo de error falla, el resultado del envío no cambia", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  guion = [{ ok: false, error: "SIESA dijo no" }];
  correoErrorLanza = true;
  try {
    const fila = await M.enviarInicial(8, "recibidor");
    assert.equal(fila.estado, "error");
    assert.equal(fila.error, "SIESA dijo no");
    assert.equal(errores.length, 1);
  } finally {
    correoErrorLanza = false;
  }
});

// ─── Ajuste de vísceras rechazado por faltante: el flujo lo compensa solo ───

const FALTANTE_71 = {
  codigo: 1,
  detalle: [{ f_valor: "Item:0000071Bodega:00201", f_detalle: "Movto Inventario: Item sin cantidad disponible Faltante Inv.: -1.5 Faltante Adic.: 0.0000" }],
  mensaje: "Error al importar el plano",
};

test("ajuste de vísceras rechazado por faltante y compensado: no se avisa error por correo", async () => {
  conVisceras();
  guion = [
    { ok: false, error: "faltante", respuesta: FALTANTE_71 },
    { ok: true }, // compensación
    { ok: true }, // ajuste reenviado
  ];
  const r = await M.enviarAjusteVisceras(6, "admin");
  assert.equal(r.completo, true, JSON.stringify(r));
  assert.equal(errores.length, 0);
});

test("ajuste de vísceras con faltante que no se pudo compensar: UN solo correo", async () => {
  conVisceras();
  guion = [
    { ok: false, error: "faltante", respuesta: FALTANTE_71 },
    { ok: false, error: "compensación rechazada" }, // otro error: no se reintenta
  ];
  const r = await M.enviarAjusteVisceras(6, "admin");
  assert.equal(r.completo, false);
  assert.equal(errores.filter((e) => e.envio.tipo === "ajuste_visceras").length, 1);
});
