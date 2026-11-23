// Anular la preliquidación completa (3.7, R12): las guardas se deciden en JS y la RPC las revalida bajo
// lock. Resultados ok | no_anulable(motivo) | version_cambiada. Nada de esto toca SIESA.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;
const sqlDe = (nombre) => readFileSync(fileURLToPath(new URL(`../sql/${nombre}`, import.meta.url)), "utf8");

let tablas = {};
let rpcs = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))).map((r) => ({ ...r })); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const h = manejadores[nombre];
    return { data: h ? await h(args) : { resultado: "ok" }, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Correcciones = await import(url("models/PreliquidacionCorrecciones.model.js"));
const { decidirAnulacionPreliquidacion } = await import(url("shared/preliquidacionAnulacion.js"));

const cabecera = (extra = {}) => ({ id: 1, especie: "res", estado: "abierta", version: 3, orden_version: 5, ...extra });
const sede = (extra = {}) => ({ id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "calculada", envio_id: null, ...extra });
const silencio = { info() {}, warn() {}, error() {}, log() {} };

// ─── Guardas puras (matriz) ────────────────────────────────────────────────

test("sin nada enviado, una preliquidación abierta es anulable (con o sin sedes)", () => {
  assert.deepEqual(decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [] }), { ok: true });
  for (const estado of ["vinculada", "calculada", "lista_para_enviar", "error", "simulada", "bloqueada"]) {
    assert.deepEqual(decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [sede({ estado })] }), { ok: true }, estado);
  }
});

test("solo una preliquidación abierta se anula: cerrada o anulada es no_abierta", () => {
  for (const estado of ["cerrada", "anulada"]) {
    assert.deepEqual(decidirAnulacionPreliquidacion({ cabecera: cabecera({ estado }), sedes: [] }), { ok: false, motivo: "no_abierta" });
  }
});

test("una sede enviando/enviada/sin_confirmar/anulada (alguna vez enviada) impide anular: sede_enviada", () => {
  for (const estado of ["enviando", "enviada", "sin_confirmar", "anulada"]) {
    assert.deepEqual(
      decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [sede({ id: 1, estado: "calculada" }), sede({ id: 2, estado })] }),
      { ok: false, motivo: "sede_enviada" },
      estado,
    );
  }
});

test("un envío vinculado ok/enviando/sin_confirmar impide anular aunque la sede no lo diga; error/anulado no", () => {
  const s = sede({ estado: "calculada", envio_id: 900 });
  for (const estado of ["ok", "enviando", "sin_confirmar"]) {
    assert.deepEqual(
      decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [s], envios: [{ id: 900, estado }] }),
      { ok: false, motivo: "sede_enviada" },
      estado,
    );
  }
  for (const estado of ["error", "anulado"]) {
    assert.deepEqual(decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [s], envios: [{ id: 900, estado }] }), { ok: true }, estado);
  }
});

test("una recepción ya Enviado_SIESA impide anular aunque la sede no lo diga", () => {
  assert.deepEqual(
    decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [sede()], recepciones: [{ id: 101, estado: "Enviado_SIESA" }] }),
    { ok: false, motivo: "sede_enviada" },
  );
  assert.deepEqual(
    decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [sede()], recepciones: [{ id: 101, estado: "Costeado" }] }),
    { ok: true },
  );
});

test("un saldo ORIGINADO por ella ya aplicado en otra preliquidación impide anular: saldo_aplicado", () => {
  assert.deepEqual(
    decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [], saldos: [{ id: 1, estado: "aplicado" }] }),
    { ok: false, motivo: "saldo_aplicado" },
  );
  for (const estado of ["pendiente", "movido", "descartado"]) {
    assert.deepEqual(decidirAnulacionPreliquidacion({ cabecera: cabecera(), sedes: [], saldos: [{ id: 1, estado }] }), { ok: true }, estado);
  }
});

test("la precedencia de motivos es la de la RPC: no_abierta, luego sede_enviada, luego saldo_aplicado", () => {
  const todo = { sedes: [sede({ estado: "enviada" })], saldos: [{ id: 1, estado: "aplicado" }] };
  assert.equal(decidirAnulacionPreliquidacion({ cabecera: cabecera({ estado: "cerrada" }), ...todo }).motivo, "no_abierta");
  assert.equal(decidirAnulacionPreliquidacion({ cabecera: cabecera(), ...todo }).motivo, "sede_enviada");
});

// ─── Modelo ────────────────────────────────────────────────────────────────

beforeEach(() => {
  rpcs = [];
  manejadores = {
    carnes_preliq_anular: () => ({ resultado: "ok", preliquidacion_id: 1, sedes_desvinculadas: 2, recepciones: [101, 102] }),
  };
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [sede({ id: 11, recepcion_id: 101 }), sede({ id: 12, recepcion_id: 102, estado: "vinculada" })],
    carnes_recepciones: [{ id: 101, estado: "Costeado" }, { id: 102, estado: "Aprobado" }],
    carnes_siesa_envios: [],
    carnes_preliquidacion_saldos: [],
  };
});

const llamadasAnular = () => rpcs.filter((r) => r.nombre === "carnes_preliq_anular");
const anular = (id = 1, datos = { motivo: "se creó por error" }) => Correcciones.anularPreliquidacion(id, datos, { log: silencio });

test("anular llama a la RPC con las versiones leídas, quién y el motivo", async () => {
  const r = await anular(1, { por: "ana@merka.co", motivo: "se creó por error" });
  assert.equal(r.resultado, "ok");
  assert.deepEqual(r.recepciones, [101, 102]);
  assert.deepEqual(llamadasAnular()[0].args, {
    p_id: 1, p_version: 3, p_orden_version: 5, p_por: "ana@merka.co", p_motivo: "se creó por error",
  });
});

test("el motivo es obligatorio: sin él 422 motivo_requerido y la RPC no se llama", async () => {
  for (const motivo of [undefined, null, "", "   "]) {
    await assert.rejects(Correcciones.anularPreliquidacion(1, { motivo }, { log: silencio }), (e) => e.statusCode === 422 && e.codigo === "motivo_requerido");
  }
  assert.equal(llamadasAnular().length, 0);
});

test("una guarda de JS que falla es 409 no_anulable con su motivo y la RPC no se llama", async () => {
  tablas.carnes_preliquidacion_sedes[0].estado = "enviada";
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "no_anulable" && e.motivo === "sede_enviada");
  assert.equal(llamadasAnular().length, 0);
});

test("un envío ok vinculado a una sede no enviada también bloquea (se lee por envio_id)", async () => {
  tablas.carnes_preliquidacion_sedes[0].envio_id = 900;
  tablas.carnes_siesa_envios = [{ id: 900, estado: "ok" }];
  await assert.rejects(anular(), (e) => e.codigo === "no_anulable" && e.motivo === "sede_enviada");
});

test("un saldo originado por ella y aplicado bloquea: saldo_aplicado", async () => {
  tablas.carnes_preliquidacion_saldos = [{ id: 5, origen_preliquidacion_id: 1, estado: "aplicado", destino_preliquidacion_id: 2 }];
  await assert.rejects(anular(), (e) => e.codigo === "no_anulable" && e.motivo === "saldo_aplicado");
});

test("anular una preliquidación ya anulada no es idempotente en silencio: 409 no_anulable no_abierta, sin RPC", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ estado: "anulada" })];
  await assert.rejects(anular(), (e) => e.codigo === "no_anulable" && e.motivo === "no_abierta");
  assert.equal(llamadasAnular().length, 0);
});

test("si la RPC revalida bajo lock y responde no_anulable (carrera con un envío), es 409 con el motivo", async () => {
  manejadores.carnes_preliq_anular = () => ({ resultado: "no_anulable", motivo: "sede_enviada" });
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "no_anulable" && e.motivo === "sede_enviada");
  assert.equal(llamadasAnular().length, 1);
});

test("version_cambiada relee y reintenta hasta 3 veces; agotado es 409", async () => {
  let n = 0;
  manejadores.carnes_preliq_anular = () => (++n < 2 ? { resultado: "version_cambiada" } : { resultado: "ok", preliquidacion_id: 1, sedes_desvinculadas: 2, recepciones: [] });
  assert.equal((await anular()).resultado, "ok");
  assert.equal(n, 2);

  rpcs = [];
  manejadores.carnes_preliq_anular = () => ({ resultado: "version_cambiada" });
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "version_cambiada");
  assert.equal(llamadasAnular().length, 3);
});

test("preliquidación inexistente es 404 y sin RPC", async () => {
  await assert.rejects(anular(999), (e) => e.statusCode === 404);
  assert.equal(llamadasAnular().length, 0);
});

// ─── Lo que hace la RPC (estático; las carreras reales van en test/sql/041b) ──

test("el índice parcial de 'sin iniciar' solo cubre abierta: anular libera la especie", () => {
  const ddl = sqlDe("038_preliquidacion.sql");
  assert.match(ddl, /uq_carnes_preliquidaciones_sin_iniciar[\s\S]{0,200}WHERE estado = 'abierta' AND fecha_primer_ingreso IS NULL/);
  const rpc = sqlDe("041_preliquidacion_rpc_correcciones.sql");
  assert.match(rpc, /SET estado = 'anulada'/);
});

test("la RPC revierte los saldos consumidos y descarta los propios pendientes", () => {
  const rpc = sqlDe("041_preliquidacion_rpc_correcciones.sql");
  assert.match(rpc, /SET estado = 'pendiente', destino_preliquidacion_id = NULL[\s\S]{0,120}estado IN \('aplicado', 'pendiente'\)/);
  assert.match(rpc, /SET estado = 'descartado'[\s\S]{0,200}origen_preliquidacion_id = p_id AND estado = 'pendiente'/);
});
