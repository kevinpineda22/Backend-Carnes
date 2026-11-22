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

// ─── Corridas perdidas (R7, A-S4 de la programación) ───────────────────────

const { revisarCorridasPerdidas } = await import("../src/models/PreliquidacionVigilancia.model.js");

// Corte del 2026-11-23 = 2026-11-24T02:30Z. 61+ minutos después ya es "perdida" sin corrida ok.
const TARDE = new Date("2026-11-24T03:45:00Z");
const sinLiquidar = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", fecha_primer_ingreso: "2026-11-23", liquidada_at: null, ...extra,
});

test("corrida perdida: pasó el corte + 60 min sin corrida ok -> encola corrida_perdida y la reporta", async () => {
  const alertas = [];
  const r = await revisarCorridasPerdidas({
    ahora: TARDE,
    leerAbiertas: async () => [sinLiquidar()],
    leerCorridas: async () => [],
    encolar: async (a) => (alertas.push(a), { ok: true }),
    log: silencio,
  });
  assert.deepEqual(r.perdidas, [1]);
  assert.deepEqual(
    { e: alertas[0].evento, p: alertas[0].preliquidacionId, s: alertas[0].sedeId, o: alertas[0].ocurrencia },
    { e: "corrida_perdida", p: 1, s: 0, o: 0 },
  );
});

test("con una corrida ok reciente que incluye la preliquidación no hay alerta", async () => {
  const alertas = [];
  const r = await revisarCorridasPerdidas({
    ahora: TARDE,
    leerAbiertas: async () => [sinLiquidar()],
    leerCorridas: async () => [
      { id: 9, estado: "ok", dry_run: false, preliquidacion_ids: [1], terminada_at: "2026-11-24T03:20:00Z" },
    ],
    encolar: async (a) => (alertas.push(a), { ok: true }),
    log: silencio,
  });
  assert.deepEqual(r.perdidas, []);
  assert.equal(alertas.length, 0);
});

test("un dry_run no cubre la corrida perdida", async () => {
  const r = await revisarCorridasPerdidas({
    ahora: TARDE,
    leerAbiertas: async () => [sinLiquidar()],
    leerCorridas: async () => [
      { id: 9, estado: "ok", dry_run: true, preliquidacion_ids: [1], terminada_at: "2026-11-24T03:30:00Z" },
    ],
    encolar: async () => ({ ok: true }),
    log: silencio,
  });
  assert.deepEqual(r.perdidas, [1]);
});

test("antes de corte + 60 min o ya liquidada: no es perdida y ni siquiera consulta corridas", async () => {
  let consultas = 0;
  const r = await revisarCorridasPerdidas({
    ahora: new Date("2026-11-24T03:00:00Z"),
    leerAbiertas: async () => [sinLiquidar(), sinLiquidar({ id: 2, liquidada_at: "2026-11-24T02:31:00Z" })],
    leerCorridas: async () => ((consultas += 1), []),
    encolar: async () => ({ ok: true }),
    log: silencio,
  });
  assert.deepEqual(r.perdidas, []);
  assert.equal(consultas, 0);
});

test("con preliquidaciones dadas (GET) no las lee de la base y encola la alerta deduplicada por el puerto", async () => {
  const alertas = [];
  const r = await revisarCorridasPerdidas({
    ahora: TARDE,
    preliquidaciones: [sinLiquidar({ id: 5 })],
    leerAbiertas: async () => assert.fail("no debe leer"),
    leerCorridas: async () => [],
    encolar: async (a) => (alertas.push(a), { ok: true }),
    log: silencio,
  });
  assert.deepEqual(r.perdidas, [5]);
  assert.equal(alertas[0].preliquidacionId, 5);
});

test("una falla al alertar no impide devolver las perdidas ni lanza", async () => {
  const r = await revisarCorridasPerdidas({
    ahora: TARDE,
    leerAbiertas: async () => [sinLiquidar()],
    leerCorridas: async () => [],
    encolar: async () => { throw new Error("correo caído"); },
    log: silencio,
  });
  assert.deepEqual(r.perdidas, [1]);
});

test("las lecturas piden solo corridas ok, no dry_run, terminadas en la última hora", async () => {
  let filtro = null;
  await revisarCorridasPerdidas({
    ahora: TARDE,
    leerAbiertas: async () => [sinLiquidar()],
    leerCorridas: async (f) => ((filtro = f), []),
    encolar: async () => ({ ok: true }),
    log: silencio,
  });
  assert.equal(filtro.desde.toISOString(), "2026-11-24T02:45:00.000Z");
});
