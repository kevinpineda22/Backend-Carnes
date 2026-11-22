// Camino inmediato (2.16): vincular al finalizar y, si la preliquidación ya liquidó (o debe
// liquidar), programar el envío de esa sede con waitUntil ANTES de responder. Sin base ni SIESA:
// todas las dependencias son falsas.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { alFinalizar } = await import("../src/services/preliquidacionInmediato.js");

const silencio = { info() {}, warn() {}, error() {} };
const recepcion = (extra = {}) => ({ id: 101, especie: "res", fecha_ingreso: "2026-11-23", recibido_por: "ana@x.co", ...extra });
// 2026-11-23: corte 21:30 Bogotá = 2026-11-24T02:30Z
const ANTES = new Date("2026-11-23T15:00:00Z");
const DESPUES = new Date("2026-11-24T15:00:00Z");

function armar({
  apagado = null,
  cabecera = { id: 1, especie: "res", estado: "abierta", fecha_primer_ingreso: "2026-11-23", liquidada_at: "2026-11-24T02:31:00Z" },
  sede = { id: 11, estado: "vinculada", version: 4, preliquidacion_id: 1 },
  vincular = async () => ({ resultado: "vinculada", preliquidacion_id: 1, restantes: 2 }),
  ahoraMs = 1_000,
  siesaEncendido = true,
  waitUntil,
  procesar,
} = {}) {
  const registro = { alertas: [], procesar: [], terminar: [], waitUntil: 0, registradoAntesDeResponder: null };
  const deps = {
    motivoApagado: () => apagado,
    siesaActivo: () => siesaEncendido,
    ahoraMs: () => ahoraMs,
    vincular: async (id) => vincular(id),
    leerSedeDeRecepcion: async () => ({ sede, cabecera }),
    encolar: async (a) => (registro.alertas.push(a), { ok: true }),
    abrirCorrida: async (o) => ({ id: 500, origen: o.origen, preliquidacion_ids: [], resumen: { reevaluadas: [] } }),
    registrarProgreso: async () => {},
    terminarCorrida: async (c, o) => registro.terminar.push(o),
    procesar:
      procesar ??
      (async (id, o) => {
        registro.procesar.push({ id, ...o });
        return { preliquidacion_id: id, resultado: "ok", enviadas: 1, pendientes: 0 };
      }),
    waitUntil:
      waitUntil ??
      ((fn) => {
        registro.waitUntil += 1;
        registro.promesa = fn();
        return true;
      }),
    log: silencio,
  };
  return { deps, registro };
}

test("A-S6: con el interruptor apagado no hace nada y no agrega nada a la respuesta", async () => {
  const { deps, registro } = armar({ apagado: "flag_apagado" });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r, null);
  assert.equal(registro.waitUntil, 0);
  assert.equal(registro.alertas.length, 0);
});

test("la compuerta de auth también lo deja inerte", async () => {
  const { deps } = armar({ apagado: "auth_requerida" });
  assert.equal(await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps), null);
});

test("una recepción que no es de res/cerdo no se vincula", async () => {
  const { deps, registro } = armar();
  let vinculo = false;
  deps.vincular = async () => ((vinculo = true), { resultado: "vinculada" });
  assert.equal(await alFinalizar(recepcion({ especie: "pollo" }), { inicioPeticion: 0, ahora: DESPUES }, deps), null);
  assert.equal(vinculo, false);
  assert.equal(registro.waitUntil, 0);
});

test("D-S7: antes de la primera corrida vincula y no envía (espera_corte)", async () => {
  const { deps, registro } = armar({
    cabecera: { id: 1, especie: "res", estado: "abierta", fecha_primer_ingreso: "2026-11-23", liquidada_at: null },
  });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: ANTES }, deps);
  assert.deepEqual(r, { resultado: "vinculada", envio: "espera_corte" });
  assert.equal(registro.waitUntil, 0);
});

test("D-S6: ya liquidada, registra waitUntil ANTES de volver y envía solo esa sede (origen inmediato)", async () => {
  const { deps, registro } = armar();
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.deepEqual(r, { resultado: "vinculada", envio: "programado" });
  assert.equal(registro.waitUntil, 1, "waitUntil registrado antes de devolver la respuesta");
  await registro.promesa;
  const [p] = registro.procesar;
  assert.equal(p.id, 1);
  assert.equal(p.origen, "inmediato");
  assert.equal(p.soloSedeId, 11);
  assert.equal(p.corrida.id, 500);
  assert.ok(p.timeoutMs >= 30_000, "usa el presupuesto restante como timeout");
  assert.equal(typeof p.hayPresupuesto, "function");
  assert.equal(registro.terminar[0].error ?? null, null);
});

test("D1: la primera sede después de las 21:30 liquida de inmediato (programado)", async () => {
  const { deps, registro } = armar({
    cabecera: { id: 1, especie: "res", estado: "abierta", fecha_primer_ingreso: "2026-11-23", liquidada_at: null },
  });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: new Date("2026-11-24T03:30:00Z") }, deps);
  assert.equal(r.envio, "programado");
  await registro.promesa;
  assert.equal(registro.procesar.length, 1);
});

test("sin presupuesto de tiempo responde diferido y lo recoge el barrido", async () => {
  const { deps, registro } = armar({ ahoraMs: 280_000 });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.deepEqual(r, { resultado: "vinculada", envio: "diferido" });
  assert.equal(registro.waitUntil, 0);
});

test("si waitUntil no está disponible el envío queda diferido (no se ejecuta en caliente)", async () => {
  const { deps, registro } = armar({ waitUntil: () => false });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r.envio, "diferido");
  assert.equal(registro.procesar.length, 0);
});

test("SIESA apagado: envio simulada", async () => {
  const { deps, registro } = armar({ siesaEncendido: false });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r.envio, "simulada");
  await registro.promesa;
  assert.equal(registro.procesar.length, 1);
});

test("inicial no ok con SIESA encendido: inicial_pendiente y no se programa envío", async () => {
  const { deps, registro } = armar();
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES, inicialEstado: "error" }, deps);
  assert.equal(r.envio, "inicial_pendiente");
  assert.equal(registro.waitUntil, 0);
});

test("desborde: sede bloqueada, alerta excede_animales con la versión de la sede y sin envío", async () => {
  const { deps, registro } = armar({
    vincular: async () => ({ resultado: "excede", preliquidacion_id: 1, restantes: 1 }),
    sede: { id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", version: 2, preliquidacion_id: 1 },
  });
  const r = await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.deepEqual(r, { resultado: "excede", envio: "bloqueada" });
  assert.equal(registro.waitUntil, 0);
  const alerta = registro.alertas[0];
  assert.equal(alerta.evento, "excede_animales");
  assert.equal(alerta.preliquidacionId, 1);
  assert.equal(alerta.sedeId, 11);
  assert.equal(alerta.ocurrencia, 2);
});

for (const codigo of ["sin_preliquidacion", "fuera_ventana", "oficial_legacy"]) {
  test(`${codigo}: encola la alerta por recepción (sede 0) y no envía ni lanza`, async () => {
    const error = Object.assign(new Error(codigo), { codigo });
    const { deps, registro } = armar({ vincular: async () => { throw error; } });
    const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
    assert.deepEqual(r, { resultado: codigo, envio: null });
    assert.equal(registro.alertas[0].evento, codigo);
    assert.equal(registro.alertas[0].sedeId, 0);
    assert.equal(registro.alertas[0].ocurrencia, 101);
    assert.equal(registro.waitUntil, 0);
  });
}

test("ya_vinculada no es un error: sigue con la sede existente", async () => {
  const error = Object.assign(new Error("ya"), { codigo: "ya_vinculada" });
  const { deps, registro } = armar({ vincular: async () => { throw error; } });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r.envio, "programado");
  assert.equal(registro.waitUntil, 1);
});

test("un error inesperado nunca se propaga a la respuesta de finalizar", async () => {
  const { deps } = armar({ vincular: async () => { throw new Error("base caída"); } });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.deepEqual(r, { resultado: "error", envio: null });
});

test("no bloquea la respuesta: un procesar que nunca termina no retrasa alFinalizar", async () => {
  const { deps } = armar({ procesar: () => new Promise(() => {}) });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r.envio, "programado");
});

test("si la tarea de fondo falla, la corrida termina con error y nada se propaga", async () => {
  const { deps, registro } = armar({ procesar: async () => { throw new Error("SIESA caído"); } });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r.envio, "programado");
  await registro.promesa;
  assert.match(registro.terminar[0].error.message, /SIESA caído/);
});

// ─── Cableado en el controlador (estático) ─────────────────────────────────

import { readFileSync } from "node:fs";
const controlador = readFileSync(new URL("../src/controllers/recepciones.controller.js", import.meta.url), "utf8");
const cuerpoFinalizar = controlador.slice(controlador.indexOf("export async function finalizar"), controlador.indexOf("export async function descartar"));

test("finalizar captura inicioPeticion al empezar y llama a alFinalizar antes de res.json", () => {
  const inicio = cuerpoFinalizar.indexOf("inicioPeticion = Date.now()");
  const modelo = cuerpoFinalizar.indexOf("RecepcionModel.finalizar(");
  const todos = cuerpoFinalizar.indexOf("Promise.all");
  const alfin = cuerpoFinalizar.indexOf("preliquidacionAlFinalizar(");
  const respuesta = cuerpoFinalizar.indexOf("res.json(");
  assert.ok(inicio > -1 && inicio < modelo, "inicioPeticion se captura antes de cerrar la recepción");
  assert.ok(alfin > todos, "alFinalizar va después del Promise.all (inicial + vísceras)");
  assert.ok(alfin < respuesta, "alFinalizar (y su waitUntil) se registra antes de res.json");
  assert.match(cuerpoFinalizar, /preliquidacion/);
});

test("@vercel/functions está declarado como dependencia", () => {
  const paquete = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(paquete.dependencies["@vercel/functions"]);
});
