// reabrir / eliminar / costear / vincular no pueden tocar una liquidación con documentos vigentes
// en SIESA (la oficial por fecha puede estar parcial con la liquidación Costeada).
// Supabase falso; usa mock.module (npm test corre con --experimental-test-module-mocks).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let envios = [];
let otrasConsultas = [];
class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
  then(res, rej) {
    if (this.t !== "carnes_siesa_envios") {
      otrasConsultas.push(this.t);
      return Promise.resolve({ data: null, error: { message: "no debería llegar acá" } }).then(res, rej);
    }
    return Promise.resolve({ data: envios.filter((r) => this.f.every((g) => g(r))), error: null }).then(res, rej);
  }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t) } } });
const L = await import(url("models/Liquidacion.model.js"));

const fila = (extra) => ({
  liquidacion_id: 6, recepcion_id: null, tipo: "oficial", estado: "ok", referencia: "TC OFI L6KD", ...extra,
});

for (const [nombre, accion, texto] of [
  ["reabrir", () => L.reabrir(6), /reabrirla/],
  ["eliminar", () => L.eliminar(6), /borrarla/],
  ["costear", () => L.costear(6), /volver a costearla/],
  ["vincular", () => L.vincular(6, [11, 12]), /vincular recepciones/],
]) {
  test(`${nombre}: con una oficial por fecha ya ok en SIESA responde 409 y no toca nada`, async () => {
    otrasConsultas = [];
    envios = [fila({ estado: "ok" })];
    await assert.rejects(accion, (e) => e.statusCode === 409 || e.status === 409 ? texto.test(e.message) && /TC OFI L6KD/.test(e.message) : false);
    assert.deepEqual(otrasConsultas, []);
  });
}

for (const tipo of ["ajuste_visceras", "ajuste_faltante"]) {
  for (const estado of ["enviando", "sin_confirmar", "ok"]) {
    test(`reabrir: ${tipo} ${estado} también frena`, async () => {
      envios = [fila({ tipo, estado, referencia: "TC X" })];
      await assert.rejects(() => L.reabrir(6), /documentos en SIESA/);
    });
  }
}

test("exigirSinDocumentosEnSiesa: error, anulado, otra liquidación o de recepción no frenan", async () => {
  envios = [
    fila({ estado: "error" }),
    fila({ estado: "anulado" }),
    fila({ liquidacion_id: 7 }),
    fila({ recepcion_id: 2, tipo: "inicial" }),
  ];
  await L.exigirSinDocumentosEnSiesa(6, "reabrirla");
});
