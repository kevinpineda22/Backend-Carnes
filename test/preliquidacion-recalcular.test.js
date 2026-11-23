// POST /:id/recalcular ("recalcular no enviadas"): cambios sobre la cabecera ya liquidada, recosteo de
// las sedes sin enviar con destinos EXACTOS de la tabla de transiciones, y marcado de las enviadas.
// Supabase falso con RPC que mutan las tablas. Nada de esto toca SIESA.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let rpcs = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  update() { return this; }
  insert() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const h = manejadores[nombre];
    return { data: h ? h(args) : { resultado: "ok" }, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Modelo = await import(url("models/Preliquidacion.model.js"));

const silencio = { info() {}, warn() {}, error() {} };

const cabecera = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", animales: 10, animal_en_pie: "1000000.00",
  servicio_precorte: null, servicio_por_animal: "50000.00", fecha_primer_ingreso: "2026-11-23",
  ventana_fin: "2026-11-25T04:59:59.999Z", liquidada_at: "2026-11-24T02:31:00.000Z",
  servicio_aplicado: "500000.00", gasto_total_aplicado: "1500000.00", costo_por_animal: "150000.00",
  version: 3, orden_version: 5, tercero_id: "frigorifico", ...extra,
});
const sede = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "calculada",
  motivo_bloqueo: null, liberada_at: null, version: 2, intentos: 0, error_tipo: null, motivo_pendiente: null,
  gasto_sede: "600000.00", costeo_orden_version: 5, costeo_animales: 4, requiere_correccion: false, envio_id: null, ...extra,
});
// Items de una recepción: costo_base alto = utilidad positiva; bajo = utilidad negativa.
const item = (id, recepcionId, costoBase = "1000000") => ({
  id, recepcion_id: recepcionId, tipo: "carne", cantidad: "100", costo_base: costoBase, descripcion: "x", orden: 1,
});

/** Una sola sede (la 4 animales) en el estado dado, más una segunda enviada de 6 animales. */
function escenario({ estado, extra = {}, costoBase = "1000000", cab = {} } = {}) {
  tablas = {
    carnes_preliquidaciones: [cabecera(cab)],
    carnes_preliquidacion_sedes: [
      sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1, estado, ...extra }),
      sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2, estado: "enviada", gasto_sede: "900000.00", costeo_animales: 6 }),
    ],
    carnes_preliquidacion_gastos: [], carnes_preliquidacion_saldos: [], carnes_preliquidacion_retomas: [],
    carnes_recepciones: [{ id: 101, especie: "res", estado: "Aprobado" }, { id: 102, especie: "res", estado: "Enviado_SIESA" }],
    carnes_recepcion_items: [item(1, 101, costoBase), item(2, 102)],
  };
}

const rpcDe = (n) => rpcs.filter((r) => r.nombre === n);
const NOMBRES_DE_ENVIO = ["carnes_preliq_reclamar_sede", "carnes_preliq_cerrar_envio", "carnes_preliq_sincronizar_envio"];

// RPC falsas con efecto sobre las tablas.
const rpcRecalcular = (a) => {
  const h = tablas.carnes_preliquidaciones[0];
  h.orden_version += 1;
  if (Object.keys(a.p_cambios).length) h.version += 1;
  for (const k of ["animales", "animal_en_pie", "servicio_por_animal", "tercero_id"]) if (k in a.p_cambios) h[k] = a.p_cambios[k];
  if (a.p_plan.gasto_total) Object.assign(h, { gasto_total_aplicado: a.p_plan.gasto_total, servicio_aplicado: a.p_plan.servicio_aplicado, costo_por_animal: a.p_plan.costo_por_animal });
  const marcadas = [];
  for (const s of tablas.carnes_preliquidacion_sedes) {
    if (["enviando", "enviada", "sin_confirmar"].includes(s.estado)) {
      Object.assign(s, { requiere_correccion: true, correccion_orden_version: h.orden_version, version: s.version + 1 });
      marcadas.push({ sede_id: s.id, sede_version: s.version });
    }
    if (a.p_plan.liberadas.includes(s.recepcion_id)) Object.assign(s, { liberada_at: "2026-11-24T05:00:00.000Z", version: s.version + 1 });
  }
  return { resultado: "ok", version: h.version, orden_version: h.orden_version, sedes_marcadas: marcadas };
};
const rpcCongelar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => x.id === a.p_sede_id);
  const h = tablas.carnes_preliquidaciones[0];
  assert.equal(a.p_orden_version, h.orden_version, "congelar usa la orden_version posterior al recálculo");
  Object.assign(s, {
    estado: a.p_plan.hacia, gasto_sede: a.p_plan.gasto_sede, costeo_orden_version: a.p_orden_version, costeo_animales: s.animales,
    version: s.version + 1, motivo_bloqueo: a.p_plan.motivo_bloqueo ?? null, liberada_at: a.p_plan.hacia === "bloqueada" ? s.liberada_at : null,
  });
  return { resultado: "ok" };
};

beforeEach(() => {
  rpcs = [];
  manejadores = { carnes_preliq_recalcular_no_enviadas: rpcRecalcular, carnes_preliq_congelar_sede: rpcCongelar };
  escenario({ estado: "calculada" });
});

const alertas = [];
const recalcular = (cambios = {}, motivo = "ajuste", extra = {}) => {
  alertas.length = 0;
  return Modelo.recalcular(1, { cambios, motivo }, {
    por: "ana", siesaActivo: false, log: silencio, encolar: async (a) => (alertas.push(a), { ok: true }), ...extra,
  });
};
const estadoDe = (id) => tablas.carnes_preliquidacion_sedes.find((s) => s.id === id).estado;

// ─── Plan puro ─────────────────────────────────────────────────────────────

const sedePlan = (extra = {}) => ({
  recepcionId: 101, animales: 4, orden: 1, estado: "calculada", motivoBloqueo: null, liberadaAt: null,
  fechaIngreso: "2026-11-23", recibidoAt: "2026-11-23T14:00:00Z", ...extra,
});

test("plan: cambios vacíos = recosteo puro, sin recalcular el gasto y con la orden_version leída", () => {
  const r = Modelo.armarPlanRecalcular({ cabecera: cabecera(), sedes: [sedePlan()], gastos: [], saldosAplicados: [], cambios: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.cambios, {});
  assert.equal(r.plan.orden_version, 5);
  assert.equal("gasto_total" in r.plan, false);
  assert.deepEqual([r.plan.reordenar, r.plan.excede, r.plan.liberadas], [[], [], []]);
  assert.equal(r.plan.restantes, 6);
});

test("plan: animal_en_pie nuevo recalcula el gasto con gastoTotal (incluye saldos aplicados y gastos vigentes)", () => {
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera(),
    sedes: [sedePlan()],
    gastos: [{ concepto: "Flete", valor: "100000.00", signo: 1 }],
    saldosAplicados: [{ id: 7, valor: "200000.00", estado: "aplicado" }],
    cambios: { animal_en_pie: "2000000" },
  });
  // 2,000,000 + 500,000 (servicio 50,000 x 10) + 100,000 flete + 200,000 saldo = 2,800,000
  assert.equal(r.plan.gasto_total, "2800000.00");
  assert.equal(r.plan.servicio_aplicado, "500000.00");
  assert.equal(r.plan.costo_por_animal, "280000.00");
  assert.deepEqual(r.cambios, { animal_en_pie: "2000000" });
});

test("plan: gastos nuevos reemplazan a los vigentes; servicio_por_animal nuevo cambia el servicio aplicado", () => {
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera(),
    sedes: [sedePlan()],
    gastos: [{ concepto: "Viejo", valor: "999999.00", signo: 1 }],
    saldosAplicados: [],
    cambios: { servicio_por_animal: "60000", gastos: [{ concepto: "Flete", valor: "50000", signo: -1 }] },
  });
  // 1,000,000 + 600,000 - 50,000 = 1,550,000
  assert.equal(r.plan.gasto_total, "1550000.00");
  assert.equal(r.plan.servicio_aplicado, "600000.00");
});

const saldoAlterna = (extra = {}) => ({ id: 3, origen_preliquidacion_id: 1, valor: "200000.00", estado: "pendiente", alterna_id: 77, ...extra });

test("plan: cambiar el servicio aplicado con un saldo pendiente de una alterna (neto distinto de cero) -> saldo_alterna_vigente", () => {
  for (const saldos of [
    [saldoAlterna({ estado: "pendiente" })],
    [saldoAlterna({ id: 3, estado: "aplicado" }), saldoAlterna({ id: 4, estado: "pendiente", valor: "50000.00" })],
  ]) {
    const r = Modelo.armarPlanRecalcular({
      cabecera: cabecera(), sedes: [sedePlan()], gastos: [], saldosAplicados: [], saldosOrigen: saldos,
      cambios: { servicio_por_animal: "60000" },
    });
    assert.deepEqual({ ok: r.ok, resultado: r.resultado }, { ok: false, resultado: "saldo_alterna_vigente" });
  }
});

test("plan: saldos de alterna solo aplicados -> el recálculo sigue con aviso de saldo no recomputado", () => {
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera(), sedes: [sedePlan()], gastos: [], saldosAplicados: [], saldosOrigen: [saldoAlterna({ estado: "aplicado" })],
    cambios: { servicio_por_animal: "60000" },
  });
  assert.equal(r.ok, true);
  // El aviso lo entrega solo la RPC: el planificador no produce uno propio.
  assert.equal("aviso" in r, false);
});

test("plan: saldos de alterna vigentes con neto cero no bloquean ni avisan", () => {
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera(), sedes: [sedePlan()], gastos: [], saldosAplicados: [],
    saldosOrigen: [saldoAlterna({ id: 3, estado: "aplicado" }), saldoAlterna({ id: 4, estado: "pendiente", valor: "-200000.00" })],
    cambios: { servicio_por_animal: "60000" },
  });
  assert.equal(r.ok, true);
  assert.equal("aviso" in r, false);
});

test("plan: con saldo de alterna pero sin cambiar el servicio aplicado (o saldo descartado/movido) el recálculo sigue", () => {
  const base = { cabecera: cabecera(), sedes: [sedePlan()], gastos: [], saldosAplicados: [] };
  // animal_en_pie no toca el servicio aplicado (50,000 x 10 = 500,000).
  assert.equal(Modelo.armarPlanRecalcular({ ...base, saldosOrigen: [saldoAlterna()], cambios: { animal_en_pie: "2000000" } }).ok, true);
  // Recosteo puro: no recalcula el gasto.
  assert.equal(Modelo.armarPlanRecalcular({ ...base, saldosOrigen: [saldoAlterna()], cambios: {} }).ok, true);
  // Un servicio por animal distinto pero igual servicio aplicado (animales x por animal = 500,000).
  assert.equal(Modelo.armarPlanRecalcular({ ...base, saldosOrigen: [saldoAlterna()], cambios: { servicio_por_animal: "50000" } }).ok, true);
  for (const estado of ["descartado", "movido"]) {
    const r = Modelo.armarPlanRecalcular({ ...base, saldosOrigen: [saldoAlterna({ estado })], cambios: { servicio_por_animal: "60000" } });
    assert.equal(r.ok, true, estado);
  }
});

test("recalcular con un saldo de alterna vigente y servicio aplicado distinto: 409 y no se llama a la RPC", async () => {
  tablas.carnes_preliquidacion_saldos = [saldoAlterna()];
  await assert.rejects(
    () => recalcular({ servicio_por_animal: "60000" }, "ajuste de servicio"),
    (e) => e.statusCode === 409 && e.codigo === "saldo_alterna_vigente",
  );
  assert.equal(rpcDe("carnes_preliq_recalcular_no_enviadas").length, 0);
});

test("recalcular con saldo de alterna ya aplicado: sigue y devuelve el aviso de saldo no recomputado", async () => {
  tablas.carnes_preliquidacion_saldos = [saldoAlterna({ estado: "aplicado" })];
  manejadores.carnes_preliq_recalcular_no_enviadas = () => ({ resultado: "ok", version: 4, orden_version: 6, sedes_marcadas: [], aviso: "saldo_alterna_aplicado" });
  const r = await recalcular({ servicio_por_animal: "60000" }, "ajuste de servicio");
  assert.equal(r.resultado, "ok");
  assert.deepEqual(r.aviso, Modelo.AVISO_RECALCULAR_SALDO_APLICADO);
  assert.match(r.aviso.mensaje, /no se recalcul/i);
});

test("recalcular sin saldo aplicado: aviso nulo", async () => {
  manejadores.carnes_preliq_recalcular_no_enviadas = () => ({ resultado: "ok", version: 4, orden_version: 6, sedes_marcadas: [], aviso: null });
  const r = await recalcular({ animal_en_pie: "1" }, "x");
  assert.equal(r.aviso ?? null, null);
});

test("la RPC también lo rechaza bajo el lock: el código llega como 409", async () => {
  manejadores.carnes_preliq_recalcular_no_enviadas = () => ({ resultado: "saldo_alterna_vigente" });
  await assert.rejects(() => recalcular({ animal_en_pie: "1" }, "x"), (e) => e.statusCode === 409 && e.codigo === "saldo_alterna_vigente");
});

test("plan: animales sube -> la sede en desborde se libera (B-S5)", () => {
  const desborde = sedePlan({ recepcionId: 102, animales: 3, orden: 2, estado: "bloqueada", motivoBloqueo: "excede_animales" });
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera({ animales: 5 }), sedes: [sedePlan(), desborde], gastos: [], saldosAplicados: [], cambios: { animales: 8 },
  });
  assert.deepEqual(r.plan.liberadas, [102]);
  assert.equal(r.plan.restantes, 1);
});

test("plan: animales por debajo de lo consumido por sedes enviadas -> animales_insuficientes", () => {
  const enviada = sedePlan({ recepcionId: 102, animales: 6, orden: 2, estado: "enviada" });
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera(), sedes: [sedePlan(), enviada], gastos: [], saldosAplicados: [], cambios: { animales: 5 },
  });
  assert.deepEqual({ ok: r.ok, resultado: r.resultado }, { ok: false, resultado: "animales_insuficientes" });
});

test("plan: animales que no alcanzan para las sedes ya costeadas (sin enviar) -> excede_capacidad", () => {
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera(), sedes: [sedePlan({ animales: 4 }), sedePlan({ recepcionId: 102, animales: 4, orden: 2 })], gastos: [], saldosAplicados: [], cambios: { animales: 6 },
  });
  assert.deepEqual({ ok: r.ok, resultado: r.resultado }, { ok: false, resultado: "excede_capacidad" });
});

test("plan: un cambio que deja el servicio en cero se rechaza (servicio_cero)", () => {
  const r = Modelo.armarPlanRecalcular({
    cabecera: cabecera({ servicio_precorte: null }), sedes: [sedePlan()], gastos: [], saldosAplicados: [], cambios: { servicio_por_animal: "0" },
  });
  assert.deepEqual({ ok: r.ok, resultado: r.resultado }, { ok: false, resultado: "servicio_cero" });
});

test("plan: retomas solo para cerdo y valores inválidos se rechazan", () => {
  const res = Modelo.armarPlanRecalcular({
    cabecera: cabecera(), sedes: [], gastos: [], saldosAplicados: [], cambios: { retomas: [{ nombre: "Cabeza", kilos: 1, precio: 10 }] },
  });
  assert.deepEqual({ ok: res.ok, resultado: res.resultado }, { ok: false, resultado: "retomas_solo_cerdo" });
  const cerdo = Modelo.armarPlanRecalcular({
    cabecera: cabecera({ especie: "cerdo" }), sedes: [], gastos: [], saldosAplicados: [], cambios: { retomas: [{ nombre: "Cabeza", kilos: 1, precio: 10 }] },
  });
  assert.equal(cerdo.ok, true);
  assert.equal(cerdo.cambios.retomas.length, 1);
  const malo = Modelo.armarPlanRecalcular({
    cabecera: cabecera(), sedes: [], gastos: [], saldosAplicados: [], cambios: { animal_en_pie: "abc" },
  });
  assert.deepEqual({ ok: malo.ok, resultado: malo.resultado }, { ok: false, resultado: "datos_invalidos" });
});

// ─── Tabla de transiciones: una prueba por destino ─────────────────────────

const casos = [
  { nombre: "vinculada -> calculada", estado: "vinculada", extra: { gasto_sede: null, costeo_orden_version: null }, esperado: "calculada" },
  { nombre: "calculada -> calculada", estado: "calculada", esperado: "calculada" },
  { nombre: "error (cualquier tipo) -> calculada", estado: "error", extra: { error_tipo: "permanente", intentos: 3 }, esperado: "calculada" },
  { nombre: "lista_para_enviar -> lista_para_enviar", estado: "lista_para_enviar", esperado: "lista_para_enviar" },
  { nombre: "anulada -> lista_para_enviar", estado: "anulada", esperado: "lista_para_enviar" },
  { nombre: "simulada (SIESA apagado) -> simulada", estado: "simulada", esperado: "simulada" },
  { nombre: "simulada (SIESA encendido) -> calculada", estado: "simulada", opciones: { siesaActivo: true }, esperado: "calculada" },
  { nombre: "bloqueada(utilidad_negativa) corregida -> lista_para_enviar", estado: "bloqueada", extra: { motivo_bloqueo: "utilidad_negativa", gasto_sede: null }, esperado: "lista_para_enviar" },
  { nombre: "bloqueada(excede_animales) liberada -> lista_para_enviar", estado: "bloqueada", extra: { motivo_bloqueo: "excede_animales", liberada_at: "2026-11-24T05:00:00Z", gasto_sede: null }, esperado: "lista_para_enviar" },
  { nombre: "bloqueada(servicio_cero) -> calculada", estado: "bloqueada", extra: { motivo_bloqueo: "servicio_cero", gasto_sede: null }, esperado: "calculada" },
  { nombre: "bloqueada(armado_invalido) -> calculada", estado: "bloqueada", extra: { motivo_bloqueo: "armado_invalido", gasto_sede: null }, esperado: "calculada" },
  { nombre: "bloqueada(costeo_invalido) -> calculada", estado: "bloqueada", extra: { motivo_bloqueo: "costeo_invalido", gasto_sede: null }, esperado: "calculada" },
  { nombre: "calculada con utilidad negativa -> bloqueada(utilidad_negativa)", estado: "calculada", costoBase: "100", esperado: "bloqueada" },
  { nombre: "bloqueada(utilidad_negativa) que sigue negativa -> bloqueada", estado: "bloqueada", extra: { motivo_bloqueo: "utilidad_negativa", gasto_sede: null }, costoBase: "100", esperado: "bloqueada" },
];

for (const c of casos) {
  test(`recosteo: ${c.nombre}`, async () => {
    escenario({ estado: c.estado, extra: c.extra, costoBase: c.costoBase });
    await recalcular({}, null, c.opciones);
    const congelar = rpcDe("carnes_preliq_congelar_sede").filter((r) => r.args.p_sede_id === 11);
    assert.equal(congelar.length, 1);
    assert.equal(congelar[0].args.p_plan.desde, c.estado);
    assert.equal(congelar[0].args.p_plan.hacia, c.esperado);
    assert.equal(estadoDe(11), c.esperado);
  });
}

test("recosteo: una sede en desborde sin liberar sigue bloqueada y no se toca", async () => {
  escenario({ estado: "bloqueada", extra: { motivo_bloqueo: "excede_animales", liberada_at: null, gasto_sede: null }, cab: { animales: 8 } });
  const r = await recalcular({}, null);
  assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 0);
  assert.equal(estadoDe(11), "bloqueada");
  assert.equal(r.recosteo.find((x) => x.sede_id === 11), undefined);
});

// ─── Escenarios F ──────────────────────────────────────────────────────────

test("F-S1: antes de enviar, el recálculo recostea la sede sin ningún tráfico a SIESA", async () => {
  const r = await recalcular({ animal_en_pie: "2000000" }, "corrección de precio");
  assert.equal(r.resultado, "ok");
  const congelar = rpcDe("carnes_preliq_congelar_sede");
  assert.deepEqual(congelar.map((c) => c.args.p_sede_id), [11]);
  assert.deepEqual(rpcs.filter((x) => NOMBRES_DE_ENVIO.includes(x.nombre)), []);
});

test("F-S5: con animal_en_pie cambiado, la sede enviada queda marcada y se encola requiere_correccion", async () => {
  const r = await recalcular({ animal_en_pie: "2000000" }, "corrección de precio");
  assert.deepEqual(r.sedes_marcadas, [{ sede_id: 12, sede_version: 3 }]);
  const enviada = tablas.carnes_preliquidacion_sedes.find((s) => s.id === 12);
  assert.equal(enviada.requiere_correccion, true);
  assert.equal(enviada.correccion_orden_version, 6);
  const alerta = alertas.find((a) => a.evento === "requiere_correccion");
  assert.deepEqual({ p: alerta.preliquidacionId, s: alerta.sedeId, o: alerta.ocurrencia }, { p: 1, s: 12, o: 3 });
  // La enviada NO se recostea ni se le toca el monto.
  assert.equal(rpcDe("carnes_preliq_congelar_sede").filter((c) => c.args.p_sede_id === 12).length, 0);
  assert.equal(enviada.gasto_sede, "900000.00");
});

test("la RPC recibe versión, orden_version, cambios, plan y motivo; el recosteo usa la orden_version nueva", async () => {
  await recalcular({ animal_en_pie: "2000000" }, "motivo x");
  const [llamada] = rpcDe("carnes_preliq_recalcular_no_enviadas");
  assert.deepEqual(
    { id: llamada.args.p_id, version: llamada.args.p_version, ov: llamada.args.p_plan.orden_version, por: llamada.args.p_por, motivo: llamada.args.p_motivo },
    { id: 1, version: 3, ov: 5, por: "ana", motivo: "motivo x" },
  );
  assert.deepEqual(llamada.args.p_cambios, { animal_en_pie: "2000000" });
  assert.equal(llamada.args.p_plan.gasto_total, "2500000.00");
});

test("version_cambiada relee, recalcula el plan y reintenta (máx. 3)", async () => {
  let n = 0;
  manejadores.carnes_preliq_recalcular_no_enviadas = (a) => (++n < 2 ? { resultado: "version_cambiada" } : rpcRecalcular(a));
  const r = await recalcular({}, null);
  assert.equal(r.resultado, "ok");
  assert.equal(rpcDe("carnes_preliq_recalcular_no_enviadas").length, 2);

  rpcs = [];
  manejadores.carnes_preliq_recalcular_no_enviadas = () => ({ resultado: "version_cambiada" });
  await assert.rejects(() => recalcular({}, null), (e) => e.statusCode === 409 && e.codigo === "version_cambiada");
  assert.equal(rpcDe("carnes_preliq_recalcular_no_enviadas").length, 3);
});

test("preliquidación sin liquidar o no abierta: 409 y no se llama a la RPC", async () => {
  escenario({ estado: "calculada", cab: { liquidada_at: null } });
  await assert.rejects(() => recalcular({}, null), (e) => e.statusCode === 409 && e.codigo === "no_liquidada");
  escenario({ estado: "calculada", cab: { estado: "cerrada" } });
  await assert.rejects(() => recalcular({}, null), (e) => e.statusCode === 409 && e.codigo === "no_abierta");
  assert.equal(rpcDe("carnes_preliq_recalcular_no_enviadas").length, 0);
});

test("errores del plan puro salen como HTTP y sin tocar la base", async () => {
  await assert.rejects(() => recalcular({ animales: 5 }, "x"), (e) => e.statusCode === 409 && e.codigo === "animales_insuficientes");
  await assert.rejects(() => recalcular({ servicio_por_animal: "0" }, "x"), (e) => e.statusCode === 422 && e.codigo === "servicio_cero");
  assert.equal(rpcDe("carnes_preliq_recalcular_no_enviadas").length, 0);
});

test("motivo requerido con cambios: el código de la RPC llega como 422", async () => {
  manejadores.carnes_preliq_recalcular_no_enviadas = () => ({ resultado: "motivo_requerido" });
  await assert.rejects(() => recalcular({ animal_en_pie: "1" }, ""), (e) => e.statusCode === 422 && e.codigo === "motivo_requerido");
});

test("una sede que falla al recostear no detiene a las demás", async () => {
  escenario({ estado: "calculada" });
  // La segunda sede también queda sin enviar: una cae, la otra se recostea.
  Object.assign(tablas.carnes_preliquidacion_sedes[1], { estado: "lista_para_enviar" });
  manejadores.carnes_preliq_congelar_sede = (a) => {
    if (a.p_sede_id === 11) throw new Error("RPC caída");
    return rpcCongelar(a);
  };
  const r = await recalcular({}, null);
  assert.equal(r.resultado, "ok");
  assert.equal(r.recosteo.find((x) => x.sede_id === 11).recosteo, "error");
  assert.equal(r.recosteo.find((x) => x.sede_id === 12).recosteo, "lista_para_enviar");
});

test("el recálculo no envía nada: ninguna RPC de reclamo ni cierre de envío", async () => {
  for (const estado of ["calculada", "lista_para_enviar", "error", "simulada", "anulada"]) {
    rpcs = [];
    escenario({ estado });
    await recalcular({ animal_en_pie: "1500000" }, "x");
    assert.deepEqual(rpcs.filter((x) => NOMBRES_DE_ENVIO.includes(x.nombre)), [], estado);
  }
});
