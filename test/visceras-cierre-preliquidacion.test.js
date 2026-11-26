// Vísceras al cerrar la recepción: las de res que la preliquidación lleva NO salen al cierre aunque
// CARNES_SIESA_VISCERAS_AL_CIERRE esté prendida; las demás siguen como siempre. Dependencias falsas.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { viscerasSeDifieren, viscerasTrasVinculo } = await import("../src/services/viscerasCierre.js");

const recepcion = (extra = {}) => ({ id: 7, especie: "res", recibido_por: "ana", ...extra });
const silencio = { error() {}, warn() {} };

function armar({ habilitada = true, siesa = true, alCierre = true, sede = null, falloLectura = null } = {}) {
  const llamadas = { enviar: [], leer: [] };
  const deps = {
    moduloActivo: () => habilitada,
    siesaActivo: () => siesa,
    viscerasAlCierre: () => alCierre,
    leerSedeDeRecepcion: async (id) => {
      llamadas.leer.push(id);
      if (falloLectura) throw falloLectura;
      return sede;
    },
    enviarViscerasRecepcion: async (id, por, opciones) => {
      llamadas.enviar.push({ id, por, opciones });
      return { tipo: "visceras_recepcion", recepcion_id: id, estado: "ok", referencia: "TC VISC R7" };
    },
    log: silencio,
  };
  return { deps, llamadas };
}

test("la preliquidación lleva las vísceras de una recepción de res cuando el módulo está habilitado", () => {
  assert.equal(viscerasSeDifieren(recepcion(), armar().deps), true);
  assert.equal(viscerasSeDifieren(recepcion({ especie: "cerdo" }), armar().deps), false);
  assert.equal(viscerasSeDifieren(recepcion(), armar({ habilitada: false }).deps), false);
});

test("vinculada a una sede: NO sale CEI al cierre aunque la bandera esté prendida", async () => {
  const { deps, llamadas } = armar({ sede: { sede: { id: 1 }, cabecera: { id: 1 } } });
  const r = await viscerasTrasVinculo(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.estado, "no_aplica");
  assert.equal(llamadas.enviar.length, 0);
});

test("sin vincular (sin preliquidación, fuera de ventana, oficial legado) y bandera prendida: CEI al cierre como siempre", async () => {
  const { deps, llamadas } = armar({ sede: null });
  const r = await viscerasTrasVinculo(recepcion(), { inicioPeticion: 1000 }, deps);
  assert.equal(r.estado, "ok");
  assert.deepEqual(llamadas.enviar, [{ id: 7, por: "ana", opciones: { inicio: 1000 } }]);
});

test("bandera apagada o SIESA apagado: apagado, sin leer la base ni mandar", async () => {
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
