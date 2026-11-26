// Barrido horario de las vísceras (CEI) de las sedes de res cuya entrada oficial ya está ok y cuya
// recepción no tiene CEI vigente. Supabase y SIESA FALSOS: nada sale a la red.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

const db = {};
class Q {
  constructor(t) { this.t = t; this.f = []; this.lim = null; this.ord = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, a) { this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  then(res, rej) {
    let rows = (db[this.t] ?? []).filter((r) => this.f.every((g) => g(r)));
    for (const [c, asc] of [...this.ord].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    if (this.lim != null) rows = rows.slice(0, this.lim);
    return Promise.resolve({ data: rows, error: null }).then(res, rej);
  }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t), rpc: async () => ({ data: { resultado: "ok" }, error: null }) } } });
const Modelo = await import(url("models/Preliquidacion.model.js"));

const AHORA = new Date("2026-11-25T12:00:00.000Z");
const hace = (dias) => new Date(AHORA.getTime() - dias * 86400000).toISOString();
let enviados;
let respuestas;
let alertas;
const enviarVisceras = async (recepcionId, opciones) => {
  enviados.push({ recepcionId, opciones });
  return respuestas[recepcionId] ?? { estado: "ok" };
};
const encolar = async (a) => { alertas.push(a); };
const silencio = { error() {}, warn() {} };
const barrer = (extra = {}) =>
  Modelo.barrerVisceras({ ahora: AHORA, siesaActivo: true, enviarVisceras, encolar, log: silencio, restante: () => 120000, ...extra });

beforeEach(() => {
  enviados = [];
  respuestas = {};
  alertas = [];
  db.carnes_preliquidaciones = [{ id: 1, especie: "res" }, { id: 2, especie: "cerdo" }, { id: 3, especie: "res", estado: "cerrada" }];
  db.carnes_preliquidacion_sedes = [
    { id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "enviada", version: 4, updated_at: hace(1) },
    { id: 12, preliquidacion_id: 1, recepcion_id: 102, estado: "enviada", version: 4, updated_at: hace(1) },
    { id: 13, preliquidacion_id: 1, recepcion_id: 103, estado: "error", version: 4, updated_at: hace(1) },
    { id: 14, preliquidacion_id: 2, recepcion_id: 104, estado: "enviada", version: 4, updated_at: hace(1) },
    { id: 15, preliquidacion_id: 3, recepcion_id: 105, estado: "enviada", version: 6, updated_at: hace(2) },
    { id: 16, preliquidacion_id: 1, recepcion_id: 106, estado: "enviada", version: 4, updated_at: hace(60) },
  ];
  db.carnes_siesa_envios = [{ id: 1, recepcion_id: 102, tipo: "visceras_recepcion", estado: "ok" }];
});

test("selecciona sedes de res enviadas, recientes y sin CEI vigente (también de preliquidaciones cerradas)", async () => {
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id).sort(), [11, 15]);
  assert.ok(lista.every((x) => x.especie === "res"));
});

test("un CEI en error o anulado NO cuenta como hecho: la sede sigue pendiente", async () => {
  db.carnes_siesa_envios = [
    { id: 1, recepcion_id: 102, tipo: "visceras_recepcion", estado: "error" },
    { id: 2, recepcion_id: 101, tipo: "visceras_recepcion", estado: "anulado" },
  ];
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id).sort(), [11, 12, 15]);
});

test("el barrido manda el CEI de cada pendiente con el presupuesto y cuenta los resultados", async () => {
  respuestas[105] = { estado: "error", error: "SIESA dijo no" };
  const r = await barrer();
  assert.deepEqual(enviados.map((e) => e.recepcionId).sort(), [101, 105]);
  assert.equal(typeof enviados[0].opciones.restante, "function");
  assert.equal(r.candidatas, 2);
  assert.equal(r.enviadas, 1);
  assert.equal(r.errores, 1);
  assert.equal(alertas.filter((a) => a.evento === "visceras_error").length, 1);
});

test("sin tiempo: se detiene y lo que falta queda para el siguiente ciclo", async () => {
  respuestas[105] = { estado: "sin_tiempo" }; // la más antigua va primero
  const r = await barrer();
  assert.equal(enviados.length, 1);
  assert.equal(r.agotado, true);
});

test("sin presupuesto no arranca ninguna", async () => {
  const r = await barrer({ hayPresupuesto: () => false });
  assert.equal(enviados.length, 0);
  assert.equal(r.agotado, true);
});

test("SIESA apagado: no lee ni manda nada", async () => {
  const r = await barrer({ siesaActivo: false });
  assert.equal(enviados.length, 0);
  assert.equal(r.candidatas, 0);
});

test("el tope por corrida limita cuántas se intentan", async () => {
  db.carnes_preliquidacion_sedes = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i, preliquidacion_id: 1, recepcion_id: 500 + i, estado: "enviada", version: 1, updated_at: hace(1),
  }));
  db.carnes_siesa_envios = [];
  const r = await barrer();
  assert.equal(enviados.length, Modelo.LIMITE_BARRIDO_VISCERAS);
  assert.equal(r.candidatas, 30);
});

test("nunca lanza: si la lectura falla devuelve el error en el resumen", async () => {
  const r = await barrer({ listarPendientes: async () => { throw new Error("db caída"); } });
  assert.equal(r.error, "db caída");
});
