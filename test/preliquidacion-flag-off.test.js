// Paridad con el interruptor apagado (A-S6, H1): con CARNES_PRELIQUIDACION apagado
// nada crea ni vincula preliquidaciones (ni siquiera toca la base) y el código de los
// flujos legados no depende del interruptor. Router, controlador, validadores y modelo
// son los REALES; solo Supabase y el guard de admin son falsos. Sin red ni base real.
import test, { mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let accesosBase = [];
const registrar = (tipo, nombre) => {
  accesosBase.push(`${tipo}:${nombre}`);
};
const consultaVacia = () => {
  const q = {
    select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
    update: () => q, insert: () => q, upsert: () => q, delete: () => q,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
  };
  return q;
};
mock.module(url("config/supabase.js"), {
  namedExports: {
    supabase: {
      from: (t) => { registrar("from", t); return consultaVacia(); },
      rpc: async (n) => { registrar("rpc", n); return { data: { resultado: "ok" }, error: null }; },
    },
  },
});
mock.module(url("middleware/authCarnes.js"), {
  namedExports: { requireAdminCarnes: (_q, _s, next) => next(), autenticar: (_q, _s, next) => next() },
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

const consolaError = console.error;
beforeEach(() => {
  accesosBase = [];
  delete process.env.CARNES_PRELIQUIDACION;
  console.error = () => {};
});
after(() => { console.error = consolaError; });

test("apagado por defecto: crear responde 409 preliquidacion_apagada sin tocar la base", async () => {
  const r = await llamar("POST", "/", { especie: "res", animales: 10, animal_en_pie: 1000000 });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.deepEqual(accesosBase, []);
});

test("apagado por defecto: vincular responde 409 sin tocar la base", async () => {
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10, 11] });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.deepEqual(accesosBase, []);
});

test("cualquier valor que no sea afirmativo deja el módulo apagado", async () => {
  for (const valor of ["", "off", "false", "0", "no"]) {
    process.env.CARNES_PRELIQUIDACION = valor;
    const r = await llamar("POST", "/", { especie: "res", animales: 3 });
    assert.equal(r.estado, 409, `valor ${JSON.stringify(valor)}`);
  }
  assert.deepEqual(accesosBase, []);
});

test("encendido el mismo POST sí llega a la base (el 409 es solo del interruptor)", async () => {
  process.env.CARNES_PRELIQUIDACION = "on";
  await llamar("POST", "/", { especie: "res", animales: 3 });
  assert.ok(accesosBase.includes("rpc:carnes_preliq_crear"));
});

test("apagado: TODA escritura de /preliquidaciones responde 409 preliquidacion_apagada sin tocar la base", async () => {
  const escrituras = [
    ["POST", "/", { especie: "res", animales: 10, animal_en_pie: 1000000 }],
    ["PUT", "/config/res", { servicio_por_animal: 50000 }],
    ["PATCH", "/3", { servicio: 1000 }],
    ["PUT", "/3/gastos", { filas: [] }],
    ["PUT", "/3/retomas", { filas: [] }],
    ["POST", "/3/recepciones", { recepcion_ids: [10] }],
    ["DELETE", "/3/sedes/9"],
    // El 409 va antes que la validación: un cuerpo inválido tampoco llega a ningún sitio.
    ["PUT", "/config/res", {}],
    ["PUT", "/3/gastos", { filas: "x" }],
  ];
  for (const [m, ruta, cuerpo] of escrituras) {
    const r = await llamar(m, ruta, cuerpo);
    assert.equal(r.estado, 409, `${m} ${ruta}`);
    assert.equal(r.json.codigo, "preliquidacion_apagada", `${m} ${ruta}`);
  }
  assert.deepEqual(accesosBase, []);
});

test("apagado: las lecturas (GET) siguen funcionando", async () => {
  for (const ruta of ["/", "/config/res", "/3", "/3/retomas", "/3/previsualizar"]) {
    const r = await llamar("GET", ruta);
    assert.notEqual(r.json.codigo, "preliquidacion_apagada", `GET ${ruta}`);
  }
});

test("encendido: config y desvincular sí llegan a la base (el 409 es solo del interruptor)", async () => {
  process.env.CARNES_PRELIQUIDACION = "on";
  await llamar("PUT", "/config/res", { servicio_por_animal: 50000 });
  await llamar("DELETE", "/3/sedes/9");
  assert.ok(accesosBase.length > 0);
});

// ─── Los flujos legados no dependen del interruptor ────────────────────────

const leer = (ruta) => fs.readFileSync(new URL(`../src/${ruta}`, import.meta.url), "utf8");

test("solo el controlador de /preliquidaciones lee el interruptor", () => {
  const archivos = fs
    .readdirSync(new URL("../src/", import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith(".js"))
    .map(String);
  const quienes = archivos.filter((f) => /preliquidacionHabilitada|estadoPreliquidacion|CARNES_PRELIQUIDACION/.test(leer(f)));
  assert.deepEqual(quienes.map((f) => f.replace(/\\/g, "/")).sort(), [
    "config/preliquidacion.js",
    "controllers/preliquidaciones.controller.js",
  ]);
});

test("el flujo de envío a SIESA y los controladores legados no mencionan la preliquidación", () => {
  for (const archivo of [
    "services/siesa.service.js",
    "controllers/recepciones.controller.js",
    "controllers/liquidaciones.controller.js",
    "controllers/siesa.controller.js",
    "routes/liquidaciones.routes.js",
    "routes/recepciones.routes.js",
    "routes/siesa.routes.js",
  ]) {
    assert.doesNotMatch(leer(archivo), /preliquidaci/i, archivo);
  }
});

test("SiesaEnvio.model solo conoce la preliquidación por el hook del resolver (S2 2.9), sin interruptor", () => {
  const texto = leer("models/SiesaEnvio.model.js");
  // El hook busca la sede por envio_id: sin sede (flag apagado o envío legado) es un no-op.
  assert.match(texto, /carnes_preliq_sincronizar_envio/);
  assert.match(texto, /enviarOficialRecepcion/);
  assert.doesNotMatch(texto, /preliquidacionHabilitada|estadoPreliquidacion|CARNES_PRELIQUIDACION/);
  const nombres = new Set([...texto.matchAll(/w*preliquidaciw*/gi)].map((m) => m[0].toLowerCase()));
  for (const n of nombres) {
    assert.ok(
      ["carnes_preliquidacion_sedes", "sincronizarsededepreliquidacion", "preliquidaci", "preliquidacion", "preliquidaciones"].includes(n),
      "mención inesperada de la preliquidación en SiesaEnvio.model: " + n,
    );
  }
});

test("los modelos legados dependen del VÍNCULO, nunca del interruptor", () => {
  for (const archivo of ["models/Recepcion.model.js", "models/Liquidacion.model.js"]) {
    assert.doesNotMatch(leer(archivo), /preliquidacionHabilitada|estadoPreliquidacion|CARNES_PRELIQUIDACION/, archivo);
  }
});

test("los scripts que escriben en SIESA real no se tocan", () => {
  const raiz = fileURLToPath(new URL("../scripts/", import.meta.url));
  for (const f of fs.readdirSync(raiz)) {
    const texto = fs.readFileSync(raiz + f, "utf8");
    assert.doesNotMatch(texto, /preliquidaci/i, f);
  }
});
