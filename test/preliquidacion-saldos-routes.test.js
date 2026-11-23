// Saldos pendientes (3.8): GET /saldos?especie= y PATCH /saldos/:id (editar, descartar, mover) sobre el
// router real, el modelo real y una base falsa con las RPC de saldos (041). Escenarios E-S3 a E-S6.
// El saldo es la única fuente: el banner sale de los saldos `pendiente`. Nada de esto toca SIESA.
import test, { mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;
const sqlDe = (nombre) => readFileSync(fileURLToPath(new URL(`../sql/${nombre}`, import.meta.url)), "utf8");

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

// ─── Base falsa ────────────────────────────────────────────────────────────

let tablas = {};
let rpcs = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))).map((r) => ({ ...r })); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
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
mock.module(url("models/PreliquidacionVigilancia.model.js"), {
  namedExports: { revisarCorridasPerdidas: async () => ({ perdidas: [] }), escanearVentanas: async () => ({ vencidas: [], avisadas: [] }) },
});
mock.module(url("models/PreliquidacionRetomas.model.js"), {
  namedExports: { obtenerRetomas: async () => ({}), guardarRetomas: async () => ({}) },
});
let guardPasa = true;
mock.module(url("middleware/authCarnes.js"), {
  namedExports: {
    requireAdminCarnes: (_req, res, next) => (guardPasa ? next() : res.status(403).json({ ok: false })),
    autenticar: (_req, _res, next) => next(),
  },
});

const { default: express } = await import("express");
const { default: router } = await import(url("routes/preliquidaciones.routes.js"));
const { errorHandler } = await import(url("middleware/errorHandler.js"));

const app = express();
app.use(express.json());
app.use("/preliquidaciones", router);
app.use(errorHandler);
const servidor = http.createServer(app);
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${servidor.address().port}/preliquidaciones`;
after(() => servidor.close());

const llamar = async (metodo, ruta, cuerpo) => {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { estado: r.status, json: await r.json() };
};

const silenciar = console.error;
const encendida = () => { process.env.CARNES_PRELIQUIDACION = "on"; };

const saldo = (extra = {}) => ({
  id: 1, origen_preliquidacion_id: 10, especie: "res", valor: "200000.00", destino_preliquidacion_id: null,
  estado: "pendiente", ajuste_de_saldo_id: null, movido_a_saldo_id: null, alterna_id: 3, editado_por: null,
  created_at: "2026-11-24T03:00:00Z", updated_at: "2026-11-24T03:00:00Z", ...extra,
});
const preliq = (extra = {}) => ({
  id: 10, especie: "res", estado: "abierta", animales: 10, animal_en_pie: "9000000.00", servicio_precorte: "500000.00",
  servicio_por_animal: "50000.00", liquidada_at: null, version: 1, orden_version: 1, tercero_id: "frigorifico", ...extra,
});

beforeEach(() => {
  rpcs = [];
  manejadores = {};
  guardPasa = true;
  delete process.env.CARNES_PRELIQUIDACION;
  delete process.env.VERCEL_ENV;
  console.error = () => {};
  tablas = {
    carnes_preliquidaciones: [preliq({ id: 10 }), preliq({ id: 11 }), preliq({ id: 12, especie: "cerdo" })],
    carnes_preliquidacion_saldos: [],
    carnes_preliquidacion_gastos: [],
    carnes_preliquidacion_sedes: [],
    carnes_preliquidacion_retomas: [],
    carnes_recepciones: [],
    carnes_recepcion_items: [],
  };
});
after(() => { console.error = silenciar; });

const rpcDe = (n) => rpcs.filter((r) => r.nombre === n);

// ─── GET /saldos y el banner ───────────────────────────────────────────────

test("E-S5: GET /saldos?especie= devuelve los saldos pendientes de la especie con el banner (monto, origen, destino)", async () => {
  tablas.carnes_preliquidacion_saldos = [
    saldo({ id: 1, valor: "200000.00", destino_preliquidacion_id: null }),
    saldo({ id: 2, valor: "-100000.00", destino_preliquidacion_id: 11 }),
    saldo({ id: 3, especie: "cerdo", origen_preliquidacion_id: 12, valor: "50000.00" }),
    saldo({ id: 4, estado: "aplicado", destino_preliquidacion_id: 11 }),
  ];
  const r = await llamar("GET", "/saldos?especie=res");
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json.data.saldos.map((s) => s.id), [1, 2]);
  assert.deepEqual(r.json.data.banner, {
    visible: true,
    cantidad: 2,
    total: "100000.00",
    items: [
      { saldo_id: 1, valor: "200000.00", especie: "res", origen_preliquidacion_id: 10, destino_preliquidacion_id: null },
      { saldo_id: 2, valor: "-100000.00", especie: "res", origen_preliquidacion_id: 10, destino_preliquidacion_id: 11 },
    ],
  });
  assert.equal(r.json.data.saldos[0].destino, null, "sin destino: espera una preliquidación nueva");
  assert.equal(r.json.data.saldos[1].destino.id, 11);
  assert.equal(r.json.data.saldos[0].origen.id, 10);
});

test("E-S5: el banner desaparece cuando ya no hay pendientes (aplicado, movido o descartado no cuentan)", async () => {
  tablas.carnes_preliquidacion_saldos = [
    saldo({ id: 1, estado: "aplicado", destino_preliquidacion_id: 11 }),
    saldo({ id: 2, estado: "movido", movido_a_saldo_id: 5 }),
    saldo({ id: 3, estado: "descartado" }),
  ];
  const r = await llamar("GET", "/saldos?especie=res");
  assert.deepEqual(r.json.data.saldos, []);
  assert.deepEqual(r.json.data.banner, { visible: false, cantidad: 0, total: "0.00", items: [] });
  const todos = await llamar("GET", "/saldos?especie=res&estado=todos");
  assert.deepEqual(todos.json.data.saldos.map((s) => s.id), [1, 2, 3], "con estado=todos se ve el historial");
});

test("GET /saldos sin especie lista las dos; especie o estado inválidos son 400; el guard de admin protege la ruta", async () => {
  tablas.carnes_preliquidacion_saldos = [saldo({ id: 1 }), saldo({ id: 2, especie: "cerdo", origen_preliquidacion_id: 12 })];
  assert.equal((await llamar("GET", "/saldos")).json.data.saldos.length, 2);
  assert.equal((await llamar("GET", "/saldos?especie=ovino")).estado, 400);
  assert.equal((await llamar("GET", "/saldos?estado=raro")).estado, 400);
  guardPasa = false;
  assert.equal((await llamar("GET", "/saldos")).estado, 403);
});

test("GET /saldos es lectura: funciona con el interruptor apagado", async () => {
  tablas.carnes_preliquidacion_saldos = [saldo({ id: 1 })];
  assert.equal((await llamar("GET", "/saldos?especie=res")).estado, 200);
});

test("E-S3: el saldo pendiente dirigido a una preliquidación entra en su gasto total (9.000.000 + 500.000 + 200.000)", async () => {
  tablas.carnes_preliquidacion_saldos = [saldo({ id: 1, valor: "200000.00", destino_preliquidacion_id: 11 })];
  const r = await llamar("GET", "/11");
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.calculo.gasto_total, "9700000.00");
  assert.deepEqual(r.json.data.saldos.map((s) => s.id), [1], "el saldo viaja en el payload para el banner");
});

// ─── PATCH /saldos/:id ─────────────────────────────────────────────────────

test("E-S4: editar un saldo pendiente llama a saldo_editar con el valor nuevo y quién lo hace", async () => {
  encendida();
  manejadores.carnes_preliq_saldo_editar = () => ({ resultado: "ok", saldo_id: 1, destino_id: 11 });
  const r = await llamar("PATCH", "/saldos/1", { valor: 150000 });
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.resultado, "ok");
  assert.deepEqual(rpcDe("carnes_preliq_saldo_editar")[0].args, { p_saldo_id: 1, p_valor: 150000, p_por: null });
});

test("E-S4: un saldo negativo se puede editar (el servicio real puede ser menor al aplicado)", async () => {
  encendida();
  const r = await llamar("PATCH", "/saldos/1", { valor: "-100000.50" });
  assert.equal(r.estado, 200);
  assert.equal(rpcDe("carnes_preliq_saldo_editar")[0].args.p_valor, "-100000.50");
});

test("E-S4: quitar el saldo llama a saldo_descartar", async () => {
  encendida();
  const r = await llamar("PATCH", "/saldos/1", { descartar: true });
  assert.equal(r.estado, 200);
  assert.deepEqual(rpcDe("carnes_preliq_saldo_descartar")[0].args, { p_saldo_id: 1, p_por: null });
  assert.equal(rpcs.length, 1);
});

test("E-S4: mover el saldo a otra preliquidación llama a saldo_mover", async () => {
  encendida();
  manejadores.carnes_preliq_saldo_mover = () => ({ resultado: "ok", saldo_id: 9, saldo_anterior_id: 1, destino_id: 11 });
  const r = await llamar("PATCH", "/saldos/1", { destino_id: 11 });
  assert.equal(r.estado, 200);
  assert.deepEqual(rpcDe("carnes_preliq_saldo_mover")[0].args, { p_saldo_id: 1, p_destino_id: 11, p_por: null });
  assert.equal(r.json.data.saldo_id, 9);
});

test("E-S6: mover un saldo de res a una preliquidación de cerdo se rechaza (422 especie_distinta)", async () => {
  encendida();
  manejadores.carnes_preliq_saldo_mover = () => ({ resultado: "especie_distinta" });
  const r = await llamar("PATCH", "/saldos/1", { destino_id: 12 });
  assert.equal(r.estado, 422);
  assert.equal(r.json.codigo, "especie_distinta");
});

test("las ediciones solo afectan lo pendiente: un saldo ya aplicado responde 409 no_pendiente (editar, quitar y mover)", async () => {
  encendida();
  for (const [metodo, cuerpo] of [["editar", { valor: 1 }], ["descartar", { descartar: true }], ["mover", { destino_id: 11 }]]) {
    manejadores[`carnes_preliq_saldo_${metodo}`] = () => ({ resultado: "no_pendiente" });
    const r = await llamar("PATCH", "/saldos/1", cuerpo);
    assert.equal(r.estado, 409, metodo);
    assert.equal(r.json.codigo, "no_pendiente", metodo);
  }
});

test("errores de la RPC: destino_liquidada 409, destino_invalido 422, no_encontrada 404, sin_cambios es 200", async () => {
  encendida();
  const casos = [["destino_liquidada", 409], ["destino_invalido", 422], ["no_encontrada", 404]];
  for (const [resultado, estado] of casos) {
    manejadores.carnes_preliq_saldo_mover = () => ({ resultado });
    const r = await llamar("PATCH", "/saldos/1", { destino_id: 11 });
    assert.equal(r.estado, estado, resultado);
    assert.equal(r.json.codigo, resultado);
  }
  manejadores.carnes_preliq_saldo_editar = () => ({ resultado: "sin_cambios" });
  const sin = await llamar("PATCH", "/saldos/1", { valor: 200000 });
  assert.equal(sin.estado, 200);
  assert.equal(sin.json.data.resultado, "sin_cambios");
});

test("version_cambiada se reintenta y luego es 409", async () => {
  encendida();
  let n = 0;
  manejadores.carnes_preliq_saldo_descartar = () => (++n < 2 ? { resultado: "version_cambiada" } : { resultado: "ok", saldo_id: 1 });
  assert.equal((await llamar("PATCH", "/saldos/1", { descartar: true })).estado, 200);
  assert.equal(n, 2);
  manejadores.carnes_preliq_saldo_descartar = () => ({ resultado: "version_cambiada" });
  rpcs = [];
  const r = await llamar("PATCH", "/saldos/1", { descartar: true });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "version_cambiada");
  assert.equal(rpcDe("carnes_preliq_saldo_descartar").length, 3);
});

test("el cuerpo debe traer EXACTAMENTE una acción válida; lo demás es 400 sin llegar a la RPC", async () => {
  encendida();
  for (const cuerpo of [
    {}, { valor: 1, descartar: true }, { valor: 1, destino_id: 2 }, { descartar: false }, { descartar: true, destino_id: 2 },
    { valor: "abc" }, { valor: 1e15 }, { valor: "1.234" }, { destino_id: 0 }, { destino_id: "x" }, { valor: 1, extra: 1 },
  ]) {
    assert.equal((await llamar("PATCH", "/saldos/1", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await llamar("PATCH", "/saldos/abc", { descartar: true })).estado, 400);
  assert.deepEqual(rpcs, []);
  guardPasa = false;
  assert.equal((await llamar("PATCH", "/saldos/1", { descartar: true })).estado, 403);
});

test("PATCH /saldos/:id es una escritura normal: apagado 409 preliquidacion_apagada; producción sin CARNES_AUTH=exigir 503 primero", async () => {
  const apagado = await llamar("PATCH", "/saldos/1", { descartar: true });
  assert.equal(apagado.estado, 409);
  assert.equal(apagado.json.codigo, "preliquidacion_apagada");
  encendida();
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  const sinAuth = await llamar("PATCH", "/saldos/1", { descartar: true });
  assert.equal(sinAuth.estado, 503);
  assert.equal(sinAuth.json.codigo, "auth_requerida");
  assert.deepEqual(rpcs, []);
});

// ─── Lo que hace la base (estático; las carreras reales van en test/sql/041a) ──

test("E-S5: crear una preliquidación adjunta los saldos pendientes SIN destino de su MISMA especie", () => {
  const sql = sqlDe("039_preliquidacion_rpc.sql");
  assert.match(
    sql,
    /UPDATE carnes_preliquidacion_saldos\s+SET destino_preliquidacion_id = v_id\s+WHERE destino_preliquidacion_id IS NULL\s+AND especie = p_especie\s+AND estado = 'pendiente'/,
  );
});

test("cada toque de un saldo sube la versión del destino (editar, descartar, mover)", () => {
  const sql = sqlDe("041_preliquidacion_rpc_correcciones.sql");
  for (const nombre of ["carnes_preliq_saldo_editar", "carnes_preliq_saldo_descartar", "carnes_preliq_saldo_mover"]) {
    const ini = sql.indexOf(`CREATE OR REPLACE FUNCTION ${nombre}`);
    const fin = sql.indexOf("$fn$ LANGUAGE plpgsql;", ini);
    assert.match(sql.slice(ini, fin), /UPDATE carnes_preliquidaciones SET version = version \+ 1 WHERE id/, nombre);
  }
});

// ─── E-S4: el efecto en el gasto del destino (lo que la base deja tras la RPC) ──

const gastoDe = async (id) => (await llamar("GET", `/${id}`)).json.data.calculo.gasto_total;

test("E-S4: editar el saldo a 150.000 mueve el gasto del destino; quitarlo lo devuelve a la base", async () => {
  tablas.carnes_preliquidacion_saldos = [saldo({ id: 1, valor: "200000.00", destino_preliquidacion_id: 11 })];
  assert.equal(await gastoDe(11), "9700000.00");
  tablas.carnes_preliquidacion_saldos[0].valor = "150000.00"; // estado tras carnes_preliq_saldo_editar
  assert.equal(await gastoDe(11), "9650000.00");
  tablas.carnes_preliquidacion_saldos[0].estado = "descartado"; // tras carnes_preliq_saldo_descartar
  assert.equal(await gastoDe(11), "9500000.00");
});

test("E-S4: mover el saldo a otra preliquidación abierta cambia el gasto de ambas, solo las sin liquidar", async () => {
  tablas.carnes_preliquidaciones.push(preliq({ id: 13 }));
  tablas.carnes_preliquidacion_saldos = [
    saldo({ id: 1, estado: "movido", movido_a_saldo_id: 2, destino_preliquidacion_id: 11 }),
    saldo({ id: 2, destino_preliquidacion_id: 13 }),
  ];
  assert.equal(await gastoDe(11), "9500000.00");
  assert.equal(await gastoDe(13), "9700000.00");
});

test("E-S4: una preliquidación ya liquidada conserva su gasto congelado aunque cambien los saldos", async () => {
  tablas.carnes_preliquidaciones.push(
    preliq({ id: 14, liquidada_at: "2026-11-24T02:31:00.000Z", gasto_total_aplicado: "9700000.00", servicio_aplicado: "500000.00", costo_por_animal: "970000.00" }),
  );
  tablas.carnes_preliquidacion_saldos = [saldo({ id: 1, estado: "aplicado", destino_preliquidacion_id: 14 })];
  assert.equal(await gastoDe(14), "9700000.00");
  tablas.carnes_preliquidacion_saldos.push(saldo({ id: 2, valor: "999999.00", destino_preliquidacion_id: 14 }));
  assert.equal(await gastoDe(14), "9700000.00", "un saldo pendiente nuevo no reabre lo congelado");
});
