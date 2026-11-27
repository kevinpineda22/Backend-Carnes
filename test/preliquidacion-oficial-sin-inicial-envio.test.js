// Oficial sin inicial (sql/044): toda ruta que manda una CEA inicial se niega si la recepción la omitió, y la
// oficial no pide anular una inicial que nunca existió. Supabase y SIESA FALSOS: nada sale a la red.
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
let seq = 0;
const reiniciar = () => {
  db.carnes_recepciones = [
    {
      id: 2, estado: "Costeado", fecha_ingreso: "2026-11-20", sede_id: 2,
      sede: { id: 2, nombre: "Barbosa", bodega_siesa: "00201", codigo_co: "02" },
    },
  ];
  db.carnes_recepcion_items = [
    { id: 201, recepcion_id: 2, tipo: "carne", orden: 1, codigo_item: "1", descripcion: "C1", cantidad: 10, costo_base: 100, costo_ajustado: 90 },
  ];
  seq = 10;
  db.carnes_siesa_envios = [
    { id: 1, tipo: "inicial", estado: "ok", recepcion_id: 2, liquidacion_id: null, referencia: "TC INI R2", total_kilos: 10, total_valor: 1000, enviado_at: "2026-11-20T01:00:00Z" },
  ];
  db.carnes_preliquidacion_sedes = [];
};

const VIG = ["enviando", "ok", "sin_confirmar"];
let rechazarInicialEnBase = false;
let fallarLecturaRecepcion = false;
let rpcLlamadas = [];
let rpcRespuesta = { resultado: "ok" };

class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.pay = null; this.ord = []; this.lim = null; }
  select(cols) { this.cols = cols; return this; }
  insert(p) { this.op = "insert"; this.pay = p; return this; }
  update(p) { this.op = "update"; this.pay = p; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v) && r[c] != null); return this; }
  in(c, a) { this.f.push((r) => r[c] != null && a.map(String).includes(String(r[c]))); return this; }
  lt(c, v) { this.f.push((r) => r[c] != null && r[c] < v); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  run() {
    const tabla = (db[this.t] ??= []);
    if (fallarLecturaRecepcion && this.t === "carnes_recepciones" && this.op === "select" && this.cols === "inicial_omitida_at") {
      return { data: null, error: { code: "08006", message: "conexión caída" } };
    }
    let rows = tabla.filter((r) => this.f.every((g) => g(r)));
    if (this.op === "insert") {
      const omitidaEnBase = rechazarInicialEnBase || (db.carnes_recepciones.find((r) => r.id === this.pay.recepcion_id)?.inicial_omitida_at ?? null) !== null;
      if (this.t === "carnes_siesa_envios" && this.pay.tipo === "inicial" && omitidaEnBase) {
        return { data: null, error: { code: "CA044", message: "inicial_omitida: la recepción 2 no manda la entrada inicial; solo sale la oficial." } };
      }
      const nuevo = { id: ++seq, enviado_at: new Date().toISOString(), ...this.pay };
      if (this.t === "carnes_siesa_envios" && VIG.includes(nuevo.estado) &&
        tabla.some((r) => VIG.includes(r.estado) && r.recepcion_id === nuevo.recepcion_id && r.tipo === nuevo.tipo)) {
        return { data: null, error: { code: "23505", message: "dup" } };
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
    return this.one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => { rpcLlamadas.push({ nombre, args }); return { data: rpcRespuesta, error: null }; },
};

// ─── SIESA falso ───
let llamadas = [];
let guion = [];
const enviarASiesaFalso = async (payload, opts) => {
  llamadas.push({ payload, opts });
  const r = guion.shift() ?? { ok: true };
  return r.ok
    ? { ok: true, status: 200, respuesta: { ok: 1 }, error: null }
    : { ok: false, incierto: Boolean(r.incierto), status: r.incierto ? null : 400, respuesta: { e: 1 }, error: r.error ?? "SIESA dijo no" };
};
let correosAnulacion = [];
let correosError = [];

mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
mock.module(url("services/siesa.service.js"), {
  namedExports: { enviarASiesa: enviarASiesaFalso, TIMEOUT_INICIAL_MS: 90000, TIMEOUT_OFICIAL_MS: 240000 },
});
mock.module(url("services/notificaciones.service.js"), {
  namedExports: {
    notificarAnularIniciales: async () => ({ success: true }),
    notificarAnularInicial: async (recepcion, inicial, oficial) => { correosAnulacion.push({ recepcion, inicial, oficial }); return { success: true }; },
    notificarErrorEnvioSiesa: async (envio) => { correosError.push(envio); return { success: true }; },
  },
});

// El auto-cierre de la preliquidación se prueba en test/preliquidacion-cierre-modelo.test.js: aquí solo
// se verifica que el resolver lo pida cuando la sede pasa a enviada.
let cierresPedidos = [];
mock.module(url("models/PreliquidacionCierre.model.js"), {
  namedExports: {
    intentarAutocierre: async (id) => { cierresPedidos.push(id); return { cerrada: false, motivo: "falso" }; },
    cerrarPreliquidacion: async () => ({ resultado: "ok" }),
  },
});

const M = await import(url("models/SiesaEnvio.model.js"));
const nuevo = () => { reiniciar(); llamadas = []; guion = []; correosAnulacion = []; correosError = []; rpcLlamadas = []; rpcRespuesta = { resultado: "ok" }; rechazarInicialEnBase = false; fallarLecturaRecepcion = false; };
const omitir = () => { db.carnes_recepciones[0].inicial_omitida_at = "2026-11-26T10:00:00Z"; db.carnes_recepciones[0].inicial_omitida_por = "admin@x.co"; };
const iniciales = () => db.carnes_siesa_envios.filter((f) => f.tipo === "inicial");
const sinInicial = () => { db.carnes_siesa_envios = []; };

// ─── Cierre de la recepción: enviarInicial ─────────────────────────────────

test("cierre: con la inicial omitida no se manda, no se registra nada y se informa `omitida`", async () => {
  nuevo(); sinInicial(); omitir();
  const r = await M.enviarInicial(2, "recibidor");
  assert.equal(r.estado, "omitida");
  assert.equal(r.tipo, "inicial");
  assert.match(r.mensaje, /omitida por un administrador/);
  assert.equal(llamadas.length, 0);
  assert.equal(iniciales().length, 0);
});

test("cierre: la omisión que llega entre la lectura y la reserva la frena el trigger de la base, sin mandar", async () => {
  nuevo(); sinInicial();
  rechazarInicialEnBase = true; // la lectura previa dice "no omitida"; el INSERT ya la ve omitida
  const r = await M.enviarInicial(2, "recibidor");
  assert.equal(r.estado, "omitida");
  assert.equal(llamadas.length, 0);
  assert.equal(iniciales().length, 0);
});

test("cierre: sin omisión la inicial sale como siempre (regresión)", async () => {
  nuevo(); sinInicial();
  const r = await M.enviarInicial(2, "recibidor");
  assert.equal(r.estado, "ok");
  assert.equal(llamadas.length, 1);
  assert.equal(iniciales().length, 1);
});

// ─── Reintento manual: POST /siesa/recepciones/:id/inicial ─────────────────

test("reintento manual: con la inicial omitida es 409 inicial_omitida y no toca SIESA", async () => {
  nuevo(); sinInicial(); omitir();
  await assert.rejects(
    () => M.reintentarInicial(2, "admin"),
    (e) => e.statusCode === 409 && e.codigo === "inicial_omitida" && /solo sale la oficial/.test(e.message),
  );
  assert.equal(llamadas.length, 0);
  assert.equal(iniciales().length, 0);
});

test("reintento manual: la omisión concurrente que solo ve el trigger también es 409 inicial_omitida", async () => {
  nuevo(); sinInicial();
  rechazarInicialEnBase = true;
  await assert.rejects(() => M.reintentarInicial(2, "admin"), (e) => e.statusCode === 409 && e.codigo === "inicial_omitida");
  assert.equal(llamadas.length, 0);
});

test("reintento manual: sin omisión sigue funcionando (regresión)", async () => {
  nuevo(); sinInicial();
  const r = await M.reintentarInicial(2, "admin");
  assert.equal(r.estado, "ok");
  assert.equal(llamadas.length, 1);
});

// ─── La oficial de una recepción sin inicial ───────────────────────────────

test("oficial con la inicial omitida: sale, SIN correo de anulación, y el aviso queda cumplido", async () => {
  nuevo(); sinInicial(); omitir();
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.estado, "ok");
  assert.equal(r.fila.tipo, "oficial");
  assert.equal(llamadas.length, 1);
  assert.equal(correosAnulacion.length, 0, "no hay inicial que anular");
  assert.equal(db.carnes_siesa_envios.find((f) => f.id === r.fila.id).aviso_anulacion, true);
});

test("oficial normal (con inicial ok y sin omisión): el correo de anulación sale como siempre (regresión)", async () => {
  nuevo();
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.estado, "ok");
  assert.equal(correosAnulacion.length, 1);
});

test("oficial resuelta a mano (sin_confirmar -> ok) con la inicial omitida: tampoco pide anular nada", async () => {
  nuevo(); sinInicial(); omitir();
  db.carnes_siesa_envios.push({
    id: 50, tipo: "oficial", estado: "sin_confirmar", recepcion_id: 2, liquidacion_id: null,
    referencia: "TC OFI R2", enviado_at: new Date().toISOString(),
  });
  await M.resolver(50, { resultado: "ok", por: "admin" });
  assert.equal(correosAnulacion.length, 0);
  assert.equal(db.carnes_siesa_envios.find((f) => f.id === 50).aviso_anulacion, true);
});

test("resolver: si falla la lectura de la marca, el aviso no lanza y se intenta el correo como antes", async () => {
  nuevo();
  db.carnes_siesa_envios.push({
    id: 51, tipo: "oficial", estado: "sin_confirmar", recepcion_id: 2, liquidacion_id: null,
    referencia: "TC OFI R2", enviado_at: new Date().toISOString(),
  });
  fallarLecturaRecepcion = true;
  const log = mock.method(console, "error", () => {});
  try {
    await M.resolver(51, { resultado: "ok", por: "admin" });
  } finally {
    log.mock.restore();
  }
  assert.equal(db.carnes_siesa_envios.find((f) => f.id === 51).estado, "ok", "la resolución guardada se conserva");
  assert.equal(correosAnulacion.length, 1, "se intentó el correo");
  assert.equal(db.carnes_siesa_envios.find((f) => f.id === 51).aviso_anulacion, true);
});

// ─── Lectura de la marca ───────────────────────────────────────────────────

test("inicialOmitida: false sin marca y true con marca", async () => {
  nuevo();
  assert.equal(await M.inicialOmitida(2), false);
  omitir();
  assert.equal(await M.inicialOmitida(2), true);
});
