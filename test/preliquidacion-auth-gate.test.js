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
