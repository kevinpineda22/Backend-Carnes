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
    hojaSede: falso("hojaSede"),
    obtenerConfig: falso("obtenerConfig"),
    guardarConfig: falso("guardarConfig"),
    procesarAdmin: falso("procesarAdmin"),
    procesarSedeAdmin: falso("procesarSedeAdmin"),
    cerrar: falso("cerrar"),
    recalcular: falso("recalcular"),
    fijarCorte: falso("fijarCorte"),
  },
});

mock.module(url("models/PreliquidacionCorrecciones.model.js"), {
  namedExports: {
    anularSede: falso("anularSede"),
    descartarCorreccion: falso("descartarCorreccion"),
    anularPreliquidacion: falso("anularPreliquidacion"),
    anularPreliquidacionEnviada: falso("anularPreliquidacionEnviada"),
  },
});

mock.module(url("models/PreliquidacionSaldos.model.js"), {
  namedExports: {
    listarSaldos: falso("listarSaldos"),
    actualizarSaldo: falso("actualizarSaldo"),
  },
});

mock.module(url("models/PreliquidacionInicial.model.js"), {
  namedExports: {
    omitirInicialSede: falso("omitirInicialSede"),
    omitirInicialPreliquidacion: falso("omitirInicialPreliquidacion"),
  },
});

let despachos = [];
mock.module(url("services/preliquidacionAlertas.js"), {
  namedExports: {
    despacharAlertas: async (contexto) => {
      despachos.push(contexto);
      return { ok: true, enviadas: 0 };
    },
    encolarAlerta: async () => ({ ok: true }),
    EVENTOS_ALERTA: [],
    REGLA_OCURRENCIA: {},
    MAX_INTENTOS_ALERTA: 5,
    VENCIMIENTO_RECLAMO_MS: 300000,
    PRESUPUESTO_MINIMO_DESPACHO_MS: 31000,
    esperaReintentoMs: () => 0,
  },
});

let perdidasFalsas = [];
let nuevasFalsas = 0;
mock.module(url("models/PreliquidacionVigilancia.model.js"), {
  namedExports: {
    revisarCorridasPerdidas: async (o) => {
      llamadas.push({ nombre: "revisarCorridasPerdidas", args: [o] });
      if (respuestas.revisarCorridasPerdidas instanceof Error) throw respuestas.revisarCorridasPerdidas;
      return { perdidas: perdidasFalsas, nuevas: nuevasFalsas };
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
  despachos = [];
  nuevasFalsas = 0;
  guardPasa = true;
  delete process.env.CARNES_PRELIQUIDACION;
  console.error = () => {};
});
after(() => { console.error = silenciar; });

const encendida = () => { process.env.CARNES_PRELIQUIDACION = "on"; };

// ─── Procesar / cerrar del admin (2.18) ────────────────────────────────────

const ACCIONES_ADMIN = [
  ["/5/procesar", "procesarAdmin", 5],
  ["/sedes/3/procesar", "procesarSedeAdmin", 3],
  ["/5/cerrar", "cerrar", 5],
];

test("procesar/cerrar con el interruptor encendido responden y pasan el id y quién lo pide", async () => {
  encendida();
  for (const [ruta, nombre, id] of ACCIONES_ADMIN) {
    llamadas = [];
    respuestas[nombre] = { resultado: "ok" };
    const r = await llamar("POST", ruta);
    assert.equal(r.estado, 200, ruta);
    assert.deepEqual(r.json, { ok: true, data: { resultado: "ok" } });
    assert.equal(llamadas[0].nombre, nombre);
    assert.equal(llamadas[0].args[0], id);
  }
});

test("drenaje: con el interruptor APAGADO procesar y cerrar siguen funcionando (lo ya vinculado se puede terminar)", async () => {
  for (const [ruta, nombre] of ACCIONES_ADMIN) {
    llamadas = [];
    const r = await llamar("POST", ruta);
    assert.equal(r.estado, 200, ruta);
    assert.equal(llamadas[0].nombre, nombre);
  }
});

test("drenaje: el resto de escrituras sigue en 409 con el interruptor apagado", async () => {
  for (const [metodo, ruta, cuerpo] of [["POST", "/", {}], ["POST", "/5/recepciones", {}], ["PATCH", "/5", {}], ["DELETE", "/5/sedes/2"]]) {
    const r = await llamar(metodo, ruta, cuerpo);
    assert.equal(r.estado, 409, `${metodo} ${ruta}`);
  }
});

test("C3: en producción sin CARNES_AUTH=exigir procesar/cerrar responden 503 auth_requerida aunque el interruptor esté encendido", async () => {
  encendida();
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  try {
    for (const [ruta] of ACCIONES_ADMIN) {
      const r = await llamar("POST", ruta);
      assert.equal(r.estado, 503, ruta);
      assert.equal(r.json.codigo, "auth_requerida");
    }
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test("procesar/cerrar: ids inválidos son 400 y el guard de admin los protege", async () => {
  encendida();
  assert.equal((await llamar("POST", "/abc/procesar")).estado, 400);
  assert.equal((await llamar("POST", "/sedes/abc/procesar")).estado, 400);
  guardPasa = false;
  for (const [ruta] of ACCIONES_ADMIN) assert.equal((await llamar("POST", ruta)).estado, 403, ruta);
});

test("procesar/cerrar propagan los errores de negocio del modelo", async () => {
  encendida();
  respuestas.cerrar = createError(409, "no se puede", "no_cerrable");
  const r = await llamar("POST", "/5/cerrar");
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "no_cerrable");
});

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

test("las alertas se entregan solo por el cron: ningún endpoint despacha, ni en éxito, ni en error, ni en lecturas", async () => {
  encendida();
  despachos = [];
  perdidasFalsas = [2];
  nuevasFalsas = 1;
  respuestas.listar = [{ id: 2, estado: "abierta" }];
  respuestas.obtener = { id: 2, estado: "abierta" };
  await llamar("GET", "/");
  await llamar("GET", "/2");
  perdidasFalsas = [];
  nuevasFalsas = 0;
  for (const [metodo, ruta, nombre] of [
    ["POST", "/5/procesar", "procesarAdmin"],
    ["POST", "/sedes/3/procesar", "procesarSedeAdmin"],
    ["POST", "/5/recalcular", "recalcular"],
    ["POST", "/5/cerrar", "cerrar"],
  ]) {
    respuestas[nombre] = createError(409, "no se pudo", "conflicto_test");
    const r = await llamar(metodo, ruta, {});
    assert.equal(r.estado, 409, ruta);
    assert.equal(r.json.ok, false, ruta);
  }
  respuestas.vincularRecepcion = createError(409, "fuera de ventana", "fuera_ventana");
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10, 11] });
  assert.equal(r.estado, 409);
  delete respuestas.vincularRecepcion;
  assert.equal(despachos.length, 0, "el despacho es solo del cron (barrido horario + 21:30)");
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
    ["GET", "/1/sedes/2/hoja"], ["GET", "/config/res"], ["PUT", "/config/res", {}],
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

// ─── Hoja de costeo de una sede ────────────────────────────────────────────

test("GET /:id/sedes/:sedeId/hoja es una lectura: no exige el interruptor y pasa los dos ids al modelo", async () => {
  respuestas.hojaSede = { sede_row_id: 9, cortes: [] };
  const r = await llamar("GET", "/3/sedes/9/hoja");
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { ok: true, data: { sede_row_id: 9, cortes: [] } });
  assert.equal(llamadas[0].nombre, "hojaSede");
  assert.deepEqual(llamadas[0].args, [3, 9]);
});

test("GET /:id/sedes/:sedeId/hoja: ids inválidos son 400 y el 404 del modelo se propaga", async () => {
  for (const ruta of ["/x/sedes/9/hoja", "/3/sedes/0/hoja", "/3/sedes/abc/hoja"]) {
    assert.equal((await llamar("GET", ruta)).estado, 400, ruta);
  }
  assert.equal(llamadas.length, 0);
  respuestas.hojaSede = createError(404, "Sede no encontrada.", "sede_no_encontrada");
  const r = await llamar("GET", "/3/sedes/9/hoja");
  assert.equal(r.estado, 404);
  assert.equal(r.json.codigo, "sede_no_encontrada");
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

test("POST /:id/recepciones: permitir_anterior llega al modelo; sin él va en false", async () => {
  encendida();
  respuestas.vincularRecepcion = { resultado: "vinculada" };
  await llamar("POST", "/3/recepciones", { recepcion_ids: [10], permitir_anterior: true });
  await llamar("POST", "/3/recepciones", { recepcion_ids: [11] });
  await llamar("POST", "/3/recepciones", { recepcion_ids: [12], permitir_anterior: false });
  assert.deepEqual(llamadas.map((c) => c.args[1].permitirAnterior), [true, false, false]);
});

test("POST /:id/recepciones: permitir_anterior debe ser booleano", async () => {
  encendida();
  const r = await llamar("POST", "/3/recepciones", { recepcion_ids: [10], permitir_anterior: "si" });
  assert.equal(r.estado, 400);
  assert.equal(llamadas.length, 0);
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
  respuestas.hojaSede = { cortes: [] };
  respuestas.listar = [];
  for (const r of ["/", "/3", "/3/retomas", "/3/previsualizar", "/3/sedes/9/hoja", "/config/res"]) {
    assert.equal((await llamar("GET", r)).estado, 200, `GET ${r}`);
  }
});

test("PUT /config/:especie con el interruptor encendido guarda la configuración", async () => {
  encendida();
  respuestas.guardarConfig = { especie: "cerdo" };
  const r = await llamar("PUT", "/config/cerdo", { servicio_por_animal: 40000 });
  assert.equal(r.estado, 200);
});

// ─── Recalcular no enviadas (3.5) ──────────────────────────────────────────

test("POST /:id/recalcular pasa id, cambios, motivo y quién lo pide al modelo", async () => {
  encendida();
  respuestas.recalcular = { resultado: "ok", recosteo: [] };
  const r = await llamar("POST", "/5/recalcular", { cambios: { animal_en_pie: 2000000 }, motivo: "ajuste de precio" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { ok: true, data: { resultado: "ok", recosteo: [] } });
  assert.equal(llamadas[0].nombre, "recalcular");
  assert.equal(llamadas[0].args[0], 5);
  assert.deepEqual(llamadas[0].args[1], { cambios: { animal_en_pie: 2000000 }, motivo: "ajuste de precio" });
});

test("recalcular sin cuerpo es un recosteo puro: cambios vacíos", async () => {
  encendida();
  const r = await llamar("POST", "/5/recalcular", {});
  assert.equal(r.estado, 200);
  assert.deepEqual(llamadas[0].args[1].cambios, {});
});

test("recalcular es una escritura: apagado responde 409 preliquidacion_apagada (no es drenaje) y no llega al modelo", async () => {
  const r = await llamar("POST", "/5/recalcular", {});
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.deepEqual(llamadas, []);
});

test("recalcular: en producción sin CARNES_AUTH=exigir es 503 auth_requerida", async () => {
  encendida();
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  try {
    const r = await llamar("POST", "/5/recalcular", {});
    assert.equal(r.estado, 503);
    assert.equal(r.json.codigo, "auth_requerida");
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test("recalcular: id inválido 400, guard de admin 403 y cuerpo inválido 400 sin llegar al modelo", async () => {
  encendida();
  assert.equal((await llamar("POST", "/abc/recalcular", {})).estado, 400);
  for (const cuerpo of [
    { cambios: { liquidada_at: "2020-01-01" } },
    { cambios: { animales: 0 } },
    { cambios: { animal_en_pie: -5 } },
    { cambios: { gastos: [{ concepto: "", valor: 1, signo: 1 }] } },
    { cambios: { gastos: [{ concepto: "x", valor: 1, signo: 2 }] } },
    { motivo: "x".repeat(501) },
  ]) {
    assert.equal((await llamar("POST", "/5/recalcular", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.deepEqual(llamadas, []);
  guardPasa = false;
  assert.equal((await llamar("POST", "/5/recalcular", {})).estado, 403);
});

test("recalcular propaga los errores de negocio del modelo", async () => {
  encendida();
  respuestas.recalcular = createError(409, "no liquidada", "no_liquidada");
  const r = await llamar("POST", "/5/recalcular", {});
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo ?? r.json.error?.codigo ?? "no_liquidada", "no_liquidada");
});

// ─── Correcciones de sede (3.6) ────────────────────────────────────────────

test("POST /sedes/:sedeId/anular con la confirmación pasa sede, quién y motivo al modelo", async () => {
  encendida();
  respuestas.anularSede = { resultado: "ok", estado: "anulada" };
  const r = await llamar("POST", "/sedes/3/anular", { confirmado_en_siesa: true, motivo: "error de pesos" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { ok: true, data: { resultado: "ok", estado: "anulada" } });
  assert.equal(llamadas[0].nombre, "anularSede");
  assert.equal(llamadas[0].args[0], 3);
  assert.deepEqual(llamadas[0].args[1], { por: null, motivo: "error de pesos" });
});

test("F-S4: anular sin confirmar que ya se anuló en SIESA es 400 y no llega al modelo", async () => {
  encendida();
  for (const cuerpo of [{}, { motivo: "x" }, { confirmado_en_siesa: false }, { confirmado_en_siesa: "si" }, { confirmado_en_siesa: true, otro: 1 }]) {
    assert.equal((await llamar("POST", "/sedes/3/anular", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.deepEqual(llamadas, []);
});

test("anular sede: id inválido 400, guard de admin 403 y los errores del modelo se propagan", async () => {
  encendida();
  assert.equal((await llamar("POST", "/sedes/abc/anular", { confirmado_en_siesa: true })).estado, 400);
  guardPasa = false;
  assert.equal((await llamar("POST", "/sedes/3/anular", { confirmado_en_siesa: true })).estado, 403);
  guardPasa = true;
  respuestas.anularSede = createError(409, "no enviada", "sede_no_enviada");
  const r = await llamar("POST", "/sedes/3/anular", { confirmado_en_siesa: true });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "sede_no_enviada");
});

test("anular sede es drenaje: con el interruptor apagado sigue disponible, pero la compuerta de auth (503) va primero", async () => {
  const r = await llamar("POST", "/sedes/3/anular", { confirmado_en_siesa: true });
  assert.equal(r.estado, 200);
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  try {
    const bloqueada = await llamar("POST", "/sedes/3/anular", { confirmado_en_siesa: true });
    assert.equal(bloqueada.estado, 503);
    assert.equal(bloqueada.json.codigo, "auth_requerida");
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test("POST /sedes/:sedeId/descartar-correccion pasa sede, quién y motivo; el motivo es obligatorio", async () => {
  encendida();
  respuestas.descartarCorreccion = { resultado: "ok", estado: "enviada" };
  const r = await llamar("POST", "/sedes/4/descartar-correccion", { motivo: "el cambio no afecta lo enviado" });
  assert.equal(r.estado, 200);
  assert.equal(llamadas[0].nombre, "descartarCorreccion");
  assert.equal(llamadas[0].args[0], 4);
  assert.deepEqual(llamadas[0].args[1], { por: null, motivo: "el cambio no afecta lo enviado" });
  llamadas = [];
  for (const cuerpo of [{}, { motivo: "" }, { motivo: "x" }, { motivo: "y".repeat(501) }]) {
    assert.equal((await llamar("POST", "/sedes/4/descartar-correccion", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.deepEqual(llamadas, []);
});

test("descartar-correccion es una escritura normal: apagado responde 409 preliquidacion_apagada", async () => {
  const r = await llamar("POST", "/sedes/4/descartar-correccion", { motivo: "ya revisado" });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.deepEqual(llamadas, []);
});

// ─── Anular la preliquidación completa (3.7) ───────────────────────────────

test("POST /:id/anular pasa id, quién y motivo al modelo", async () => {
  encendida();
  respuestas.anularPreliquidacion = { resultado: "ok", sedes_desvinculadas: 2 };
  const r = await llamar("POST", "/5/anular", { motivo: "se creó por error" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { ok: true, data: { resultado: "ok", sedes_desvinculadas: 2 } });
  assert.equal(llamadas[0].nombre, "anularPreliquidacion");
  assert.equal(llamadas[0].args[0], 5);
  assert.deepEqual(llamadas[0].args[1], { por: null, motivo: "se creó por error" });
});

test("anular: el motivo es obligatorio (400 sin llegar al modelo), el id inválido 400 y el guard 403", async () => {
  encendida();
  for (const cuerpo of [{}, { motivo: "" }, { motivo: "x" }, { motivo: "y".repeat(501) }, { motivo: "ok motivo", otro: 1 }]) {
    assert.equal((await llamar("POST", "/5/anular", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await llamar("POST", "/abc/anular", { motivo: "por error" })).estado, 400);
  assert.deepEqual(llamadas, []);
  guardPasa = false;
  assert.equal((await llamar("POST", "/5/anular", { motivo: "por error" })).estado, 403);
});

test("anular no anulable: 409 con codigo y motivo para el panel", async () => {
  encendida();
  respuestas.anularPreliquidacion = Object.assign(createError(409, "Ya hay sedes enviadas", "no_anulable"), { motivo: "sede_enviada" });
  const r = await llamar("POST", "/5/anular", { motivo: "por error" });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "no_anulable");
  assert.equal(r.json.motivo, "sede_enviada");
});

test("anular es drenaje: con el interruptor apagado sigue disponible (rollback), pero la auth en producción va primero", async () => {
  const r = await llamar("POST", "/5/anular", { motivo: "rollback" });
  assert.equal(r.estado, 200);
  assert.equal(llamadas[0].nombre, "anularPreliquidacion");
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  try {
    const bloqueada = await llamar("POST", "/5/anular", { motivo: "rollback" });
    assert.equal(bloqueada.estado, 503);
    assert.equal(bloqueada.json.codigo, "auth_requerida");
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

// ─── Anular una preliquidación ya enviada a SIESA (sql/046) ────────────────

test("POST /:id/anular-enviada pasa id, quién y motivo al modelo", async () => {
  encendida();
  respuestas.anularPreliquidacionEnviada = { resultado: "ok", sedes_liberadas: 10 };
  const r = await llamar("POST", "/19/anular-enviada", { confirmo_anulacion_siesa: true, motivo: "conteo de animales erróneo" });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { ok: true, data: { resultado: "ok", sedes_liberadas: 10 } });
  assert.equal(llamadas[0].nombre, "anularPreliquidacionEnviada");
  assert.equal(llamadas[0].args[0], 19);
  assert.deepEqual(llamadas[0].args[1], { por: null, motivo: "conteo de animales erróneo" });
});

test("anular-enviada: sin confirmar lo hecho en SIESA o sin motivo es 400 (strict), id inválido 400, guard 403", async () => {
  encendida();
  const cuerpos = [
    {},
    { motivo: "por error de conteo" },
    { confirmo_anulacion_siesa: true },
    { confirmo_anulacion_siesa: false, motivo: "por error de conteo" },
    { confirmo_anulacion_siesa: "true", motivo: "por error de conteo" },
    { confirmo_anulacion_siesa: true, motivo: "" },
    { confirmo_anulacion_siesa: true, motivo: "   " },
    { confirmo_anulacion_siesa: true, motivo: "y".repeat(501) },
    { confirmo_anulacion_siesa: true, motivo: "por error de conteo", otro: 1 },
  ];
  for (const cuerpo of cuerpos) {
    assert.equal((await llamar("POST", "/19/anular-enviada", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await llamar("POST", "/abc/anular-enviada", { confirmo_anulacion_siesa: true, motivo: "por error" })).estado, 400);
  assert.deepEqual(llamadas, []);
  guardPasa = false;
  assert.equal((await llamar("POST", "/19/anular-enviada", { confirmo_anulacion_siesa: true, motivo: "por error" })).estado, 403);
  assert.deepEqual(llamadas, []);
});

test("anular-enviada no anulable: 409 con codigo y motivo para el panel", async () => {
  encendida();
  respuestas.anularPreliquidacionEnviada = Object.assign(createError(409, "Sedes ambiguas", "no_anulable"), { motivo: "sede_ambigua" });
  const r = await llamar("POST", "/19/anular-enviada", { confirmo_anulacion_siesa: true, motivo: "por error" });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "no_anulable");
  assert.equal(r.json.motivo, "sede_ambigua");
});

test("anular-enviada es escritura normal: apagado responde 409 preliquidacion_apagada y no toca el modelo", async () => {
  const r = await llamar("POST", "/19/anular-enviada", { confirmo_anulacion_siesa: true, motivo: "por error" });
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "preliquidacion_apagada");
  assert.deepEqual(llamadas, []);
});

test("C3: en producción sin CARNES_AUTH=exigir anular-enviada responde 503 auth_requerida", async () => {
  encendida();
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  try {
    const r = await llamar("POST", "/19/anular-enviada", { confirmo_anulacion_siesa: true, motivo: "por error" });
    assert.equal(r.estado, 503);
    assert.equal(r.json.codigo, "auth_requerida");
    assert.deepEqual(llamadas, []);
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

// ─── Corte manual ──────────────────────────────────────────────────────────

test("PUT /:id/corte pasa id, corte y quién al modelo y devuelve la preliquidación", async () => {
  encendida();
  respuestas.fijarCorte = { id: 3, corte: "2026-11-24T23:00:00.000Z", corte_manual: "2026-11-24T23:00:00+00:00" };
  const r = await llamar("PUT", "/3/corte", { corte: "2026-11-24T18:00:00-05:00" });
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.corte, "2026-11-24T23:00:00.000Z");
  const [id, corte, ctx] = llamadas[0].args;
  assert.equal(id, 3);
  assert.equal(corte, "2026-11-24T18:00:00-05:00");
  assert.ok("por" in ctx);
});

test("PUT /:id/corte con null restablece el automático", async () => {
  encendida();
  respuestas.fijarCorte = { id: 3, corte_manual: null };
  const r = await llamar("PUT", "/3/corte", { corte: null });
  assert.equal(r.estado, 200);
  assert.equal(llamadas[0].args[1], null);
});

test("PUT /:id/corte rechaza cuerpos inválidos con 400 sin llamar al modelo", async () => {
  encendida();
  for (const cuerpo of [{}, { corte: 123 }, { corte: true }, { corte: "x", otro: 1 }, []]) {
    assert.equal((await llamar("PUT", "/3/corte", cuerpo)).estado, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await llamar("PUT", "/abc/corte", { corte: null })).estado, 400);
  assert.equal(llamadas.length, 0);
});

test("PUT /:id/corte propaga los errores de negocio del modelo (pasado, congelada)", async () => {
  encendida();
  respuestas.fijarCorte = createError(422, "El cierre debe ser una fecha y hora futuras.", "corte_pasado");
  const pasado = await llamar("PUT", "/3/corte", { corte: "2020-01-01T00:00:00Z" });
  assert.equal(pasado.estado, 422);
  assert.equal(pasado.json.codigo, "corte_pasado");
  respuestas.fijarCorte = createError(409, "La preliquidación ya fue liquidada.", "ya_liquidada");
  assert.equal((await llamar("PUT", "/3/corte", { corte: null })).estado, 409);
});

test("PUT /:id/corte es solo admin y con el interruptor apagado responde 409 sin llamar al modelo", async () => {
  guardPasa = false;
  assert.equal((await llamar("PUT", "/3/corte", { corte: null })).estado, 403);
  guardPasa = true;
  const apagada = await llamar("PUT", "/3/corte", { corte: null });
  assert.equal(apagada.estado, 409);
  assert.equal(apagada.json.codigo, "preliquidacion_apagada");
  assert.equal(llamadas.length, 0);
});

// ─── Oficial sin inicial (sql/044) ─────────────────────────────────────────

test("POST /sedes/:sedeId/omitir-inicial pasa la sede y quién lo pide, sin cuerpo", async () => {
  encendida();
  respuestas.omitirInicialSede = { resultado: "ok", sede_id: 7 };
  const r = await llamar("POST", "/sedes/7/omitir-inicial");
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { ok: true, data: { resultado: "ok", sede_id: 7 } });
  assert.equal(llamadas[0].nombre, "omitirInicialSede");
  assert.equal(llamadas[0].args[0], 7);
  assert.ok("por" in llamadas[0].args[1]);
});

test("POST /:id/omitir-inicial pasa la preliquidación y devuelve el resultado por sede", async () => {
  encendida();
  respuestas.omitirInicialPreliquidacion = { preliquidacion_id: 19, resultados: [{ sede_id: 1, ok: true, resultado: "ok" }] };
  const r = await llamar("POST", "/19/omitir-inicial", { sede_ids: [1, "2"] });
  assert.equal(r.estado, 200);
  assert.equal(r.json.data.resultados.length, 1);
  assert.equal(llamadas[0].nombre, "omitirInicialPreliquidacion");
  assert.equal(llamadas[0].args[0], 19);
  assert.deepEqual(llamadas[0].args[1].sedeIds, [1, 2]);
});

test("POST /:id/omitir-inicial exige sede_ids explícito y no vacío; sin ellos 400 y no llega al modelo", async () => {
  encendida();
  assert.equal((await llamar("POST", "/19/omitir-inicial")).estado, 400);
  assert.equal((await llamar("POST", "/19/omitir-inicial", {})).estado, 400);
  assert.equal((await llamar("POST", "/19/omitir-inicial", { sede_ids: [] })).estado, 400);
  assert.equal((await llamar("POST", "/19/omitir-inicial", { sede_ids: [0] })).estado, 400);
  assert.equal((await llamar("POST", "/19/omitir-inicial", { sede_ids: ["x"] })).estado, 400);
  assert.equal((await llamar("POST", "/19/omitir-inicial", { sede_ids: 1 })).estado, 400);
  assert.equal(llamadas.length, 0);
});

test("omitir-inicial: id inválido 400, cuerpo con campos extra 400, guard de admin 403; ninguno llega al modelo", async () => {
  encendida();
  assert.equal((await llamar("POST", "/sedes/abc/omitir-inicial")).estado, 400);
  assert.equal((await llamar("POST", "/0/omitir-inicial")).estado, 400);
  assert.equal((await llamar("POST", "/sedes/7/omitir-inicial", { forzar: true })).estado, 400);
  assert.equal((await llamar("POST", "/19/omitir-inicial", { sede_ids: [1], forzar: true })).estado, 400);
  guardPasa = false;
  assert.equal((await llamar("POST", "/sedes/7/omitir-inicial")).estado, 403);
  assert.equal((await llamar("POST", "/19/omitir-inicial", { sede_ids: [1] })).estado, 403);
  assert.equal(llamadas.length, 0);
});

test("omitir-inicial: los errores del modelo se propagan (409 inicial_vigente / oficial_enviada)", async () => {
  encendida();
  respuestas.omitirInicialSede = createError(409, "ya hay inicial", "inicial_vigente");
  const r = await llamar("POST", "/sedes/7/omitir-inicial");
  assert.equal(r.estado, 409);
  assert.equal(r.json.codigo, "inicial_vigente");
});

test("omitir-inicial es escritura normal: con el interruptor apagado es 409 preliquidacion_apagada y no toca el modelo", async () => {
  for (const ruta of ["/sedes/7/omitir-inicial", "/19/omitir-inicial"]) {
    const r = await llamar("POST", ruta, ruta === "/19/omitir-inicial" ? { sede_ids: [1] } : undefined);
    assert.equal(r.estado, 409, ruta);
    assert.equal(r.json.codigo, "preliquidacion_apagada", ruta);
  }
  assert.equal(llamadas.length, 0);
});

test("C3: en producción sin CARNES_AUTH=exigir omitir-inicial responde 503 auth_requerida", async () => {
  encendida();
  process.env.VERCEL_ENV = "production";
  delete process.env.CARNES_AUTH;
  try {
    for (const ruta of ["/sedes/7/omitir-inicial", "/19/omitir-inicial"]) {
      const r = await llamar("POST", ruta, ruta === "/19/omitir-inicial" ? { sede_ids: [1] } : undefined);
      assert.equal(r.estado, 503, ruta);
      assert.equal(r.json.codigo, "auth_requerida");
    }
  } finally {
    delete process.env.VERCEL_ENV;
  }
});
