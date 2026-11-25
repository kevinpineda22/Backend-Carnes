// Consolidado por sede en `obtener` (GET /preliquidaciones/:id): kilos, costo_teorico, costo_real y factor
// por sede (idénticos a la hoja) y `totales_sedes`. Supabase falso, sin red ni base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let tablas = {};
let consultas = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; consultas.push(t); }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => ({ data: manejadores[nombre] ? manejadores[nombre](args) : { resultado: "ok" }, error: null }),
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Modelo = await import(url("models/Preliquidacion.model.js"));

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
const corte = (id, recepcionId, orden, extra = {}) => ({
  id, recepcion_id: recepcionId, tipo: "carne", cantidad: "100", costo_base: "10000",
  descripcion: `Corte ${id}`, codigo_item: `C${id}`, orden, costo_ajustado: null, costo_total: null, ...extra,
});
const congelado = (extra = {}) => ({
  gasto_sede: "400000.00", utilidad: "12.50", servicio_compra: "20000.00", valor_viceras: "0.00", valor_retomas: "0.00",
  costeo_orden_version: 5, costeo_animales: 4, costeo: { costoTeorico: 1200000, costoReal: 420000, factor: 0.65, advertencias: [] },
  ...extra,
});

beforeEach(() => {
  consultas = [];
  manejadores = {};
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
    carnes_recepciones: [101, 102, 103].map((id) => ({ id, especie: "res", estado: "Aprobado", sede_id: 5 })),
    carnes_recepcion_items: [
      corte(1, 101, 1, { cantidad: "60", costo_base: "12000" }),
      corte(2, 101, 2, { cantidad: "40.5", costo_base: "9000", tipo: "adicional" }),
      corte(3, 101, 3, { tipo: "vicera", cantidad: "10", costo_base: "5000", descripcion: "Higado" }),
      corte(4, 102, 1, { cantidad: "150", costo_base: "10000" }),
      corte(5, 103, 1, { cantidad: "20.25", costo_base: "8000" }),
    ],
  };
});

const sedeDe = (r, id) => r.sedes.find((s) => s.id === id);

async function igualAHoja(id) {
  const r = await Modelo.obtener(1);
  const s = sedeDe(r, id);
  const h = await Modelo.hojaSede(1, id);
  assert.equal(s.kilos, h.totales.cantidad, "kilos");
  // Con costeo (vivo o guardado) el costo_teorico de la hoja manda; sin costeo la hoja no trae teorico y sale de los renglones.
  assert.equal(s.costo_teorico, h.costo_teorico ?? h.totales.costo_teorico, "costo_teorico = el de la hoja");
  assert.equal(s.costo_real, h.costo_real, "costo_real");
  assert.equal(s.factor, h.factor, "factor");
  if (s.costo_teorico != null && s.costo_real != null && s.factor != null) {
    assert.ok(Math.abs(s.factor - (s.costo_teorico - s.costo_real) / s.costo_teorico) < 1e-9, "factor = (teorico - real) / teorico");
  }
  return { r, s, h };
}

test("consolidado en vivo: kilos, costo_teorico, costo_real y factor son los de la hoja; visceras no cuentan", async () => {
  const { s, h } = await igualAHoja(11);
  assert.equal(s.fuente_calculo, "previsualizado");
  assert.equal(s.kilos, 100.5);
  assert.equal(s.costo_teorico, 60 * 12000 + 40.5 * 9000);
  assert.equal(h.totales.costo_teorico, s.costo_teorico);
  assert.equal(typeof s.costo_real, "number");
  assert.equal(typeof s.factor, "number");
  assert.equal(s.costo_teorico, h.costo_teorico, "coincide tambien con el costo_teorico del costeo de la hoja");
  await igualAHoja(12);
});

test("consolidado congelado: sale del costeo guardado, igual que la hoja", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({ id: 11, estado: "calculada", ...congelado() });
  const { s, h } = await igualAHoja(11);
  assert.equal(s.fuente_calculo, "congelado");
  assert.equal(s.costo_teorico, 1200000, "teorico guardado, no la suma de renglones");
  assert.equal(s.costo_teorico, h.costo_teorico);
  assert.equal(s.costo_real, 420000);
  assert.equal(s.factor, 0.65);
  assert.equal(s.kilos, 100.5);
});

test("consolidado de sede bloqueada con costeo guardado: costo_real y factor guardados, igual que la hoja", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "x", ...congelado({ utilidad: "-5.00" }),
  });
  const { s, h } = await igualAHoja(11);
  assert.equal(s.costo_teorico, 1200000);
  assert.equal(s.costo_teorico, h.costo_teorico);
  assert.equal(s.costo_real, 420000);
  assert.equal(s.factor, 0.65);
});

test("consolidado de sede bloqueada sin costeo: kilos y costo_teorico si; costo_real y factor nulos (igual que la hoja)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({ id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "x" });
  const { s, h } = await igualAHoja(11);
  assert.equal(s.kilos, 100.5);
  assert.equal(s.costo_teorico, 60 * 12000 + 40.5 * 9000);
  assert.equal(s.costo_real, null);
  assert.equal(s.factor, null);
  assert.equal(h.costo_teorico, null, "sin costeo la hoja no trae teorico; el consolidado lo saca de los renglones");
});

test("consolidado: un desborde sin liberar tiene kilos y costo_teorico pero ningun costo real", async () => {
  tablas.carnes_preliquidacion_sedes.push(sede({
    id: 13, recepcion_id: 103, animales: 3, orden: 3, estado: "bloqueada", motivo_bloqueo: "excede_animales", detalle_bloqueo: "x",
  }));
  const { s } = await igualAHoja(13);
  assert.equal(s.kilos, 20.25);
  assert.equal(s.costo_teorico, 162000);
  assert.equal(s.costo_real, null);
  assert.equal(s.factor, null);
});

test("consolidado con servicio en cero (bloqueo de cabecera): kilos y teorico siguen; sin real ni factor", async () => {
  tablas.carnes_preliquidaciones[0] = cabecera({ servicio_por_animal: "0.00" });
  tablas.carnes_preliquidacion_gastos = [];
  const r = await Modelo.obtener(1);
  for (const s of r.sedes) {
    assert.ok(s.kilos > 0);
    assert.ok(s.costo_teorico > 0);
    assert.equal(s.costo_real, null);
    assert.equal(s.factor, null);
  }
});

test("consolidado: sede sin renglones de producto da kilos 0 y costo_teorico nulo", async () => {
  tablas.carnes_recepcion_items = tablas.carnes_recepcion_items.filter((i) => i.recepcion_id !== 102);
  const s = sedeDe(await Modelo.obtener(1), 12);
  assert.equal(s.kilos, 0);
  assert.equal(s.costo_teorico, null);
});

test("consolidado: no agrega consultas por sede (una sola lectura de renglones)", async () => {
  tablas.carnes_preliquidacion_sedes.push(sede({ id: 13, recepcion_id: 103, animales: 0, orden: 3 }));
  await Modelo.obtener(1);
  assert.equal(consultas.filter((t) => t === "carnes_recepcion_items").length, 1);
});

test("totales_sedes: animales y kilos suman todas las sedes; los montos solo las incluidas", async () => {
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, estado: "calculada", animales: 4, orden: 1, ...congelado() }),
    sede({ id: 12, estado: "calculada", animales: 6, orden: 2, recepcion_id: 102, ...congelado({
      costeo_animales: 6, gasto_sede: "600000.10", utilidad: "-3.25", servicio_compra: "30000.00", valor_viceras: "1500.50",
      costeo: { costoTeorico: 1500000, costoReal: 630000.1, factor: 0.58, advertencias: [] },
    }) }),
    sede({ id: 13, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "x", recepcion_id: 103, animales: 3, orden: 3 }),
  ];
  const r = await Modelo.obtener(1);
  assert.deepEqual(r.totales_sedes, {
    animales: 13,
    kilos: 270.75,
    gasto_sede: 1000000.1,
    servicio_compra: 50000,
    costo_real: 1050000.1,
    costo_teorico: 2700000,
    utilidad: 9.25,
    complemento: 1500.5,
    sedes_incluidas: 2,
    sedes_excluidas: 1,
    sedes_total: 3,
  });
  for (const v of Object.values(r.totales_sedes)) assert.equal(typeof v, "number");
});

test("totales_sedes en cerdo: el complemento es la suma de valor_retomas de las incluidas", async () => {
  tablas.carnes_preliquidaciones[0] = cabecera({ especie: "cerdo" });
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, estado: "calculada", ...congelado({ valor_retomas: "5000.25", valor_viceras: "7.00" }) }),
    sede({ id: 12, estado: "calculada", recepcion_id: 102, animales: 6, ...congelado({ costeo_animales: 6, valor_retomas: "100.00", valor_viceras: "9.00" }) }),
  ];
  const r = await Modelo.obtener(1);
  assert.equal(r.totales_sedes.complemento, 5100.25);
});

test("totales_sedes: sin ninguna sede incluida los montos son null (no 0); animales y kilos si se suman", async () => {
  tablas.carnes_preliquidaciones[0] = cabecera({ servicio_por_animal: "0.00" });
  tablas.carnes_preliquidacion_gastos = [];
  const r = await Modelo.obtener(1);
  assert.deepEqual(r.totales_sedes, {
    animales: 10, kilos: 250.5, gasto_sede: null, servicio_compra: null, costo_real: null, costo_teorico: null,
    utilidad: null, complemento: null, sedes_incluidas: 0, sedes_excluidas: 2, sedes_total: 2,
  });
});

test("consolidado en vivo: el costo_teorico por sede es el del costeo vivo (hoja) para cada sede", async () => {
  const r = await Modelo.obtener(1);
  for (const s of r.sedes) {
    const h = await Modelo.hojaSede(1, s.id);
    assert.equal(s.costo_teorico, h.costo_teorico);
  }
});

test("obtener: una lectura de renglones fallida no oculta el bloqueo servicio_cero en calculo", async () => {
  tablas.carnes_preliquidaciones[0] = cabecera({ servicio_por_animal: "0.00" });
  tablas.carnes_preliquidacion_gastos = [];
  const original = tablas.carnes_recepcion_items;
  Object.defineProperty(tablas, "carnes_recepcion_items", { get() { throw new Error("falla de lectura"); }, configurable: true });
  try {
    const r = await Modelo.obtener(1);
    assert.equal(r.calculo?.bloqueo, "servicio_cero");
    assert.ok(r.calculo_error);
  } finally {
    Object.defineProperty(tablas, "carnes_recepcion_items", { value: original, writable: true, configurable: true, enumerable: true });
  }
});

test("totales_sedes en vivo: coincide con la suma de las hojas de las sedes", async () => {
  const r = await Modelo.obtener(1);
  const hojas = await Promise.all(r.sedes.map((s) => Modelo.hojaSede(1, s.id)));
  const suma = (f) => Math.round(hojas.reduce((a, h) => a + Number(f(h)), 0) * 100) / 100;
  assert.equal(r.totales_sedes.costo_real, suma((h) => h.costo_real));
  assert.equal(r.totales_sedes.gasto_sede, suma((h) => h.gasto_sede));
  assert.equal(r.totales_sedes.utilidad, suma((h) => h.utilidad));
  assert.equal(r.totales_sedes.kilos, suma((h) => h.totales.cantidad));
  assert.equal(r.totales_sedes.animales, 10);
  assert.equal(r.totales_sedes.costo_teorico, suma((h) => h.costo_teorico));
});

test("obtener conserva los campos existentes de cada sede", async () => {
  const s = sedeDe(await Modelo.obtener(1), 11);
  for (const c of ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas", "fuente_calculo", "costeo_previo_obsoleto", "bloqueos_calculo"]) {
    assert.ok(c in s, c);
  }
});
