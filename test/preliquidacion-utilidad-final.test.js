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
const { aCentavos, centavosATexto, roundHalfAwayFromZero } = await import(url("shared/preliquidacionCosteo.js"));

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

test("utilidad_final en vivo: utilidad - servicio_compra, igual en obtener, hoja y previsualizar", async () => {
  const r = await Modelo.obtener(1);
  const p = await Modelo.previsualizar(1);
  for (const id of [11, 12]) {
    const s = sedeDe(r, id);
    const h = await Modelo.hojaSede(1, id);
    const pv = p.sedes.find((x) => x.sede_id === id);
    const esperado = centavosATexto(aCentavos(s.utilidad) - aCentavos(s.servicio_compra));
    assert.equal(s.utilidad_final, esperado);
    assert.equal(h.utilidad_final, s.utilidad_final, "hoja = obtener");
    assert.equal(pv.utilidad_final, s.utilidad_final, "previsualizar = obtener");
    assert.match(s.utilidad_final, /^-?\d+\.\d{2}$/);
  }
});

test("utilidad_final congelada: sale de utilidad y servicio_compra guardados", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({ id: 11, estado: "calculada", ...congelado({ utilidad: "100.00", servicio_compra: "50.00" }) });
  const s = sedeDe(await Modelo.obtener(1), 11);
  assert.equal(s.utilidad, "100.00");
  assert.equal(s.utilidad_final, "50.00");
  assert.equal((await Modelo.hojaSede(1, 11)).utilidad_final, "50.00");
});

test("utilidad_final con utilidad negativa: servicio medio-hacia-afuera y final = inicial - servicio (-10.01 -> -5.01 -> -5.00)", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({
    id: 11, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "x", ...congelado({ utilidad: "-10.01", servicio_compra: "-5.01" }),
  });
  const s = sedeDe(await Modelo.obtener(1), 11);
  assert.equal(s.utilidad, "-10.01", "la utilidad inicial no cambia");
  assert.equal(s.utilidad_final, "-5.00");
  assert.equal((await Modelo.hojaSede(1, 11)).utilidad_final, "-5.00");
  assert.equal(centavosATexto(roundHalfAwayFromZero(-1001n, 2n)), "-5.01", "regla del modulo");
});

test("utilidad_final es null sin numeros (bloqueada sin costeo) en obtener y hoja", async () => {
  tablas.carnes_preliquidacion_sedes[0] = sede({ id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", detalle_bloqueo: "x" });
  const s = sedeDe(await Modelo.obtener(1), 11);
  assert.equal(s.utilidad_final, null);
  assert.equal((await Modelo.hojaSede(1, 11)).utilidad_final, null);
});

test("totales_sedes.utilidad_final = suma de las incluidas; null sin incluidas", async () => {
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, estado: "calculada", animales: 4, orden: 1, ...congelado({ utilidad: "100.00", servicio_compra: "50.00" }) }),
    sede({ id: 12, estado: "calculada", animales: 6, orden: 2, recepcion_id: 102, ...congelado({ costeo_animales: 6, utilidad: "-10.01", servicio_compra: "-5.01" }) }),
    sede({ id: 13, estado: "bloqueada", motivo_bloqueo: "utilidad_negativa", detalle_bloqueo: "x", recepcion_id: 103, animales: 3, orden: 3 }),
  ];
  const r = await Modelo.obtener(1);
  assert.equal(r.totales_sedes.utilidad_final, 45);
  assert.equal(typeof r.totales_sedes.utilidad_final, "number");
  const suma = r.sedes.filter((s) => s.utilidad_final != null).reduce((a, s) => a + Math.round(Number(s.utilidad_final) * 100), 0) / 100;
  assert.equal(r.totales_sedes.utilidad_final, suma);
  assert.equal(r.totales_sedes.utilidad, 89.99, "la utilidad inicial sigue igual");

  tablas.carnes_preliquidacion_sedes = [sede({ id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", detalle_bloqueo: "x" })];
  assert.equal((await Modelo.obtener(1)).totales_sedes.utilidad_final, null);
});
