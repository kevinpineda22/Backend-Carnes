// Camino inmediato (2.16): vincular al finalizar y, si la preliquidación ya liquidó (o debe
// liquidar), programar el envío de esa sede con waitUntil ANTES de responder. Sin base ni SIESA:
// todas las dependencias son falsas.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { alFinalizar, waitUntilPorDefecto, reiniciarAvisoWaitUntil } = await import("../src/services/preliquidacionInmediato.js");

const { PRESUPUESTO_MINIMO_DESPACHO_MS } = await import("../src/services/preliquidacionAlertas.js");
const { LIMITE_FUNCION_MS } = await import("../src/shared/siesaAjusteVisceras.js");

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
  const registro = { despachos: [], perdidas: 0, alertas: [], procesar: [], terminar: [], waitUntil: 0, registradoAntesDeResponder: null };
  const deps = {
    motivoApagado: () => apagado,
    siesaActivo: () => siesaEncendido,
    ahoraMs: () => ahoraMs,
    vincular: async (id) => vincular(id),
    leerSedeDeRecepcion: async () => ({ sede, cabecera }),
    encolar: async (a) => (registro.alertas.push(a), { ok: true }),
    despacharAlertas: async (c) => (registro.despachos.push(c), { ok: true, enviadas: 0 }),
    segundoPlano: async (fn) => (await fn(), true),
    revisarCorridasPerdidas: async () => (registro.perdidas += 1, { perdidas: [] }),
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

test("R7: revisa corridas perdidas al finalizar, y si la revisión falla la vinculación sigue", async () => {
  const { deps, registro } = armar();
  await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(registro.perdidas, 1);
  const fallida = armar();
  fallida.deps.revisarCorridasPerdidas = async () => { throw new Error("boom"); };
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, fallida.deps);
  assert.equal(r.envio, "programado");
  const apagada = armar({ apagado: "flag_apagado" });
  await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, apagada.deps);
  assert.equal(apagada.registro.perdidas, 0, "con el interruptor apagado no revisa nada");
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
  assert.equal(typeof p.restante, "function", "el CEI de vísceras mide el tiempo que queda desde el inicio de la petición");
  assert.ok(p.restante() >= 30_000);
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

test("inicial omitida (sql/044) con SIESA encendido: no es inicial_pendiente, el envío sigue su curso", async () => {
  const { deps, registro } = armar();
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES, inicialEstado: "omitida" }, deps);
  assert.notEqual(r.envio, "inicial_pendiente");
  assert.equal(registro.waitUntil, 1);
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

// ─── JD S2: la falta de @vercel/functions no se traga en silencio ──────────

test("si @vercel/functions no carga: devuelve false, no inicia la tarea y avisa UNA sola vez con console.warn", async () => {
  reiniciarAvisoWaitUntil();
  const avisos = [];
  const log = { warn: (m) => avisos.push(m) };
  let iniciada = 0;
  const importar = async () => {
    throw new Error("Cannot find package '@vercel/functions'");
  };
  assert.equal(await waitUntilPorDefecto(() => { iniciada += 1; }, { importar, log }), false);
  assert.equal(await waitUntilPorDefecto(() => { iniciada += 1; }, { importar, log }), false);
  assert.equal(iniciada, 0);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /@vercel\/functions/);
});

test("waitUntilPorDefecto registra la tarea cuando la dependencia carga", async () => {
  const tareas = [];
  const importar = async () => ({ waitUntil: (t) => tareas.push(t) });
  assert.equal(await waitUntilPorDefecto(() => "tarea", { importar }), true);
  assert.deepEqual(tareas, ["tarea"]);
});

test("vercel.json fija maxDuration 300 s para la función (legacy builds)", () => {
  const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(cfg.builds[0].config?.maxDuration, 300);
});

// ─── Despacho en segundo plano de las alertas sin envío ────────────────────

const desborde = (extra = {}) =>
  armar({
    vincular: async () => ({ resultado: "excede", preliquidacion_id: 1, restantes: 1 }),
    sede: { id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", version: 2, preliquidacion_id: 1 },
    ...extra,
  });

test("el despacho en segundo plano no pasa `ahora` (el reloj lo lee el propio despacho) y va acotado", async () => {
  const { deps, registro } = desborde();
  await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(registro.despachos.length, 1);
  assert.equal("ahora" in registro.despachos[0], false);
  assert.ok(registro.despachos[0].limite > 0 && Number.isFinite(registro.despachos[0].hasta));
});

test("un tiempo restante no finito cuenta como sin presupuesto: no se despacha", async () => {
  const { deps, registro } = desborde({ ahoraMs: Number.NaN });
  await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(registro.despachos.length, 0);
  assert.equal(registro.alertas.length, 1, "la alerta sigue encolada para el barrido");
});

test("si lo que queda no alcanza para el peor caso de un envío (TIMEOUT_ENVIO_MS + margen) no se despacha", async () => {
  const { deps, registro } = desborde({ ahoraMs: LIMITE_FUNCION_MS - 30_500 });
  await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(registro.despachos.length, 0);
  const justo = desborde({ ahoraMs: LIMITE_FUNCION_MS - PRESUPUESTO_MINIMO_DESPACHO_MS });
  await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, justo.deps);
  assert.equal(justo.registro.despachos.length, 1);
});

test("corte manual futuro: vincular tras el corte automático NO envía (espera_corte); alcanzado, sí", async () => {
  const cabecera = {
    id: 1, especie: "res", estado: "abierta", fecha_primer_ingreso: "2026-11-23", liquidada_at: null,
    corte_manual: "2026-11-24T20:00:00.000Z",
  };
  const retenida = armar({ cabecera });
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, retenida.deps);
  assert.deepEqual(r, { resultado: "vinculada", envio: "espera_corte" });
  assert.equal(retenida.registro.waitUntil, 0);

  const alcanzada = armar({ cabecera: { ...cabecera, corte_manual: "2026-11-23T20:00:00.000Z" } });
  const r2 = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: new Date("2026-11-23T21:00:00Z") }, alcanzada.deps);
  assert.equal(r2.envio, "programado");
});
