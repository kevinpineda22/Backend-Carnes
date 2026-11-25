// Recepcion.listar expone `preliquidacion_id` en cada fila con UNA sola lectura por página
// (para "En preliquidación #id" en el panel del admin). Supabase falso con mock.module.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let consultas = []; // { tabla, cols, ids }
let fallaVinculos = false;
let sinColumna = false;

class Q {
  constructor(t) { this.t = t; this.f = []; this.cols = ""; }
  select(c) { this.cols = c || ""; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, a) { this.ids = a; this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  limit() { return this; }
  gte() { return this; }
  lte() { return this; }
  then(res, rej) {
    consultas.push({ tabla: this.t, cols: this.cols, ids: this.ids });
    const soloVinculos = this.cols.replace(/\s/g, "") === "id,preliquidacion_id";
    let r;
    if (soloVinculos && fallaVinculos) r = { data: null, error: { code: "XX000", message: "caída" } };
    else if (soloVinculos && sinColumna) r = { data: null, error: { code: "42703", message: "column preliquidacion_id does not exist" } };
    else r = { data: (tablas[this.t] || []).filter((x) => this.f.every((g) => g(x))).map(({ preliquidacion_id, ...x }) => (soloVinculos ? { id: x.id, preliquidacion_id } : x)), error: null };
    return Promise.resolve(r).then(res, rej);
  }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t) } } });
const Recepcion = await import(url("models/Recepcion.model.js"));

beforeEach(() => {
  tablas = {
    carnes_recepciones: [
      { id: 1, estado: "Aprobado", preliquidacion_id: 7 },
      { id: 2, estado: "Aprobado", preliquidacion_id: null },
      { id: 3, estado: "Aprobado", preliquidacion_id: 9 },
    ],
  };
  consultas = [];
  fallaVinculos = false;
  sinColumna = false;
});

const vinculos = () => consultas.filter((c) => c.tabla === "carnes_recepciones" && c.ids);

test("listar: cada fila trae preliquidacion_id (el número o null) con una sola lectura de vínculos", async () => {
  const filas = await Recepcion.listar({});
  const mapa = Object.fromEntries(filas.map((f) => [f.id, f.preliquidacion_id]));
  assert.deepEqual(mapa, { 1: 7, 2: null, 3: 9 });
  assert.equal(vinculos().length, 1);
  assert.deepEqual(vinculos()[0].ids.map(Number).sort(), [1, 2, 3]);
});

test("listar: sin filas no consulta vínculos", async () => {
  tablas.carnes_recepciones = [];
  assert.deepEqual(await Recepcion.listar({}), []);
  assert.equal(vinculos().length, 0);
});

test("listar: antes de sql/038 (sin la columna) todas las filas llevan null", async () => {
  sinColumna = true;
  const filas = await Recepcion.listar({});
  assert.equal(filas.length, 3);
  assert.ok(filas.every((f) => f.preliquidacion_id === null));
});

test("listar: si falla la lectura de vínculos el error se propaga como el de cualquier otra lectura", async () => {
  fallaVinculos = true;
  await assert.rejects(() => Recepcion.listar({}), /preliquidaciones de las recepciones/);
});
