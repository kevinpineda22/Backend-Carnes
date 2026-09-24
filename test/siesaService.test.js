import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { enviarASiesa } from "../src/services/siesa.service.js";

// `incierto` decide si un fallo se puede reintentar (error) o hay que mirar en
// SIESA primero (sin_confirmar). Equivocarse para el lado de "error" es lo que
// duplica documentos.

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

const responder = (status, cuerpo) => async () =>
  new Response(cuerpo === undefined ? "" : JSON.stringify(cuerpo), { status });

const fallar = (error) => async () => {
  throw error;
};

test("200 sin rechazo: ok y no incierto", async () => {
  globalThis.fetch = responder(200, { codigo: 0, mensaje: "Importado" });
  const r = await enviarASiesa({});
  assert.equal(r.ok, true);
  assert.ok(!r.incierto);
});

test("400 del conector: es un rechazo, se puede corregir y reintentar", async () => {
  globalThis.fetch = responder(400, { mensaje: "Error en la Estructura" });
  const r = await enviarASiesa({});
  assert.equal(r.ok, false);
  assert.equal(r.incierto, false);
});

test("504 del gateway: no se sabe si SIESA lo creó", async () => {
  globalThis.fetch = responder(504);
  const r = await enviarASiesa({});
  assert.equal(r.ok, false);
  assert.equal(r.incierto, true);
});

test("timeout: no se sabe si SIESA lo creó", async () => {
  const e = new Error("aborted");
  e.name = "AbortError";
  globalThis.fetch = fallar(e);
  const r = await enviarASiesa({});
  assert.equal(r.incierto, true);
  assert.match(r.error, /verificalo/i);
});

test("conexión rechazada: seguro que no salió, se puede reintentar", async () => {
  const e = new TypeError("fetch failed");
  e.cause = { code: "ECONNREFUSED" };
  globalThis.fetch = fallar(e);
  const r = await enviarASiesa({});
  assert.equal(r.incierto, false);
});

test("corte de red a mitad de camino: no se sabe", async () => {
  const e = new TypeError("fetch failed");
  e.cause = { code: "ECONNRESET" };
  globalThis.fetch = fallar(e);
  const r = await enviarASiesa({});
  assert.equal(r.incierto, true);
});
