// Acta de devolución para contabilidad / consulta: la MISMA que la del recibidor, solo
// de recepciones en SIESA y solo si hubo devolución. Supabase falso; usa mock.module
// (npm test corre con --experimental-test-module-mocks). Sin red.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let cabeceras = [];
let renglones = [];
let consultas = [];

class Q {
  constructor(t) {
    this.t = t;
    this.f = [];
    consultas.push(this);
  }
  select(c) { this.columnas = c; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  ilike(c, v) { this.f.push((r) => String(r[c]).toLowerCase() === String(v).toLowerCase()); return this; }
  in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
  gt(c, v) { this.f.push((r) => Number(r[c]) > v); return this; }
  order() { return this; }
  filas() {
    const base = this.t === "carnes_proveedor_recepciones" ? cabeceras : renglones;
    return base.filter((r) => this.f.every((g) => g(r)));
  }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t) } } });
const M = await import(url("models/RecepcionProveedor.model.js"));

const cabecera = (extra) => ({
  id: 7, estado: "Enviada_SIESA", recibido_por: "ana@x.co", recibidor_nombre: "Ana",
  recibidor_cedula: "123", firma_data: "data:firma", proveedor_firma: "data:firma-prov",
  proveedor_firma_nombre: "Pedro", proveedor_firma_documento: "999", ...extra,
});
const renglon = (extra) => ({ id: 1, recepcion_id: 7, cantidad: 10, cantidad_devuelta: 2, orden: 1, ...extra });

test("obtenerActaContabilidad: Enviada_SIESA con devolución entrega el acta con firmas y cédula, con la forma del acta del recibidor", async () => {
  cabeceras = [cabecera()];
  renglones = [renglon(), renglon({ id: 2, cantidad_devuelta: 0 }), renglon({ id: 3, cantidad: 0 })];
  const acta = await M.obtenerActaContabilidad({ id: 7 });
  assert.equal(acta.recibidor_nombre, "Ana");
  assert.equal(acta.recibidor_cedula, "123");
  assert.equal(acta.firma_data, "data:firma");
  assert.equal(acta.proveedor_firma_nombre, "Pedro");
  assert.equal(acta.proveedor_firma_documento, "999");
  assert.deepEqual(acta.items.map((i) => i.id), [1]);

  const delRecibidor = await M.obtenerActa({ id: 7, correo: "ana@x.co" });
  assert.deepEqual(acta, delRecibidor);
});

test("obtenerActaContabilidad: usa las mismas columnas del acta (nada más sale)", async () => {
  cabeceras = [cabecera()];
  renglones = [renglon()];
  consultas = [];
  await M.obtenerActaContabilidad({ id: 7 });
  const { COLUMNAS_ACTA_PROVEEDOR, COLUMNAS_ITEMS_ACTA_PROVEEDOR } = await import(url("shared/historialRecibidor.js"));
  assert.deepEqual(consultas.map((q) => q.columnas), [COLUMNAS_ACTA_PROVEEDOR, COLUMNAS_ITEMS_ACTA_PROVEEDOR]);
});

test("obtenerActaContabilidad: solo Enviada_SIESA (borrador, finalizada y anulada: 404)", async () => {
  renglones = [renglon()];
  for (const estado of ["Borrador", "Finalizada", "Anulada"]) {
    cabeceras = [cabecera({ estado })];
    await assert.rejects(() => M.obtenerActaContabilidad({ id: 7 }), (e) => e.statusCode === 404 || e.status === 404, estado);
  }
});

test("obtenerActaContabilidad: sin devolución o inexistente es 404", async () => {
  cabeceras = [cabecera()];
  renglones = [renglon({ cantidad_devuelta: 0 })];
  await assert.rejects(() => M.obtenerActaContabilidad({ id: 7 }), (e) => e.statusCode === 404 || e.status === 404);
  renglones = [renglon()];
  await assert.rejects(() => M.obtenerActaContabilidad({ id: 99 }), (e) => e.statusCode === 404 || e.status === 404);
});

test("obtenerActaContabilidad: no depende de quién firmó (otra cuenta de solo lectura la ve)", async () => {
  cabeceras = [cabecera({ recibido_por: "otra@x.co" })];
  renglones = [renglon()];
  const acta = await M.obtenerActaContabilidad({ id: 7 });
  assert.equal(acta.recibido_por, "otra@x.co");
});
