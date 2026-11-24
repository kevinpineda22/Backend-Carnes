// Helpers de corridas (`carnes_preliquidacion_corridas`): crear, continuar, registrar progreso y cerrar.
// Supabase falso en memoria; sin red ni base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let filas = [];
let secuencia = 0;
let fallaProxima = null;

class Q {
  constructor() { this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  insert(v) { this.ins = v; return this; }
  update(v) { this.upd = v; return this; }
  ejecutar() {
    if (fallaProxima) { const m = fallaProxima; fallaProxima = null; return { data: null, error: { message: m } }; }
    if (this.ins) {
      secuencia += 1;
      const fila = { id: secuencia, estado: "en_curso", preliquidacion_ids: [], resumen: {}, dry_run: false, ...this.ins };
      filas.push(fila);
      return { data: [fila], error: null };
    }
    const sel = filas.filter((r) => this.f.every((g) => g(r)));
    if (this.upd) { for (const r of sel) Object.assign(r, this.upd); return { data: sel, error: null }; }
    return { data: sel, error: null };
  }
  maybeSingle() { const { data, error } = this.ejecutar(); return Promise.resolve({ data: data?.[0] ?? null, error }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve(this.ejecutar()).then(res, rej); }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: () => new Q() } } });
const Corridas = await import(url("models/PreliquidacionCorrida.model.js"));

const AHORA = new Date("2026-11-24T03:00:00.000Z");

beforeEach(() => {
  filas = [];
  secuencia = 0;
  fallaProxima = null;
});

test("iniciarCorrida crea una fila en_curso con origen, gh_run_id y dry_run", async () => {
  const c = await Corridas.iniciarCorrida({ origen: "schedule", ghRunId: "123", dryRun: true, ahora: AHORA });
  assert.equal(c.id, 1);
  assert.equal(filas[0].origen, "schedule");
  assert.equal(filas[0].gh_run_id, "123");
  assert.equal(filas[0].dry_run, true);
  assert.equal(filas[0].iniciada_at, AHORA.toISOString());
  assert.equal(c.resumen.reevaluadas.length, 0);
});

test("iniciarCorrida rechaza un origen desconocido", async () => {
  await assert.rejects(() => Corridas.iniciarCorrida({ origen: "otro" }), /origen/);
  assert.equal(filas.length, 0);
});

test("abrirCorrida sin corrida_id crea una nueva (nunca NULL, R14)", async () => {
  const c = await Corridas.abrirCorrida({ origen: "sweep", ahora: AHORA });
  assert.equal(c.id, 1);
  assert.equal(filas.length, 1);
});

test("abrirCorrida con un corrida_id en curso la continúa y conserva `reevaluadas`", async () => {
  filas.push({ id: 7, origen: "schedule", estado: "en_curso", preliquidacion_ids: [1], resumen: { reevaluadas: [11, 12] }, dry_run: false });
  const c = await Corridas.abrirCorrida({ corridaId: 7, origen: "dispatch", ahora: AHORA });
  assert.equal(c.id, 7);
  assert.deepEqual(c.resumen.reevaluadas, [11, 12]);
  assert.equal(filas.length, 1);
});

test("abrirCorrida con un corrida_id desconocido crea una corrida nueva", async () => {
  const c = await Corridas.abrirCorrida({ corridaId: 999, origen: "schedule", ahora: AHORA });
  assert.equal(c.id, 1);
  assert.equal(filas.length, 1);
});

test("abrirCorrida con una corrida ya terminada crea una nueva", async () => {
  filas.push({ id: 7, origen: "schedule", estado: "ok", preliquidacion_ids: [], resumen: {}, dry_run: false });
  secuencia = 7;
  const c = await Corridas.abrirCorrida({ corridaId: 7, origen: "schedule", ahora: AHORA });
  assert.equal(c.id, 8);
});

test("abrirCorrida con un corrida_id no numérico crea una nueva sin consultar", async () => {
  const c = await Corridas.abrirCorrida({ corridaId: "abc", origen: "schedule", ahora: AHORA });
  assert.equal(c.id, 1);
});

test("registrarProgreso une las preliquidaciones sin duplicar y guarda `reevaluadas`", async () => {
  const c = await Corridas.iniciarCorrida({ origen: "schedule", ahora: AHORA });
  c.resumen.reevaluadas.push(11);
  await Corridas.registrarProgreso(c, { preliquidacionId: 1 });
  await Corridas.registrarProgreso(c, { preliquidacionId: 1 });
  await Corridas.registrarProgreso(c, { preliquidacionId: 2 });
  assert.deepEqual(filas[0].preliquidacion_ids, [1, 2]);
  assert.deepEqual(filas[0].resumen.reevaluadas, [11]);
});

test("registrarProgreso acumula los contadores de cada preliquidación en el resumen", async () => {
  const c = await Corridas.iniciarCorrida({ origen: "schedule", ahora: AHORA });
  await Corridas.registrarProgreso(c, { preliquidacionId: 1, resultado: { enviadas: 2, errores: 1 } });
  await Corridas.registrarProgreso(c, { preliquidacionId: 2, resultado: { enviadas: 1, errores: 0 } });
  assert.equal(filas[0].resumen.enviadas, 3);
  assert.equal(filas[0].resumen.errores, 1);
});

test("terminarCorrida marca ok con terminada_at", async () => {
  const c = await Corridas.iniciarCorrida({ origen: "schedule", ahora: AHORA });
  await Corridas.terminarCorrida(c, { ahora: AHORA });
  assert.equal(filas[0].estado, "ok");
  assert.equal(filas[0].terminada_at, AHORA.toISOString());
  assert.equal(filas[0].error, undefined);
});

test("terminarCorrida con error marca error y guarda el mensaje", async () => {
  const c = await Corridas.iniciarCorrida({ origen: "schedule", ahora: AHORA });
  await Corridas.terminarCorrida(c, { error: new Error("falló todo"), ahora: AHORA });
  assert.equal(filas[0].estado, "error");
  assert.equal(filas[0].error, "falló todo");
});

test("una corrida con pendientes se deja en_curso para que el workflow la continúe", async () => {
  const c = await Corridas.iniciarCorrida({ origen: "schedule", ahora: AHORA });
  await Corridas.terminarCorrida(c, { ahora: AHORA, continua: true });
  assert.equal(filas[0].estado, "en_curso");
  assert.equal(filas[0].terminada_at, undefined);
});

test("un fallo de la base al crear la corrida se propaga", async () => {
  fallaProxima = "sin conexión";
  await assert.rejects(() => Corridas.iniciarCorrida({ origen: "schedule" }), /sin conexión/);
});
