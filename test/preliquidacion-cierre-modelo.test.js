// Cierre de la preliquidación (auto-cierre D3 y manual): lee, decide con las funciones puras y
// escribe por `carnes_preliq_cerrar`. Lecturas, RPC y alertas inyectadas: sin base.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { intentarAutocierre, cerrarPreliquidacion } = await import("../src/models/PreliquidacionCierre.model.js");

const silencio = { info() {}, warn() {}, error() {} };
const cab = (extra = {}) => ({
  id: 1, estado: "abierta", liquidada_at: "2026-11-24T02:31:00Z", restantes: 0, gasto_total_aplicado: "1000000.00", orden_version: 7, ...extra,
});
const enviada = (id, g) => ({ id, estado: "enviada", gasto_sede: g, requiere_correccion: false });

function armar({ cabeceras = [cab()], sedes = [enviada(1, "1000000.00")], respuestas = [{ resultado: "ok" }] } = {}) {
  const reg = { rpcs: [], alertas: [], lecturas: 0 };
  const deps = {
    leer: async () => {
      const cabecera = cabeceras[Math.min(reg.lecturas, cabeceras.length - 1)];
      reg.lecturas += 1;
      return { cabecera, sedes };
    },
    rpc: async (nombre, args) => {
      reg.rpcs.push({ nombre, args });
      return respuestas[Math.min(reg.rpcs.length - 1, respuestas.length - 1)];
    },
    encolar: async (a) => (reg.alertas.push(a), { ok: true }),
    log: silencio,
  };
  return { deps, reg };
}

test("auto-cierre D3: cierra con la orden_version leída y el monto no asignado, y alerta 'cerrada' una vez", async () => {
  const { deps, reg } = armar({ sedes: [enviada(1, "999999.99")] });
  const r = await intentarAutocierre(1, deps);
  assert.equal(r.cerrada, true);
  assert.equal(reg.rpcs[0].nombre, "carnes_preliq_cerrar");
  assert.deepEqual(reg.rpcs[0].args, { p_id: 1, p_orden_version: 7, p_monto_no_asignado: "0.01" });
  assert.equal(reg.alertas.length, 1);
  assert.deepEqual(
    { e: reg.alertas[0].evento, p: reg.alertas[0].preliquidacionId, s: reg.alertas[0].sedeId, o: reg.alertas[0].ocurrencia },
    { e: "cerrada", p: 1, s: 0, o: 0 },
  );
});

test("auto-cierre: con restantes, sedes pendientes o requiere_correccion (I5) no llama a la RPC", async () => {
  for (const { cabeceras, sedes, motivo } of [
    { cabeceras: [cab({ restantes: 3 })], sedes: [enviada(1, "1.00")], motivo: "restantes" },
    { cabeceras: [cab()], sedes: [enviada(1, "1.00"), { id: 2, estado: "calculada" }], motivo: "sedes_pendientes" },
    { cabeceras: [cab()], sedes: [{ ...enviada(1, "1.00"), requiere_correccion: true }], motivo: "requiere_correccion" },
  ]) {
    const { deps, reg } = armar({ cabeceras, sedes });
    const r = await intentarAutocierre(1, deps);
    assert.deepEqual({ c: r.cerrada, m: r.motivo }, { c: false, m: motivo });
    assert.equal(reg.rpcs.length, 0);
    assert.equal(reg.alertas.length, 0);
  }
});

test("version_cambiada: relee y reintenta; a la tercera deja de insistir sin lanzar", async () => {
  const { deps, reg } = armar({
    cabeceras: [cab({ orden_version: 7 }), cab({ orden_version: 8 })],
    respuestas: [{ resultado: "version_cambiada" }, { resultado: "ok" }],
  });
  const r = await intentarAutocierre(1, deps);
  assert.equal(r.cerrada, true);
  assert.deepEqual(reg.rpcs.map((x) => x.args.p_orden_version), [7, 8]);

  const agotado = armar({ respuestas: [{ resultado: "version_cambiada" }] });
  const r2 = await intentarAutocierre(1, agotado.deps);
  assert.deepEqual({ c: r2.cerrada, m: r2.motivo }, { c: false, m: "version_cambiada" });
  assert.equal(agotado.reg.rpcs.length, 3);
});

test("auto-cierre nunca lanza: una falla de lectura o de RPC se informa", async () => {
  const { deps } = armar();
  deps.leer = async () => { throw new Error("base caída"); };
  const r = await intentarAutocierre(1, deps);
  assert.equal(r.cerrada, false);
  assert.equal(r.motivo, "error");
});

test("una alerta que falla no deshace el cierre", async () => {
  const { deps } = armar();
  deps.encolar = async () => { throw new Error("correo caído"); };
  const r = await intentarAutocierre(1, deps);
  assert.equal(r.cerrada, true);
});

test("cierre manual: permite cerrar con animales restantes y devuelve ok + monto", async () => {
  const { deps, reg } = armar({ cabeceras: [cab({ restantes: 4 })], sedes: [enviada(1, "600000.00")] });
  const r = await cerrarPreliquidacion(1, deps);
  assert.equal(r.resultado, "ok");
  assert.equal(r.monto_no_asignado, "400000.00");
  assert.equal(reg.rpcs[0].args.p_monto_no_asignado, "400000.00");
});

test("cierre manual con trabajo pendiente: no_cerrable con el motivo y sin RPC", async () => {
  const { deps, reg } = armar({ sedes: [{ id: 2, estado: "enviando" }] });
  const r = await cerrarPreliquidacion(1, deps);
  assert.deepEqual({ r: r.resultado, m: r.motivo }, { r: "no_cerrable", m: "sedes_pendientes" });
  assert.equal(reg.rpcs.length, 0);
});

test("cierre manual: no_abierta y no_liquidada salen con su código de negocio", async () => {
  assert.equal((await cerrarPreliquidacion(1, armar({ cabeceras: [cab({ estado: "cerrada" })] }).deps)).resultado, "no_abierta");
  assert.equal((await cerrarPreliquidacion(1, armar({ cabeceras: [cab({ liquidada_at: null })] }).deps)).resultado, "no_liquidada");
});

test("cierre manual: version_cambiada persistente se devuelve para que el admin recargue", async () => {
  const { deps } = armar({ respuestas: [{ resultado: "version_cambiada" }] });
  assert.equal((await cerrarPreliquidacion(1, deps)).resultado, "version_cambiada");
});
