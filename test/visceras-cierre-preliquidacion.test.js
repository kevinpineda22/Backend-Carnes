// Vísceras al cerrar la recepción: las de res que la preliquidación lleva NO salen al cierre aunque
// CARNES_SIESA_VISCERAS_AL_CIERRE esté prendida; las demás siguen EN PARALELO con la inicial, como siempre.
// Dependencias falsas.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { viscerasAlCerrar, viscerasTrasVinculo } = await import("../src/services/viscerasCierre.js");

const recepcion = (extra = {}) => ({ id: 7, especie: "res", fecha_ingreso: "2026-11-20", recibido_por: "ana", ...extra });
const silencio = { error() {}, warn() {} };

function armar({
  habilitada = true,
  siesa = true,
  alCierre = true,
  vincularia = false,
  falloVincularia = null,
  sede = null,
  falloLectura = null,
  eventos = [],
} = {}) {
  const llamadas = { enviar: [], leer: [], vincularia: [] };
  const deps = {
    moduloActivo: () => habilitada,
    siesaActivo: () => siesa,
    viscerasAlCierre: () => alCierre,
    recepcionSeVincularia: async (r) => {
      llamadas.vincularia.push(r.id);
      eventos.push("vincularia");
      if (falloVincularia) throw falloVincularia;
      return vincularia;
    },
    leerSedeDeRecepcion: async (id) => {
      llamadas.leer.push(id);
      if (falloLectura) throw falloLectura;
      return sede;
    },
    enviarViscerasRecepcion: async (id, por, opciones) => {
      llamadas.enviar.push({ id, por, opciones });
      eventos.push("visceras:inicio");
      await new Promise((r) => setTimeout(r, 5));
      eventos.push("visceras:fin");
      return { tipo: "visceras_recepcion", recepcion_id: id, estado: "ok", referencia: "TC VISC R7" };
    },
    log: silencio,
  };
  return { deps, llamadas };
}

test("res NO vinculable (sin preliquidación abierta que la reciba): CEI al cierre EN PARALELO, sin diferir", async () => {
  const eventos = [];
  const { deps, llamadas } = armar({ vincularia: false, eventos });
  const inicial = (async () => {
    eventos.push("inicial:inicio");
    await new Promise((r) => setTimeout(r, 30));
    eventos.push("inicial:fin");
  })();
  const [r] = await Promise.all([viscerasAlCerrar(recepcion(), { inicioPeticion: 1000 }, deps), inicial]);
  assert.equal(r.diferidas, false);
  assert.equal(r.resultado.estado, "ok");
  assert.deepEqual(llamadas.enviar, [{ id: 7, por: "ana", opciones: { inicio: 1000 } }]);
  // arranca mientras la inicial sigue en curso: no espera al vínculo ni a la inicial
  assert.ok(eventos.indexOf("visceras:inicio") < eventos.indexOf("inicial:fin"), eventos.join(","));
  assert.ok(eventos.indexOf("visceras:fin") < eventos.indexOf("inicial:fin"), "termina antes que la inicial lenta: no la serializa");
});

test("res vinculable: NO sale CEI al cierre (la preliquidación lo lleva), se difiere la comprobación", async () => {
  const { deps, llamadas } = armar({ vincularia: true });
  const r = await viscerasAlCerrar(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.diferidas, true);
  assert.equal(llamadas.enviar.length, 0);
});

test("cerdo o módulo apagado: CEI al cierre como siempre, sin consultar preliquidaciones", async () => {
  for (const [rec, cfg] of [[recepcion({ especie: "cerdo" }), {}], [recepcion(), { habilitada: false }]]) {
    const { deps, llamadas } = armar({ vincularia: true, ...cfg });
    const r = await viscerasAlCerrar(rec, { inicioPeticion: 5 }, deps);
    assert.equal(r.diferidas, false);
    assert.equal(llamadas.vincularia.length, 0);
    assert.equal(llamadas.enviar.length, 1);
  }
});

test("bandera de cierre o SIESA apagados: nada que mandar al cierre, no consulta preliquidaciones ni difiere", async () => {
  for (const cfg of [{ alCierre: false }, { siesa: false }]) {
    const { deps, llamadas } = armar({ vincularia: true, ...cfg });
    const r = await viscerasAlCerrar(recepcion(), { inicioPeticion: 5 }, deps);
    assert.equal(r.diferidas, false);
    assert.equal(llamadas.vincularia.length, 0);
  }
});

test("si no se puede saber si se vincularía, se difiere (camino seguro: el CEI nunca antes de la oficial)", async () => {
  const { deps, llamadas } = armar({ falloVincularia: new Error("db caída") });
  const r = await viscerasAlCerrar(recepcion(), { inicioPeticion: 5 }, deps);
  assert.equal(r.diferidas, true);
  assert.equal(llamadas.enviar.length, 0);
});

test("vinculada a una sede (comprobación diferida): NO sale CEI al cierre aunque la bandera esté prendida", async () => {
  const { deps, llamadas } = armar({ sede: { sede: { id: 1 }, cabecera: { id: 1 } } });
  const r = await viscerasTrasVinculo(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.estado, "no_aplica");
  assert.equal(llamadas.enviar.length, 0);
});

test("diferida pero que al final no se vinculó (sin preliquidación, fuera de ventana, oficial legado): CEI al cierre como siempre", async () => {
  const { deps, llamadas } = armar({ sede: null });
  const r = await viscerasTrasVinculo(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.estado, "ok");
  assert.deepEqual(llamadas.enviar, [{ id: 7, por: "ana", opciones: { inicio: 1000 } }]);
});

test("comprobación diferida con bandera apagada o SIESA apagado: apagado, sin leer la base ni mandar", async () => {
  for (const cfg of [{ alCierre: false }, { siesa: false }]) {
    const { deps, llamadas } = armar(cfg);
    const r = await viscerasTrasVinculo(recepcion(), { inicioPeticion: 1 }, deps);
    assert.equal(r.estado, "apagado");
    assert.equal(llamadas.leer.length, 0);
    assert.equal(llamadas.enviar.length, 0);
  }
});

test("si no se puede saber si está vinculada, NO se manda (el CEI no puede ir antes de la oficial)", async () => {
  const { deps, llamadas } = armar({ falloLectura: new Error("db caída") });
  const r = await viscerasTrasVinculo(recepcion(), { inicioPeticion: 1 }, deps);
  assert.equal(r.estado, "error");
  assert.equal(llamadas.enviar.length, 0);
});

// El controlador: el CEI del cierre va DENTRO del Promise.all (paralelo con la inicial), y solo lo diferido espera al vínculo.
const controlador = readFileSync(new URL("../src/controllers/recepciones.controller.js", import.meta.url), "utf8");
const cuerpoFinalizar = controlador.slice(controlador.indexOf("export async function finalizar"), controlador.indexOf("export async function descartar"));

test("controlador: viscerasAlCerrar corre dentro del Promise.all; viscerasTrasVinculo solo tras alFinalizar y solo si se difirió", () => {
  const todos = cuerpoFinalizar.indexOf("Promise.all");
  const cierre = cuerpoFinalizar.indexOf("viscerasAlCerrar(");
  const fin = cuerpoFinalizar.indexOf("]);", todos);
  const alfin = cuerpoFinalizar.indexOf("preliquidacionAlFinalizar(");
  const tras = cuerpoFinalizar.indexOf("viscerasTrasVinculo(");
  assert.ok(todos > -1 && cierre > todos && cierre < fin, "viscerasAlCerrar va dentro del Promise.all");
  assert.ok(tras > alfin, "la comprobación diferida va después de alFinalizar");
  assert.match(cuerpoFinalizar, /diferidas\s*\?/);
  assert.equal(cuerpoFinalizar.includes("viscerasSeDifieren"), false);
});

// ─── Carrera: la recepción ya quedó vinculada (p. ej. a mano, a una preliquidación en Borrador) ───

test("predicha NO vinculable pero la base ya la tiene vinculada: NO se manda al cierre, se difiere", async () => {
  const { deps, llamadas } = armar({ vincularia: false, sede: { sede: { id: 1 }, cabecera: { id: 1 } } });
  const r = await viscerasAlCerrar(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.diferidas, true);
  assert.equal(llamadas.enviar.length, 0);
  assert.deepEqual(llamadas.leer, [7]);
});

test("predicha NO vinculable y la base confirma que no tiene sede: se manda al cierre, en paralelo con la inicial", async () => {
  const eventos = [];
  const { deps, llamadas } = armar({ vincularia: false, sede: null, eventos });
  const inicial = (async () => {
    eventos.push("inicial:inicio");
    await new Promise((r) => setTimeout(r, 30));
    eventos.push("inicial:fin");
  })();
  const [r] = await Promise.all([viscerasAlCerrar(recepcion(), { inicioPeticion: 1000 }, deps), inicial]);
  assert.equal(r.diferidas, false);
  assert.equal(llamadas.enviar.length, 1);
  assert.ok(eventos.indexOf("visceras:fin") < eventos.indexOf("inicial:fin"), "la lectura extra no serializa el cierre");
});

test("si no se puede leer el vínculo real antes de mandar, se difiere (el CEI nunca antes de la oficial)", async () => {
  const { deps, llamadas } = armar({ vincularia: false, falloLectura: new Error("db caída") });
  const r = await viscerasAlCerrar(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.diferidas, true);
  assert.equal(llamadas.enviar.length, 0);
});

test("cerdo, módulo apagado o bandera apagada: no se lee el vínculo (nada que decidir)", async () => {
  for (const [rec, cfg] of [[recepcion({ especie: "cerdo" }), {}], [recepcion(), { habilitada: false }], [recepcion(), { alCierre: false }]]) {
    const { deps, llamadas } = armar(cfg);
    await viscerasAlCerrar(rec, { inicioPeticion: 5 }, deps);
    assert.equal(llamadas.leer.length, 0);
  }
});
