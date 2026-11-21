// Guardas de una recepción vinculada a una preliquidación (C11): no se elimina, no se
// reabre ni se rechaza, no entra a una liquidación legada y sus novillos se cambian
// por la RPC. Con una recepción SIN vínculo (o sin la columna, antes de sql/038) todo
// se comporta como antes. Supabase falso con mock.module. Sin red ni base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

// ─── Supabase falso ────────────────────────────────────────────────────────

let tablas = {};
let escrituras = [];
let sinColumnaPreliq = false; // simula una base sin sql/038

class Q {
  constructor(t) { this.t = t; this.f = []; this.cols = ""; }
  select(c) { this.cols = c || ""; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, a) { this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  order() { return this; }
  update(v) { this.upd = v; return this; }
  upsert(v) { this.ups = v; return this; }
  delete() { this.borrar = true; return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  ejecutar() {
    if (sinColumnaPreliq && /preliquidacion_id/.test(this.cols) && !this.upd && !this.ups && !this.borrar) {
      return { data: null, error: { code: "42703", message: 'column carnes_recepciones.preliquidacion_id does not exist' } };
    }
    if (this.upd) {
      escrituras.push({ tabla: this.t, op: "update", valores: this.upd });
      const filas = this.filas();
      for (const fila of filas) Object.assign(fila, this.upd);
      return { data: filas.map((r) => ({ id: r.id })), error: null };
    }
    if (this.ups) {
      escrituras.push({ tabla: this.t, op: "upsert", valores: this.ups });
      return { data: [], error: null };
    }
    if (this.borrar) {
      escrituras.push({ tabla: this.t, op: "delete" });
      const filas = this.filas();
      tablas[this.t] = (tablas[this.t] || []).filter((r) => !filas.includes(r));
      return { data: filas, error: null };
    }
    return { data: this.filas(), error: null };
  }
  maybeSingle() { const { data, error } = this.ejecutar(); return Promise.resolve({ data: data?.[0] ?? null, error }); }
  then(res, rej) { return Promise.resolve(this.ejecutar()).then(res, rej); }
}
const supabaseFalso = { from: (t) => new Q(t) };

const { createError } = await import(url("middleware/errorHandler.js"));
let llamadasNovillos = [];
let errorNovillos = null;

mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
mock.module(url("models/SiesaEnvio.model.js"), {
  namedExports: { enviosDeRecepcion: async () => [], referenciasInicialesDe: async () => ({}) },
});
mock.module(url("models/Desposte.model.js"), {
  namedExports: { archivoDeRecepcion: async () => null, borrarArchivoHuerfano: async () => {} },
});
mock.module(url("models/Preliquidacion.model.js"), {
  namedExports: {
    actualizarNovillos: async (id, n) => {
      llamadasNovillos.push([id, n]);
      if (errorNovillos) throw errorNovillos;
      return { resultado: "ok" };
    },
  },
});

const { puedeEliminarRecepcion } = await import(url("shared/eliminacionAdmin.js"));
const Recepcion = await import(url("models/Recepcion.model.js"));
const Liquidacion = await import(url("models/Liquidacion.model.js"));

const rec = (extra = {}) => ({
  id: 10, especie: "res", estado: "Aprobado", liquidacion_id: null, preliquidacion_id: null,
  novillos: "4", sede_id: 1, sede: { nombre: "Sede 1" }, ...extra,
});

beforeEach(() => {
  tablas = { carnes_recepciones: [rec()], carnes_recepcion_items: [], carnes_liquidaciones: [{ id: 6, estado: "Abierta", especie: "res", viceras_bonificacion: false }], carnes_siesa_envios: [] };
  escrituras = [];
  sinColumnaPreliq = false;
  llamadasNovillos = [];
  errorNovillos = null;
});

const falla = async (fn, estado, codigo) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.statusCode, estado, `status ${e.statusCode} (${e.message})`);
    if (codigo) assert.equal(e.codigo, codigo);
    return true;
  });
};

// ─── puedeEliminarRecepcion ────────────────────────────────────────────────

test("puedeEliminarRecepcion: una recepción vinculada a una preliquidación no se elimina", () => {
  const r = puedeEliminarRecepcion({ estado: "Aprobado", liquidacion_id: null, preliquidacion_id: 4, envios: [] });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /preliquidaci/i);
});

test("puedeEliminarRecepcion: sin preliquidacion_id (o ausente) el resultado es el de siempre", () => {
  assert.deepEqual(puedeEliminarRecepcion({ estado: "Aprobado", liquidacion_id: null, envios: [] }), { ok: true, motivo: null });
  assert.deepEqual(puedeEliminarRecepcion({ estado: "Aprobado", liquidacion_id: null, preliquidacion_id: null, envios: [] }), { ok: true, motivo: null });
  assert.equal(puedeEliminarRecepcion({ estado: "Aprobado", liquidacion_id: 3, envios: [] }).ok, false);
});

// ─── eliminarRecepcionAdmin ────────────────────────────────────────────────

test("eliminarRecepcionAdmin: vinculada a una preliquidación responde 409 y no borra", async () => {
  tablas.carnes_recepciones = [rec({ preliquidacion_id: 4 })];
  await falla(() => Recepcion.eliminarRecepcionAdmin(10), 409);
  assert.equal(escrituras.length, 0);
});

test("eliminarRecepcionAdmin: sin vínculo borra como siempre", async () => {
  const r = await Recepcion.eliminarRecepcionAdmin(10);
  assert.equal(r.eliminada, 10);
  assert.ok(escrituras.some((e) => e.op === "delete"));
});

test("eliminarRecepcionAdmin: antes de sql/038 (sin la columna) borra como siempre", async () => {
  sinColumnaPreliq = true;
  const r = await Recepcion.eliminarRecepcionAdmin(10);
  assert.equal(r.eliminada, 10);
});

// ─── cambiarEstado: reabrir / rechazar ─────────────────────────────────────

test("cambiarEstado: reabrir (a Borrador) una recepción vinculada es 409", async () => {
  tablas.carnes_recepciones = [rec({ estado: "Rechazado", preliquidacion_id: 4 })];
  await falla(() => Recepcion.cambiarEstado(10, "Borrador", {}, supabaseFalso), 409, "recepcion_en_preliquidacion");
  assert.equal(escrituras.length, 0);
});

test("cambiarEstado: Aprobado -> Rechazado no existe como transición (no hay otra salida que guardar)", async () => {
  tablas.carnes_recepciones = [rec({ estado: "Aprobado", preliquidacion_id: 4 })];
  await falla(() => Recepcion.cambiarEstado(10, "Rechazado", {}, supabaseFalso), 409);
  assert.equal(escrituras.length, 0);
});

test("cambiarEstado: reabrir sin vínculo funciona como siempre", async () => {
  tablas.carnes_recepciones = [rec({ estado: "Rechazado" })];
  const r = await Recepcion.cambiarEstado(10, "Borrador", {}, supabaseFalso);
  assert.equal(r.estado, "Borrador");
});

test("cambiarEstado: los demás destinos no consultan la preliquidación", async () => {
  tablas.carnes_recepciones = [rec({ estado: "Borrador", preliquidacion_id: 4 })];
  const r = await Recepcion.cambiarEstado(10, "Aprobado", {}, supabaseFalso);
  assert.equal(r.estado, "Aprobado");
});

// ─── Liquidacion.vincular (legada) ─────────────────────────────────────────

test("Liquidacion.vincular: rechaza una recepción que ya está en una preliquidación", async () => {
  tablas.carnes_recepciones = [rec({ preliquidacion_id: 4 })];
  await assert.rejects(
    () => Liquidacion.vincular(6, [10]),
    (e) => e.statusCode === 409 && /preliquidaci/i.test(e.message),
  );
  assert.ok(!escrituras.some((e) => e.op === "update"));
});

test("Liquidacion.vincular: sin vínculo vincula como siempre", async () => {
  tablas.carnes_recepciones = [rec()];
  tablas.carnes_liquidacion_gastos = [];
  try {
    await Liquidacion.vincular(6, [10]);
  } catch {
    // El resto del flujo legado (lecturas posteriores) no es objeto de esta prueba.
  }
  assert.ok(escrituras.some((e) => e.tabla === "carnes_recepciones" && e.op === "update" && e.valores.liquidacion_id === 6));
});

test("Liquidacion.vincular: antes de sql/038 (sin la columna) vincula como siempre", async () => {
  sinColumnaPreliq = true;
  try {
    await Liquidacion.vincular(6, [10]);
  } catch {
    // idem
  }
  assert.ok(escrituras.some((e) => e.tabla === "carnes_recepciones" && e.op === "update" && e.valores.liquidacion_id === 6));
});

// ─── editarNovillos ────────────────────────────────────────────────────────

const vicera = (extra = {}) => ({
  id: 1, recepcion_id: 10, tipo: "vicera", factor_novillo: 2, unidad: "UN", cantidad: 8, costo_base: 100,
  plantilla_item_id: null, vicera_item_id: 1, codigo_item: "X", codigo_tabla: null, descripcion: "Higado", orden: 1, ...extra,
});

test("editarNovillos: una recepción vinculada pasa por la RPC y recalcula las vísceras por novillo", async () => {
  tablas.carnes_recepciones = [rec({ preliquidacion_id: 4, estado: "Costeado" })];
  tablas.carnes_recepcion_items = [vicera()];
  await Recepcion.editarNovillos(10, { novillos: 5, editado_por: "ana@x.co" });
  assert.deepEqual(llamadasNovillos, [[10, 5]]);
  // La RPC escribe `novillos` en la recepción: JS no la actualiza por su cuenta.
  assert.ok(!escrituras.some((e) => e.tabla === "carnes_recepciones" && e.op === "update"));
  const up = escrituras.find((e) => e.tabla === "carnes_recepcion_items" && e.op === "upsert");
  assert.equal(up.valores[0].cantidad, 10);
});

test("editarNovillos: sede_no_editable de la RPC sale como 409 y no recalcula nada", async () => {
  tablas.carnes_recepciones = [rec({ preliquidacion_id: 4 })];
  tablas.carnes_recepcion_items = [vicera()];
  errorNovillos = createError(409, "no editable", "sede_no_editable");
  await falla(() => Recepcion.editarNovillos(10, { novillos: 5 }), 409, "sede_no_editable");
  assert.equal(escrituras.length, 0);
});

test("editarNovillos: sin vínculo actualiza la recepción como siempre", async () => {
  tablas.carnes_recepcion_items = [vicera()];
  await Recepcion.editarNovillos(10, { novillos: 5, editado_por: "ana@x.co" });
  assert.equal(llamadasNovillos.length, 0);
  const upd = escrituras.find((e) => e.tabla === "carnes_recepciones" && e.op === "update");
  assert.equal(upd.valores.novillos, 5);
  assert.ok(escrituras.some((e) => e.tabla === "carnes_recepcion_items" && e.op === "upsert"));
});

test("editarNovillos: sin vínculo y en Costeado sigue rechazándose como antes", async () => {
  tablas.carnes_recepciones = [rec({ estado: "Costeado" })];
  await falla(() => Recepcion.editarNovillos(10, { novillos: 5 }), 409);
  assert.equal(llamadasNovillos.length, 0);
});
