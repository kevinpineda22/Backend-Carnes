// enviarOficialRecepcion (una CEA oficial por sede de preliquidación) y el hook de
// resolver() hacia la sede, con supabase y SIESA FALSOS: nada sale a la red.
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
let rpcLlamadas = [];
let rpcRespuesta = { resultado: "ok" };

class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.pay = null; this.ord = []; this.lim = null; }
  select() { return this; }
  insert(p) { this.op = "insert"; this.pay = p; return this; }
  update(p) { this.op = "update"; this.pay = p; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v) && r[c] != null); return this; }
  in(c, a) { this.f.push((r) => r[c] != null && a.map(String).includes(String(r[c]))); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  run() {
    const tabla = (db[this.t] ??= []);
    let rows = tabla.filter((r) => this.f.every((g) => g(r)));
    if (this.op === "insert") {
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

const M = await import(url("models/SiesaEnvio.model.js"));
const nuevo = () => { reiniciar(); llamadas = []; guion = []; correosAnulacion = []; correosError = []; rpcLlamadas = []; rpcRespuesta = { resultado: "ok" }; };
const oficiales = () => db.carnes_siesa_envios.filter((f) => f.tipo === "oficial");

// ─── enviarOficialRecepcion ────────────────────────────────────────────────

test("ok: una oficial por recepción, con la referencia de la inicial, y sale el aviso de anulación", async () => {
  nuevo();
  const r = await M.enviarOficialRecepcion(2, { por: "sistema", timeoutMs: 45000 });
  assert.equal(r.fila.estado, "ok");
  assert.equal(r.fila.tipo, "oficial");
  assert.equal(r.fila.recepcion_id, 2);
  assert.equal(r.fila.liquidacion_id, null);
  assert.deepEqual(r.armadoBloqueos, []);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].opts.timeoutMs, 45000, "el presupuesto de tiempo viaja a SIESA");
  assert.equal(correosAnulacion.length, 1);
  assert.equal(correosAnulacion[0].inicial.id, 1);
  assert.equal(oficiales()[0].aviso_anulacion, true);
});

test("sin timeoutMs se usa el de la oficial", async () => {
  nuevo();
  await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(llamadas[0].opts.timeoutMs, 240000);
});

test("repetido: ya hay una oficial vigente, no se manda ni se avisa otra vez", async () => {
  nuevo();
  db.carnes_siesa_envios.push({
    id: 5, tipo: "oficial", estado: "ok", recepcion_id: 2, liquidacion_id: null,
    referencia: "TC OFI R2", enviado_at: "2026-11-20T02:00:00Z",
  });
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.repetido, true);
  assert.equal(r.fila.estado, "ok");
  assert.equal(llamadas.length, 0);
  assert.equal(correosAnulacion.length, 0);
});

test("repetido en vuelo: devuelve la fila enviando sin mandar", async () => {
  nuevo();
  db.carnes_siesa_envios.push({
    id: 5, tipo: "oficial", estado: "enviando", recepcion_id: 2, liquidacion_id: null,
    referencia: "TC OFI R2", enviado_at: new Date().toISOString(),
  });
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.repetido, true);
  assert.equal(r.fila.estado, "enviando");
  assert.equal(llamadas.length, 0);
});

test("sin_confirmar: no hay aviso de anulación hasta que una persona lo resuelva", async () => {
  nuevo();
  guion = [{ ok: false, incierto: true, error: "timeout" }];
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.estado, "sin_confirmar");
  assert.equal(correosAnulacion.length, 0);
});

test("error: SIESA rechaza, queda la fila en error y no hay aviso de anulación", async () => {
  nuevo();
  guion = [{ ok: false, error: "Item inválido" }];
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.estado, "error");
  assert.equal(r.fila.http_status, 400);
  assert.equal(correosAnulacion.length, 0);
  assert.equal(oficiales().length, 1);
});

test("armado con bloqueos: no se llama a SIESA y los bloqueos se devuelven aparte", async () => {
  nuevo();
  db.carnes_recepciones[0].sede.bodega_siesa = null;
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(llamadas.length, 0);
  assert.equal(r.fila.estado, "error");
  assert.equal(r.armadoBloqueos.length, 1);
  assert.match(r.armadoBloqueos[0], /bodega/);
  assert.equal(correosAnulacion.length, 0);
});

test("sin inicial ok la oficial igual se arma (la compuerta la hace la RPC de reclamo)", async () => {
  nuevo();
  db.carnes_siesa_envios = [];
  const r = await M.enviarOficialRecepcion(2, { por: "sistema" });
  assert.equal(r.fila.estado, "ok");
  assert.equal(correosAnulacion.length, 1);
  assert.equal(correosAnulacion[0].inicial, null);
});

test("recepción inexistente: lanza 404 como el resto de los envíos", async () => {
  nuevo();
  await assert.rejects(() => M.enviarOficialRecepcion(99, { por: "x" }), /no encontrada/i);
});

test("enviarOficial (por fecha) sigue exportada y sin cambios de firma", () => {
  assert.equal(typeof M.enviarOficial, "function");
  assert.equal(M.enviarOficial.length, 3);
});

// ─── Hook de resolver() hacia la sede de preliquidación ────────────────────

const sedeConEnvio = (extra = {}) => ({
  id: 77, preliquidacion_id: 9, recepcion_id: 2, estado: "sin_confirmar", envio_id: 50, version: 4,
  requiere_correccion: false, claim_costeo_orden_version: 3, correccion_orden_version: null, ...extra,
});
const envioSinConfirmar = () => ({
  id: 50, tipo: "oficial", estado: "sin_confirmar", recepcion_id: 2, liquidacion_id: null,
  referencia: "TC OFI R2", enviado_at: new Date().toISOString(),
});

test("resolver ok: la sede que referencia el envío pasa a enviada por el CAS de la RPC", async () => {
  nuevo();
  db.carnes_siesa_envios.push(envioSinConfirmar());
  db.carnes_preliquidacion_sedes = [sedeConEnvio()];
  await M.resolver(50, { resultado: "ok", por: "admin" });
  assert.equal(rpcLlamadas.length, 1);
  const { nombre, args } = rpcLlamadas[0];
  assert.equal(nombre, "carnes_preliq_sincronizar_envio");
  assert.equal(args.p_envio_id, 50);
  assert.equal(args.p_sede_version, 4);
  assert.equal(args.p_desde, "sin_confirmar");
  assert.equal(args.p_hacia, "enviada");
  assert.equal(args.p_campos.recepcion_estado, "Enviado_SIESA");
  assert.equal(args.p_campos.requiere_correccion, false);
  assert.equal("estado" in args.p_campos, false, "el estado va en p_hacia, no en p_campos");
});

test("resolver no_llego: la sede queda en error permanente (solo el admin la reenvía)", async () => {
  nuevo();
  db.carnes_siesa_envios.push(envioSinConfirmar());
  db.carnes_preliquidacion_sedes = [sedeConEnvio()];
  await M.resolver(50, { resultado: "no_llego", por: "admin" });
  const { args } = rpcLlamadas[0];
  assert.equal(args.p_hacia, "error");
  assert.equal(args.p_campos.error_tipo, "permanente");
});

test("resolver ok con requiere_correccion y claim anterior al recálculo: conserva el flag (M2)", async () => {
  nuevo();
  db.carnes_siesa_envios.push(envioSinConfirmar());
  db.carnes_preliquidacion_sedes = [
    sedeConEnvio({ requiere_correccion: true, claim_costeo_orden_version: 3, correccion_orden_version: 5 }),
  ];
  await M.resolver(50, { resultado: "ok" });
  const { args } = rpcLlamadas[0];
  assert.equal(args.p_hacia, "enviada");
  assert.equal("requiere_correccion" in args.p_campos, false);
});

test("resolver sin sede de preliquidación: no llama a la RPC (envíos legados intactos)", async () => {
  nuevo();
  db.carnes_siesa_envios.push(envioSinConfirmar());
  await M.resolver(50, { resultado: "ok" });
  assert.equal(rpcLlamadas.length, 0);
});

test("resolver: un fallo de la sincronización no rompe la resolución del envío", async () => {
  nuevo();
  db.carnes_siesa_envios.push(envioSinConfirmar());
  db.carnes_preliquidacion_sedes = [sedeConEnvio()];
  const original = supabaseFalso.rpc;
  supabaseFalso.rpc = async () => { throw new Error("red caída"); };
  try {
    const data = await M.resolver(50, { resultado: "ok" });
    assert.equal(data.estado, "ok");
  } finally {
    supabaseFalso.rpc = original;
  }
});

test("resolver: version_cambiada se reintenta releyendo la sede (máx. 3)", async () => {
  nuevo();
  db.carnes_siesa_envios.push(envioSinConfirmar());
  db.carnes_preliquidacion_sedes = [sedeConEnvio()];
  rpcRespuesta = { resultado: "version_cambiada" };
  await M.resolver(50, { resultado: "ok" });
  assert.equal(rpcLlamadas.length, 3);
});
