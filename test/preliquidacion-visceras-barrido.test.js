// Barrido horario de las vísceras (CEI) de las sedes de res cuya entrada oficial ya está ok y cuya
// recepción no tiene CEI vigente. Supabase y SIESA FALSOS: nada sale a la red.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

const db = {};
let lecturas = [];
class Q {
  constructor(t) { this.t = t; this.f = []; this.lim = null; this.ord = []; this.rango = null; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, a) { if (c === "recepcion_id") this.ids = a; if (c === "envio_origen_id" && db.falloCompensaciones) this.falla = true; this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  overlaps(c, a) { this.f.push((r) => Array.isArray(r[c]) && r[c].some((x) => a.map(Number).includes(Number(x)))); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rango = [a, b]; return this; }
  then(res, rej) {
    lecturas.push(this.t);
    if (this.falla) return Promise.resolve({ data: null, error: { message: "db caída" } }).then(res, rej);
    let rows = (db[this.t] ?? []).filter((r) => this.f.every((g) => g(r)));
    if (this.t === "carnes_recepcion_items") rows = itemsDe(this.ids ?? [], rows);
    for (const [c, asc] of [...this.ord].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    if (this.rango) rows = rows.slice(this.rango[0], this.rango[1] + 1);
    if (this.lim != null) rows = rows.slice(0, this.lim);
    return Promise.resolve({ data: rows, error: null }).then(res, rej);
  }
}
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t), rpc: async () => ({ data: { resultado: "ok" }, error: null }) } } });
// Renglones de las recepciones: las que no tienen renglones propios en `db.carnes_recepcion_items` llevan una víscera
// con código y cantidad (lo normal); `db.sinVisceras` son las recepciones que no tienen ninguna.
const itemsDe = (ids, propios) =>
  ids.flatMap((id) => {
    if ((db.sinVisceras ?? []).includes(Number(id))) return [];
    const suyos = propios.filter((r) => Number(r.recepcion_id) === Number(id));
    if (suyos.length || (db.carnes_recepcion_items ?? []).some((r) => Number(r.recepcion_id) === Number(id))) return suyos;
    return [{ recepcion_id: id, tipo: "vicera", codigo_item: "20101", cantidad: 10, unidad: "KL" }];
  });
const Modelo = await import(url("models/Preliquidacion.model.js"));
const Cfg = await import(url("config/siesa.js"));

const AHORA = new Date("2026-11-25T12:00:00.000Z");
const hace = (dias) => new Date(AHORA.getTime() - dias * 86400000).toISOString();
let enviados;
let respuestas;
let alertas;
const enviarVisceras = async (recepcionId, opciones) => {
  enviados.push({ recepcionId, opciones });
  return respuestas[recepcionId] ?? { estado: "ok" };
};
const encolar = async (a) => { alertas.push(a); };
const silencio = { error() {}, warn() {} };
const barrer = (extra = {}) =>
  Modelo.barrerVisceras({ ahora: AHORA, siesaActivo: true, enviarVisceras, encolar, log: silencio, restante: () => 120000, ...extra });

beforeEach(() => {
  enviados = [];
  respuestas = {};
  alertas = [];
  lecturas = [];
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = "2026-01-01T00:00:00Z";
  Cfg.reiniciarAvisoViscerasPreliquidacionDesde?.();
  db.carnes_preliquidaciones = [{ id: 1, especie: "res" }, { id: 2, especie: "cerdo" }, { id: 3, especie: "res", estado: "cerrada" }];
  db.carnes_preliquidacion_sedes = [
    { id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "enviada", version: 4, updated_at: hace(1) },
    { id: 12, preliquidacion_id: 1, recepcion_id: 102, estado: "enviada", version: 4, updated_at: hace(1) },
    { id: 13, preliquidacion_id: 1, recepcion_id: 103, estado: "error", version: 4, updated_at: hace(1) },
    { id: 14, preliquidacion_id: 2, recepcion_id: 104, estado: "enviada", version: 4, updated_at: hace(1) },
    { id: 15, preliquidacion_id: 3, recepcion_id: 105, estado: "enviada", version: 6, updated_at: hace(2) },
    { id: 16, preliquidacion_id: 1, recepcion_id: 106, estado: "enviada", version: 4, updated_at: hace(60) },
  ];
  db.carnes_siesa_envios = [{ id: 1, recepcion_id: 102, tipo: "visceras_recepcion", estado: "ok" }];
  db.carnes_recepcion_items = [];
  db.sinVisceras = [];
  db.falloCompensaciones = false;
});

test("selecciona sedes de res enviadas, recientes y sin CEI vigente (también de preliquidaciones cerradas)", async () => {
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id).sort(), [11, 15]);
  assert.ok(lista.every((x) => x.especie === "res"));
});

test("un CEI en error o anulado NO cuenta como hecho: la sede sigue pendiente", async () => {
  db.carnes_siesa_envios = [
    { id: 1, recepcion_id: 102, tipo: "visceras_recepcion", estado: "error" },
    { id: 2, recepcion_id: 101, tipo: "visceras_recepcion", estado: "anulado" },
  ];
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id).sort(), [11, 12, 15]);
});

test("las pendientes salen de la MÁS NUEVA a la más vieja", async () => {
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id), [11, 15]);
  db.carnes_preliquidacion_sedes.push({ id: 17, preliquidacion_id: 1, recepcion_id: 107, estado: "enviada", version: 1, updated_at: hace(0.1) });
  const otra = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(otra.map((x) => x.sede.id), [17, 11, 15]);
});

test("las ya resueltas por un ajuste de vísceras vigente (por sede o consolidado) no son candidatas", async () => {
  db.carnes_siesa_envios.push(
    { id: 2, recepcion_id: 101, tipo: "ajuste_visceras", estado: "ok" },
    { id: 3, recepcion_id: null, tipo: "ajuste_visceras", estado: "ok", recepcion_ids: [105] },
  );
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id), []);
});

test("más de 200 sedes ya resueltas NO esconden a una fresca (sin hambruna por el límite de lectura)", async () => {
  const resueltas = Array.from({ length: 230 }, (_, i) => ({
    id: 1000 + i, preliquidacion_id: 1, recepcion_id: 2000 + i, estado: "enviada", version: 1, updated_at: hace(10),
  }));
  db.carnes_preliquidacion_sedes = [
    ...resueltas,
    { id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "enviada", version: 4, updated_at: hace(1) },
  ];
  db.carnes_siesa_envios = resueltas.map((s, i) => ({ id: 5000 + i, recepcion_id: s.recepcion_id, tipo: "visceras_recepcion", estado: "ok" }));
  // y 230 MÁS NUEVAS que la fresca, también resueltas, para que la fresca quede más allá de la primera página
  const nuevas = Array.from({ length: 230 }, (_, i) => ({
    id: 3000 + i, preliquidacion_id: 1, recepcion_id: 4000 + i, estado: "enviada", version: 1, updated_at: hace(0.5),
  }));
  db.carnes_preliquidacion_sedes.push(...nuevas);
  db.carnes_siesa_envios.push(...nuevas.map((s, i) => ({ id: 9000 + i, recepcion_id: s.recepcion_id, tipo: "visceras_recepcion", estado: "ok" })));
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id), [11]);
});

test("más de 200 sedes de CERDO no esconden a las de res (la especie se filtra antes del tope)", async () => {
  const cerdo = Array.from({ length: 230 }, (_, i) => ({
    id: 1000 + i, preliquidacion_id: 2, recepcion_id: 2000 + i, estado: "enviada", version: 1, updated_at: hace(0.2),
  }));
  db.carnes_preliquidacion_sedes = [
    ...cerdo,
    { id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "enviada", version: 4, updated_at: hace(3) },
  ];
  db.carnes_siesa_envios = [];
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id), [11]);
});

test("el barrido manda el CEI de cada pendiente con el presupuesto y cuenta los resultados", async () => {
  respuestas[105] = { estado: "error", error: "SIESA dijo no", referencia: "TC VISC R105" };
  const r = await barrer();
  assert.deepEqual(enviados.map((e) => e.recepcionId).sort(), [101, 105]);
  assert.equal(typeof enviados[0].opciones.restante, "function");
  assert.equal(r.candidatas, 2);
  assert.equal(r.enviadas, 1);
  assert.equal(r.errores, 1);
  assert.equal(r.intentadas, 2);
});

test("sin tiempo: se detiene y lo que falta queda para el siguiente ciclo", async () => {
  respuestas[101] = { estado: "sin_tiempo" }; // la más nueva va primero
  const r = await barrer();
  assert.equal(enviados.length, 1);
  assert.equal(r.agotado, true);
});

test("sin presupuesto no arranca ninguna", async () => {
  const r = await barrer({ hayPresupuesto: () => false });
  assert.equal(enviados.length, 0);
  assert.equal(r.agotado, true);
});

test("SIESA apagado: no lee ni manda nada", async () => {
  const r = await barrer({ siesaActivo: false });
  assert.equal(enviados.length, 0);
  assert.equal(r.candidatas, 0);
});

test("el tope por corrida limita cuántos ENVÍOS reales se intentan", async () => {
  db.carnes_preliquidacion_sedes = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i, preliquidacion_id: 1, recepcion_id: 500 + i, estado: "enviada", version: 1, updated_at: hace(1),
  }));
  db.carnes_siesa_envios = [];
  const r = await barrer();
  assert.equal(enviados.length, Modelo.LIMITE_BARRIDO_VISCERAS);
  assert.equal(r.candidatas, 30);
  assert.equal(r.intentadas, Modelo.LIMITE_BARRIDO_VISCERAS);
});

test("resultados que no son un envío (sin_visceras, bloqueado, agotado, sin_oficial...) NO gastan el tope: una fresca detrás de 25 atascadas sale", async () => {
  const atascadas = Array.from({ length: 25 }, (_, i) => ({
    id: 100 + i, preliquidacion_id: 1, recepcion_id: 500 + i, estado: "enviada", version: 1, updated_at: hace(1),
  }));
  db.carnes_preliquidacion_sedes = [
    ...atascadas,
    { id: 11, preliquidacion_id: 1, recepcion_id: 101, estado: "enviada", version: 4, updated_at: hace(5) },
  ];
  db.carnes_siesa_envios = [];
  const motivos = ["sin_visceras", "bloqueado", "agotado", "sin_oficial", "anterior_a_activacion"];
  atascadas.forEach((s, i) => { respuestas[s.recepcion_id] = { estado: motivos[i % motivos.length] }; });
  const r = await barrer();
  assert.equal(enviados.length, 26, "las 25 atascadas se examinan y la fresca se envía");
  assert.ok(enviados.some((e) => e.recepcionId === 101), "la fresca salió");
  assert.equal(r.enviadas, 1);
  assert.equal(r.intentadas, 1);
  assert.equal(r.candidatas, 26);
});

test("el resumen cuenta TODOS los resultados por estado", async () => {
  respuestas[101] = { estado: "sin_visceras" };
  respuestas[105] = { estado: "agotado" };
  const r = await barrer();
  assert.deepEqual(r.resultados, { sin_visceras: 1, agotado: 1 });
  assert.equal(r.examinadas, 2);
});

test("un envío repetido (otra corrida ya lo mandó) no cuenta como intento ni como enviado", async () => {
  respuestas[101] = { estado: "ok", repetido: true };
  respuestas[105] = { estado: "error", repetido: true };
  const r = await barrer();
  assert.equal(r.enviadas, 0);
  assert.equal(r.errores, 0);
  assert.equal(r.intentadas, 0);
  assert.deepEqual(r.resultados, { repetido: 2 });
});

test("nunca lanza: si la lectura falla devuelve el error en el resumen", async () => {
  const r = await barrer({ listarPendientes: async () => { throw new Error("db caída"); } });
  assert.equal(r.error, "db caída");
});

// ─── Piso de activación ────────────────────────────────────────────────────

test("piso de activación: las sedes actualizadas antes del piso no son candidatas", async () => {
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = hace(1.5);
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id), [11]);
});

test("piso de activación: sin la variable o inválida el barrido no lee sedes ni manda nada, y avisa UNA vez", async () => {
  for (const valor of [undefined, "", "mañana"]) {
    Cfg.reiniciarAvisoViscerasPreliquidacionDesde?.();
    if (valor === undefined) delete process.env.CARNES_VISCERAS_PRELIQ_DESDE;
    else process.env.CARNES_VISCERAS_PRELIQ_DESDE = valor;
    const avisos = [];
    const log = { error() {}, warn: (m) => avisos.push(String(m)) };
    lecturas = [];
    const a = await barrer({ log });
    const b = await barrer({ log });
    assert.equal(enviados.length, 0, String(valor));
    assert.equal(a.candidatas, 0);
    assert.equal(b.candidatas, 0);
    assert.equal(lecturas.length, 0, "ni siquiera consulta la base");
    assert.equal(avisos.filter((m) => /CARNES_VISCERAS_PRELIQ_DESDE/.test(m)).length, 1, `un solo aviso (${valor})`);
  }
});

// ─── Exclusiones baratas primero: lo que nunca va a mandar nada no cuesta lecturas cada hora ────────────

test("sin vísceras que mandar (ninguna, sin código o en cero) la sede NO es candidata", async () => {
  db.sinVisceras = [101]; // ni un renglón de víscera
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => x.sede.id), [15]);

  db.sinVisceras = [];
  db.carnes_recepcion_items = [
    { recepcion_id: 101, tipo: "vicera", codigo_item: "", cantidad: 5, unidad: "KL" }, // sin código
    { recepcion_id: 101, tipo: "carne", codigo_item: "1", cantidad: 5, unidad: "KL" }, // no es víscera
    { recepcion_id: 105, tipo: "vicera", codigo_item: "20101", cantidad: 0, unidad: "KL" }, // en cero
  ];
  assert.deepEqual((await Modelo.viscerasPendientes({ ahora: AHORA })).map((x) => x.sede.id), []);
});

test("una recepción con UNA víscera con código y cantidad sí es candidata aunque tenga otros renglones", async () => {
  db.carnes_recepcion_items = [
    { recepcion_id: 101, tipo: "carne", codigo_item: "1", cantidad: 5, unidad: "KL" },
    { recepcion_id: 101, tipo: "vicera", codigo_item: "20101", cantidad: 3.3, unidad: "KL" },
    { recepcion_id: 105, tipo: "vicera", codigo_item: "20102", cantidad: 2, unidad: "UND" },
  ];
  assert.deepEqual((await Modelo.viscerasPendientes({ ahora: AHORA })).map((x) => x.sede.id), [11, 15]);
});

test("los renglones se leen en lote por página (una lectura), no uno por sede", async () => {
  lecturas = [];
  await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.equal(lecturas.filter((t) => t === "carnes_recepcion_items").length, 1);
});

test("las sedes sin vísceras ni siquiera llegan a la lectura de envíos (las baratas primero)", async () => {
  db.sinVisceras = [101, 102, 105, 106];
  lecturas = [];
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista, []);
  assert.equal(lecturas.filter((t) => t === "carnes_siesa_envios").length, 0);
});

const hecha102 = [{ id: 1, recepcion_id: 102, tipo: "visceras_recepcion", estado: "ok" }];
const errorCei = (id, recepcion) => ({ id, recepcion_id: recepcion, tipo: "visceras_recepcion", estado: "error" });
const compensacion = (id, origen) => ({ id, tipo: "ajuste_faltante", estado: "ok", envio_origen_id: origen });

test("recepción en el tope de intentos (3 con error): no se reintenta, pero el aviso de agotada sigue saliendo sin leer más", async () => {
  db.carnes_siesa_envios = [...hecha102, errorCei(31, 101), errorCei(32, 101), errorCei(33, 101)];
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => [x.sede.id, Boolean(x.agotada)]), [[11, true], [15, false]]);

  const r = await barrer();
  assert.deepEqual(enviados.map((e) => e.recepcionId), [105], "la agotada no pasa por el envío completo (≈7 lecturas)");
  assert.equal(r.resultados.agotado, 1);
  assert.deepEqual(alertas.map((a) => a.evento), ["visceras_agotadas"]);
  assert.equal(alertas[0].sedeId, 11);
});

test("con 2 intentos con error NO está agotada; una compensación ok detrás de un error no lo cuenta como intento", async () => {
  db.carnes_siesa_envios = [...hecha102, errorCei(31, 101), errorCei(32, 101), errorCei(41, 105), errorCei(42, 105), errorCei(43, 105), compensacion(51, 43)];
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => [x.sede.id, Boolean(x.agotada)]), [[11, false], [15, false]]);
});

test("una falla al leer las compensaciones NO excluye a nadie (sin dato no se descarta)", async () => {
  db.carnes_siesa_envios = [...hecha102, errorCei(31, 101), errorCei(32, 101), errorCei(33, 101)];
  db.falloCompensaciones = true; // sin saber si hubo compensaciones, lo seguro es dejar que el envío decida
  const lista = await Modelo.viscerasPendientes({ ahora: AHORA });
  assert.deepEqual(lista.map((x) => [x.sede.id, Boolean(x.agotada)]), [[11, false], [15, false]]);
});
