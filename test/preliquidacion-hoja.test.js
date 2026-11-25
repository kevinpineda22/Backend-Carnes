// Hoja de costeo de una sede (GET /preliquidaciones/:id/sedes/:sedeId/hoja): corte por corte,
// en vivo antes de liquidar y congelada después. La hoja en vivo usa el MISMO camino de cálculo
// que la liquidación (`calcular` -> `costearSede`), así que debe coincidir con lo que se congela.
// Supabase falso con RPC que mutan las tablas. Sin red ni base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let rpcs = [];
let escrituras = [];
let manejadores = {};
let erroresTabla = {};

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
  then(res, rej) {
    if (erroresTabla[this.t]) return Promise.resolve({ data: null, error: { message: erroresTabla[this.t] } }).then(res, rej);
    return Promise.resolve({ data: this.filas(), error: null }).then(res, rej);
  }
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

const DESPUES = new Date("2026-11-24T03:00:00.000Z"); // después del corte de las 21:30 Bogotá

const cabecera = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", animales: 10, animal_en_pie: "1000000.00",
  servicio_precorte: null, servicio_por_animal: "50000.00", fecha_primer_ingreso: "2026-11-23",
  ventana_fin: "2026-11-25T04:59:59.999Z", liquidada_at: null, version: 3, orden_version: 5, ...extra,
});
const sede = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "vinculada",
  motivo_bloqueo: null, detalle_bloqueo: null, liberada_at: null, version: 0, intentos: 0, gasto_sede: null,
  costeo_orden_version: null, costeo_animales: null, requiere_correccion: false, ...extra,
});
const recepcion = (id, extra = {}) => ({ id, especie: "res", estado: "Aprobado", sede_id: 5, ...extra });
const corte = (id, recepcionId, orden, extra = {}) => ({
  id, recepcion_id: recepcionId, tipo: "carne", cantidad: "100", costo_base: "10000",
  descripcion: `Corte ${id}`, codigo_item: `C${id}`, orden, costo_ajustado: null, costo_total: null, ...extra,
});

// RPC falsas con efecto sobre las tablas (lo que hace plpgsql al congelar)
const rpcLiquidar = (a) => {
  const h = tablas.carnes_preliquidaciones[0];
  if (h.liquidada_at) return { resultado: "ya_liquidada" };
  Object.assign(h, {
    liquidada_at: DESPUES.toISOString(), orden_version: h.orden_version + 1,
    servicio_aplicado: a.p_plan.servicio_aplicado, gasto_total_aplicado: a.p_plan.gasto_total,
    costo_por_animal: a.p_plan.costo_por_animal,
  });
  return { resultado: "ok" };
};
const rpcCongelar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => x.id === a.p_sede_id);
  const { gasto_sede, utilidad, servicio_compra, valor_viceras, valor_retomas, costeo, items } = a.p_plan;
  Object.assign(s, {
    estado: a.p_plan.hacia, gasto_sede, utilidad, servicio_compra, valor_viceras, valor_retomas, costeo,
    costeo_orden_version: a.p_orden_version, costeo_animales: s.animales, version: s.version + 1,
    motivo_bloqueo: a.p_plan.motivo_bloqueo ?? null, detalle_bloqueo: a.p_plan.detalle_bloqueo ?? null,
  });
  for (const i of items) {
    Object.assign(tablas.carnes_recepcion_items.find((x) => x.id === i.id), {
      costo_ajustado: i.costo_ajustado, costo_total: i.costo_total,
    });
  }
  return { resultado: "ok" };
};
const rpcTransicionar = (a) => {
  const s = tablas.carnes_preliquidacion_sedes.find((x) => x.id === a.p_sede_id);
  Object.assign(s, { estado: a.p_hacia, ...a.p_campos, version: s.version + 1 });
  return { resultado: "ok", sede_version: s.version };
};

const liquidarAhora = () =>
  Modelo.procesarPreliquidacion(1, {
    ahora: DESPUES, origen: "schedule", corridaId: 90, siesaActivo: false,
    procesarSede: async () => ({ resultado: "sin_envio" }),
  });
const rpcDe = (n) => rpcs.filter((r) => r.nombre === n);

beforeEach(() => {
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [
      sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }),
      sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2 }),
    ],
    carnes_preliquidacion_gastos: [{ id: 1, preliquidacion_id: 1, concepto: "Flete", valor: "100000.00", signo: 1, orden: 1 }],
    carnes_preliquidacion_saldos: [],
    carnes_preliquidacion_retomas: [],
    carnes_sedes: [{ id: 5, nombre: "Sede Norte" }],
    carnes_recepciones: [recepcion(101), recepcion(102)],
    carnes_recepcion_items: [
      corte(1, 101, 1, { cantidad: "60", costo_base: "12000" }),
      corte(2, 101, 2, { cantidad: "40.5", costo_base: "9000", tipo: "adicional" }),
      corte(3, 101, 3, { tipo: "vicera", cantidad: "10", costo_base: "5000", descripcion: "Hígado" }),
      corte(4, 102, 1, { cantidad: "150", costo_base: "10000" }),
    ],
  };
  rpcs = []; escrituras = []; erroresTabla = {};
  manejadores = {
    carnes_preliq_liquidar: rpcLiquidar,
    carnes_preliq_congelar_sede: rpcCongelar,
    carnes_preliq_transicionar_sede: rpcTransicionar,
  };
});

const falla = async (fn, estado) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.statusCode, estado, `status ${e.statusCode} (${e.message})`);
    return true;
  });
};

const CLAVES = [
  "preliquidacion_id", "sede_row_id", "sede_id", "sede_nombre", "recepcion_id", "especie", "estado", "congelada",
  "animales", "gasto_sede", "utilidad", "utilidad_final", "servicio_compra", "valor_viceras", "valor_retomas",
  "costo_teorico", "costo_real", "factor", "cortes", "totales", "bloqueos", "advertencias", "costeo_previo_obsoleto",
];

test("hoja en vivo: tiene la forma acordada y no escribe nada", async () => {
  const h = await Modelo.hojaSede(1, 11);
  assert.deepEqual(Object.keys(h).sort(), [...CLAVES].sort());
  assert.equal(h.preliquidacion_id, 1);
  assert.equal(h.sede_row_id, 11);
  assert.equal(h.recepcion_id, 101);
  assert.equal(h.sede_id, 5);
  assert.equal(h.sede_nombre, "Sede Norte");
  assert.equal(h.especie, "res");
  assert.equal(h.estado, "vinculada");
  assert.equal(h.congelada, false);
  assert.equal(h.animales, 4);
  for (const c of ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas"]) {
    assert.match(h[c], /^-?\d+\.\d{2}$/, c);
  }
  assert.equal(h.valor_viceras, "50000.00");
  assert.equal(typeof h.factor, "number");
  assert.deepEqual(h.bloqueos, []);
  assert.ok(Array.isArray(h.advertencias));
  // Solo los cortes de producto (carne/adicional), en el orden de la recepción; la vícera no es un corte.
  assert.deepEqual(h.cortes.map((c) => c.item_id), [1, 2]);
  assert.deepEqual(Object.keys(h.cortes[0]).sort(), [
    "cantidad", "codigo_item", "costo_ajustado", "costo_base", "costo_total", "descripcion", "item_id", "tipo",
  ]);
  assert.equal(h.cortes[0].cantidad, 60);
  assert.equal(h.cortes[0].costo_base, 12000);
  assert.equal(h.cortes[1].tipo, "adicional");
  assert.equal(escrituras.length, 0);
  assert.equal(rpcs.length, 0);
});

test("hoja en vivo = lo que congela la liquidación (multi-sede con vísceras): mismos montos, factor y cortes", async () => {
  const vivas = [await Modelo.hojaSede(1, 11), await Modelo.hojaSede(1, 12)];
  assert.ok(vivas.every((h) => h.congelada === false));

  await liquidarAhora();
  const congelados = rpcDe("carnes_preliq_congelar_sede");
  assert.equal(congelados.length, 2);

  for (const [i, h] of vivas.entries()) {
    const plan = congelados[i].args.p_plan;
    assert.equal(h.gasto_sede, plan.gasto_sede);
    assert.equal(h.utilidad, plan.utilidad);
    assert.equal(h.servicio_compra, plan.servicio_compra);
    assert.equal(h.valor_viceras, plan.valor_viceras);
    assert.equal(h.valor_retomas, plan.valor_retomas);
    assert.equal(h.costo_teorico, plan.costeo.costoTeorico);
    assert.equal(h.costo_real, plan.costeo.costoReal);
    assert.equal(h.factor, plan.costeo.factor);
    assert.deepEqual(
      h.cortes.map((c) => [c.item_id, c.costo_ajustado, c.costo_total]),
      plan.items.map((x) => [x.id, x.costo_ajustado, x.costo_total]),
    );
  }
  // costo real = gasto de sede + servicio de compra - vísceras (sede 11: 640000 + utilidad/2 - 50000).
  assert.equal(vivas[0].gasto_sede, "640000.00");
  assert.ok(vivas[0].costo_real < Number(vivas[0].gasto_sede) + Number(vivas[0].servicio_compra));
});

test("hoja congelada (tras liquidar) devuelve lo guardado y coincide con la hoja en vivo previa", async () => {
  const viva = await Modelo.hojaSede(1, 11);
  await liquidarAhora();
  const fria = await Modelo.hojaSede(1, 11);
  assert.equal(fria.congelada, true);
  assert.notEqual(fria.estado, "vinculada");
  assert.deepEqual({ ...fria, congelada: undefined, estado: undefined }, { ...viva, congelada: undefined, estado: undefined });
});

test("hoja congelada: devuelve los valores guardados sin recalcular", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "enviada", gasto_sede: "123.45", utilidad: "10.00", servicio_compra: "5.00",
    valor_viceras: "0.00", valor_retomas: "0.00",
    costeo: { costoTeorico: 999, costoReal: 5.5, factor: 0.25, cantidadTotal: 3, totalCosteado: 5.5, advertencias: [{ codigo: "factor_alto", mensaje: "alto" }] },
  });
  tablas.carnes_recepcion_items[0] = corte(1, 101, 1, { costo_ajustado: "7.1234", costo_total: "7.12" });
  tablas.carnes_recepcion_items[1] = corte(2, 101, 2, { costo_ajustado: "1.5", costo_total: "60.75" });
  // Si recalculara, el servicio en cero lo bloquearía: lo congelado no se vuelve a calcular.
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "0";

  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, true);
  assert.equal(h.estado, "enviada");
  assert.equal(h.gasto_sede, "123.45");
  assert.equal(h.utilidad, "10.00");
  assert.equal(h.servicio_compra, "5.00");
  assert.equal(h.costo_teorico, 999);
  assert.equal(h.costo_real, 5.5);
  assert.equal(h.factor, 0.25);
  assert.deepEqual(h.cortes.map((c) => [c.costo_ajustado, c.costo_total]), [[7.1234, 7.12], [1.5, 60.75]]);
  assert.deepEqual(h.advertencias, [{ codigo: "factor_alto", mensaje: "alto" }]);
  assert.equal(h.totales.costo_total, 67.87);
  assert.equal(escrituras.length, 0);
});

test("hoja: totales suman cantidad, costo teórico y costo total de los cortes", async () => {
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.totales.cantidad, 100.5);
  // 60 x 12000 + 40.5 x 9000
  assert.equal(h.totales.costo_teorico, 1084500);
  assert.equal(h.totales.costo_teorico, h.costo_teorico);
  const suma = Math.round(h.cortes.reduce((a, c) => a + c.costo_total, 0) * 100) / 100;
  assert.equal(h.totales.costo_total, suma);
});

test("hoja: la sede de otra preliquidación o inexistente es 404", async () => {
  tablas.carnes_preliquidacion_sedes.push(sede({ id: 77, preliquidacion_id: 2, recepcion_id: 103 }));
  await falla(() => Modelo.hojaSede(1, 77), 404);
  await falla(() => Modelo.hojaSede(1, 999), 404);
  await falla(() => Modelo.hojaSede(99, 11), 404);
});

test("hoja de una sede bloqueada por desborde: cortes con cantidad y costo base, costos nulos y el bloqueo", async () => {
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 3, orden: 2, estado: "bloqueada", motivo_bloqueo: "excede_animales", detalle_bloqueo: "Excede los animales" }),
  ];
  const h = await Modelo.hojaSede(1, 12);
  assert.equal(h.estado, "bloqueada");
  assert.equal(h.congelada, false);
  assert.deepEqual(h.bloqueos, [{ motivo: "excede_animales", detalle: "Excede los animales" }]);
  for (const c of ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas", "costo_real", "factor", "costo_teorico"]) {
    assert.equal(h[c], null, c);
  }
  assert.deepEqual(h.cortes.map((c) => [c.item_id, c.cantidad, c.costo_base, c.costo_ajustado, c.costo_total]), [[4, 150, 10000, null, null]]);
  assert.equal(h.totales.cantidad, 150);
  assert.equal(h.totales.costo_total, null);
  assert.deepEqual(h.advertencias, []);
});

test("hoja en vivo con servicio en cero: bloqueo servicio_cero y costos nulos", async () => {
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "0";
  const h = await Modelo.hojaSede(1, 11);
  assert.deepEqual(h.bloqueos.map((b) => b.motivo), ["servicio_cero"]);
  assert.equal(h.gasto_sede, null);
  assert.equal(h.factor, null);
  assert.ok(h.cortes.every((c) => c.costo_total === null));
});

test("hoja en vivo con utilidad negativa: calcula y reporta el bloqueo", async () => {
  tablas.carnes_recepcion_items[0] = corte(1, 101, 1, { cantidad: "1", costo_base: "1000" });
  tablas.carnes_recepcion_items[1] = corte(2, 101, 2, { cantidad: "1", costo_base: "1000", tipo: "adicional" });
  const h = await Modelo.hojaSede(1, 11);
  assert.deepEqual(h.bloqueos.map((b) => b.motivo), ["utilidad_negativa"]);
  assert.ok(Number(h.utilidad) < 0);
  assert.equal(typeof h.costo_real, "number");
});

test("hoja de cerdo: las retomas entran por sede y las vísceras no (convención 'retomas solo cerdo')", async () => {
  tablas.carnes_preliquidaciones[0] = cabecera({ especie: "cerdo" });
  tablas.carnes_preliquidacion_retomas = [{ id: 1, preliquidacion_id: 1, vicera_item_id: 5, kilos: "10", precio: "3000" }];
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.especie, "cerdo");
  assert.equal(h.valor_viceras, "0.00");
  assert.equal(h.valor_retomas, "12000.00"); // 30.000 x 4/10
});

test("hoja de res: valor_retomas es 0.00 aunque haya filas de retomas", async () => {
  tablas.carnes_preliquidacion_retomas = [{ id: 1, preliquidacion_id: 1, vicera_item_id: 5, kilos: "10", precio: "3000" }];
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.valor_retomas, "0.00");
});

test("hoja en vivo coincide con la previsualización de la sede (misma ruta de cálculo)", async () => {
  const prev = await Modelo.previsualizar(1);
  for (const p of prev.sedes) {
    const fila = tablas.carnes_preliquidacion_sedes.find((s) => s.recepcion_id === p.recepcion_id);
    const h = await Modelo.hojaSede(1, fila.id);
    for (const c of ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas"]) {
      assert.equal(h[c], p[c], c);
    }
  }
});

// ─── Vigencia del costeo guardado, error de lectura y error de cálculo ─────

test("hoja de una sede calculada con orden_version desfasado: no se muestra lo guardado, se calcula en vivo y se avisa", async () => {
  await liquidarAhora();
  // Se recalculan las sedes con montos viejos y un cambio posterior del conjunto de sedes.
  const fila = tablas.carnes_preliquidacion_sedes[0];
  assert.equal(fila.estado, "calculada");
  Object.assign(fila, { gasto_sede: "1.00", utilidad: "1.00", servicio_compra: "1.00" });
  tablas.carnes_preliquidaciones[0].orden_version += 1;

  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, false);
  assert.equal(h.costeo_previo_obsoleto, true);

  const prev = await Modelo.previsualizar(1);
  const p = prev.sedes.find((x) => x.sede_id === 11);
  for (const c of ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas"]) {
    assert.equal(h[c], p[c], c);
  }
  assert.notEqual(h.gasto_sede, "1.00");
});

test("hoja de una sede calculada con costeo vigente: valores guardados, sin aviso de obsolescencia", async () => {
  await liquidarAhora();
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, true);
  assert.equal(h.costeo_previo_obsoleto, false);
});

test("hoja de una sede en estado de monto fijo: usa lo guardado aunque el costeo ya no sea vigente", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "enviada", gasto_sede: "123.45", utilidad: "10.00", servicio_compra: "5.00",
    valor_viceras: "0.00", valor_retomas: "0.00", costeo_orden_version: 1, costeo_animales: 4,
    costeo: { costoTeorico: 999, costoReal: 5.5, factor: 0.25, advertencias: [] },
  });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, true);
  assert.equal(h.gasto_sede, "123.45");
  assert.equal(h.costeo_previo_obsoleto, false);
});

test("hoja de una sede simulada con costeo desactualizado: se calcula en vivo (la liquidación la recostea)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "simulada", gasto_sede: "1.00", utilidad: "1.00", servicio_compra: "1.00",
    valor_viceras: "0.00", valor_retomas: "0.00", costeo_orden_version: 1, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, false);
  assert.equal(h.costeo_previo_obsoleto, true);
  assert.notEqual(h.gasto_sede, "1.00");
});

test("hoja de una sede bloqueada con costeo vigente guardado: devuelve lo guardado (montos, costeo y bloqueo)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
    gasto_sede: "500.00", utilidad: "-5.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 5, costeo_animales: 4, costeo: { costoTeorico: 7, costoReal: 8, factor: 0.5, advertencias: ["a"] },
  });
  const h = await Modelo.hojaSede(1, 11);
  const prev = await Modelo.previsualizar(1);
  assert.equal(prev.sedes.some((x) => x.sede_id === 11), false);
  assert.equal(h.congelada, true);
  assert.equal(h.costeo_previo_obsoleto, false);
  assert.equal(h.gasto_sede, "500.00");
  assert.equal(h.utilidad, "-5.00");
  assert.equal(h.costo_teorico, 7);
  assert.equal(h.costo_real, 8);
  assert.equal(h.factor, 0.5);
  assert.deepEqual(h.advertencias, ["a"]);
  assert.deepEqual(h.bloqueos, [{ motivo: "utilidad_negativa", detalle: "Utilidad negativa" }]);
});

test("hoja de una sede bloqueada sin costeo guardado: montos y costos nulos, con el bloqueo", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
  });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, false);
  assert.equal(h.gasto_sede, null);
  assert.ok(h.cortes.every((c) => c.costo_total === null));
  assert.deepEqual(h.bloqueos, [{ motivo: "utilidad_negativa", detalle: "Utilidad negativa" }]);
});

test("hoja de un desborde liberado con costeo guardado vigente: se recostea en vivo (no se congela)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", liberada_at: "2026-11-23T10:00:00.000Z",
    gasto_sede: "1.00", utilidad: "1.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 5, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, false);
  assert.notEqual(h.gasto_sede, "1.00");
  assert.notEqual(h.gasto_sede, null);
});

test("hoja: un error al leer los renglones se propaga (no responde con cortes vacíos)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "enviada", gasto_sede: "123.45", utilidad: "10.00", servicio_compra: "5.00",
    valor_viceras: "0.00", valor_retomas: "0.00", costeo: { costoTeorico: 1, costoReal: 1, factor: 1, advertencias: [] },
  });
  erroresTabla.carnes_recepcion_items = "fallo de lectura";
  await assert.rejects(() => Modelo.hojaSede(1, 11), /renglones|fallo de lectura/);
});

test("hoja: si el cálculo lanza por datos inválidos responde 422 calculo_error", async () => {
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "no-numerico";
  await assert.rejects(
    () => Modelo.hojaSede(1, 11),
    (e) => {
      assert.equal(e.statusCode, 422);
      assert.equal(e.codigo, "calculo_error");
      assert.equal(e.expose, true);
      assert.match(e.message, /No se pudo calcular la hoja/);
      return true;
    },
  );
});

// ─── Ronda 2: obtener/hoja consistentes, errores de lectura, renglones sin plan y errores de cálculo ───

const NUMEROS = ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas"];

test("obtener: una sede calculada con costeo desactualizado usa los valores en vivo (iguales a la hoja) y avisa", async () => {
  await liquidarAhora();
  Object.assign(tablas.carnes_preliquidacion_sedes[0], { gasto_sede: "1.00", utilidad: "1.00", servicio_compra: "1.00" });
  tablas.carnes_preliquidaciones[0].orden_version += 1;

  const r = await Modelo.obtener(1);
  const s = r.sedes.find((x) => x.id === 11);
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(s.fuente_calculo, "previsualizado");
  assert.equal(s.costeo_previo_obsoleto, true);
  for (const c of NUMEROS) assert.equal(s[c], h[c], c);
  assert.notEqual(s.gasto_sede, "1.00");
  assert.equal(h.costeo_previo_obsoleto, true);
});

test("obtener: una sede calculada con costeo vigente se devuelve congelada y sin aviso", async () => {
  await liquidarAhora();
  const r = await Modelo.obtener(1);
  for (const s of r.sedes) {
    assert.equal(s.fuente_calculo, "congelado");
    assert.equal(s.costeo_previo_obsoleto, false);
  }
});

test("obtener: una sede de monto fijo conserva lo guardado aunque el costeo no sea vigente", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "enviada", gasto_sede: "123.45", utilidad: "10.00", servicio_compra: "5.00",
    valor_viceras: "0.00", valor_retomas: "0.00", costeo_orden_version: 1, costeo_animales: 4,
  });
  const s = (await Modelo.obtener(1)).sedes.find((x) => x.id === 11);
  assert.equal(s.fuente_calculo, "congelado");
  assert.equal(s.gasto_sede, "123.45");
  assert.equal(s.costeo_previo_obsoleto, false);
});

test("calcular: un error al leer los renglones se propaga a previsualizar, hoja en vivo y procesar (no congela costeo vacío)", async () => {
  erroresTabla.carnes_recepcion_items = "fallo de lectura";
  await assert.rejects(() => Modelo.previsualizar(1), /fallo de lectura/);
  const consola = mock.method(console, "error", () => {});
  try {
    await assert.rejects(() => Modelo.hojaSede(1, 11), /fallo de lectura/);
  } finally {
    consola.mock.restore();
  }
  await assert.rejects(() => liquidarAhora(), /fallo de lectura/);
  assert.equal(rpcDe("carnes_preliq_congelar_sede").length, 0);
});

test("hoja de una sede bloqueada con costeo vigente: muestra los costos por corte guardados en los renglones", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
    gasto_sede: "500.00", utilidad: "-5.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 5, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  tablas.carnes_recepcion_items[0] = corte(1, 101, 1, { cantidad: "60", costo_base: "12000", costo_ajustado: "9.99", costo_total: "599.40" });
  tablas.carnes_recepcion_items[1] = corte(2, 101, 2, { tipo: "adicional", cantidad: "40.5", costo_base: "9000", costo_ajustado: "8.88", costo_total: "359.64" });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, true);
  assert.deepEqual(h.cortes.map((c) => [c.costo_ajustado, c.costo_total]), [[9.99, 599.4], [8.88, 359.64]]);
  assert.equal(h.totales.costo_total, 959.04);
});

test("hoja de una sede bloqueada con costeo desactualizado: los renglones guardados por un costeo previo no se muestran", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
    gasto_sede: "500.00", utilidad: "-5.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 1, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  tablas.carnes_recepcion_items[0] = corte(1, 101, 1, { cantidad: "60", costo_base: "12000", costo_ajustado: "9.99", costo_total: "599.40" });
  tablas.carnes_recepcion_items[1] = corte(2, 101, 2, { tipo: "adicional", cantidad: "40.5", costo_base: "9000", costo_ajustado: "8.88", costo_total: "359.64" });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.congelada, false);
  assert.ok(h.cortes.length > 0);
  assert.ok(h.cortes.every((c) => c.costo_ajustado === null && c.costo_total === null));
  assert.equal(h.totales.costo_total, null);
});

test("obtener: una sede bloqueada (utilidad_negativa) con costeo vigente conserva lo guardado, incluida la utilidad negativa", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
    gasto_sede: "500.00", utilidad: "-5.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 5, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  const s = (await Modelo.obtener(1)).sedes.find((x) => x.id === 11);
  assert.equal(s.fuente_calculo, "congelado");
  assert.equal(s.costeo_previo_obsoleto, false);
  assert.equal(s.gasto_sede, "500.00");
  assert.equal(s.utilidad, "-5.00");
  assert.equal(s.motivo_bloqueo, "utilidad_negativa");
});

test("obtener: una sede bloqueada sin costeo guardado devuelve montos nulos y sin fuente", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
  });
  const s = (await Modelo.obtener(1)).sedes.find((x) => x.id === 11);
  assert.equal(s.fuente_calculo, null);
  for (const c of NUMEROS) assert.equal(s[c], null, c);
});

test("obtener: un desborde liberado con costeo guardado vigente se recostea en vivo (previsualizado)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", liberada_at: "2026-11-23T10:00:00.000Z",
    gasto_sede: "1.00", utilidad: "1.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 5, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  const s = (await Modelo.obtener(1)).sedes.find((x) => x.id === 11);
  assert.equal(s.fuente_calculo, "previsualizado");
  assert.notEqual(s.gasto_sede, "1.00");
});

test("hoja: costeo_previo_obsoleto es falso si la sede no tiene plan vivo (bloqueada con costeo desactualizado)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "Utilidad negativa",
    gasto_sede: "500.00", utilidad: "-5.00", servicio_compra: "1.00", valor_viceras: "0.00", valor_retomas: "0.00",
    costeo_orden_version: 1, costeo_animales: 4, costeo: { costoTeorico: 1 },
  });
  const h = await Modelo.hojaSede(1, 11);
  assert.equal(h.gasto_sede, null);
  assert.equal(h.costeo_previo_obsoleto, false);
  const s = (await Modelo.obtener(1)).sedes.find((x) => x.id === 11);
  assert.equal(s.costeo_previo_obsoleto, false);
});

test("hoja: un error inesperado del cálculo no se convierte en 422; se registra y se propaga", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({ id: 11, animales: 4, orden: 1, liberada_at: null });
  // Un renglón con cantidad Symbol provoca un TypeError dentro del cálculo: no es validación de datos.
  tablas.carnes_recepcion_items[0] = corte(1, 101, 1, { cantidad: Symbol("x") });
  const consola = mock.method(console, "error", () => {});
  try {
    await assert.rejects(
      () => Modelo.hojaSede(1, 11),
      (e) => {
        assert.notEqual(e.statusCode, 422);
        assert.notEqual(e.codigo, "calculo_error");
        return true;
      },
    );
    assert.ok(consola.mock.callCount() >= 1);
  } finally {
    consola.mock.restore();
  }
});

test("hoja: un error de validación de datos sigue siendo 422 calculo_error y se registra", async () => {
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "no-numerico";
  const consola = mock.method(console, "error", () => {});
  try {
    await assert.rejects(() => Modelo.hojaSede(1, 11), (e) => e.statusCode === 422 && e.codigo === "calculo_error");
    assert.ok(consola.mock.callCount() >= 1);
  } finally {
    consola.mock.restore();
  }
});
