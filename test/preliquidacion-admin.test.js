// Endpoints admin del modelo: procesar (lote), procesar una sede y cerrar. Supabase falso; el
// procesamiento, las corridas y el cierre se inyectan: sin base, sin SIESA.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t), rpc: async () => ({ data: { resultado: "ok" }, error: null }) } } });
const Modelo = await import(url("models/Preliquidacion.model.js"));

const silencio = { info() {}, warn() {}, error() {} };
let reg;
const base = (extra = {}) => ({
  por: "admin@x.co",
  log: silencio,
  abrirCorrida: async (o) => (reg.corridas.push(o), { id: 700, origen: o.origen, preliquidacion_ids: [], resumen: { reevaluadas: [] } }),
  registrarProgreso: async (c, o) => reg.progreso.push(o),
  terminarCorrida: async (c, o) => reg.terminar.push(o),
  procesar: async (id, o) => {
    reg.procesar.push({ id, ...o });
    return { preliquidacion_id: id, resultado: "ok", enviadas: 1, pendientes: 0, cerrada: false, sedes: [{ sede_id: 11, recosteo: "calculada", envio: "enviada" }] };
  },
  ...extra,
});

beforeEach(() => {
  reg = { corridas: [], progreso: [], terminar: [], procesar: [], cierres: [] };
  tablas = {
    carnes_preliquidaciones: [{ id: 1, especie: "res", estado: "abierta", version: 1 }, { id: 2, especie: "res", estado: "cerrada", version: 1 }],
    carnes_preliquidacion_sedes: [
      { id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "lista_para_enviar", version: 3 },
      { id: 21, preliquidacion_id: 2, recepcion_id: 201, estado: "enviada", version: 3 },
    ],
  };
});

// ─── POST /:id/procesar ────────────────────────────────────────────────────

test("procesarAdmin: origen admin, corrida propia, quién lo pide y presupuesto dinámico", async () => {
  const r = await Modelo.procesarAdmin(1, base());
  assert.equal(reg.corridas[0].origen, "admin");
  const p = reg.procesar[0];
  assert.deepEqual({ id: p.id, origen: p.origen, por: p.por, corridaId: p.corrida.id }, { id: 1, origen: "admin", por: "admin@x.co", corridaId: 700 });
  assert.equal(typeof p.hayPresupuesto, "function");
  assert.equal(typeof p.timeoutMs, "function");
  assert.ok(p.timeoutMs() >= 30_000);
  assert.equal(reg.progreso[0].preliquidacionId, 1);
  assert.equal(reg.terminar[0].error ?? null, null);
  assert.equal(r.corrida_id, 700);
  assert.equal(r.enviadas, 1);
  assert.deepEqual(r.sedes, [{ sede_id: 11, recosteo: "calculada", envio: "enviada" }]);
});

test("procesarAdmin: preliquidación no abierta -> 409 no_abierta y sin corrida", async () => {
  await assert.rejects(Modelo.procesarAdmin(2, base()), (e) => e.statusCode === 409 && e.codigo === "no_abierta");
  assert.equal(reg.corridas.length, 0);
});

test("procesarAdmin: preliquidación inexistente -> 404", async () => {
  await assert.rejects(Modelo.procesarAdmin(99, base()), (e) => e.statusCode === 404);
});

test("procesarAdmin: si el procesamiento falla la corrida termina con error y se relanza", async () => {
  await assert.rejects(Modelo.procesarAdmin(1, base({ procesar: async () => { throw new Error("boom"); } })), /boom/);
  assert.match(reg.terminar[0].error.message, /boom/);
});

test("M5: el lote con SIESA apagado devuelve siesa_apagado por sede", async () => {
  const r = await Modelo.procesarAdmin(
    1,
    base({ procesar: async () => ({ resultado: "ok", enviadas: 0, pendientes: 0, sedes: [{ sede_id: 11, codigo: "siesa_apagado" }] }) }),
  );
  assert.deepEqual(r.sedes, [{ sede_id: 11, codigo: "siesa_apagado" }]);
});

// ─── POST /sedes/:sedeId/procesar ──────────────────────────────────────────

test("procesarSedeAdmin: congela y reclama solo esa sede; responde {recosteo, envio}", async () => {
  const r = await Modelo.procesarSedeAdmin(11, base());
  assert.equal(reg.procesar[0].soloSedeId, 11);
  assert.equal(reg.procesar[0].origen, "admin");
  assert.equal(reg.procesar[0].id, 1);
  assert.deepEqual({ recosteo: r.recosteo, envio: r.envio }, { recosteo: "calculada", envio: "enviada" });
  assert.equal(r.corrida_id, 700);
});

test("procesarSedeAdmin: un recosteo que termina bloqueada no se envía (envio null)", async () => {
  const r = await Modelo.procesarSedeAdmin(
    11,
    base({ procesar: async () => ({ resultado: "ok", pendientes: 0, sedes: [{ sede_id: 11, recosteo: "bloqueada", motivo_bloqueo: "utilidad_negativa" }] }) }),
  );
  assert.deepEqual({ recosteo: r.recosteo, envio: r.envio }, { recosteo: "bloqueada", envio: null });
});

test("M5: sede que no puede enviarse con SIESA apagado -> 409 siesa_apagado (nunca un Enviar sin resultado)", async () => {
  const procesar = async () => ({ resultado: "ok", pendientes: 0, sedes: [{ sede_id: 11, codigo: "siesa_apagado" }] });
  await assert.rejects(Modelo.procesarSedeAdmin(11, base({ procesar })), (e) => e.statusCode === 409 && e.codigo === "siesa_apagado");
});

test("procesarSedeAdmin: otros códigos de no envío viajan en la respuesta (inicial_pendiente)", async () => {
  const procesar = async () => ({ resultado: "ok", pendientes: 0, sedes: [{ sede_id: 11, recosteo: "calculada", envio: "no_reclamable", codigo: "inicial_pendiente" }] });
  const r = await Modelo.procesarSedeAdmin(11, base({ procesar }));
  assert.equal(r.codigo, "inicial_pendiente");
});

test("procesarSedeAdmin: antes del corte u otro resultado de cabecera se informa en `resultado`", async () => {
  const r = await Modelo.procesarSedeAdmin(11, base({ procesar: async () => ({ resultado: "antes_del_corte", pendientes: 0, sedes: [] }) }));
  assert.equal(r.resultado, "antes_del_corte");
  assert.equal(r.envio, null);
});

test("procesarSedeAdmin: sede inexistente 404; preliquidación cerrada 409 no_abierta", async () => {
  await assert.rejects(Modelo.procesarSedeAdmin(999, base()), (e) => e.statusCode === 404);
  await assert.rejects(Modelo.procesarSedeAdmin(21, base()), (e) => e.statusCode === 409 && e.codigo === "no_abierta");
  assert.equal(reg.corridas.length, 0);
});

// ─── POST /:id/cerrar ──────────────────────────────────────────────────────

test("cerrar: ok devuelve el monto no asignado", async () => {
  const r = await Modelo.cerrar(1, { cerrarPreliquidacion: async () => ({ resultado: "ok", monto_no_asignado: "125.00" }) });
  assert.deepEqual({ resultado: r.resultado, monto: r.monto_no_asignado }, { resultado: "ok", monto: "125.00" });
});

test("cerrar: no_cerrable -> 409 con el motivo; no_abierta/no_liquidada/version_cambiada -> 409; no_encontrada -> 404", async () => {
  const falso = (r) => ({ cerrarPreliquidacion: async () => r });
  await assert.rejects(Modelo.cerrar(1, falso({ resultado: "no_cerrable", motivo: "sedes_pendientes" })), (e) => e.statusCode === 409 && e.codigo === "no_cerrable" && e.motivo === "sedes_pendientes");
  for (const codigo of ["no_abierta", "no_liquidada", "version_cambiada"]) {
    await assert.rejects(Modelo.cerrar(1, falso({ resultado: codigo })), (e) => e.statusCode === 409 && e.codigo === codigo);
  }
  await assert.rejects(Modelo.cerrar(1, falso({ resultado: "no_encontrada" })), (e) => e.statusCode === 404);
});
