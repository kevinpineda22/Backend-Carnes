// Compuerta de autenticación (C3): en producción la preliquidación solo funciona con
// CARNES_AUTH=exigir; si no, las escrituras y los envíos a SIESA responden 503
// `auth_requerida`. Sin red ni base real; el controlador se prueba con req/res falsos.
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;
const Config = await import(url("config/preliquidacion.js"));

const matriz = [
  // [VERCEL_ENV, flag, CARNES_AUTH, habilitada, motivo]
  [undefined, "on", undefined, true, null],
  [undefined, "off", undefined, false, "flag_apagado"],
  ["development", "on", "off", true, null],
  ["preview", "on", "reportar", true, null],
  ["production", "on", "exigir", true, null],
  ["production", "on", "reportar", false, "auth_requerida"],
  ["production", "on", "off", false, "auth_requerida"],
  ["production", "on", undefined, false, "auth_requerida"],
  ["production", "on", "exigr", false, "auth_requerida"],
  ["production", "off", "exigir", false, "flag_apagado"],
  ["production", undefined, undefined, false, "flag_apagado"],
  ["production", "TRUE", " Exigir ", true, null],
  ["production", "1", "exigir", true, null],
];

for (const [entorno, flag, auth, habilitada, motivo] of matriz) {
  test(`matriz: VERCEL_ENV=${entorno} flag=${flag} CARNES_AUTH=${auth} -> ${motivo ?? "habilitada"}`, () => {
    const env = { VERCEL_ENV: entorno, CARNES_PRELIQUIDACION: flag, CARNES_AUTH: auth };
    assert.equal(Config.preliquidacionHabilitada(env), habilitada);
    assert.equal(Config.motivoApagado(env), motivo);
    assert.equal(Config.estadoPreliquidacion(env), habilitada ? "on" : "off");
  });
}

test("sin argumentos lee process.env en cada llamada", () => {
  const antes = { ...process.env };
  try {
    process.env.CARNES_PRELIQUIDACION = "on";
    delete process.env.VERCEL_ENV;
    assert.equal(Config.preliquidacionHabilitada(), true);
    process.env.VERCEL_ENV = "production";
    delete process.env.CARNES_AUTH;
    assert.equal(Config.preliquidacionHabilitada(), false);
    process.env.CARNES_AUTH = "exigir";
    assert.equal(Config.preliquidacionHabilitada(), true);
  } finally {
    for (const k of ["CARNES_PRELIQUIDACION", "VERCEL_ENV", "CARNES_AUTH"]) {
      if (antes[k] === undefined) delete process.env[k];
      else process.env[k] = antes[k];
    }
  }
});

test("advertenciaDeArranque: solo cuando el interruptor está encendido en producción sin exigir", () => {
  assert.match(Config.advertenciaDeArranque({ VERCEL_ENV: "production", CARNES_PRELIQUIDACION: "on" }), /CARNES_AUTH=exigir/);
  assert.equal(Config.advertenciaDeArranque({ VERCEL_ENV: "production", CARNES_PRELIQUIDACION: "on", CARNES_AUTH: "exigir" }), null);
  assert.equal(Config.advertenciaDeArranque({ VERCEL_ENV: "production" }), null);
  assert.equal(Config.advertenciaDeArranque({ VERCEL_ENV: "preview", CARNES_PRELIQUIDACION: "on" }), null);
});

test("avisarAuthRequerida registra la advertencia una sola vez", () => {
  const avisos = [];
  const log = { warn: (m) => avisos.push(m) };
  const env = { VERCEL_ENV: "production", CARNES_PRELIQUIDACION: "on" };
  Config.reiniciarAvisoAuth();
  Config.avisarAuthRequerida({ env, log });
  Config.avisarAuthRequerida({ env, log });
  assert.equal(avisos.length, 1);
});

// ─── Controlador: escrituras ───────────────────────────────────────────────

const Controlador = await import(url("controllers/preliquidaciones.controller.js"));
const correr = (metodo) =>
  new Promise((resolver) => Controlador.exigirEscrituraHabilitada({ method: metodo }, {}, (error) => resolver(error ?? null)));

function conEntorno(valores, fn) {
  const claves = ["CARNES_PRELIQUIDACION", "VERCEL_ENV", "CARNES_AUTH"];
  const antes = Object.fromEntries(claves.map((k) => [k, process.env[k]]));
  for (const k of claves) delete process.env[k];
  Object.assign(process.env, valores);
  return Promise.resolve(fn()).finally(() => {
    for (const k of claves) {
      if (antes[k] === undefined) delete process.env[k];
      else process.env[k] = antes[k];
    }
  });
}

test("flag apagado: la escritura es 409 preliquidacion_apagada (sin cambio)", () =>
  conEntorno({}, async () => {
    const error = await correr("POST");
    assert.equal(error.statusCode, 409);
    assert.equal(error.codigo, "preliquidacion_apagada");
  }));

test("producción sin CARNES_AUTH=exigir: la escritura es 503 auth_requerida", () =>
  conEntorno({ CARNES_PRELIQUIDACION: "on", VERCEL_ENV: "production" }, async () => {
    for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
      const error = await correr(metodo);
      assert.equal(error.statusCode, 503, metodo);
      assert.equal(error.codigo, "auth_requerida", metodo);
    }
  }));

test("producción con CARNES_AUTH=exigir: la escritura pasa", () =>
  conEntorno({ CARNES_PRELIQUIDACION: "on", VERCEL_ENV: "production", CARNES_AUTH: "exigir" }, async () => {
    assert.equal(await correr("POST"), null);
  }));

test("las lecturas (GET) nunca se bloquean por la compuerta", () =>
  conEntorno({ CARNES_PRELIQUIDACION: "on", VERCEL_ENV: "production" }, async () => {
    assert.equal(await correr("GET"), null);
  }));

// ─── JD S2: la compuerta de auth no depende del interruptor ────────────────

const correrRuta = (metodo, path) =>
  new Promise((resolver) =>
    Controlador.exigirEscrituraHabilitada({ method: metodo, path }, {}, (error) => resolver(error ?? null)),
  );
const RUTAS_DRENAJE_PRUEBA = ["/5/procesar", "/sedes/3/procesar", "/5/cerrar"];

for (const auth of ["off", undefined, "reportar"]) {
  test(`producción + interruptor apagado + CARNES_AUTH=${auth}: toda ruta de drenaje es 503 auth_requerida`, () =>
    conEntorno({ VERCEL_ENV: "production", ...(auth ? { CARNES_AUTH: auth } : {}) }, async () => {
      for (const ruta of RUTAS_DRENAJE_PRUEBA) {
        const error = await correrRuta("POST", ruta);
        assert.equal(error?.statusCode, 503, ruta);
        assert.equal(error?.codigo, "auth_requerida", ruta);
      }
    }));
}

test("producción + interruptor apagado + CARNES_AUTH=exigir: el drenaje pasa", () =>
  conEntorno({ VERCEL_ENV: "production", CARNES_AUTH: "exigir" }, async () => {
    for (const ruta of RUTAS_DRENAJE_PRUEBA) assert.equal(await correrRuta("POST", ruta), null, ruta);
  }));

test("producción + interruptor apagado + auth exigir: una ruta que no es de drenaje sigue en 409", () =>
  conEntorno({ VERCEL_ENV: "production", CARNES_AUTH: "exigir" }, async () => {
    const error = await correrRuta("POST", "/5/recepciones");
    assert.equal(error?.statusCode, 409);
    assert.equal(error?.codigo, "preliquidacion_apagada");
  }));

test("producción + interruptor apagado + sin auth: ruta que no es de drenaje también es 503", () =>
  conEntorno({ VERCEL_ENV: "production" }, async () => {
    const error = await correrRuta("POST", "/5/recepciones");
    assert.equal(error?.statusCode, 503);
    assert.equal(error?.codigo, "auth_requerida");
  }));
