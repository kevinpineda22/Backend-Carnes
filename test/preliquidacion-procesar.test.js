// procesarPreliquidacion: liquidar -> corregir/reevaluar -> congelar -> reclamar/enviar.
// Supabase falso con RPC que mutan las tablas; `procesarSede` se inyecta (sin SIESA).
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let rpcs = [];
let escrituras = [];
let manejadores = {}; // nombre -> (args) => respuesta (puede mutar tablas)

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  update() { escrituras.push({ tabla: this.t, op: "update" }); return this; }
  insert() { escrituras.push({ tabla: this.t, op: "insert" }); return this; }
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

// 2026-11-23 corte 21:30 Bogotá = 2026-11-24T02:30Z
const ANTES = new Date("2026-11-24T02:00:00.000Z");
const DESPUES = new Date("2026-11-24T03:00:00.000Z");

const cabecera = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", animales: 10, animal_en_pie: "1000000.00",
  servicio_precorte: null, servicio_por_animal: "50000.00", fecha_primer_ingreso: "2026-11-23",
  ventana_fin: "2026-11-25T04:59:59.999Z", liquidada_at: null, version: 3, orden_version: 5, ...extra,
});
const liquidada = (extra = {}) =>
  cabecera({
    liquidada_at: "2026-11-24T02:31:00.000Z", servicio_aplicado: "500000.00",
    gasto_total_aplicado: "1500000.00", costo_por_animal: "150000.00", ...extra,
  });
const sede = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "vinculada",
  motivo_bloqueo: null, liberada_at: null, version: 0, intentos: 0, gasto_sede: null,
  costeo_orden_version: null, costeo_animales: null, requiere_correccion: false, ...extra,
});
const recepcion = (id) => ({ id, especie: "res", estado: "Aprobado" });
const item = (id, recepcionId) => ({ id, recepcion_id: recepcionId, tipo: "carne", cantidad: "100", costo_base: "10000", descripcion: "x", orden: 1 });

let llamadas = [];
const procesarSedeFalso = async (s, ctx) => {
  llamadas.push({ sede: s, ctx });
  return { resultado: "enviada" };
};
const procesar = (extra = {}) =>
  Modelo.procesarPreliquidacion(1, {
    ahora: DESPUES, origen: "schedule", corridaId: 90, siesaActivo: true, procesarSede: procesarSedeFalso, ...extra,
  });
const rpcDe = (n) => rpcs.filter((r) => r.nombre === n);

// RPC falsas con efecto sobre las tablas
const rpcLiquidar = (a) => {
  const h = tablas.carnes_preliquidaciones[0];
  if (h.liquidada_at) return { resultado: "ya_liquidada" };
  Object.assign(h, {
    liquidada_at: DESPUES.toISOString(), orden_version: h.orden_version + 1,
    servicio_aplicado: a.p_plan.servicio_aplicado, gasto_total_aplicado: a.p_plan.gasto_total, costo_por_animal: a.p_plan.costo_por_animal,
  });
  return { resultado: "ok" };
};
const rpcCongelar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => x.id === a.p_sede_id);
  const h = tablas.carnes_preliquidaciones[0];
  Object.assign(s, {
    estado: a.p_plan.hacia, gasto_sede: a.p_plan.gasto_sede, costeo_orden_version: a.p_orden_version,
    costeo_animales: s.animales, version: s.version + 1, motivo_bloqueo: a.p_plan.motivo_bloqueo ?? null,
  });
  assert.equal(a.p_orden_version, h.orden_version);
  return { resultado: "ok" };
};
const rpcTransicionar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => x.id === a.p_sede_id);
  Object.assign(s, { estado: a.p_hacia, ...a.p_campos, version: s.version + 1 });
  return { resultado: "ok", sede_version: s.version };
};

beforeEach(() => {
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }), sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2 })],
    carnes_preliquidacion_gastos: [], carnes_preliquidacion_saldos: [], carnes_preliquidacion_retomas: [],
    carnes_recepciones: [recepcion(101), recepcion(102)],
    carnes_recepcion_items: [item(1, 101), item(2, 102)],
  };
  rpcs = []; escrituras = []; llamadas = [];
  manejadores = {
    carnes_preliq_liquidar: rpcLiquidar,
    carnes_preliq_congelar_sede: rpcCongelar,
    carnes_preliq_transicionar_sede: rpcTransicionar,
  };
});

test("D-S3: antes del corte no se liquida ni se escribe nada", async () => {
  const r = await procesar({ ahora: ANTES });
  assert.equal(r.resultado, "antes_del_corte");
  assert.equal(rpcs.length, 0);
  assert.equal(llamadas.length, 0);
});

test("D-S1: después del corte liquida UNA vez con el plan de gastoTotal y la versión leída", async () => {
  await procesar();
  const l = rpcDe("carnes_preliq_liquidar");
  assert.equal(l.length, 1);
  assert.equal(l[0].args.p_id, 1);
  assert.equal(l[0].args.p_version, 3);
  assert.equal(l[0].args.p_plan.gasto_total, "1500000.00");
  assert.deepEqual(l[0].args.p_plan.saldo_ids, []);
  assert.equal(new Date(l[0].args.p_corte).toISOString(), "2026-11-24T02:30:00.000Z");
});

test("congela cada sede con el monto de montoSedes y la orden_version posterior a liquidar", async () => {
  await procesar();
  const c = rpcDe("carnes_preliq_congelar_sede");
  assert.equal(c.length, 2);
  assert.equal(c[0].args.p_orden_version, 6);
  assert.equal(c[0].args.p_plan.desde, "vinculada");
  assert.equal(c[0].args.p_plan.hacia, "calculada");
  assert.equal(c[0].args.p_plan.gasto_sede, "600000.00");
  assert.equal(c[1].args.p_plan.gasto_sede, "900000.00");
  assert.equal(c[0].args.p_plan.recepcion_costeado, true);
  assert.ok(c[0].args.p_plan.items.length === 1 && c[0].args.p_plan.items[0].id === 1);
  assert.ok(c[0].args.p_plan.costeo && typeof c[0].args.p_plan.costeo === "object");
});

test("reclama solo con el costeo vigente: procesarSede recibe la sede ya congelada", async () => {
  await procesar();
  assert.equal(llamadas.length, 2);
  for (const { sede: s, ctx } of llamadas) {
    assert.equal(s.estado, "calculada");
    assert.equal(s.costeo_orden_version, 6);
    assert.equal(ctx.corridaId, 90);
    assert.equal(ctx.origen, "schedule");
    assert.equal(ctx.header.orden_version, 6);
  }
});

test("D-S4: segunda corrida sobre sedes ya enviadas no escribe ni envía", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  for (const s of tablas.carnes_preliquidacion_sedes) Object.assign(s, { estado: "enviada", gasto_sede: "1", costeo_orden_version: 6, costeo_animales: s.animales });
  const r = await procesar();
  assert.equal(rpcs.length, 0);
  assert.equal(llamadas.length, 0);
  assert.equal(r.pendientes, 0);
});

test("liquidada: usa el gasto congelado de la cabecera, no recalcula con saldos aplicados", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  await procesar();
  assert.equal(rpcDe("carnes_preliq_liquidar").length, 0);
  assert.equal(rpcDe("carnes_preliq_congelar_sede")[0].args.p_plan.gasto_sede, "600000.00");
});

test("la RPC responde antes_del_corte: no se sigue procesando", async () => {
  manejadores.carnes_preliq_liquidar = () => ({ resultado: "antes_del_corte" });
  const r = await procesar();
  assert.equal(r.resultado, "antes_del_corte");
  assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 0);
});

test("liquidar con version_cambiada: relee y reintenta hasta 3 veces, luego informa", async () => {
  manejadores.carnes_preliq_liquidar = () => ({ resultado: "version_cambiada" });
  const r = await procesar();
  assert.equal(rpcDe("carnes_preliq_liquidar").length, 3);
  assert.equal(r.resultado, "version_cambiada");
  assert.equal(llamadas.length, 0);
});

test("liquidar con version_cambiada una vez: reintenta con la cabecera releída y sigue", async () => {
  let n = 0;
  manejadores.carnes_preliq_liquidar = (a) => {
    n += 1;
    if (n === 1) { tablas.carnes_preliquidaciones[0].version = 4; return { resultado: "version_cambiada" }; }
    return rpcLiquidar(a);
  };
  await procesar();
  const l = rpcDe("carnes_preliq_liquidar");
  assert.deepEqual(l.map((x) => x.args.p_version), [3, 4]);
  assert.equal(llamadas.length, 2);
});

test("servicio_cero: no liquida, bloquea las sedes vinculadas y no envía", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ servicio_por_animal: "0" })];
  const r = await procesar();
  assert.equal(r.resultado, "servicio_cero");
  assert.equal(rpcDe("carnes_preliq_liquidar").length, 0);
  const t = rpcDe("carnes_preliq_transicionar_sede");
  assert.equal(t.length, 2);
  assert.equal(t[0].args.p_hacia, "bloqueada");
  assert.equal(t[0].args.p_campos.motivo_bloqueo, "servicio_cero");
  assert.equal(llamadas.length, 0);
});

test("I1: servicio_cero con las sedes ya bloqueadas no vuelve a escribir", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ servicio_por_animal: "0" })];
  for (const s of tablas.carnes_preliquidacion_sedes) Object.assign(s, { estado: "bloqueada", motivo_bloqueo: "servicio_cero" });
  const r = await procesar();
  assert.equal(r.resultado, "servicio_cero");
  assert.equal(rpcs.length, 0);
});

test("servicio_cero no toca sedes en desborde (bloqueada excede_animales)", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ servicio_por_animal: "0" })];
  Object.assign(tablas.carnes_preliquidacion_sedes[1], { estado: "bloqueada", motivo_bloqueo: "excede_animales" });
  await procesar();
  assert.deepEqual(rpcDe("carnes_preliq_transicionar_sede").map((r) => r.args.p_sede_id), [11]);
});

test("porCorregir: servicio_cero ya liquidada vuelve a vinculada y se costea en la misma corrida", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  Object.assign(tablas.carnes_preliquidacion_sedes[0], { estado: "bloqueada", motivo_bloqueo: "servicio_cero" });
  tablas.carnes_preliquidacion_sedes.pop();
  tablas.carnes_preliquidacion_sedes[0].animales = 10;
  tablas.carnes_recepcion_items[0].costo_base = "30000";
  await procesar();
  const t = rpcDe("carnes_preliq_transicionar_sede");
  assert.equal(t[0].args.p_desde, "bloqueada");
  assert.equal(t[0].args.p_hacia, "vinculada");
  assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 1);
  assert.equal(llamadas.length, 1);
});

test("D-S9 mixta: utilidad negativa bloquea una sede, la otra se envía, el desborde no se toca", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6, gasto_total_aplicado: "99999999.00" })];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1 }),
    sede({ id: 13, recepcion_id: 103, animales: 3, orden: 3, estado: "bloqueada", motivo_bloqueo: "excede_animales" }),
  ];
  tablas.carnes_recepciones.push(recepcion(103));
  const r = await procesar();
  const c = rpcDe("carnes_preliq_congelar_sede");
  assert.equal(c.length, 1);
  assert.equal(c[0].args.p_plan.hacia, "bloqueada");
  assert.equal(c[0].args.p_plan.motivo_bloqueo, "utilidad_negativa");
  assert.equal(llamadas.length, 0);
  assert.equal(r.bloqueadas, 1);
});

test("D-S10 falla parcial: una sede con error no impide procesar la otra y queda pendiente", async () => {
  let n = 0;
  const falla = async (s, ctx) => {
    llamadas.push({ sede: s, ctx });
    n += 1;
    if (n === 1) throw new Error("boom");
    return { resultado: "enviada" };
  };
  const r = await procesar({ procesarSede: falla, log: { warn() {}, error() {} } });
  assert.equal(llamadas.length, 2);
  assert.equal(r.errores, 1);
  assert.equal(r.enviadas, 1);
});

test("el resultado cuenta enviadas, simuladas y congeladas", async () => {
  const r = await procesar();
  assert.equal(r.resultado, "ok");
  assert.equal(r.congeladas, 2);
  assert.equal(r.enviadas, 2);
});

test("SIESA apagado: las sedes pasan por procesarSede (simulada) sin que la corrida llame a SIESA", async () => {
  await procesar({ siesaActivo: false });
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].ctx.siesaActivo, false);
});

test("presupuesto agotado: no sigue enviando y el resto queda en pendientes", async () => {
  let permitidas = 1;
  const r = await procesar({ hayPresupuesto: () => permitidas-- > 0 });
  assert.equal(llamadas.length, 1);
  assert.equal(r.agotado, true);
  assert.ok(r.pendientes >= 1);
});

test("dry run: calcula el resumen y no escribe ni envía", async () => {
  const r = await procesar({ dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal(rpcs.length, 0);
  assert.equal(escrituras.length, 0);
  assert.equal(llamadas.length, 0);
});

test("preliquidación que no está abierta no se procesa", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ estado: "cerrada" })];
  const r = await procesar();
  assert.equal(r.resultado, "no_abierta");
  assert.equal(rpcs.length, 0);
});

test("porReevaluar: si el costeo sigue bloqueado no escribe y la sede se anota como reevaluada", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6, gasto_total_aplicado: "99999999.00" })];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1, estado: "bloqueada", motivo_bloqueo: "costeo_invalido" }),
  ];
  const corrida = { id: 90, resumen: { reevaluadas: [] } };
  await procesar({ corrida });
  assert.equal(rpcs.length, 0);
  assert.deepEqual(corrida.resumen.reevaluadas, [11]);
});

test("armado_invalido se reevalúa una vez por corrida SOLO por el admin: vuelve a vinculada y se recosteo", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1, estado: "bloqueada", motivo_bloqueo: "armado_invalido" }),
  ];
  tablas.carnes_recepcion_items[0].costo_base = "30000";
  const corrida = { id: 90, resumen: { reevaluadas: [] } };
  await procesar({ corrida, origen: "admin" });
  assert.equal(rpcDe("carnes_preliq_transicionar_sede")[0].args.p_hacia, "vinculada");
  assert.deepEqual(corrida.resumen.reevaluadas, [11]);
  // segunda pasada en la misma corrida: ya no se reevalúa
  rpcs = [];
  tablas.carnes_preliquidacion_sedes[0].estado = "bloqueada";
  tablas.carnes_preliquidacion_sedes[0].motivo_bloqueo = "armado_invalido";
  await procesar({ corrida, origen: "admin" });
  assert.equal(rpcDe("carnes_preliq_transicionar_sede").length, 0);
});

test("JD S2: una corrida automática deja intacta la sede armado_invalido: sin transición, sin envío, sin alerta", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1, estado: "bloqueada", motivo_bloqueo: "armado_invalido" }),
  ];
  tablas.carnes_recepcion_items[0].costo_base = "30000"; // el costeo hipotético la desbloquearía
  const alertas = [];
  for (const origen of ["schedule", "sweep", "dispatch"]) {
    const corrida = { id: 90, resumen: { reevaluadas: [] } };
    const r = await procesar({ corrida, origen, encolar: async (a) => alertas.push(a) });
    assert.equal(rpcDe("carnes_preliq_transicionar_sede").length, 0, origen);
    assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 0, origen);
    assert.equal(llamadas.length, 0, origen);
    assert.equal(r.pendientes, 0, origen);
    assert.deepEqual(corrida.resumen.reevaluadas, [], origen);
  }
  assert.equal(alertas.length, 0);
  assert.equal(tablas.carnes_preliquidacion_sedes[0].estado, "bloqueada");
});

test("M1: un enviando abandonado se libera (transicionar) y se recosteo (congelar) antes de reclamar", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  tablas.carnes_preliquidacion_sedes = [
    sede({
      id: 11, recepcion_id: 101, animales: 10, orden: 1, estado: "enviando", envio_id: null,
      claimed_at: "2026-11-24T00:00:00.000Z", claim_token: "tok", gasto_sede: "1", costeo_orden_version: 5, costeo_animales: 10,
    }),
  ];
  await procesar();
  const t = rpcDe("carnes_preliq_transicionar_sede")[0].args;
  assert.equal(t.p_desde, "enviando");
  assert.equal(t.p_hacia, "calculada");
  assert.equal(t.p_campos.claim_token, null);
  assert.equal(rpcDe("carnes_preliq_congelar_sede")[0].args.p_plan.desde, "calculada");
  assert.equal(llamadas.length, 1);
});

test("version_cambiada al congelar: la sede se omite y la corrida sigue con las demás", async () => {
  let n = 0;
  manejadores.carnes_preliq_congelar_sede = (a) => (++n === 1 ? { resultado: "version_cambiada" } : rpcCongelar(a));
  const r = await procesar();
  assert.equal(r.congeladas, 1);
  assert.equal(llamadas.length, 1);
  assert.ok(r.pendientes >= 1);
});

test("el origen admin pasa el origen a procesarSede (reinicio de intentos lo decide procesarSede)", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  Object.assign(tablas.carnes_preliquidacion_sedes[0], { estado: "error", error_tipo: "permanente", intentos: 3, gasto_sede: "1", costeo_orden_version: 6, costeo_animales: 4 });
  tablas.carnes_preliquidacion_sedes.pop();
  await procesar({ origen: "admin" });
  assert.equal(llamadas[0].ctx.origen, "admin");
});

test("el resumen cuenta sin_confirmar e inicial_pendiente para el contrato del cron", async () => {
  let n = 0;
  const mixto = async (s, ctx) => {
    llamadas.push({ sede: s, ctx });
    n += 1;
    return { resultado: n === 1 ? "sin_confirmar" : "inicial_pendiente" };
  };
  const r = await procesar({ procesarSede: mixto });
  assert.equal(r.sin_confirmar, 1);
  assert.equal(r.inicial_pendiente, 1);
  assert.equal(r.enviadas, 0);
});

// ─── Camino inmediato (2.16): una sola sede ────────────────────────────────

test("soloSedeId: liquida y congela/envía únicamente esa sede", async () => {
  const r = await procesar({ soloSedeId: 12 });
  assert.equal(r.resultado, "ok");
  assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 1);
  assert.equal(rpcDe("carnes_preliq_congelar_sede")[0].args.p_sede_id, 12);
  assert.deepEqual(llamadas.map((l) => l.sede.id), [12]);
  assert.equal(r.enviadas, 1);
});

test("sin soloSedeId se siguen procesando todas las sedes (comportamiento previo)", async () => {
  await procesar();
  assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 2);
  assert.deepEqual(llamadas.map((l) => l.sede.id).sort(), [11, 12]);
});

test("leerSedeDeRecepcion devuelve la sede y su cabecera; null si la recepción no está vinculada", async () => {
  const hallada = await Modelo.leerSedeDeRecepcion(102);
  assert.equal(hallada.sede.id, 12);
  assert.equal(hallada.cabecera.id, 1);
  assert.equal(await Modelo.leerSedeDeRecepcion(999), null);
});

// ─── 2.18: efectos de procesarSede, detalle por sede y timeout dinámico ────

test("efecto intentar_autocierre: se ejecuta UNA vez tras el lote; avisar_anulacion no se repite (ya lo envía SiesaEnvio)", async () => {
  const cierres = [];
  const conEfectos = async (s, ctx) => {
    llamadas.push({ sede: s, ctx });
    return { resultado: "enviada", efectos: [{ tipo: "intentar_autocierre" }, { tipo: "avisar_anulacion" }] };
  };
  const r = await procesar({
    procesarSede: conEfectos,
    intentarAutocierre: async (id) => (cierres.push(id), { cerrada: true, monto_no_asignado: "0.00" }),
  });
  assert.deepEqual(cierres, [1]);
  assert.equal(r.cerrada, true);
});

test("sin efecto intentar_autocierre no se intenta cerrar", async () => {
  const cierres = [];
  const r = await procesar({ intentarAutocierre: async (id) => (cierres.push(id), { cerrada: true }) });
  assert.deepEqual(cierres, []);
  assert.equal(r.cerrada, false);
});

test("una falla del auto-cierre no tumba la corrida", async () => {
  const conEfecto = async () => ({ resultado: "enviada", efectos: [{ tipo: "intentar_autocierre" }] });
  const r = await procesar({
    procesarSede: conEfecto,
    intentarAutocierre: async () => { throw new Error("boom"); },
    log: { warn() {}, error() {} },
  });
  assert.equal(r.resultado, "ok");
  assert.equal(r.cerrada, false);
});

test("detalle por sede: resultado del recosteo y del envío", async () => {
  const r = await procesar();
  assert.deepEqual(
    r.sedes.map((s) => [s.sede_id, s.recosteo, s.envio]).sort(),
    [[11, "calculada", "enviada"], [12, "calculada", "enviada"]],
  );
});

test("M5: admin con SIESA apagado informa siesa_apagado por sede en vez de un Enviar sin resultado", async () => {
  tablas.carnes_preliquidaciones = [liquidada()];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, estado: "simulada", orden: 1, gasto_sede: "600000.00", costeo_orden_version: 5, costeo_animales: 4 }),
    sede({ id: 12, recepcion_id: 102, estado: "lista_para_enviar", orden: 2, gasto_sede: "900000.00", costeo_orden_version: 5, costeo_animales: 6, animales: 6 }),
  ];
  const r = await procesar({ origen: "admin", siesaActivo: false });
  assert.deepEqual(
    r.sedes.map((s) => [s.sede_id, s.codigo]).sort(),
    [[11, "siesa_apagado"], [12, "siesa_apagado"]],
  );
  assert.equal(r.enviadas, 0);
});

test("timeoutMs puede ser una función: se evalúa en cada envío", async () => {
  let n = 0;
  await procesar({ timeoutMs: () => 1000 + (n += 1) });
  assert.deepEqual(llamadas.map((l) => l.ctx.timeoutMs), [1001, 1002]);
});

test("no_reclamable de procesarSede se refleja como codigo en el detalle", async () => {
  const noReclama = async (s, ctx) => (llamadas.push({ sede: s, ctx }), { resultado: "no_reclamable", motivo: "inicial_pendiente" });
  const r = await procesar({ procesarSede: noReclama });
  assert.ok(r.sedes.every((s) => s.codigo === "inicial_pendiente"));
});

// ─── 2.19: escenarios de la spec sin cubrir antes ──────────────────────────

test("D-S2: servicio real cargado ANTES del corte (servicio_precorte) se usa; el tardío no", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ servicio_precorte: "700000.00" })];
  await procesar();
  assert.equal(rpcDe("carnes_preliq_liquidar")[0].args.p_plan.gasto_total, "1700000.00");

  rpcs = [];
  // Cargado a las 21:40: `servicio` queda guardado pero NO es precorte, así que la corrida usa el predeterminado.
  tablas.carnes_preliquidaciones = [cabecera({ servicio: "700000.00", servicio_at: "2026-11-24T02:40:00.000Z", servicio_precorte: null })];
  await procesar();
  assert.equal(rpcDe("carnes_preliq_liquidar")[0].args.p_plan.gasto_total, "1500000.00");
});

test("D-S11 (OPEN-4): una sede corregida que quedó en lista_para_enviar NO se envía sola; la envía el admin", async () => {
  tablas.carnes_preliquidaciones = [liquidada()];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, estado: "lista_para_enviar", gasto_sede: "600000.00", costeo_orden_version: 5, costeo_animales: 4 }),
  ];
  const r = await procesar({ origen: "schedule" });
  assert.equal(llamadas.length, 0);
  assert.equal(r.enviadas, 0);
  assert.equal(r.pendientes, 0, "una lista_para_enviar no cuenta como pendiente automático");
});

test("JD S2: registrarProgreso real no corrompe `reevaluadas` y la siguiente preliquidación de la corrida puede reevaluar", async () => {
  const Corridas = await import(url("models/PreliquidacionCorrida.model.js"));
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6, gasto_total_aplicado: "99999999.00" })];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1, estado: "bloqueada", motivo_bloqueo: "costeo_invalido" }),
  ];
  const corrida = { id: 90, preliquidacion_ids: [], resumen: { reevaluadas: [] } };
  const primero = await procesar({ corrida });
  assert.equal(typeof primero.reevaluadas, "number");
  await Corridas.registrarProgreso(corrida, { preliquidacionId: 1, resultado: primero });
  assert.deepEqual(corrida.resumen.reevaluadas, [11]);

  // Siguiente preliquidación de la misma corrida: otra sede reevaluable.
  tablas.carnes_preliquidacion_sedes.push(
    sede({ id: 13, recepcion_id: 101, animales: 10, orden: 3, estado: "bloqueada", motivo_bloqueo: "costeo_invalido" }),
  );
  await procesar({ corrida });
  assert.deepEqual(corrida.resumen.reevaluadas, [11, 13]);
});

test("JD S2: un enviando abandonado con intentos agotados pasa a error con reintentos_agotados y alerta, sin reclamar ni enviar", async () => {
  tablas.carnes_preliquidaciones = [liquidada({ orden_version: 6 })];
  tablas.carnes_preliquidacion_sedes = [
    sede({
      id: 11, recepcion_id: 101, animales: 10, orden: 1, estado: "enviando", envio_id: null, intentos: 3,
      claimed_at: "2026-11-24T00:00:00.000Z", claim_token: "tok", gasto_sede: "1", costeo_orden_version: 6, costeo_animales: 10,
    }),
  ];
  const alertas = [];
  await procesar({ encolar: async (a) => alertas.push(a) });
  const t = rpcDe("carnes_preliq_transicionar_sede");
  assert.equal(t.length, 1);
  assert.equal(t[0].args.p_desde, "enviando");
  assert.equal(t[0].args.p_hacia, "error");
  assert.equal(t[0].args.p_campos.motivo_pendiente, "reintentos_agotados");
  assert.equal(t[0].args.p_campos.claim_token, null);
  assert.deepEqual(alertas.map((a) => a.evento), ["reintentos_agotados"]);
  assert.equal(rpcDe("carnes_preliq_reclamar_sede").length, 0);
  assert.equal(llamadas.length, 0);
});


// ─── Vísceras (CEI): DESPUÉS de todas las oficiales, con presupuesto acotado ─

const PRESUPUESTO_CEI_MAX = 90_000;
const MINIMO_CEI = 35_000;

const conRegistro = (orden, { resultado = "enviada", extra = {} } = {}) => ({
  procesarSede: async (s) => {
    orden.push(`oficial:${s.id}`);
    return { resultado, sede_version: 9, ...extra };
  },
  enviarViscerasSede: async (s, ctx) => {
    orden.push(`cei:${s.id}`);
    orden.cei ??= [];
    orden.cei.push({ sede: s, ctx });
    return { estado: "ok" };
  },
});

test("CEI: las oficiales de TODAS las sedes terminan antes de mandar cualquier CEI", async () => {
  const orden = [];
  await procesar({ ...conRegistro(orden), restante: () => 200_000 });
  assert.deepEqual(orden.filter((x) => typeof x === "string"), ["oficial:11", "oficial:12", "cei:11", "cei:12"]);
});

test("CEI: el CEI de cada sede lleva su versión de cierre, la especie y un presupuesto acotado a 90 s", async () => {
  const orden = [];
  await procesar({ ...conRegistro(orden), restante: () => 200_000 });
  assert.equal(orden.cei.length, 2);
  for (const { ctx } of orden.cei) {
    assert.equal(ctx.especie, "res");
    assert.equal(ctx.sedeVersion, 9);
    assert.equal(ctx.restante(), PRESUPUESTO_CEI_MAX, "min(restante, 90 s)");
  }
});

test("CEI: con menos tiempo que el tope, el presupuesto es lo que queda", async () => {
  const orden = [];
  await procesar({ ...conRegistro(orden), restante: () => 60_000 });
  assert.equal(orden.cei[0].ctx.restante(), 60_000);
});

test("CEI: sin tiempo suficiente NO se arranca (sin_tiempo, lo toma el barrido) y las oficiales no se ven afectadas", async () => {
  const orden = [];
  const r = await procesar({ ...conRegistro(orden), restante: () => MINIMO_CEI - 1 });
  assert.deepEqual(orden.filter((x) => typeof x === "string"), ["oficial:11", "oficial:12"]);
  assert.equal(r.enviadas, 2);
  assert.deepEqual(r.visceras, { sin_tiempo: 2 });
  assert.equal(r.sedes.find((x) => x.sede_id === 11).visceras, "sin_tiempo");
});

test("CEI: el presupuesto se vuelve a medir antes de cada sede: cuando se acaba, las demás quedan sin_tiempo", async () => {
  const orden = [];
  const mediciones = [200_000, 20_000]; // una medición por CEI: la 1ª alcanza, la 2ª ya no
  let n = 0;
  const restante = () => mediciones[Math.min(n++, mediciones.length - 1)];
  const r = await procesar({ ...conRegistro(orden), restante });
  assert.equal(orden.cei.length, 1, "solo el primer CEI arrancó");
  assert.equal(r.visceras.ok, 1);
  assert.equal(r.visceras.sin_tiempo, 1);
});

test("CEI: solo las sedes que quedaron enviadas mandan CEI (error, sin_confirmar, simulada no)", async () => {
  for (const resultado of ["error_envio", "sin_confirmar", "simulada", "no_reclamable"]) {
    const orden = [];
    await procesar({ ...conRegistro(orden, { resultado }), restante: () => 200_000 });
    assert.equal(orden.cei ?? undefined, undefined, resultado);
  }
});

test("CEI: cerdo y SIESA apagado no mandan CEI", async () => {
  let orden = [];
  tablas.carnes_preliquidaciones = [cabecera({ especie: "cerdo" })];
  await procesar({ ...conRegistro(orden), restante: () => 200_000 });
  assert.equal(orden.cei, undefined);

  tablas.carnes_preliquidaciones = [cabecera()];
  orden = [];
  await procesar({ ...conRegistro(orden), restante: () => 200_000, siesaActivo: false });
  assert.equal(orden.cei, undefined);
});

test("CEI: va DESPUÉS del auto-cierre (cerrar la preliquidación no depende del CEI ni espera sus POST)", async () => {
  const orden = [];
  await procesar({
    ...conRegistro(orden, { extra: { efectos: [{ tipo: "intentar_autocierre" }] } }),
    restante: () => 200_000,
    intentarAutocierre: async () => { orden.push("autocierre"); return { cerrada: true }; },
  });
  assert.deepEqual(orden.filter((x) => typeof x === "string"), ["oficial:11", "oficial:12", "autocierre", "cei:11", "cei:12"]);
});

test("CEI: una excepción del envío del CEI no tumba la corrida ni las demás sedes", async () => {
  const orden = [];
  const r = await procesar({
    ...conRegistro(orden),
    restante: () => 200_000,
    enviarViscerasSede: async (s) => { orden.push(`cei:${s.id}`); if (s.id === 11) throw new Error("boom"); return { estado: "ok" }; },
    log: { error() {}, warn() {} },
  });
  assert.deepEqual(orden.filter((x) => typeof x === "string"), ["oficial:11", "oficial:12", "cei:11", "cei:12"]);
  assert.equal(r.enviadas, 2);
  assert.equal(r.visceras.error, 1);
  assert.equal(r.visceras.ok, 1);
});

test("CEI: sin `restante` propio se deriva del presupuesto: con presupuesto alcanza el mínimo, sin él no se manda", async () => {
  const orden = [];
  await procesar({ ...conRegistro(orden), hayPresupuesto: () => true });
  assert.equal(orden.cei.length, 2);
  assert.ok(orden.cei[0].ctx.restante() >= MINIMO_CEI);
});
