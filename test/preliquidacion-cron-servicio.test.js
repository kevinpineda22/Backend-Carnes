// Orquestador del cron de preliquidaciones (`ejecutarCron`) y validación del cuerpo.
// Todas las dependencias son falsas: sin base, sin red, sin SIESA.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { ejecutarCron, validarCuerpoCron } = await import("../src/services/preliquidacionCron.js");

const silencio = { info() {}, warn() {}, error() {} };

/** Dependencias falsas con un registro de llamadas. */
function armar({ apagado = null, abiertas = [], resumenes = {}, relojMs = [0], fallos = {} } = {}) {
  const llamadas = [];
  let i = 0;
  const reg = (nombre, retorno) => async (...args) => {
    llamadas.push({ nombre, args });
    if (fallos[nombre]) throw fallos[nombre];
    return typeof retorno === "function" ? retorno(...args) : retorno;
  };
  const corrida = { id: 77, preliquidacion_ids: [], resumen: { reevaluadas: [] } };
  const deps = {
    motivoApagado: () => apagado,
    ahora: () => new Date("2026-11-24T02:30:00Z"),
    ahoraMs: () => relojMs[Math.min(i++, relojMs.length - 1)],
    presupuestoMs: 1000,
    abrirCorrida: reg("abrirCorrida", corrida),
    registrarProgreso: reg("registrarProgreso", corrida),
    terminarCorrida: reg("terminarCorrida", corrida),
    escanearVentanas: reg("escanearVentanas", { avisadas: 0 }),
    revisarCorridasPerdidas: reg("revisarCorridasPerdidas", { perdidas: [] }),
    listarAbiertas: reg("listarAbiertas", abiertas),
    procesar: reg("procesar", (id) => resumenes[id] ?? { preliquidacion_id: id, resultado: "ok", enviadas: 0, pendientes: 0 }),
    despacharAlertas: reg("despacharAlertas", { ok: true }),
    log: silencio,
  };
  return { deps, llamadas, corrida };
}
const por = (llamadas, nombre) => llamadas.filter((l) => l.nombre === nombre);

test("flag apagado: responde off con el motivo y no toca nada", async () => {
  const { deps, llamadas } = armar({ apagado: "flag_apagado" });
  const r = await ejecutarCron({ origen: "schedule" }, deps);
  assert.deepEqual(r, { ok: true, flag: "off", motivo: "flag_apagado" });
  assert.equal(llamadas.length, 0);
});

test("compuerta de auth: responde off con motivo auth_requerida", async () => {
  const { deps, llamadas } = armar({ apagado: "auth_requerida" });
  const r = await ejecutarCron({ origen: "sweep" }, deps);
  assert.deepEqual(r, { ok: true, flag: "off", motivo: "auth_requerida" });
  assert.equal(llamadas.length, 0);
});

test("abre la corrida con origen, gh_run_id y corrida_id recibidos (continuación)", async () => {
  const { deps, llamadas } = armar();
  await ejecutarCron({ origen: "dispatch", ghRunId: "123", corridaId: 55, dryRun: false }, deps);
  const [abrir] = por(llamadas, "abrirCorrida");
  assert.equal(abrir.args[0].origen, "dispatch");
  assert.equal(abrir.args[0].ghRunId, "123");
  assert.equal(abrir.args[0].corridaId, 55);
  assert.equal(abrir.args[0].dryRun, false);
});

test("procesa cada preliquidación abierta y arma el contrato de respuesta", async () => {
  const { deps, llamadas } = armar({
    abiertas: [{ id: 1, especie: "res" }, { id: 2, especie: "cerdo" }],
    resumenes: {
      1: { preliquidacion_id: 1, resultado: "ok", liquidada: true, enviadas: 2, simuladas: 0, bloqueadas: 1, errores: 0, sin_confirmar: 0, inicial_pendiente: 0, pendientes: 0 },
      2: { preliquidacion_id: 2, resultado: "antes_del_corte", liquidada: false, enviadas: 0, pendientes: 0 },
    },
  });
  const r = await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.flag, "on");
  assert.equal(r.corrida_id, 77);
  assert.equal(r.pendientes, 0);
  assert.equal(r.presupuesto_agotado, false);
  assert.deepEqual(r.procesadas[0], {
    id: 1,
    especie: "res",
    resultado: "ok",
    liquidada: true,
    sedes: { enviadas: 2, simuladas: 0, bloqueadas: 1, errores: 0, sin_confirmar: 0, inicial_pendiente: 0 },
  });
  assert.equal(r.procesadas[1].sedes.enviadas, 0);
  const proc = por(llamadas, "procesar");
  assert.equal(proc.length, 2);
  assert.equal(proc[0].args[1].origen, "schedule");
  assert.equal(proc[0].args[1].dryRun, false);
  assert.equal(proc[0].args[1].corrida.id, 77);
  assert.equal(por(llamadas, "registrarProgreso").length, 2);
});

test("un segundo run sin cambios no envía nada (enviadas 0) y termina la corrida", async () => {
  const { deps, llamadas } = armar({ abiertas: [{ id: 1, especie: "res" }] });
  const r = await ejecutarCron({ origen: "sweep" }, deps);
  assert.equal(r.procesadas[0].sedes.enviadas, 0);
  const [fin] = por(llamadas, "terminarCorrida");
  assert.equal(fin.args[1].continua, false);
  assert.equal(fin.args[1].error ?? null, null);
});

test("con pendientes la corrida sigue en curso para el siguiente ciclo del workflow", async () => {
  const { deps, llamadas } = armar({
    abiertas: [{ id: 1, especie: "res" }],
    resumenes: { 1: { preliquidacion_id: 1, resultado: "ok", enviadas: 1, pendientes: 3 } },
  });
  const r = await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(r.pendientes, 3);
  assert.equal(por(llamadas, "terminarCorrida")[0].args[1].continua, true);
});

test("dry_run: no escanea ventanas, no despacha alertas y no deja la corrida en curso", async () => {
  const { deps, llamadas } = armar({
    abiertas: [{ id: 1, especie: "res" }],
    resumenes: { 1: { preliquidacion_id: 1, resultado: "ok", dry_run: true, pendientes: 4 } },
  });
  const r = await ejecutarCron({ origen: "dispatch", dryRun: true }, deps);
  assert.equal(por(llamadas, "procesar")[0].args[1].dryRun, true);
  assert.equal(por(llamadas, "escanearVentanas").length, 0);
  assert.equal(por(llamadas, "despacharAlertas").length, 0);
  assert.equal(por(llamadas, "terminarCorrida")[0].args[1].continua, false);
  assert.equal(r.dry_run, true);
});

test("filtra por especie y solo lista las abiertas", async () => {
  const { deps, llamadas } = armar();
  await ejecutarCron({ origen: "dispatch", especie: "cerdo" }, deps);
  assert.deepEqual(por(llamadas, "listarAbiertas")[0].args[0], { especie: "cerdo", estado: "abierta" });
});

test("escanea ventanas vencidas y despacha el backlog de alertas", async () => {
  const { deps, llamadas } = armar({ abiertas: [{ id: 1, especie: "res" }] });
  await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(por(llamadas, "escanearVentanas").length, 1);
  assert.equal(por(llamadas, "despacharAlertas").length, 1);
});

test("revisa corridas perdidas antes de procesar (no en dry_run) y su falla no detiene la corrida", async () => {
  const { deps, llamadas } = armar({ abiertas: [{ id: 1, especie: "res" }], fallos: { revisarCorridasPerdidas: new Error("boom") } });
  const r = await ejecutarCron({ origen: "sweep" }, deps);
  assert.equal(r.ok, true);
  assert.equal(por(llamadas, "revisarCorridasPerdidas").length, 1);
  assert.equal(por(llamadas, "procesar").length, 1);
  const seco = armar({ abiertas: [] });
  await ejecutarCron({ origen: "dispatch", dryRun: true }, seco.deps);
  assert.equal(por(seco.llamadas, "revisarCorridasPerdidas").length, 0);
});

test("si el escaneo de ventanas falla, el resto de la corrida sigue", async () => {
  const { deps, llamadas } = armar({
    abiertas: [{ id: 1, especie: "res" }],
    fallos: { escanearVentanas: new Error("boom") },
  });
  const r = await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(r.ok, true);
  assert.equal(por(llamadas, "procesar").length, 1);
});

test("presupuesto agotado: las preliquidaciones sin procesar cuentan como pendientes", async () => {
  // El reloj ya pasó el presupuesto cuando se va a procesar la segunda.
  const { deps, llamadas } = armar({
    abiertas: [{ id: 1, especie: "res" }, { id: 2, especie: "res" }, { id: 3, especie: "cerdo" }],
    relojMs: [0, 0, 5000],
  });
  const r = await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(r.presupuesto_agotado, true);
  assert.equal(por(llamadas, "procesar").length, 1);
  assert.equal(r.pendientes, 2);
  assert.equal(por(llamadas, "terminarCorrida")[0].args[1].continua, true);
});

test("la falla de una preliquidación no detiene a las demás y marca la corrida con error", async () => {
  const { deps, llamadas } = armar({ abiertas: [{ id: 1, especie: "res" }, { id: 2, especie: "cerdo" }] });
  let n = 0;
  deps.procesar = async (id) => {
    llamadas.push({ nombre: "procesar", args: [id] });
    n += 1;
    if (id === 1) throw new Error("falló");
    return { preliquidacion_id: id, resultado: "ok", enviadas: 1, pendientes: 0 };
  };
  const r = await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(n, 2);
  assert.equal(r.ok, false);
  assert.equal(r.procesadas[0].resultado, "error");
  assert.equal(r.procesadas[1].sedes.enviadas, 1);
  assert.match(por(llamadas, "terminarCorrida")[0].args[1].error.message, /falló/);
});

test("validarCuerpoCron: valores por defecto y rechazos", () => {
  assert.deepEqual(validarCuerpoCron(undefined), {
    ok: true,
    valor: { especie: undefined, dryRun: false, origen: "schedule", ghRunId: null, corridaId: null },
  });
  const ok = validarCuerpoCron({ especie: "res", dry_run: true, origen: "sweep", gh_run_id: 99, corrida_id: "12" });
  assert.deepEqual(ok.valor, { especie: "res", dryRun: true, origen: "sweep", ghRunId: "99", corridaId: 12 });
  assert.equal(validarCuerpoCron({ especie: "vaca" }).ok, false);
  assert.equal(validarCuerpoCron({ origen: "admin" }).ok, false);
  assert.equal(validarCuerpoCron({ dry_run: "si" }).ok, false);
  assert.equal(validarCuerpoCron({ corrida_id: -3 }).ok, false);
  assert.equal(validarCuerpoCron([]).ok, false);
});

test("D-S3: un dispatch antes del corte no procesa el día y la respuesta indica que no es elegible", async () => {
  const { deps } = armar({
    abiertas: [{ id: 1, especie: "res" }],
    resumenes: { 1: { preliquidacion_id: 1, resultado: "antes_del_corte", liquidada: false, enviadas: 0, pendientes: 0 } },
  });
  const r = await ejecutarCron({ origen: "dispatch" }, deps);
  assert.equal(r.procesadas[0].resultado, "antes_del_corte");
  assert.equal(r.procesadas[0].sedes.enviadas, 0);
  assert.equal(r.pendientes, 0);
});

// ─── JD S2: el envío del cron respeta el límite de la función de Vercel ─────

test("el envío del cron recibe timeoutMs acotado por el límite de la función y sin presupuesto no arranca", async () => {
  let ahoraMs = 0;
  const { deps } = armar({ abiertas: [{ id: 1, especie: "res" }] });
  deps.presupuestoMs = 400_000; // aísla el tope de Vercel del presupuesto propio del cron
  deps.ahoraMs = () => ahoraMs;
  let opciones;
  deps.procesar = async (id, o) => {
    opciones = o;
    return { preliquidacion_id: id, resultado: "ok", enviadas: 0, pendientes: 0 };
  };
  await ejecutarCron({ origen: "schedule" }, deps);
  assert.equal(typeof opciones.timeoutMs, "function");
  ahoraMs = 0;
  assert.equal(opciones.timeoutMs(), 240_000);
  ahoraMs = 100_000;
  assert.equal(opciones.timeoutMs(), 185_000);
  assert.equal(opciones.hayPresupuesto(), true);
  ahoraMs = 260_000; // quedan 25 s < mínimo de 30 s: no se arranca un envío que no puede terminar
  assert.equal(opciones.hayPresupuesto(), false);
  assert.equal(opciones.timeoutMs(), 30_000);
});
