// Oficial sin inicial (sql/044), capa JS: omitir la inicial de una sede y de toda la preliquidación.
// Las reglas bajo lock las decide la RPC (prueba estática en preliquidacion-oficial-sin-inicial-sql.test.js);
// aquí se verifica lo que decide JS: pertenencia de la sede, qué sedes entran en el masivo, y cómo se
// traducen los resultados de la RPC a errores HTTP. Supabase falso: sin red ni base.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let rpcs = [];
let respuestasRpc = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))).map((r) => ({ ...r })); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const h = respuestasRpc[args.p_sede_id] ?? { resultado: "ok" };
    return { data: typeof h === "function" ? h(args) : h, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const M = await import(url("models/PreliquidacionInicial.model.js"));

beforeEach(() => {
  rpcs = [];
  respuestasRpc = {};
  tablas = {
    carnes_preliquidaciones: [{ id: 19, estado: "abierta" }, { id: 20, estado: "cerrada" }],
    carnes_preliquidacion_sedes: [
      { id: 1, preliquidacion_id: 19, recepcion_id: 215 },
      { id: 2, preliquidacion_id: 19, recepcion_id: 216 },
      { id: 3, preliquidacion_id: 19, recepcion_id: 217 },
      { id: 9, preliquidacion_id: 20, recepcion_id: 300 },
    ],
    carnes_siesa_envios: [
      { id: 1, recepcion_id: 217, tipo: "inicial", estado: "ok" },
      { id: 2, recepcion_id: 216, tipo: "inicial", estado: "error" },
      { id: 3, recepcion_id: 215, tipo: "oficial", estado: "ok" },
    ],
  };
});

test("una sede: llama a la RPC con la sede y quién lo hace, y devuelve el resultado", async () => {
  const r = await M.omitirInicialSede(1, { por: "admin@x.co" });
  assert.deepEqual(rpcs, [{ nombre: "carnes_preliq_omitir_inicial", args: { p_sede_id: 1, p_por: "admin@x.co" } }]);
  assert.deepEqual(r, { resultado: "ok", sede_id: 1, recepcion_id: 215, preliquidacion_id: 19 });
});

test("una sede: idempotente, ya_omitida es éxito y no un error", async () => {
  respuestasRpc[1] = { resultado: "ya_omitida" };
  const r = await M.omitirInicialSede(1, { por: null });
  assert.equal(r.resultado, "ya_omitida");
});

test("una sede inexistente o de otra preliquidación es 404 y nunca llega a la RPC", async () => {
  await assert.rejects(() => M.omitirInicialSede(99), (e) => e.statusCode === 404 && e.codigo === "no_encontrada");
  await assert.rejects(() => M.omitirInicialSede(9, { preliquidacionId: 19 }), (e) => e.statusCode === 404);
  assert.equal(rpcs.length, 0);
});

test("una sede: inicial vigente y oficial ya enviada son 409 con su código", async () => {
  respuestasRpc[1] = { resultado: "inicial_vigente", estado: "sin_confirmar" };
  await assert.rejects(() => M.omitirInicialSede(1), (e) => e.statusCode === 409 && e.codigo === "inicial_vigente");
  respuestasRpc[1] = { resultado: "oficial_enviada" };
  await assert.rejects(() => M.omitirInicialSede(1), (e) => e.statusCode === 409 && e.codigo === "oficial_enviada");
  respuestasRpc[1] = { resultado: "no_abierta" };
  await assert.rejects(() => M.omitirInicialSede(1), (e) => e.statusCode === 409 && e.codigo === "no_abierta");
});

test("un resultado desconocido de la RPC es un 500 sin exponer (no se disfraza de éxito)", async () => {
  respuestasRpc[1] = { resultado: "algo_raro" };
  await assert.rejects(() => M.omitirInicialSede(1), (e) => e.statusCode === 500 && !e.expose);
});

test("masivo: omite solo las sedes listadas, salta las que ya tienen inicial ok y informa cada una", async () => {
  const r = await M.omitirInicialPreliquidacion(19, { por: "admin@x.co", sedeIds: [1, 2, 3] });
  assert.equal(r.preliquidacion_id, 19);
  assert.deepEqual(rpcs.map((c) => c.args.p_sede_id), [1, 2], "la sede 3 tiene inicial ok: no se toca");
  assert.deepEqual(
    r.resultados.map((x) => [x.sede_id, x.recepcion_id, x.ok, x.resultado]),
    [[1, 215, true, "ok"], [2, 216, true, "ok"], [3, 217, true, "saltada"]],
  );
  assert.equal(r.resultados[2].motivo, "inicial_ok");
  assert.deepEqual(r.resumen, { omitidas: 2, ya_omitidas: 0, saltadas: 1, rechazadas: 0 });
});

test("masivo: no omite nada que no esté listado", async () => {
  const r = await M.omitirInicialPreliquidacion(19, { por: null, sedeIds: [2] });
  assert.deepEqual(rpcs.map((c) => c.args.p_sede_id), [2]);
  assert.deepEqual(r.resultados.map((x) => x.sede_id), [2]);
});

test("masivo: sin sede_ids (ausente, vacío o no arreglo) es 400 y no toca nada", async () => {
  await assert.rejects(() => M.omitirInicialPreliquidacion(19), (e) => e.statusCode === 400);
  await assert.rejects(() => M.omitirInicialPreliquidacion(19, { sedeIds: [] }), (e) => e.statusCode === 400);
  await assert.rejects(() => M.omitirInicialPreliquidacion(19, { sedeIds: "1" }), (e) => e.statusCode === 400);
  assert.equal(rpcs.length, 0);
});

test("masivo: una sede de otra preliquidación o inexistente se rechaza como no_pertenece, sin llegar a la RPC ni frenar las demás", async () => {
  const r = await M.omitirInicialPreliquidacion(19, { por: null, sedeIds: [9, 1, 99] });
  assert.deepEqual(rpcs.map((c) => c.args.p_sede_id), [1]);
  assert.deepEqual(
    r.resultados.map((x) => [x.sede_id, x.ok, x.codigo ?? x.resultado]),
    [[9, false, "no_pertenece"], [1, true, "ok"], [99, false, "no_pertenece"]],
  );
  assert.match(r.resultados[0].error, /no pertenece/);
  assert.deepEqual(r.resumen, { omitidas: 1, ya_omitidas: 0, saltadas: 0, rechazadas: 2 });
});

test("masivo: los ids repetidos se procesan una sola vez", async () => {
  await M.omitirInicialPreliquidacion(19, { sedeIds: [1, 1, "1"] });
  assert.equal(rpcs.length, 1);
});

test("masivo: una sede rechazada no frena las demás y su error viaja en su fila", async () => {
  respuestasRpc[1] = { resultado: "oficial_enviada" };
  respuestasRpc[2] = { resultado: "ya_omitida" };
  const r = await M.omitirInicialPreliquidacion(19, { por: null, sedeIds: [1, 2, 3] });
  assert.equal(rpcs.length, 2);
  assert.equal(r.resultados[0].ok, false);
  assert.equal(r.resultados[0].codigo, "oficial_enviada");
  assert.match(r.resultados[0].error, /ya se envió/);
  assert.equal(r.resultados[1].resultado, "ya_omitida");
  assert.deepEqual(r.resumen, { omitidas: 0, ya_omitidas: 1, saltadas: 1, rechazadas: 1 });
});

test("sede anulada o bloqueada: 409 sede_no_enviable; en el masivo se informa y no frena el lote", async () => {
  respuestasRpc[1] = { resultado: "sede_no_enviable", estado: "bloqueada" };
  await assert.rejects(
    () => M.omitirInicialSede(1),
    (e) => e.statusCode === 409 && e.codigo === "sede_no_enviable" && /anulada o bloqueada/.test(e.message),
  );
  const r = await M.omitirInicialPreliquidacion(19, { sedeIds: [1, 2] });
  assert.equal(r.resultados[0].ok, false);
  assert.equal(r.resultados[0].codigo, "sede_no_enviable");
  assert.equal(r.resultados[1].resultado, "ok");
  assert.deepEqual(r.resumen, { omitidas: 1, ya_omitidas: 0, saltadas: 0, rechazadas: 1 });
});

test("masivo: un error inesperado no se esconde dentro de la lista", async () => {
  respuestasRpc[1] = { resultado: "algo_raro" };
  await assert.rejects(() => M.omitirInicialPreliquidacion(19, { sedeIds: [1] }), (e) => e.statusCode === 500);
});

test("masivo: preliquidación inexistente es 404; cerrada o anulada es 409 no_abierta", async () => {
  await assert.rejects(() => M.omitirInicialPreliquidacion(77, { sedeIds: [1] }), (e) => e.statusCode === 404);
  await assert.rejects(
    () => M.omitirInicialPreliquidacion(20, { sedeIds: [9] }),
    (e) => e.statusCode === 409 && e.codigo === "no_abierta",
  );
  assert.equal(rpcs.length, 0);
});

test("masivo: si la preliquidación no tiene sedes, todo lo listado es no_pertenece", async () => {
  tablas.carnes_preliquidacion_sedes = [];
  const r = await M.omitirInicialPreliquidacion(19, { sedeIds: [1] });
  assert.deepEqual(r.resumen, { omitidas: 0, ya_omitidas: 0, saltadas: 0, rechazadas: 1 });
  assert.equal(rpcs.length, 0);
});

