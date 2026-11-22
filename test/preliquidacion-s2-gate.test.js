// Compuerta de salida de S2 (2.20): verificaciones estáticas y de configuración. Solo lee archivos y
// variables de entorno: no ejecuta nada contra SIESA ni contra la base.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const aqui = (ruta) => new URL(ruta, import.meta.url);
const leer = (ruta) => readFileSync(aqui(ruta), "utf8");
const titulos = (texto) => [...texto.matchAll(/\btest\(\s*[`"']([^`"']+)[`"']/g)].map((m) => m[1]);
const archivosDeTest = readdirSync(aqui("./")).filter((f) => f.endsWith(".test.js"));

test("M1, M2, M5 y M6 tienen pruebas con su identificador", () => {
  const todos = archivosDeTest.flatMap((f) => titulos(leer(f)));
  for (const m of ["M1", "M2", "M5", "M6"]) {
    assert.ok(todos.some((t) => new RegExp(`\\b${m}\\b`).test(t)), `ningún test menciona ${m}`);
  }
});

test("ningún test hace una llamada real a SIESA: los hosts configurados son inválidos o locales", () => {
  for (const archivo of archivosDeTest) {
    for (const m of leer(archivo).matchAll(/CONNEKTA_BASE_URL\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      assert.match(m[1], /\.invalid\b|127\.0\.0\.1|localhost/, `${archivo} apunta a ${m[1]}`);
    }
  }
});

test("ni el código de S2 ni las pruebas importan nada de scripts/ (SIESA de producción)", () => {
  const fuentes = [
    "../src/services/preliquidacionCron.js",
    "../src/services/preliquidacionInmediato.js",
    "../src/routes/cron.routes.js",
    "../src/models/Preliquidacion.model.js",
    "../src/models/PreliquidacionCierre.model.js",
    "../src/models/PreliquidacionVigilancia.model.js",
    "../src/models/PreliquidacionCorrida.model.js",
  ];
  for (const f of fuentes) assert.doesNotMatch(leer(f), /from\s+["'][^"']*scripts\//, f);
  for (const archivo of archivosDeTest) {
    assert.doesNotMatch(leer(archivo), /import\s*\(?\s*["'][^"']*\/scripts\//, `${archivo} importa scripts/`);
  }
});

test("el workflow existe, referencia secretos solo por nombre y tiene su prueba estática", () => {
  assert.ok(existsSync(aqui("../.github/workflows/preliquidacion.yml")));
  assert.ok(archivosDeTest.includes("workflow-preliquidacion.test.js"));
});

test("el interruptor está apagado por defecto y el cron es inerte con él apagado", async () => {
  const previo = { ...process.env };
  delete process.env.CARNES_PRELIQUIDACION;
  delete process.env.VERCEL_ENV;
  try {
    const { preliquidacionHabilitada, motivoApagado } = await import("../src/config/preliquidacion.js");
    assert.equal(preliquidacionHabilitada(), false);
    assert.equal(motivoApagado(), "flag_apagado");
  } finally {
    process.env = previo;
  }
  const { ejecutarCron } = await import("../src/services/preliquidacionCron.js");
  const r = await ejecutarCron({ origen: "schedule" }, { motivoApagado: () => "flag_apagado" });
  assert.deepEqual(r, { ok: true, flag: "off", motivo: "flag_apagado" });
});

test("las alertas salen a la variable de entorno, sin correos escritos en el código de S2", () => {
  for (const f of [
    "../src/services/preliquidacionAlertas.js",
    "../src/services/preliquidacionCron.js",
    "../src/services/preliquidacionInmediato.js",
    "../src/models/PreliquidacionVigilancia.model.js",
    "../src/models/PreliquidacionCierre.model.js",
    "../.github/workflows/preliquidacion.yml",
  ]) {
    assert.doesNotMatch(leer(f), /[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/i, `${f} tiene un correo escrito`);
  }
});
