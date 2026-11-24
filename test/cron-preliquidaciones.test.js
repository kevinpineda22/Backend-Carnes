// POST /api/cron/preliquidaciones: autenticación por CRON_SECRET (D-S8), 503 sin secreto,
// validación del cuerpo y paso del resultado del orquestador. El orquestador es falso:
// sin base, sin red, sin SIESA.
import test, { mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import http from "node:http";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

let ejecuciones = [];
let respuesta = { ok: true, flag: "on", corrida_id: 9, procesadas: [], pendientes: 0, presupuesto_agotado: false };
const real = await import(url("services/preliquidacionCron.js"));
mock.module(url("services/preliquidacionCron.js"), {
  namedExports: {
    validarCuerpoCron: real.validarCuerpoCron,
    ejecutarCron: async (entrada) => {
      ejecuciones.push(entrada);
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    },
  },
});

const { default: express } = await import("express");
const { default: router, secretoValido } = await import(url("routes/cron.routes.js"));
const { errorHandler } = await import(url("middleware/errorHandler.js"));

const app = express();
app.use(express.json());
app.use("/cron", router);
app.use(errorHandler);
const servidor = http.createServer(app);
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${servidor.address().port}/cron/preliquidaciones`;
after(() => servidor.close());

const llamar = async ({ token, cuerpo, crudo } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = token;
  const r = await fetch(base, { method: "POST", headers, body: crudo ?? (cuerpo === undefined ? undefined : JSON.stringify(cuerpo)) });
  return { estado: r.status, json: await r.json() };
};

const silenciar = console.error;
beforeEach(() => {
  ejecuciones = [];
  respuesta = { ok: true, flag: "on", corrida_id: 9, procesadas: [], pendientes: 0, presupuesto_agotado: false };
  process.env.CRON_SECRET = "secreto-de-prueba";
  console.error = () => {};
});
after(() => { console.error = silenciar; });

test("D-S8: sin Authorization responde 401 y no ejecuta nada", async () => {
  const r = await llamar();
  assert.equal(r.estado, 401);
  assert.equal(ejecuciones.length, 0);
});

test("D-S8: token incorrecto responde 401 sin tocar la base", async () => {
  const r = await llamar({ token: "Bearer otro-secreto" });
  assert.equal(r.estado, 401);
  assert.equal(ejecuciones.length, 0);
});

test("token de otra longitud: 401, sin lanzar (compara digests SHA-256)", async () => {
  for (const token of ["Bearer x", "Bearer " + "a".repeat(5000), "Bearer ", "secreto-de-prueba", "Basic secreto-de-prueba"]) {
    const r = await llamar({ token });
    assert.equal(r.estado, 401, token.slice(0, 20));
  }
  assert.equal(ejecuciones.length, 0);
});

test("sin CRON_SECRET configurado: 503 aunque llegue un token", async () => {
  delete process.env.CRON_SECRET;
  const r = await llamar({ token: "Bearer lo-que-sea" });
  assert.equal(r.estado, 503);
  assert.equal(ejecuciones.length, 0);
  process.env.CRON_SECRET = "   ";
  assert.equal((await llamar({ token: "Bearer    " })).estado, 503);
});

test("token correcto: ejecuta con valores por defecto y devuelve el contrato", async () => {
  const r = await llamar({ token: "Bearer secreto-de-prueba" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, respuesta);
  assert.deepEqual(ejecuciones[0], { especie: undefined, dryRun: false, origen: "schedule", ghRunId: null, corridaId: null });
});

test("el cuerpo se traduce: especie, dry_run, origen, gh_run_id y corrida_id", async () => {
  await llamar({
    token: "Bearer secreto-de-prueba",
    cuerpo: { especie: "cerdo", dry_run: true, origen: "dispatch", gh_run_id: "42", corrida_id: 7 },
  });
  assert.deepEqual(ejecuciones[0], { especie: "cerdo", dryRun: true, origen: "dispatch", ghRunId: "42", corridaId: 7 });
});

test("cuerpo inválido: 400 y no ejecuta", async () => {
  const r = await llamar({ token: "Bearer secreto-de-prueba", cuerpo: { especie: "vaca" } });
  assert.equal(r.estado, 400);
  assert.equal(ejecuciones.length, 0);
});

test("flag apagado: pasa tal cual {ok:true, flag:'off', motivo}", async () => {
  respuesta = { ok: true, flag: "off", motivo: "flag_apagado" };
  const r = await llamar({ token: "Bearer secreto-de-prueba" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, respuesta);
});

test("una falla total del orquestador es 500 (el workflow la ve como error)", async () => {
  respuesta = new Error("base caída");
  const r = await llamar({ token: "Bearer secreto-de-prueba" });
  assert.equal(r.estado, 500);
});

test("secretoValido: compara por digest y no lanza con longitudes distintas", () => {
  assert.equal(secretoValido("Bearer abc", "abc"), true);
  assert.equal(secretoValido("Bearer abcd", "abc"), false);
  assert.equal(secretoValido(undefined, "abc"), false);
  assert.equal(secretoValido("abc", "abc"), false);
});

test("el cron se monta ANTES de autenticar (usa CRON_SECRET, no la sesión)", () => {
  const indice = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
  const cron = indice.indexOf('router.use("/cron"');
  const autenticar = indice.indexOf("router.use(autenticar)");
  assert.ok(cron > -1, "falta montar /cron");
  assert.ok(cron < autenticar, "/cron debe ir antes de autenticar");
});
