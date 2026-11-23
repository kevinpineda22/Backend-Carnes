// Servicio tardío: alterna informativa + saldo (E-S1, E-S2, D-S2), generada tras la liquidación (R6)
// o al cargar el servicio sobre una preliquidación ya liquidada. Nunca toca SIESA.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const Alterna = await import(url("models/PreliquidacionAlterna.model.js"));
const { requiereAlternaTardia } = await import(url("shared/preliquidacionAlterna.js"));

// Día D = 2026-11-23. Corte 21:30 Bogotá = 2026-11-24T02:30:00Z.
const A_LAS_2129 = "2026-11-24T02:29:00.000Z";
const A_LAS_2140 = "2026-11-24T02:40:00.000Z";
const DESPUES = new Date("2026-11-24T03:00:00.000Z");

const silencio = { info() {}, warn() {}, error() {} };

const cabecera = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", animales: 10, animal_en_pie: "9000000.00",
  servicio: null, servicio_at: null, servicio_precorte: null, servicio_precorte_at: null,
  servicio_por_animal: "50000.00", fecha_primer_ingreso: "2026-11-23", ventana_fin: "2026-11-25T04:59:59.999Z",
  liquidada_at: null, version: 3, orden_version: 5, ...extra,
});
const liquidada = (extra = {}) =>
  cabecera({
    liquidada_at: "2026-11-24T02:31:00.000Z", servicio_aplicado: "500000.00",
    gasto_total_aplicado: "9500000.00", costo_por_animal: "950000.00", ...extra,
  });
const sede = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "calculada",
  motivo_bloqueo: null, liberada_at: null, version: 1, intentos: 0, gasto_sede: "3800000.00",
  costeo_orden_version: 5, costeo_animales: 4, requiere_correccion: false, ...extra,
});
const sedes2 = () => [
  sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1, gasto_sede: "3800000.00" }),
  sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2, gasto_sede: "5700000.00" }),
];

// ─── Regla pura: ¿hay alterna tardía pendiente? ────────────────────────────

test("D-S2: el servicio cargado a las 21:29 es precorte (no hay alterna); a las 21:40 es tardío (sí)", () => {
  const base = { servicioAplicado: "500000.00", fechaPrimerIngreso: "2026-11-23", liquidadaAt: "2026-11-24T02:31:00Z" };
  // 21:29: la liquidación lo usó como real, así que aplicado = servicio.
  assert.equal(requiereAlternaTardia({ ...base, servicio: "700000", servicioAt: A_LAS_2129, servicioAplicado: "700000.00" }), false);
  // Aunque el aplicado sea distinto, un servicio cargado ANTES del corte no es tardío.
  assert.equal(requiereAlternaTardia({ ...base, servicio: "700000", servicioAt: A_LAS_2129 }), false);
  // 21:40: tardío con el aplicado por defecto.
  assert.equal(requiereAlternaTardia({ ...base, servicio: "700000", servicioAt: A_LAS_2140 }), true);
});

test("sin alterna: sin liquidar, sin servicio, o servicio igual al aplicado (E-S7, T3)", () => {
  const base = { servicio: "700000", servicioAt: A_LAS_2140, servicioAplicado: "500000.00", fechaPrimerIngreso: "2026-11-23", liquidadaAt: "2026-11-24T02:31:00Z" };
  assert.equal(requiereAlternaTardia({ ...base, liquidadaAt: null }), false);
  assert.equal(requiereAlternaTardia({ ...base, servicio: null }), false);
  assert.equal(requiereAlternaTardia({ ...base, servicioAplicado: "700000.00" }), false, "servicio_cero desbloqueado: aplicado = servicio");
  assert.equal(requiereAlternaTardia({ ...base, fechaPrimerIngreso: null }), false);
});

// ─── registrarAlterna con dependencias inyectadas ──────────────────────────

function armar({ cab = liquidada({ servicio: "700000.00", servicio_at: A_LAS_2140 }), sedes = sedes2(), saldos = [], abiertas = [], alterna = null, respuestas = [{ resultado: "ok", alterna_id: 77, saldo_id: 5 }] } = {}) {
  const reg = { rpcs: [], alertas: [], lecturas: 0 };
  const deps = {
    leer: async () => {
      reg.lecturas += 1;
      return { cabecera: cab, sedes, saldos, abiertas, alterna };
    },
    rpc: async (nombre, args) => {
      reg.rpcs.push({ nombre, args });
      return respuestas[Math.min(reg.rpcs.length - 1, respuestas.length - 1)];
    },
    encolar: async (a) => (reg.alertas.push(a), { ok: true }),
    log: silencio,
  };
  return { deps, reg };
}

test("E-S1: servicio real 700,000 contra 500,000 -> alterna +200,000, saldo nuevo hacia la siguiente de la especie, alerta servicio_tardio", async () => {
  const { deps, reg } = armar({ abiertas: [{ id: 20, especie: "res", estado: "abierta", liquidada_at: null, created_at: "2026-11-25T10:00:00Z" }] });
  const r = await Alterna.registrarAlterna(1, { ...deps, por: "ana" });
  assert.equal(r.resultado, "ok");
  assert.equal(reg.rpcs.length, 1);
  const { nombre, args } = reg.rpcs[0];
  assert.equal(nombre, "carnes_preliq_registrar_alterna");
  assert.deepEqual(
    { id: args.p_id, servicio: args.p_servicio, at: args.p_servicio_at, dif: args.p_diferencia },
    { id: 1, servicio: "700000.00", at: A_LAS_2140, dif: "200000.00" },
  );
  assert.deepEqual(args.p_por_sede.map((s) => [s.sede_id, s.diferencia]), [[11, "80000.00"], [12, "120000.00"]]);
  assert.deepEqual(args.p_saldo_plan, {
    accion: "crear_ajuste", valor: "200000.00", ajuste_de_saldo_id: null, destino_preliquidacion_id: 20, por: "ana",
  });
  assert.equal(reg.alertas.length, 1);
  assert.deepEqual(
    { e: reg.alertas[0].evento, p: reg.alertas[0].preliquidacionId, s: reg.alertas[0].sedeId, o: reg.alertas[0].ocurrencia },
    { e: "servicio_tardio", p: 1, s: 0, o: 77 },
  );
  assert.equal(r.alterna.diferencia, "200000.00");
  assert.equal(r.alterna.saldo.accion, "crear_ajuste");
});

test("E-S2: servicio real menor -> diferencia y saldo negativos", async () => {
  const { deps, reg } = armar({ cab: liquidada({ servicio: "400000.00", servicio_at: A_LAS_2140 }) });
  await Alterna.registrarAlterna(1, deps);
  assert.equal(reg.rpcs[0].args.p_diferencia, "-100000.00");
  assert.equal(reg.rpcs[0].args.p_saldo_plan.valor, "-100000.00");
});

test("un saldo pendiente del origen se actualiza en el lugar (no se crea otra fila)", async () => {
  const { deps, reg } = armar({ saldos: [{ id: 9, valor: "200000.00", estado: "pendiente", destino_preliquidacion_id: 20 }] });
  deps.leer = async () => ({ cabecera: liquidada({ servicio: "900000.00", servicio_at: A_LAS_2140 }), sedes: sedes2(), saldos: [{ id: 9, valor: "200000.00", estado: "pendiente", destino_preliquidacion_id: 20 }], abiertas: [], alterna: null });
  await Alterna.registrarAlterna(1, deps);
  assert.deepEqual(reg.rpcs[0].args.p_saldo_plan, { accion: "actualizar_pendiente", saldo_id: 9, valor: "400000.00", descartar: false, por: null });
});

test("un saldo aplicado no se toca: se pide un ajuste nuevo que lo referencia", async () => {
  const { deps, reg } = armar({ saldos: [{ id: 9, valor: "200000.00", estado: "aplicado", destino_preliquidacion_id: 20 }] });
  await Alterna.registrarAlterna(1, deps);
  // Diferencia 200,000 ya contabilizada en el aplicado: no hay nada que crear.
  assert.equal(reg.rpcs[0].args.p_saldo_plan.accion, "nada");
  const otra = armar({ cab: liquidada({ servicio: "800000.00", servicio_at: A_LAS_2140 }), saldos: [{ id: 9, valor: "200000.00", estado: "aplicado", destino_preliquidacion_id: 20 }] });
  await Alterna.registrarAlterna(1, otra.deps);
  assert.deepEqual(
    { a: otra.reg.rpcs[0].args.p_saldo_plan.accion, v: otra.reg.rpcs[0].args.p_saldo_plan.valor, aj: otra.reg.rpcs[0].args.p_saldo_plan.ajuste_de_saldo_id },
    { a: "crear_ajuste", v: "100000.00", aj: 9 },
  );
});

test("idempotencia: si ya existe la alterna de ese servicio no se llama a la RPC ni se alerta", async () => {
  const { deps, reg } = armar({ alterna: { id: 77 } });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "ya_registrada");
  assert.equal(reg.rpcs.length, 0);
  assert.equal(reg.alertas.length, 0);
});

test("idempotencia en la base: ya_registrada no alerta de nuevo", async () => {
  const { deps, reg } = armar({ respuestas: [{ resultado: "ya_registrada", alterna_id: 77 }] });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "ya_registrada");
  assert.equal(reg.alertas.length, 0);
});

test("sin diferencia (servicio igual al aplicado) no hay alterna ni RPC", async () => {
  const { deps, reg } = armar({ cab: liquidada({ servicio: "500000.00", servicio_at: A_LAS_2140 }) });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "sin_diferencia");
  assert.equal(reg.rpcs.length, 0);
});

test("servicio corregido hasta igualar el aplicado con un saldo pendiente previo: se descarta el saldo (no queda monto viejo)", async () => {
  const saldos = [{ id: 9, valor: "200000.00", estado: "pendiente", destino_preliquidacion_id: 20 }];
  const { deps, reg } = armar({ cab: liquidada({ servicio: "500000.00", servicio_at: A_LAS_2140 }), saldos });
  const r = await Alterna.registrarAlterna(1, { ...deps, por: "ana" });
  assert.equal(r.resultado, "ok");
  assert.equal(reg.rpcs.length, 1);
  const { args } = reg.rpcs[0];
  assert.equal(args.p_diferencia, "0.00");
  assert.deepEqual(args.p_saldo_plan, { accion: "actualizar_pendiente", saldo_id: 9, valor: "0.00", descartar: true, por: "ana" });
  assert.equal(r.alterna.diferencia, "0.00");
});

test("servicio corregido hasta igualar el aplicado con un saldo ya aplicado: ajuste que lo revierte", async () => {
  const saldos = [{ id: 9, valor: "200000.00", estado: "aplicado", destino_preliquidacion_id: 20 }];
  const { deps, reg } = armar({ cab: liquidada({ servicio: "500000.00", servicio_at: A_LAS_2140 }), saldos });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "ok");
  assert.deepEqual(
    { a: reg.rpcs[0].args.p_saldo_plan.accion, v: reg.rpcs[0].args.p_saldo_plan.valor, aj: reg.rpcs[0].args.p_saldo_plan.ajuste_de_saldo_id },
    { a: "crear_ajuste", v: "-200000.00", aj: 9 },
  );
});

test("sin diferencia y con saldos que ya valen cero o están descartados: no hay nada que corregir", async () => {
  const saldos = [{ id: 9, valor: "0.00", estado: "pendiente" }, { id: 8, valor: "100000.00", estado: "descartado" }];
  const { deps, reg } = armar({ cab: liquidada({ servicio: "500000.00", servicio_at: A_LAS_2140 }), saldos });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "sin_diferencia");
  assert.equal(reg.rpcs.length, 0);
});

test("sin liquidar no se registra alterna", async () => {
  const { deps, reg } = armar({ cab: cabecera({ servicio: "700000.00", servicio_at: A_LAS_2140 }) });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "no_liquidada");
  assert.equal(reg.rpcs.length, 0);
});

test("version_cambiada relee y reintenta; a la tercera se rinde sin lanzar", async () => {
  const { deps, reg } = armar({ respuestas: [{ resultado: "version_cambiada" }, { resultado: "ok", alterna_id: 3 }] });
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "ok");
  assert.equal(reg.lecturas, 2);

  const agotado = armar({ respuestas: [{ resultado: "version_cambiada" }] });
  const r2 = await Alterna.registrarAlterna(1, agotado.deps);
  assert.equal(r2.resultado, "version_cambiada");
  assert.equal(agotado.reg.rpcs.length, 3);
});

test("destino_invalido (el destino se liquidó o cerró entre la lectura y la RPC) relee y replanea con otro destino", async () => {
  const abiertas = [
    { id: 20, especie: "res", estado: "abierta", liquidada_at: null, created_at: "2026-11-25T10:00:00Z" },
    { id: 21, especie: "res", estado: "abierta", liquidada_at: null, created_at: "2026-11-26T10:00:00Z" },
  ];
  const { deps, reg } = armar({ abiertas, respuestas: [{ resultado: "destino_invalido" }, { resultado: "ok", alterna_id: 3 }] });
  let lectura = 0;
  deps.leer = async () => {
    lectura += 1;
    return { cabecera: liquidada({ servicio: "700000.00", servicio_at: A_LAS_2140 }), sedes: sedes2(), saldos: [], abiertas: lectura === 1 ? abiertas : abiertas.slice(1), alterna: null };
  };
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "ok");
  assert.deepEqual(reg.rpcs.map((x) => x.args.p_saldo_plan.destino_preliquidacion_id), [20, 21]);

  const agotado = armar({ respuestas: [{ resultado: "destino_invalido" }] });
  const r2 = await Alterna.registrarAlterna(1, agotado.deps);
  assert.equal(r2.resultado, "destino_invalido");
  assert.equal(agotado.reg.rpcs.length, 3);
});

test("una alerta que falla no deshace la alterna", async () => {
  const { deps } = armar();
  deps.encolar = async () => { throw new Error("correo caído"); };
  const r = await Alterna.registrarAlterna(1, deps);
  assert.equal(r.resultado, "ok");
});

test("registrarAlternaTardia nunca lanza y no hace nada si no hay alterna pendiente", async () => {
  const { deps, reg } = armar({ cab: liquidada({ servicio: "700000.00", servicio_at: A_LAS_2129 }) });
  assert.equal(await Alterna.registrarAlternaTardia(liquidada({ servicio: "700000.00", servicio_at: A_LAS_2129 }), deps), null);
  assert.equal(reg.rpcs.length, 0);

  const roto = armar();
  roto.deps.leer = async () => { throw new Error("base caída"); };
  const r = await Alterna.registrarAlternaTardia(liquidada({ servicio: "700000.00", servicio_at: A_LAS_2140 }), roto.deps);
  assert.equal(r.resultado, "error");
});

test("el módulo de la alterna no conoce SIESA (nada se envía por un servicio tardío)", () => {
  for (const archivo of ["models/PreliquidacionAlterna.model.js", "shared/preliquidacionAlterna.js"]) {
    const fuente = readFileSync(new URL(`../src/${archivo}`, import.meta.url), "utf8");
    const imports = fuente.split("\n").filter((l) => l.trimStart().startsWith("import ")).join("\n");
    assert.doesNotMatch(imports, /siesa/i, archivo);
  }
});

// ─── Integración con el modelo (supabase falso) ────────────────────────────

const rpcDe = (n) => rpcs.filter((r) => r.nombre === n);
const NOMBRES_DE_ENVIO = ["carnes_preliq_reclamar_sede", "carnes_preliq_cerrar_envio", "carnes_preliq_sincronizar_envio"];

const rpcLiquidar = (a) => {
  const h = tablas.carnes_preliquidaciones[0];
  Object.assign(h, {
    liquidada_at: DESPUES.toISOString(), orden_version: h.orden_version + 1,
    servicio_aplicado: a.p_plan.servicio_aplicado, gasto_total_aplicado: a.p_plan.gasto_total, costo_por_animal: a.p_plan.costo_por_animal,
  });
  return { resultado: "ok" };
};
const rpcCongelar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => x.id === a.p_sede_id);
  Object.assign(s, { estado: a.p_plan.hacia, gasto_sede: a.p_plan.gasto_sede, costeo_orden_version: a.p_orden_version, costeo_animales: s.animales, version: s.version + 1 });
  return { resultado: "ok" };
};
const rpcRegistrar = (a) => {
  const fila = { id: 500 + tablas.carnes_preliquidacion_alternas.length, preliquidacion_id: a.p_id, servicio_at: a.p_servicio_at };
  tablas.carnes_preliquidacion_alternas.push(fila);
  return { resultado: "ok", alterna_id: fila.id, saldo_accion: a.p_saldo_plan.accion };
};

const sedeVinculada = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "vinculada", motivo_bloqueo: null,
  liberada_at: null, version: 0, intentos: 0, gasto_sede: null, costeo_orden_version: null, costeo_animales: null,
  requiere_correccion: false, ...extra,
});

beforeEach(() => {
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [sedeVinculada({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }), sedeVinculada({ id: 12, recepcion_id: 102, animales: 6, orden: 2 })],
    carnes_preliquidacion_gastos: [], carnes_preliquidacion_saldos: [], carnes_preliquidacion_retomas: [],
    carnes_preliquidacion_alternas: [],
    carnes_recepciones: [{ id: 101, especie: "res", estado: "Aprobado" }, { id: 102, especie: "res", estado: "Aprobado" }],
    carnes_recepcion_items: [
      { id: 1, recepcion_id: 101, tipo: "carne", cantidad: "100", costo_base: "1000000", descripcion: "x", orden: 1 },
      { id: 2, recepcion_id: 102, tipo: "carne", cantidad: "100", costo_base: "1000000", descripcion: "x", orden: 1 },
    ],
  };
  rpcs = [];
  manejadores = {
    carnes_preliq_liquidar: rpcLiquidar,
    carnes_preliq_congelar_sede: rpcCongelar,
    carnes_preliq_registrar_alterna: rpcRegistrar,
  };
});

const procesar = (extra = {}) =>
  Modelo.procesarPreliquidacion(1, {
    ahora: DESPUES, origen: "schedule", corridaId: 90, siesaActivo: false, log: silencio,
    encolar: async () => ({ ok: true }), ...extra,
  });

test("servicio tardío ANTES de liquidar: la alerta se genera tras la liquidación, con cero sedes enviadas", async () => {
  Object.assign(tablas.carnes_preliquidaciones[0], { servicio: "700000.00", servicio_at: A_LAS_2140 });
  await procesar();
  const registros = rpcDe("carnes_preliq_registrar_alterna");
  assert.equal(registros.length, 1);
  assert.equal(registros[0].args.p_diferencia, "200000.00");
  // Se registra después de costear las sedes (así hay montos congelados que comparar).
  const orden = rpcs.map((r) => r.nombre);
  assert.ok(orden.lastIndexOf("carnes_preliq_congelar_sede") < orden.indexOf("carnes_preliq_registrar_alterna"));
  assert.equal(registros[0].args.p_por_sede.length, 2);
  // Nada se envía a SIESA por ello.
  assert.deepEqual(rpcs.filter((r) => NOMBRES_DE_ENVIO.includes(r.nombre)), []);
});

test("una segunda corrida no duplica la alterna", async () => {
  Object.assign(tablas.carnes_preliquidaciones[0], { servicio: "700000.00", servicio_at: A_LAS_2140 });
  await procesar();
  await procesar();
  assert.equal(rpcDe("carnes_preliq_registrar_alterna").length, 1);
});

test("servicio cargado antes del corte: no hay alterna", async () => {
  Object.assign(tablas.carnes_preliquidaciones[0], { servicio: "700000.00", servicio_at: A_LAS_2129, servicio_precorte: "700000.00", servicio_precorte_at: A_LAS_2129 });
  await procesar();
  assert.equal(rpcDe("carnes_preliq_registrar_alterna").length, 0);
});

test("T3: el servicio tardío que desbloqueó servicio_cero quedó como precorte -> sin alterna", async () => {
  // Predeterminado 0: el servicio tardío se guardó como precorte y es el aplicado.
  Object.assign(tablas.carnes_preliquidaciones[0], {
    servicio_por_animal: "0.00", servicio: "700000.00", servicio_at: A_LAS_2140, servicio_precorte: "700000.00", servicio_precorte_at: A_LAS_2140,
  });
  await procesar();
  assert.equal(rpcDe("carnes_preliq_registrar_alterna").length, 0);
});

test("una falla al registrar la alterna no detiene la corrida", async () => {
  Object.assign(tablas.carnes_preliquidaciones[0], { servicio: "700000.00", servicio_at: A_LAS_2140 });
  manejadores.carnes_preliq_registrar_alterna = () => { throw new Error("RPC caída"); };
  const r = await procesar();
  assert.equal(r.liquidada, true);
  assert.ok(r.congeladas >= 1);
});

test("PATCH servicio con la preliquidación liquidada: responde alterna y aviso, y no envía nada a SIESA", async () => {
  tablas.carnes_preliquidaciones = [liquidada()];
  tablas.carnes_preliquidacion_sedes = [
    sedeVinculada({ id: 11, recepcion_id: 101, animales: 4, orden: 1, estado: "calculada", gasto_sede: "3800000.00" }),
    sedeVinculada({ id: 12, recepcion_id: 102, animales: 6, orden: 2, estado: "calculada", gasto_sede: "5700000.00" }),
  ];
  manejadores.carnes_preliq_actualizar_servicio = (a) => {
    Object.assign(tablas.carnes_preliquidaciones[0], { servicio: String(a.p_servicio), servicio_at: A_LAS_2140 });
    return { resultado: "tardio", congelada: true, desbloqueo: false };
  };
  const r = await Modelo.actualizar(1, { servicio: 700000 }, { por: "ana", log: silencio, encolar: async () => ({ ok: true }) });
  assert.equal(r.resultado, "tardio");
  assert.equal(r.aviso.codigo, "servicio_tardio");
  assert.equal(r.alterna.diferencia, "200000.00");
  assert.equal(rpcDe("carnes_preliq_registrar_alterna").length, 1);
  assert.deepEqual(rpcs.filter((x) => NOMBRES_DE_ENVIO.includes(x.nombre)), []);
});

test("PATCH servicio tardío antes de liquidar: solo aviso (la alterna sale tras la liquidación)", async () => {
  manejadores.carnes_preliq_actualizar_servicio = () => ({ resultado: "tardio", congelada: false, desbloqueo: false });
  const r = await Modelo.actualizar(1, { servicio: 700000 }, { log: silencio, encolar: async () => ({ ok: true }) });
  assert.equal(r.resultado, "tardio");
  assert.equal(r.aviso.codigo, "servicio_tardio");
  assert.equal(r.alterna ?? null, null);
  assert.equal(rpcDe("carnes_preliq_registrar_alterna").length, 0);
});

test("PATCH servicio que desbloquea servicio_cero (tardío): aviso sin alterna", async () => {
  manejadores.carnes_preliq_actualizar_servicio = () => ({ resultado: "tardio", congelada: false, desbloqueo: true });
  const r = await Modelo.actualizar(1, { servicio: 700000 }, { log: silencio, encolar: async () => ({ ok: true }) });
  assert.equal(r.alterna ?? null, null);
  assert.equal(rpcDe("carnes_preliq_registrar_alterna").length, 0);
});

test("PATCH servicio a tiempo no trae aviso ni alterna", async () => {
  manejadores.carnes_preliq_actualizar_servicio = () => ({ resultado: "ok", congelada: false, desbloqueo: false });
  const r = await Modelo.actualizar(1, { servicio: 700000 }, { log: silencio });
  assert.equal(r.aviso ?? null, null);
  assert.equal(r.alterna ?? null, null);
});

test("si registrar la alterna falla, el PATCH igual responde (se reintenta en la próxima corrida)", async () => {
  tablas.carnes_preliquidaciones = [liquidada()];
  manejadores.carnes_preliq_actualizar_servicio = (a) => {
    Object.assign(tablas.carnes_preliquidaciones[0], { servicio: String(a.p_servicio), servicio_at: A_LAS_2140 });
    return { resultado: "tardio", congelada: true, desbloqueo: false };
  };
  manejadores.carnes_preliq_registrar_alterna = () => { throw new Error("RPC caída"); };
  const r = await Modelo.actualizar(1, { servicio: 700000 }, { log: silencio, encolar: async () => ({ ok: true }) });
  assert.equal(r.resultado, "tardio");
  assert.equal(r.alterna ?? null, null);
  assert.equal(r.aviso.codigo, "servicio_tardio");
});
