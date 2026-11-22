// Rutas de /preliquidaciones: contrato HTTP, validación, interruptor
// CARNES_PRELIQUIDACION (apagado por defecto) y propagación de los errores del
// modelo. Se monta el router real en un Express de prueba con el modelo y el guard
// de admin falsos (mock.module). Sin red externa ni base.
import test, { mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

// ─── Modelo falso ──────────────────────────────────────────────────────────

let llamadas = [];
let respuestas = {};
const { createError } = await import(url("middleware/errorHandler.js"));

const falso = (nombre) => async (...args) => {
  llamadas.push({ nombre, args });
  const r = respuestas[nombre];
  if (r instanceof Error) throw r;
  return typeof r === "function" ? r(...args) : r ?? { id: 1 };
};

mock.module(url("models/Preliquidacion.model.js"), {
  namedExports: {
    listar: falso("listar"),
    obtener: falso("obtener"),
    crear: falso("crear"),
    actualizar: falso("actualizar"),
    guardarGastos: falso("guardarGastos"),
    vincularRecepcion: falso("vincularRecepcion"),
    desvincularSede: falso("desvincularSede"),
    previsualizar: falso("previsualizar"),
    obtenerConfig: falso("obtenerConfig"),
    guardarConfig: falso("guardarConfig"),
  },
});

let perdidasFalsas = [];
mock.module(url("models/PreliquidacionVigilancia.model.js"), {
  namedExports: {
    revisarCorridasPerdidas: async (o) => {
      llamadas.push({ nombre: "revisarCorridasPerdidas", args: [o] });
      if (respuestas.revisarCorridasPerdidas instanceof Error) throw respuestas.revisarCorridasPerdidas;
      return { perdidas: perdidasFalsas };
    },
    escanearVentanas: async () => ({ vencidas: [], avisadas: [] }),
  },
});

mock.module(url("models/PreliquidacionRetomas.model.js"), {
  namedExports: {
    obtenerRetomas: falso("obtenerRetomas"),
    guardarRetomas: falso("guardarRetomas"),
  },
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
const { preliquidacionHabilitada, estadoPreliquidacion } = await import(url("config/preliquidacion.js"));

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
beforeEach(() => {
  llamadas = [];
  respuestas = {};
  guardPasa = true;
  delete process.env.CARNES_PRELIQUIDACION;
  console.error = () => {};
});
after(() => { console.error = silenciar; });

const encendida = () => { process.env.CARNES_PRELIQUIDACION = "on"; };

// ─── Corrida perdida en las lecturas (R7) ──────────────────────────────────

test("R7: GET / y GET /:id exponen corrida_perdida cuando el interruptor está encendido", async () => {
  encendida();
  perdidasFalsas = [2];
  respuestas.listar = [{ id: 1, estado: "abierta" }, { id: 2, estado: "abierta" }];
  const lista = await llamar("GET", "/");
  assert.deepEqual(lista.json.data.map((p) => p.corrida_perdida), [false, true]);
  respuestas.obtener = { id: 2, estado: "abierta" };
  const una = await llamar("GET", "/2");
  assert.equal(una.json.data.corrida_perdida, true);
  respuestas.obtener = { id: 1, estado: "abierta" };
  assert.equal((await llamar("GET", "/1")).json.data.corrida_perdida, false);
  perdidasFalsas = [];
});

test("R7: con el interruptor apagado las lecturas no revisan nada (A-S6) y corrida_perdida es false", async () => {
  respuestas.obtener = { id: 2, estado: "abierta" };
  const r = await llamar("GET", "/2");
  assert.equal(r.json.data.corrida_perdida, false);
  assert.equal(llamadas.filter((l) => l.nombre === "revisarCorridasPerdidas").length, 0);
});

test("R7: si la revisión falla la lectura responde igual, con corrida_perdida false", async () => {
  encendida();
  respuestas.revisarCorridasPerdidas = new Error("base caída");
  respuestas.obtener = { id: 3, estado: "abierta" };
  const r = await llamar("GET", "/3");
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.corrida_perdida, false);
});

// ─── Interruptor ───────────────────────────────────────────────────────────

test("config: el interruptor está apagado por defecto y se lee en cada llamada", () => {
  assert.equal(preliquidacionHabilitada(), false);
  assert.equal(estadoPreliquidacion(), "off");
  process.env.CARNES_PRELIQUIDACION = "on";
  assert.equal(preliquidacionHabilitada(), true);
  assert.equal(estadoPreliquidacion(), "on");
  process.env.CARNES_PRELIQUIDACION = "TRUE";
  assert.equal(preliquidacionHabilitada(), true);
  process.env.CARNES_PRELIQUIDACION = "1";
  assert.equal(preliquidacionHabilitada(), true);
  for (const v of ["", "off", "false", "0", "no", "  ", "encendido"]) {
    process.env.CARNES_PRELIQUIDACION = v;
    assert.equal(preliquidacionHabilitada(), false, `valor ${JSON.stringify(v)}`);
  }
});

// ─── Guard de admin ────────────────────────────────────────────────────────

test("todo el router pasa por requireAdminCarnes", async () => {
  guardPasa = false;
  for (const [m, r, c] of [
    ["GET", "/"], ["POST", "/", {}], ["GET", "/1"], ["PATCH", "/1", {}], ["PUT", "/1/gastos", {}],
    ["POST", "/1/recepciones", {}], ["DELETE", "/1/sedes/2"], ["GET", "/1/previsualizar"],
    ["GET", "/config/res"], ["PUT", "/config/res", {}],
  ]) {
    assert.equal((await llamar(m, r, c)).estado, 403, `${m} ${r}`);
  }
  assert.equal(llamadas.length, 0);
});

// ─── Crear ─────────────────────────────────────────────────────────────────

test("POST / con el interruptor apagado responde 409 preliquidacion_apagada y no llama al modelo", async () => {
  const r = await llamar("POST", "/", { especie: "res", animales: 10 });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.equal(llamadas.length, 0);
});

test("POST / encendido crea y responde 201", async () => {
  encendida();
  respuestas.crear = { id: 7, especie: "res" };
  const r = await llamar("POST", "/", { especie: "res", animales: 10, animal_en_pie: 1000000, servicio: 700000 });
  assert.equal(r.estado, 201);
  assert.equal(r.json.data.id, 7);
  const [especie, datos] = llamadas[0].args;
  assert.equal(llamadas[0].nombre, "crear");
  assert.equal(especie, "res");
  assert.equal(datos.animales, 10);
  assert.equal(datos.servicio, 700000);
});

test("POST / valida especie, animales entero > 0 y valores no negativos", async () => {
  encendida();
  for (const cuerpo of [
    { especie: "vaca", animales: 3 },
    { especie: "res", animales: 0 },
    { especie: "res", animales: 2.5 },
    { especie: "res" },
    { especie: "res", animales: 3, animal_en_pie: -1 },
    { especie: "res", animales: 3, servicio: -5 },
  ]) {
    const r = await llamar("POST", "/", cuerpo);
    assert.equal(r.estado, 400, JSON.stringify(cuerpo));
  }
  assert.equal(llamadas.length, 0);
});

test("POST / propaga 409 config_servicio_cero del modelo", async () => {
  encendida();
  respuestas.crear = createError(409, "config", "config_servicio_cero");
  const r = await llamar("POST", "/", { especie: "res", animales: 3 });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "config_servicio_cero");
});

// ─── Lectura ───────────────────────────────────────────────────────────────

test("GET / lista con los filtros de la query (también apagado)", async () => {
  respuestas.listar = [{ id: 1 }];
  const r = await llamar("GET", "/?especie=res&estado=abierta");
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json.data, [{ id: 1, corrida_perdida: false }]);
  assert.deepEqual(llamadas[0].args[0], { especie: "res", estado: "abierta" });
});

test("GET /:id devuelve la preliquidación y un id no numérico es 400", async () => {
  respuestas.obtener = { id: 3 };
  const ok = await llamar("GET", "/3");
  assert.equal(ok.estado, 200);
  assert.equal(llamadas[0].args[0], 3);
  assert.equal((await llamar("GET", "/abc")).estado, 400);
  assert.equal((await llamar("GET", "/0")).estado, 400);
});

test("GET /:id/previsualizar no exige el interruptor", async () => {
  respuestas.previsualizar = { gasto_total: "1.00" };
  const r = await llamar("GET", "/3/previsualizar");
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.gasto_total, "1.00");
});

// ─── PATCH ─────────────────────────────────────────────────────────────────

test("PATCH /:id pasa solo los campos permitidos y el quién", async () => {
  encendida();
  respuestas.actualizar = { resultado: "ok" };
  const r = await llamar("PATCH", "/3", { servicio: 800000, estado: "cerrada", liquidada_at: "x" });
  assert.equal(r.estado, 200);
  const [id, cambios, ctx] = llamadas[0].args;
  assert.equal(id, 3);
  assert.deepEqual(cambios, { servicio: 800000 });
  assert.ok("por" in ctx);
});

test("PATCH /:id sin ningún campo permitido es 400", async () => {
  encendida();
  assert.equal((await llamar("PATCH", "/3", {})).estado, 400);
  assert.equal((await llamar("PATCH", "/3", { estado: "cerrada" })).estado, 400);
  assert.equal((await llamar("PATCH", "/3", { animales: 0 })).estado, 400);
  assert.equal(llamadas.length, 0);
});

test("PATCH /:id propaga 409 preliquidacion_congelada", async () => {
  encendida();
  respuestas.actualizar = createError(409, "congelada", "preliquidacion_congelada");
  const r = await llamar("PATCH", "/3", { animales: 5 });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_congelada");
});

// ─── Gastos ────────────────────────────────────────────────────────────────

test("PUT /:id/gastos valida las filas y las pasa al modelo", async () => {
  encendida();
  respuestas.guardarGastos = { id: 3 };
  const filas = [{ concepto: "Flete", valor: 100, signo: 1 }, { concepto: "Descuento", valor: 5, signo: -1 }];
  const r = await llamar("PUT", "/3/gastos", { filas });
  assert.equal(r.estado, 200);
  assert.deepEqual(llamadas[0].args, [3, filas]);
  for (const mala of [
    [{ concepto: "", valor: 1, signo: 1 }],
    [{ concepto: "x", valor: -1, signo: 1 }],
    [{ concepto: "x", valor: 1, signo: 2 }],
    [{ concepto: "x", valor: "abc", signo: 1 }],
  ]) {
    assert.equal((await llamar("PUT", "/3/gastos", { filas: mala })).estado, 400);
  }
});

// ─── Vincular / desvincular ────────────────────────────────────────────────

test("POST /:id/recepciones apagado responde 409 y no vincula", async () => {
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10] });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.equal(llamadas.length, 0);
});

test("POST /:id/recepciones encendido vincula cada recepción a esa preliquidación", async () => {
  encendida();
  respuestas.vincularRecepcion = (id) => ({ resultado: "vinculada", preliquidacion_id: 3, recepcion: id });
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10, 11] });
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.length, 2);
  assert.deepEqual(llamadas.map((c) => [c.args[0], c.args[1].preliquidacionId]), [[10, 3], [11, 3]]);
  assert.ok(r.json.data.every((x) => x.ok === true && x.resultado === "vinculada"));
});

test("POST /:id/recepciones: un error de una recepción no frena a las demás", async () => {
  encendida();
  respuestas.vincularRecepcion = (id) => {
    if (id === 10) throw createError(409, "ya", "ya_vinculada");
    return { resultado: "excede" };
  };
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10, 11] });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json.data.map((x) => [x.recepcion_id, x.ok, x.codigo ?? x.resultado]), [
    [10, false, "ya_vinculada"],
    [11, true, "excede"],
  ]);
});

test("POST /:id/recepciones: si todas fallan responde con el estado del primer error", async () => {
  encendida();
  respuestas.vincularRecepcion = createError(422, "fuera", "fuera_ventana");
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10] });
  assert.equal(r.estado, 422);
  assert.equal(r.json.codigo, "fuera_ventana");
});

test("POST /:id/recepciones valida el cuerpo", async () => {
  encendida();
  assert.equal((await llamar("POST", "/3/recepciones", { recepcion_ids: [] })).estado, 400);
  assert.equal((await llamar("POST", "/3/recepciones", {})).estado, 400);
});

test("DELETE /:id/sedes/:sedeId desvincula con el interruptor encendido", async () => {
  encendida();
  respuestas.desvincularSede = { resultado: "ok" };
  const r = await llamar("DELETE", "/3/sedes/9");
  assert.equal(r.estado, 200);
  assert.deepEqual(llamadas[0].args, [9, { preliquidacionId: 3 }]);
});

test("DELETE /:id/sedes/:sedeId propaga 409 sede_enviada", async () => {
  encendida();
  respuestas.desvincularSede = createError(409, "enviada", "sede_enviada");
  const r = await llamar("DELETE", "/3/sedes/9");
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "sede_enviada");
});

// ─── Retomas (cerdo) ───────────────────────────────────────────────────────

test("GET /:id/retomas lee las retomas de la preliquidación", async () => {
  respuestas.obtenerRetomas = { preliquidacion_id: 3, filas: [] };
  const r = await llamar("GET", "/3/retomas");
  assert.equal(r.estado, 200);
  assert.deepEqual(llamadas[0].args, [3]);
});

test("PUT /:id/retomas valida las filas y las guarda", async () => {
  encendida();
  respuestas.guardarRetomas = { total: 10 };
  const filas = [{ vicera_item_id: 5, kilos: 10, precio: 3000 }];
  const r = await llamar("PUT", "/3/retomas", { filas });
  assert.equal(r.estado, 200);
  assert.equal(llamadas[0].args[0], 3);
  assert.deepEqual(llamadas[0].args[1].filas, filas);
  assert.equal((await llamar("PUT", "/3/retomas", { filas: [{ vicera_item_id: "x", kilos: 1 }] })).estado, 400);
});

test("PUT /:id/retomas propaga el 409 de una preliquidación congelada", async () => {
  encendida();
  respuestas.guardarRetomas = createError(409, "congelada", "preliquidacion_congelada");
  const r = await llamar("PUT", "/3/retomas", { filas: [] });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_congelada");
});

// ─── Config ────────────────────────────────────────────────────────────────

test("GET /config/:especie va antes que /:id y no toca obtener", async () => {
  respuestas.obtenerConfig = { especie: "res", servicio_por_animal: "50000.00" };
  const r = await llamar("GET", "/config/res");
  assert.equal(r.estado, 200);
  assert.equal(llamadas[0].nombre, "obtenerConfig");
  assert.equal(llamadas.filter((c) => c.nombre === "obtener").length, 0);
});

test("PUT /config/:especie exige especie válida y servicio_por_animal numérico", async () => {
  encendida();
  respuestas.guardarConfig = { especie: "res" };
  assert.equal((await llamar("PUT", "/config/vaca", { servicio_por_animal: 5 })).estado, 400);
  assert.equal((await llamar("PUT", "/config/res", {})).estado, 400);
  assert.equal((await llamar("PUT", "/config/res", { servicio_por_animal: "abc" })).estado, 400);
  const ok = await llamar("PUT", "/config/res", { servicio_por_animal: 55000 });
  assert.equal(ok.estado, 200);
  assert.deepEqual(llamadas[0].args, ["res", { servicio_por_animal: 55000 }]);
});

test("PUT /config/:especie propaga el 422 del modelo cuando el servicio es 0", async () => {
  encendida();
  respuestas.guardarConfig = createError(422, "cero", "servicio_invalido");
  const r = await llamar("PUT", "/config/res", { servicio_por_animal: 0 });
  assert.equal(r.estado, 422);
});

test("apagado: cada ruta de escritura responde 409 preliquidacion_apagada antes de validar y sin llamar al modelo", async () => {
  for (const [m, r, c] of [
    ["POST", "/", { especie: "res", animales: 10 }],
    ["PUT", "/config/res", { servicio_por_animal: 55000 }],
    ["PATCH", "/3", { servicio: 800000 }],
    ["PUT", "/3/gastos", { filas: [] }],
    ["PUT", "/3/retomas", { filas: [] }],
    ["POST", "/3/recepciones", { recepcion_ids: [10] }],
    ["DELETE", "/3/sedes/9"],
    ["PATCH", "/3", {}],
    ["PUT", "/config/res", {}],
  ]) {
    const x = await llamar(m, r, c);
    assert.equal(x.estado, 409, `${m} ${r}`);
    assert.equal(x.json.codigo, "preliquidacion_apagada", `${m} ${r}`);
  }
  assert.equal(llamadas.length, 0);
});

test("apagado: las lecturas siguen disponibles", async () => {
  respuestas.obtenerConfig = { especie: "res" };
  respuestas.obtenerRetomas = { filas: [] };
  respuestas.listar = [];
  for (const r of ["/", "/3", "/3/retomas", "/3/previsualizar", "/config/res"]) {
    assert.equal((await llamar("GET", r)).estado, 200, `GET ${r}`);
  }
});

test("PUT /config/:especie con el interruptor encendido guarda la configuración", async () => {
  encendida();
  respuestas.guardarConfig = { especie: "cerdo" };
  const r = await llamar("PUT", "/config/cerdo", { servicio_por_animal: 40000 });
  assert.equal(r.estado, 200);
});
