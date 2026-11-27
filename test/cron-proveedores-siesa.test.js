// POST /api/cron/proveedores-siesa: autenticación por CRON_SECRET, 503 sin secreto, paso del
// resultado del barrido y 500 si la lectura falla. El barrido es falso: sin base, sin red.
import test, { mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

let barridos = 0;
let respuesta;
const real = await import(url("services/alertasSiesaProveedor.js"));
mock.module(url("services/alertasSiesaProveedor.js"), {
  namedExports: {
    ...real,
    barrerProveedoresSinSiesa: async () => {
      barridos += 1;
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    },
  },
});
mock.module(url("services/preliquidacionCron.js"), {
  namedExports: { validarCuerpoCron: () => ({ ok: true, valor: {} }), ejecutarCron: async () => ({ ok: true }) },
});

const { default: express } = await import("express");
const { default: router } = await import(url("routes/cron.routes.js"));
const { errorHandler } = await import(url("middleware/errorHandler.js"));

const app = express();
app.use(express.json());
app.use("/cron", router);
app.use(errorHandler);
const servidor = http.createServer(app);
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${servidor.address().port}/cron/proveedores-siesa`;
after(() => servidor.close());

const llamar = async ({ token } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = token;
  const r = await fetch(base, { method: "POST", headers, body: "{}" });
  return { estado: r.status, json: await r.json() };
};

const silenciar = console.error;
beforeEach(() => {
  barridos = 0;
  respuesta = { ok: true, revisadas: 0, enviadas: 0, pendientes: 0 };
  process.env.CRON_SECRET = "secreto-de-prueba";
  console.error = () => {};
});
after(() => { console.error = silenciar; });

test("sin Authorization: 401 y no barre", async () => {
  assert.equal((await llamar()).estado, 401);
  assert.equal(barridos, 0);
});

test("token incorrecto o de otra longitud: 401 sin barrer", async () => {
  for (const token of ["Bearer otro", "Bearer ", "Bearer " + "a".repeat(5000), "secreto-de-prueba"]) {
    assert.equal((await llamar({ token })).estado, 401, token.slice(0, 20));
  }
  assert.equal(barridos, 0);
});

test("sin CRON_SECRET configurado: 503 aunque llegue un token", async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await llamar({ token: "Bearer lo-que-sea" })).estado, 503);
  process.env.CRON_SECRET = "  ";
  assert.equal((await llamar({ token: "Bearer   " })).estado, 503);
  assert.equal(barridos, 0);
});

test("token correcto: barre y devuelve el resultado tal cual", async () => {
  respuesta = { ok: true, revisadas: 3, enviadas: 2, pendientes: 0 };
  const r = await llamar({ token: "Bearer secreto-de-prueba" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, respuesta);
  assert.equal(barridos, 1);
});

test("una falla de lectura del barrido es 500 (el workflow la ve como error)", async () => {
  respuesta = new Error("base caída");
  assert.equal((await llamar({ token: "Bearer secreto-de-prueba" })).estado, 500);
});
