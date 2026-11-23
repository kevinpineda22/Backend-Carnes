// Correcciones de una sede ya enviada (3.6): confirmar la anulación hecha a mano en SIESA y descartar
// el aviso `requiere_correccion`. Escenarios F-S2, F-S3 y F-S4.
// Supabase falso con RPC que mutan las tablas; el registro de la anulación del envío se inyecta.
// Nada de esto toca SIESA: la anulación allá la hace una persona, aquí solo se registra.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let rpcs = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  // Copias: una lectura vieja no debe ver las escrituras posteriores (como en la base real).
  maybeSingle() { const f = this.filas()[0]; return Promise.resolve({ data: f ? { ...f } : null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const h = manejadores[nombre];
    return { data: h ? await h(args) : { resultado: "ok" }, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Correcciones = await import(url("models/PreliquidacionCorrecciones.model.js"));
const { puedeReclamar } = await import(url("shared/preliquidacionEstados.js"));
const { planearEnvios } = await import(url("shared/preliquidacionPlan.js"));

const cabecera = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", animales: 10, liquidada_at: "2026-11-24T02:31:00.000Z",
  version: 3, orden_version: 5, ...extra,
});
const sede = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "enviada",
  version: 7, intentos: 1, error_tipo: null, motivo_pendiente: null, requiere_correccion: false,
  correccion_orden_version: null, gasto_sede: "600000.00", costeo_orden_version: 5, costeo_animales: 4,
  envio_id: 900, ...extra,
});

let anulaciones = [];
const anularEnvioOk = async (recepcionId, opciones) => {
  anulaciones.push({ recepcionId, opciones });
  return { anulados: [{ id: 900, tipo: "oficial" }] };
};
const silencio = { info() {}, warn() {}, error() {}, log() {} };

/** RPC de transición con CAS de estado + versión, igual que la real. */
const rpcTransicionar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => String(x.id) === String(a.p_sede_id));
  if (!s) return { resultado: "no_encontrada" };
  if (s.estado !== a.p_desde || s.version !== a.p_sede_version) return { resultado: "version_cambiada" };
  const { recepcion_estado: recEstado, ...campos } = a.p_campos;
  Object.assign(s, campos, { estado: a.p_hacia, version: s.version + 1 });
  if (recEstado) tablas.carnes_recepciones.find((r) => r.id === s.recepcion_id).estado = recEstado;
  return { resultado: "ok", estado: a.p_hacia, sede_version: s.version };
};

beforeEach(() => {
  rpcs = [];
  anulaciones = [];
  manejadores = { carnes_preliq_transicionar_sede: rpcTransicionar };
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [sede()],
    carnes_recepciones: [{ id: 101, especie: "res", estado: "Enviado_SIESA" }],
  };
});

const transiciones = () => rpcs.filter((r) => r.nombre === "carnes_preliq_transicionar_sede");
const anular = (id = 11, datos = { motivo: "error de pesos" }, extra = {}) =>
  Correcciones.anularSede(id, datos, { anularEnvio: anularEnvioOk, log: silencio, ...extra });

// ─── F-S2: corregir tras enviar ────────────────────────────────────────────

test("F-S2: confirmar la anulación registra el envío como anulado y la sede pasa enviada -> anulada", async () => {
  const r = await anular(11, { por: "ana@merka.co", motivo: "error de pesos" });
  assert.equal(r.resultado, "ok");
  assert.equal(r.estado, "anulada");
  assert.equal(anulaciones.length, 1);
  assert.equal(anulaciones[0].recepcionId, 101);
  assert.equal(anulaciones[0].opciones.por, "ana@merka.co");
  assert.equal(anulaciones[0].opciones.motivo, "error de pesos");
  assert.equal(transiciones().length, 1);
  assert.equal(transiciones()[0].args.p_desde, "enviada");
  assert.equal(transiciones()[0].args.p_hacia, "anulada");
  assert.equal(tablas.carnes_preliquidacion_sedes[0].estado, "anulada");
});

test("F-S2: la recepción vuelve a Costeado y la bandera requiere_correccion se conserva hasta el reenvío", async () => {
  tablas.carnes_preliquidacion_sedes[0].requiere_correccion = true;
  tablas.carnes_preliquidacion_sedes[0].correccion_orden_version = 6;
  await anular();
  assert.equal(transiciones()[0].args.p_campos.recepcion_estado, "Costeado");
  assert.equal("requiere_correccion" in transiciones()[0].args.p_campos, false, "no se toca la bandera");
  assert.equal(tablas.carnes_recepciones[0].estado, "Costeado");
  assert.equal(tablas.carnes_preliquidacion_sedes[0].requiere_correccion, true);
  assert.equal(tablas.carnes_preliquidacion_sedes[0].correccion_orden_version, 6);
});

test("F-S2: una sede anulada nunca se envía sola: ni automática ni admin hasta recostear", () => {
  const anulada = sede({ estado: "anulada" });
  const header = cabecera();
  for (const origen of ["schedule", "sweep", "dispatch", "inmediato", "admin"]) {
    const d = puedeReclamar(anulada, { header, origen, corridaId: 1, siesaActivo: true, ahora: new Date() });
    assert.equal(d.ok, false, origen);
  }
  const plan = planearEnvios([anulada], { header, origen: "schedule", corrida: { id: 1, resumen: {} }, siesaActivo: true, ahora: new Date("2026-11-24T03:00:00Z") });
  assert.equal(plan.porEnviar.length, 0);
  assert.equal(plan.porCalcular.length, 0);
});

test("F-S2: solo se anula una sede enviada; en cualquier otro estado es 409 sede_no_enviada y no se escribe nada", async () => {
  for (const estado of ["vinculada", "calculada", "lista_para_enviar", "enviando", "sin_confirmar", "error", "bloqueada", "simulada"]) {
    rpcs = [];
    anulaciones = [];
    tablas.carnes_preliquidacion_sedes = [sede({ estado })];
    await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "sede_no_enviada", estado);
    assert.equal(transiciones().length, 0, estado);
    assert.equal(anulaciones.length, 0, estado);
  }
});

test("la preliquidación debe estar abierta; con la cabecera cerrada no se anula nada", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ estado: "cerrada" })];
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "no_abierta");
  assert.equal(anulaciones.length, 0);
  assert.equal(transiciones().length, 0);
});

test("una sede inexistente es 404", async () => {
  await assert.rejects(anular(999), (e) => e.statusCode === 404);
  assert.equal(anulaciones.length, 0);
});

// ─── F-S3: idempotencia ────────────────────────────────────────────────────

test("F-S3: repetir el clic sobre una sede ya anulada no escribe ni anula otra vez", async () => {
  await anular();
  anulaciones = [];
  rpcs = [];
  const segunda = await anular();
  assert.equal(segunda.resultado, "ya_anulada");
  assert.equal(segunda.estado, "anulada");
  assert.equal(anulaciones.length, 0);
  assert.equal(transiciones().length, 0);
});

test("F-S3: dos clics a la vez producen UNA sola transición; el perdedor responde ya_anulada", async () => {
  const [a, b] = await Promise.all([anular(), anular()]);
  assert.deepEqual([a.resultado, b.resultado].sort(), ["ok", "ya_anulada"]);
  assert.equal(tablas.carnes_preliquidacion_sedes[0].version, 8, "la versión sube una sola vez");
});

test("version_cambiada se reintenta releyendo la sede (hasta 3 veces) y luego es 409", async () => {
  manejadores.carnes_preliq_transicionar_sede = () => ({ resultado: "version_cambiada" });
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "version_cambiada");
  assert.equal(transiciones().length, 3);
});

// ─── F-S4: la anulación no se pudo registrar ───────────────────────────────

test("F-S4: si el registro de la anulación del envío falla, la sede sigue enviada y no hay transición", async () => {
  const fallo = async () => { throw new Error("no se pudo anular el envío"); };
  await assert.rejects(anular(11, { motivo: "x" }, { anularEnvio: fallo }), /no se pudo anular/);
  assert.equal(transiciones().length, 0);
  assert.equal(tablas.carnes_preliquidacion_sedes[0].estado, "enviada");
  assert.equal(tablas.carnes_recepciones[0].estado, "Enviado_SIESA");
});

test("F-S4: mientras la sede está enviada (anulación sin confirmar) no hay un nuevo envío: nada la reclama", () => {
  const header = cabecera();
  for (const origen of ["schedule", "admin"]) {
    const d = puedeReclamar(sede({ estado: "enviada" }), { header, origen, corridaId: 1, siesaActivo: true, ahora: new Date() });
    assert.equal(d.ok, false, origen);
  }
});

test("F-S4: reintentar tras un fallo completa la anulación sin duplicar nada", async () => {
  let intento = 0;
  const unaFalla = async (...a) => { intento += 1; if (intento === 1) throw new Error("caído"); return anularEnvioOk(...a); };
  await assert.rejects(anular(11, { motivo: "x" }, { anularEnvio: unaFalla }));
  const r = await anular(11, { motivo: "x" }, { anularEnvio: unaFalla });
  assert.equal(r.resultado, "ok");
  assert.equal(transiciones().length, 1);
});

// ─── Descartar la corrección ───────────────────────────────────────────────

test("descartar la corrección limpia requiere_correccion y correccion_orden_version con CAS de estado", async () => {
  tablas.carnes_preliquidacion_sedes = [sede({ estado: "enviada", requiere_correccion: true, correccion_orden_version: 6 })];
  const r = await Correcciones.descartarCorreccion(11, { por: "ana@merka.co", motivo: "el cambio no afecta lo enviado" }, { log: silencio });
  assert.equal(r.resultado, "ok");
  assert.equal(r.estado, "enviada");
  assert.equal(transiciones()[0].args.p_desde, "enviada");
  assert.equal(transiciones()[0].args.p_hacia, "enviada");
  assert.equal(transiciones()[0].args.p_campos.requiere_correccion, false);
  assert.equal(transiciones()[0].args.p_campos.correccion_orden_version, null);
  assert.equal("recepcion_estado" in transiciones()[0].args.p_campos, false, "no toca la recepción");
  assert.equal(tablas.carnes_preliquidacion_sedes[0].requiere_correccion, false);
});

test("descartar funciona en cualquier estado con la bandera (p. ej. sin_confirmar)", async () => {
  tablas.carnes_preliquidacion_sedes = [sede({ estado: "sin_confirmar", requiere_correccion: true, correccion_orden_version: 6 })];
  const r = await Correcciones.descartarCorreccion(11, { motivo: "ok por ahora" }, { log: silencio });
  assert.equal(r.estado, "sin_confirmar");
});

test("descartar sin bandera es 409 sin_correccion y no escribe", async () => {
  await assert.rejects(
    Correcciones.descartarCorreccion(11, { motivo: "nada" }, { log: silencio }),
    (e) => e.statusCode === 409 && e.codigo === "sin_correccion",
  );
  assert.equal(transiciones().length, 0);
});

test("descartar: sede inexistente 404 y version_cambiada se reintenta releyendo", async () => {
  await assert.rejects(Correcciones.descartarCorreccion(999, { motivo: "nada" }, { log: silencio }), (e) => e.statusCode === 404);
  tablas.carnes_preliquidacion_sedes = [sede({ requiere_correccion: true, correccion_orden_version: 6 })];
  let n = 0;
  manejadores.carnes_preliq_transicionar_sede = (a) => (++n === 1 ? { resultado: "version_cambiada" } : rpcTransicionar(a));
  const r = await Correcciones.descartarCorreccion(11, { motivo: "nada" }, { log: silencio });
  assert.equal(r.resultado, "ok");
  assert.equal(n, 2);
});
