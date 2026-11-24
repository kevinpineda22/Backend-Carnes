// Retomas de la preliquidación (solo cerdo, solo antes de congelar). El catálogo se
// obtiene con la misma función que usa la liquidación legada; aquí va falso.
// Supabase falso con mock.module. Sin red ni base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let escrituras = [];
let catalogo = [];
let casRechazado = 0;

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); this.eqs = [...(this.eqs || []), [c, v]]; return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  update(v) { this.upd = v; return this; }
  insert(v) { this.ins = v; return this; }
  upsert(v, o) { this.ups = v; this.opciones = o; return this; }
  delete() { this.borrar = true; return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  ejecutar() {
    if (this.upd) {
      escrituras.push({ tabla: this.t, op: "update", valores: this.upd, filtros: this.eqs });
      if (casRechazado > 0) { casRechazado -= 1; return { data: [], error: null }; }
      const filas = this.filas();
      for (const fila of filas) Object.assign(fila, this.upd);
      return { data: filas, error: null };
    }
    if (this.ups) {
      escrituras.push({ tabla: this.t, op: "upsert", valores: this.ups, opciones: this.opciones });
      const lista = tablas[this.t] || (tablas[this.t] = []);
      for (const v of this.ups) {
        const previa = lista.find((r) => r.preliquidacion_id === v.preliquidacion_id && r.vicera_item_id === v.vicera_item_id);
        if (previa) Object.assign(previa, v);
        else lista.push({ id: 500 + lista.length, ...v });
      }
      return { data: [], error: null };
    }
    if (this.borrar) {
      const filas = this.filas();
      escrituras.push({ tabla: this.t, op: "delete", ids: filas.map((r) => r.id) });
      tablas[this.t] = (tablas[this.t] || []).filter((r) => !filas.includes(r));
      return { data: filas, error: null };
    }
    return { data: this.filas(), error: null };
  }
  maybeSingle() { const { data, error } = this.ejecutar(); return Promise.resolve({ data: data[0] ?? null, error }); }
  then(res, rej) { return Promise.resolve(this.ejecutar()).then(res, rej); }
}

mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t) } } });
mock.module(url("models/Liquidacion.model.js"), {
  namedExports: { listarCatalogoRetomas: async () => catalogo },
});
const Retomas = await import(url("models/PreliquidacionRetomas.model.js"));

const cabecera = (extra = {}) => ({ id: 1, especie: "cerdo", liquidada_at: null, version: 2, ...extra });

beforeEach(() => {
  catalogo = [
    { id: 5, nombre: "Chicharron", unidad: "KL", precio: "3000", orden: 1 },
    { id: 6, nombre: "Costilla", unidad: "KL", precio: "8000", orden: 2 },
  ];
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_retomas: [],
  };
  escrituras = [];
  casRechazado = 0;
});

const falla = async (fn, estado, codigo) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.statusCode, estado, `status ${e.statusCode} (${e.message})`);
    if (codigo) assert.equal(e.codigo, codigo);
    return true;
  });
};

test("obtenerRetomas: sin nada guardado muestra el catálogo con 0 kilos y el precio vigente", async () => {
  const r = await Retomas.obtenerRetomas(1);
  assert.equal(r.preliquidacion_id, 1);
  assert.equal(r.editable, true);
  assert.equal(r.filas.length, 2);
  assert.deepEqual(r.filas.map((f) => [f.vicera_item_id, f.kilos, f.precio, f.precio_catalogo]), [
    [5, 0, 3000, 3000],
    [6, 0, 8000, 8000],
  ]);
  assert.equal(r.total, 0);
});

test("obtenerRetomas: una especie res se rechaza con 400", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ especie: "res" })];
  await falla(() => Retomas.obtenerRetomas(1), 400);
});

test("obtenerRetomas: la preliquidación inexistente es 404", async () => {
  await falla(() => Retomas.obtenerRetomas(9), 404);
});

test("obtenerRetomas: congelada, el precio de catálogo mostrado es el guardado (snapshot)", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ liquidada_at: "2026-11-24T02:31:00.000Z" })];
  tablas.carnes_preliquidacion_retomas = [
    { id: 1, preliquidacion_id: 1, vicera_item_id: 5, nombre: "Chicharron", unidad: "KL", kilos: "10.000", precio: "2800.00", precio_catalogo: "2800.00", orden: 1 },
  ];
  const r = await Retomas.obtenerRetomas(1);
  assert.equal(r.editable, false);
  const f = r.filas.find((x) => x.vicera_item_id === 5);
  assert.equal(f.precio_catalogo, 2800);
  assert.equal(f.precio, 2800);
  assert.equal(r.total, 28000);
  assert.equal(r.total_kilos, 10);
});

test("guardarRetomas: guarda con snapshot de nombre, unidad y precio de catálogo y sube la versión", async () => {
  const r = await Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 5, kilos: 10, precio: 3100 }] });
  const up = escrituras.find((e) => e.op === "upsert");
  assert.equal(up.tabla, "carnes_preliquidacion_retomas");
  assert.equal(up.opciones.onConflict, "preliquidacion_id,vicera_item_id");
  assert.deepEqual(up.valores, [
    { preliquidacion_id: 1, vicera_item_id: 5, nombre: "Chicharron", unidad: "KL", kilos: 10, precio: 3100, precio_catalogo: 3000, orden: 1 },
  ]);
  const v = escrituras.find((e) => e.tabla === "carnes_preliquidaciones" && e.op === "update");
  assert.equal(v.valores.version, 3);
  assert.equal(r.total, 31000);
  // C14: las retomas NO se convierten en un gasto de la preliquidación.
  assert.ok(!escrituras.some((e) => e.tabla === "carnes_preliquidacion_gastos"));
});

test("guardarRetomas: lo que no viene (o viene en 0 kilos) se borra", async () => {
  tablas.carnes_preliquidacion_retomas = [
    { id: 1, preliquidacion_id: 1, vicera_item_id: 5, nombre: "Chicharron", unidad: "KL", kilos: "10.000", precio: "3000.00", precio_catalogo: "3000.00", orden: 1 },
    { id: 2, preliquidacion_id: 1, vicera_item_id: 6, nombre: "Costilla", unidad: "KL", kilos: "4.000", precio: "8000.00", precio_catalogo: "8000.00", orden: 2 },
  ];
  await Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 5, kilos: 12, precio: 3000 }, { vicera_item_id: 6, kilos: 0, precio: 8000 }] });
  assert.deepEqual(tablas.carnes_preliquidacion_retomas.map((r) => r.vicera_item_id), [5]);
  const borrado = escrituras.find((e) => e.op === "delete");
  assert.deepEqual(borrado.ids, [2]);
});

test("guardarRetomas: congelada responde 409 preliquidacion_congelada y no escribe", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ liquidada_at: "2026-11-24T02:31:00.000Z" })];
  await falla(() => Retomas.guardarRetomas(1, { filas: [] }), 409, "preliquidacion_congelada");
  assert.equal(escrituras.length, 0);
});

test("guardarRetomas: una especie res se rechaza con 400 y no escribe", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ especie: "res" })];
  await falla(() => Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 5, kilos: 1, precio: 1 }] }), 400);
  assert.equal(escrituras.length, 0);
});

test("guardarRetomas: un ítem fuera del catálogo o valores negativos son 400", async () => {
  await falla(() => Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 99, kilos: 1, precio: 1 }] }), 400);
  await falla(() => Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 5, kilos: -1, precio: 1 }] }), 400);
  await falla(() => Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 5, kilos: 1, precio: 1 }, { vicera_item_id: 5, kilos: 2, precio: 1 }] }), 400);
  assert.equal(escrituras.length, 0);
});

test("guardarRetomas: reintenta la versión si otra escritura la cambió", async () => {
  casRechazado = 1;
  await Retomas.guardarRetomas(1, { filas: [{ vicera_item_id: 5, kilos: 1, precio: 1 }] });
  assert.equal(escrituras.filter((e) => e.tabla === "carnes_preliquidaciones" && e.op === "update").length, 2);
});
