// Vigilancia de la preliquidación: barrido de ventanas vencidas (A-S4) y detección
// de corridas perdidas (R7). Sin base: las lecturas y escrituras se inyectan.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { escanearVentanas } = await import("../src/models/PreliquidacionVigilancia.model.js");

const silencio = { info() {}, warn() {}, error() {} };
const AHORA = new Date("2026-11-26T15:00:00Z");

const preliq = (extra = {}) => ({
  id: 1,
  especie: "res",
  estado: "abierta",
  restantes: 4,
  ventana_fin: "2026-11-25T04:59:59.999Z",
  aviso_ventana_at: null,
  ...extra,
});

test("ventana vencida con animales sin asignar: encola ventana_vencida una vez y marca el aviso", async () => {
  const alertas = [];
  const marcas = [];
  const base = {
    ahora: AHORA,
    leerAbiertas: async () => [preliq()],
    encolar: async (a) => (alertas.push(a), { ok: true }),
    marcarAviso: async (id, cuando) => marcas.push({ id, cuando }),
    log: silencio,
  };
  const r = await escanearVentanas(base);
  assert.equal(alertas.length, 1);
  assert.deepEqual(
    { e: alertas[0].evento, p: alertas[0].preliquidacionId, s: alertas[0].sedeId, o: alertas[0].ocurrencia },
    { e: "ventana_vencida", p: 1, s: 0, o: 0 },
  );
  assert.deepEqual(marcas, [{ id: 1, cuando: AHORA }]);
  assert.deepEqual(r.vencidas, [1]);
});

test("A-S4: con aviso_ventana_at ya puesto la segunda corrida no encola otra alerta", async () => {
  const alertas = [];
  const r = await escanearVentanas({
    ahora: AHORA,
    leerAbiertas: async () => [preliq({ aviso_ventana_at: "2026-11-25T06:00:00Z" })],
    encolar: async (a) => (alertas.push(a), { ok: true }),
    marcarAviso: async () => assert.fail("no debe marcar de nuevo"),
    log: silencio,
  });
  assert.equal(alertas.length, 0);
  assert.deepEqual(r.vencidas, []);
});

test("sin animales restantes o con ventana vigente no hay alerta", async () => {
  const alertas = [];
  await escanearVentanas({
    ahora: AHORA,
    leerAbiertas: async () => [preliq({ restantes: 0 }), preliq({ id: 2, ventana_fin: "2026-11-30T04:59:59.999Z" })],
    encolar: async (a) => (alertas.push(a), { ok: true }),
    marcarAviso: async () => {},
    log: silencio,
  });
  assert.equal(alertas.length, 0);
});

test("con el puerto de alertas en no-op el aviso NO se marca (la alerta real aún no existe)", async () => {
  const marcas = [];
  await escanearVentanas({
    ahora: AHORA,
    leerAbiertas: async () => [preliq()],
    encolar: async () => ({ ok: true, noop: true }),
    marcarAviso: async (id) => marcas.push(id),
    log: silencio,
  });
  assert.deepEqual(marcas, []);
});

test("una alerta que falla no impide revisar las demás ni lanza", async () => {
  const vistas = [];
  const r = await escanearVentanas({
    ahora: AHORA,
    leerAbiertas: async () => [preliq({ id: 1 }), preliq({ id: 2 })],
    encolar: async (a) => {
      vistas.push(a.preliquidacionId);
      if (a.preliquidacionId === 1) throw new Error("correo caído");
      return { ok: true };
    },
    marcarAviso: async () => {},
    log: silencio,
  });
  assert.deepEqual(vistas, [1, 2]);
  assert.deepEqual(r.vencidas, [1, 2]);
});

test("filtra por especie al leer", async () => {
  let filtro = null;
  await escanearVentanas({
    ahora: AHORA,
    especie: "cerdo",
    leerAbiertas: async (f) => ((filtro = f), []),
    encolar: async () => ({ ok: true }),
    marcarAviso: async () => {},
    log: silencio,
  });
  assert.deepEqual(filtro, { especie: "cerdo" });
});
