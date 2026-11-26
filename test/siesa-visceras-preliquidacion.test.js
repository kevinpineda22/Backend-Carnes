// El CEI de vísceras que acompaña a la entrada oficial de cada sede de la preliquidación
// (enviarViscerasPreliquidacion) y el CEI al cierre de siempre (enviarViscerasRecepcion), con
// supabase y SIESA FALSOS: nada sale a la red. Usa mock.module (npm test lo habilita).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.CARNES_SIESA_ACTIVO = "true";
delete process.env.CARNES_SIESA_VISCERAS_AL_CIERRE;
process.env.CONNEKTA_BASE_URL = "http://fake.invalid/api/connekta/v3";
process.env.CONNEKTA_ID_COMPANIA = "1";
process.env.CONNI_KEY = "k";
process.env.CONNI_TOKEN = "t";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

// ─── Base falsa ───
const db = {};
let seq = 0;
const reiniciar = (especie = "res") => {
  db.carnes_recepciones = [
    {
      id: 2, estado: "Enviado_SIESA", especie, fecha_ingreso: "2026-11-20", sede_id: 2, liquidacion_id: null,
      sede: { id: 2, nombre: "Barbosa", bodega_siesa: "00201", codigo_co: "02" },
    },
  ];
  db.carnes_recepcion_items = [
    { id: 201, recepcion_id: 2, tipo: "carne", orden: 1, codigo_item: "1", descripcion: "C1", cantidad: 10, costo_base: 100, costo_ajustado: 90 },
    { id: 202, recepcion_id: 2, tipo: "vicera", orden: 2, codigo_item: "20101", descripcion: "Mondongo", cantidad: 33.3, costo_base: 6500, unidad: "KL" },
  ];
  seq = 10;
  db.carnes_siesa_envios = [
    { id: 1, tipo: "inicial", estado: "ok", recepcion_id: 2, liquidacion_id: null, referencia: "TC INI R2", enviado_at: "2026-11-20T01:00:00Z" },
    { id: 2, tipo: "oficial", estado: "ok", recepcion_id: 2, liquidacion_id: null, referencia: "TC OFI R2", enviado_at: "2026-11-20T02:00:00Z" },
  ];
  db.carnes_preliquidacion_sedes = [];
};

const VIG = ["enviando", "ok", "sin_confirmar"];
const filtroOv = (c, v) => (r) => Array.isArray(r[c]) && r[c].some((x) => v.map(Number).includes(Number(x)));

class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.pay = null; this.ord = []; this.lim = null; }
  select() { return this; }
  insert(p) { this.op = "insert"; this.pay = p; return this; }
  update(p) { this.op = "update"; this.pay = p; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v) && r[c] != null); return this; }
  in(c, a) { this.f.push((r) => r[c] != null && a.map(String).includes(String(r[c]))); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  overlaps(c, v) { this.f.push(filtroOv(c, v)); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  run() {
    const tabla = (db[this.t] ??= []);
    let rows = tabla.filter((r) => this.f.every((g) => g(r)));
    if (this.op === "insert") {
      const nuevo = { id: ++seq, enviado_at: new Date(Date.now() + seq).toISOString(), ...this.pay };
      if (this.t === "carnes_siesa_envios" && VIG.includes(nuevo.estado) &&
        tabla.some((r) => VIG.includes(r.estado) && r.recepcion_id === nuevo.recepcion_id && r.tipo === nuevo.tipo)) {
        return { data: null, error: { code: "23505", message: "dup" } };
      }
      tabla.push(nuevo);
      return { data: nuevo, error: null };
    }
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.pay);
      return this.one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    }
    for (const [c, asc] of [...this.ord].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    if (this.lim != null) rows = rows.slice(0, this.lim);
    return this.one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
}
const supabaseFalso = { from: (t) => new Q(t), rpc: async () => ({ data: { resultado: "ok" }, error: null }) };

// ─── SIESA falso ───
let llamadas = [];
let guion = [];
let pausa = null;
const enviarASiesaFalso = async (payload, opts) => {
  llamadas.push({ payload, opts });
  if (pausa) await pausa;
  const r = guion.shift() ?? { ok: true };
  return r.ok
    ? { ok: true, status: 200, respuesta: { ok: 1 }, error: null }
    : { ok: false, incierto: Boolean(r.incierto), status: r.incierto ? null : 400, respuesta: r.respuesta ?? { e: 1 }, error: r.error ?? "SIESA dijo no" };
};
let correosError = [];

mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
mock.module(url("services/siesa.service.js"), {
  namedExports: { enviarASiesa: enviarASiesaFalso, TIMEOUT_INICIAL_MS: 45000, TIMEOUT_OFICIAL_MS: 240000 },
});
mock.module(url("services/notificaciones.service.js"), {
  namedExports: {
    notificarAnularIniciales: async () => ({ success: true }),
    notificarAnularInicial: async () => ({ success: true }),
    notificarErrorEnvioSiesa: async (envio) => { correosError.push(envio); return { success: true }; },
  },
});
mock.module(url("models/PreliquidacionCierre.model.js"), {
  namedExports: {
    intentarAutocierre: async () => ({ cerrada: false }),
    cerrarPreliquidacion: async () => ({ resultado: "ok" }),
  },
});

const M = await import(url("models/SiesaEnvio.model.js"));
const Cfg = await import(url("config/siesa.js"));
const nuevo = (especie) => {
  reiniciar(especie);
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = "2026-01-01T00:00:00Z";
  Cfg.reiniciarAvisoViscerasPreliquidacionDesde?.();
  llamadas = [];
  guion = [];
  pausa = null;
  correosError = [];
  process.env.CARNES_SIESA_ACTIVO = "true";
  delete process.env.CARNES_SIESA_VISCERAS_AL_CIERRE;
};
const cei = () => db.carnes_siesa_envios.filter((f) => f.tipo === "visceras_recepcion");
const amplio = () => 200_000;

// ─── enviarViscerasPreliquidacion ──────────────────────────────────────────

test("oficial ok: manda el CEI de la recepción SIN la bandera de cierre", async () => {
  nuevo();
  const r = await M.enviarViscerasPreliquidacion(2, { por: "cron", restante: amplio });
  assert.equal(r.estado, "ok");
  assert.equal(r.tipo, "visceras_recepcion");
  assert.equal(r.recepcion_id, 2);
  assert.match(r.referencia, /TC VISC R2/);
  assert.equal(llamadas.length, 1);
  assert.equal(cei().length, 1);
  assert.equal(cei()[0].estado, "ok");
  assert.equal(cei()[0].enviado_por, "cron");
});

test("el tiempo que queda acota la espera del POST (nunca más que lo que alcanza)", async () => {
  nuevo();
  await M.enviarViscerasPreliquidacion(2, { restante: () => 60_000 });
  assert.equal(llamadas.length, 1);
  assert.ok(llamadas[0].opts.timeoutMs <= 60_000, `timeoutMs=${llamadas[0].opts.timeoutMs}`);
  assert.ok(llamadas[0].opts.timeoutMs >= 30_000);
});

test("sin tiempo seguro (restante null o menor al mínimo): no arranca ni deja filas; lo retoma el barrido", async () => {
  nuevo();
  for (const restante of [() => null, () => 31_000]) {
    const r = await M.enviarViscerasPreliquidacion(2, { restante });
    assert.equal(r.estado, "sin_tiempo");
  }
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("SIESA apagado: no manda ni toca la base", async () => {
  nuevo();
  process.env.CARNES_SIESA_ACTIVO = "false";
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "apagado");
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("cerdo: no lleva vísceras, no se manda nada", async () => {
  nuevo("cerdo");
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "no_aplica");
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("la oficial no está ok (falló, sin confirmar, enviando o no existe): el CEI no sale", async () => {
  for (const oficial of [
    { estado: "error" },
    { estado: "sin_confirmar" },
    { estado: "enviando" },
    { estado: "anulado" },
    null,
  ]) {
    nuevo();
    db.carnes_siesa_envios = db.carnes_siesa_envios.filter((f) => f.tipo !== "oficial");
    if (oficial) db.carnes_siesa_envios.push({ id: 3, tipo: "oficial", recepcion_id: 2, referencia: "TC OFI R2", enviado_at: "2026-11-20T02:00:00Z", ...oficial });
    const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
    assert.equal(r.estado, "sin_oficial", JSON.stringify(oficial));
    assert.equal(llamadas.length, 0);
    assert.equal(cei().length, 0);
  }
});

test("dedupe: un CEI ya ok / enviando / sin_confirmar de la recepción no se vuelve a mandar", async () => {
  for (const estado of ["ok", "enviando", "sin_confirmar"]) {
    nuevo();
    db.carnes_siesa_envios.push({ id: 5, tipo: "visceras_recepcion", estado, recepcion_id: 2, referencia: "TC VISC R2", enviado_at: "2026-11-20T03:00:00Z" });
    const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
    assert.equal(r.repetido, true, estado);
    assert.equal(r.estado, estado);
    assert.equal(llamadas.length, 0);
    assert.equal(cei().length, 1);
  }
});

test("dedupe: dos corridas a la vez (cron + inmediato) producen UN solo CEI y UN solo POST", async () => {
  nuevo();
  let liberar;
  pausa = new Promise((r) => { liberar = r; });
  const a = M.enviarViscerasPreliquidacion(2, { restante: amplio });
  const b = M.enviarViscerasPreliquidacion(2, { restante: amplio });
  await new Promise((r) => setTimeout(r, 20));
  liberar();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(llamadas.length, 1, "un solo POST a SIESA");
  assert.equal(cei().length, 1, "una sola fila vigente");
  assert.deepEqual([ra, rb].map((x) => x.repetido === true).sort(), [false, true]);
});

test("una recepción sin vísceras con código y cantidad se salta limpio", async () => {
  nuevo();
  db.carnes_recepcion_items = db.carnes_recepcion_items.filter((i) => i.tipo !== "vicera");
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "sin_visceras");
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("SIESA rechaza: queda fila error (visible en el panel), sin lanzar, y se puede reintentar", async () => {
  nuevo();
  guion = [{ ok: false, error: "Item sin cantidad" }];
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "error");
  assert.ok(r.error);
  assert.equal(cei().length, 1);
  assert.equal(cei()[0].estado, "error");
  const otra = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(otra.estado, "ok");
  assert.equal(llamadas.length, 2);
});

test("sin_confirmar de SIESA: queda trabado para una persona, no se reintenta solo", async () => {
  nuevo();
  guion = [{ ok: false, incierto: true, error: "timeout" }];
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "sin_confirmar");
  const otra = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(otra.repetido, true);
  assert.equal(llamadas.length, 1);
});

test("tope de intentos automáticos: tras 3 errores deja de insistir", async () => {
  nuevo();
  guion = [{ ok: false }, { ok: false }, { ok: false }];
  for (let i = 0; i < 3; i += 1) assert.equal((await M.enviarViscerasPreliquidacion(2, { restante: amplio })).estado, "error");
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "agotado");
  assert.equal(llamadas.length, 3);
});

test("ya hay un ajuste de vísceras vigente (por sede o consolidado): no se duplica el inventario", async () => {
  nuevo();
  db.carnes_siesa_envios.push({ id: 6, tipo: "ajuste_visceras", estado: "ok", recepcion_id: 2, referencia: "TC VIS R2", enviado_at: "2026-11-20T03:00:00Z" });
  let r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "bloqueado");
  assert.match(r.error, /TC VIS R2/);

  nuevo();
  db.carnes_siesa_envios.push({ id: 7, tipo: "ajuste_visceras", estado: "ok", recepcion_id: null, liquidacion_id: 9, recepcion_ids: [2, 3], referencia: "TC VIS L9", enviado_at: "2026-11-20T03:00:00Z" });
  r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "bloqueado");
  assert.equal(llamadas.length, 0);
});

test("nunca lanza: una falla de lectura se devuelve como error", async () => {
  nuevo();
  db.carnes_recepciones = [];
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "error");
  assert.equal(llamadas.length, 0);
});

// ─── El CEI al cierre de siempre no cambia ─────────────────────────────────

test("al cierre, sin la bandera: apagado y sin tocar la base (como antes)", async () => {
  nuevo();
  const r = await M.enviarViscerasRecepcion(2, "recibidor");
  assert.equal(r.estado, "apagado");
  assert.equal(llamadas.length, 0);
});

test("al cierre, con la bandera: manda el CEI (comportamiento legado), y repetido no duplica", async () => {
  nuevo();
  process.env.CARNES_SIESA_VISCERAS_AL_CIERRE = "true";
  const r = await M.enviarViscerasRecepcion(2, "recibidor");
  assert.equal(r.estado, "ok");
  assert.equal(llamadas.length, 1);
  const otra = await M.enviarViscerasRecepcion(2, "recibidor");
  assert.equal(otra.repetido, true);
  assert.equal(llamadas.length, 1);
});

test("al cierre no exige oficial (el negocio decidió que entran antes de la oficial)", async () => {
  nuevo();
  process.env.CARNES_SIESA_VISCERAS_AL_CIERRE = "true";
  db.carnes_siesa_envios = db.carnes_siesa_envios.filter((f) => f.tipo !== "oficial");
  const r = await M.enviarViscerasRecepcion(2, "recibidor");
  assert.equal(r.estado, "ok");
});

// ─── Reintento manual desde el panel ───────────────────────────────────────

test("reintento manual: una recepción de la preliquidación con sede enviada sale SIN la bandera de cierre", async () => {
  nuevo();
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "enviada" }];
  const r = await M.reintentarViscerasRecepcion(2, "admin");
  assert.equal(r.estado, "ok");
  assert.equal(llamadas.length, 1);
});

test("reintento manual: con la sede sin su oficial (no enviada) no sale", async () => {
  nuevo();
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "error" }];
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409);
  assert.equal(llamadas.length, 0);
});

test("reintento manual: sede enviada pero la oficial no está ok en los envíos tampoco sale", async () => {
  nuevo();
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "enviada" }];
  db.carnes_siesa_envios = db.carnes_siesa_envios.filter((f) => f.tipo !== "oficial");
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409);
  assert.equal(llamadas.length, 0);
});

test("reintento manual: una recepción que no es de la preliquidación sigue exigiendo la bandera", async () => {
  nuevo();
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409 && /VISCERAS_AL_CIERRE/.test(e.message));
  process.env.CARNES_SIESA_VISCERAS_AL_CIERRE = "true";
  const r = await M.reintentarViscerasRecepcion(2, "admin");
  assert.equal(r.estado, "ok");
});

// ─── resolver(): la confirmación de un sin_confirmar también dispara el CEI ─

const oficialSinConfirmar = () => {
  db.carnes_siesa_envios = db.carnes_siesa_envios.filter((f) => f.tipo !== "oficial");
  db.carnes_siesa_envios.push({ id: 50, tipo: "oficial", estado: "sin_confirmar", recepcion_id: 2, liquidacion_id: null, referencia: "TC OFI R2", enviado_at: new Date().toISOString() });
};
const sedeSinConfirmar = (extra = {}) => ({ id: 77, preliquidacion_id: 9, recepcion_id: 2, estado: "sin_confirmar", envio_id: 50, version: 4, requiere_correccion: false, ...extra });

test("resolver ok de la oficial de una sede (sin_confirmar -> ok): sale el CEI de la recepción", async () => {
  nuevo();
  oficialSinConfirmar();
  db.carnes_preliquidacion_sedes = [sedeSinConfirmar()];
  await M.resolver(50, { resultado: "ok", por: "admin" });
  assert.equal(llamadas.length, 1, "un POST: el CEI (la oficial ya estaba en SIESA)");
  assert.equal(cei().length, 1);
  assert.equal(cei()[0].estado, "ok");
});

test("resolver no_llego: la oficial no está en SIESA, el CEI no sale", async () => {
  nuevo();
  oficialSinConfirmar();
  db.carnes_preliquidacion_sedes = [sedeSinConfirmar()];
  await M.resolver(50, { resultado: "no_llego", por: "admin" });
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("resolver ok de una oficial sin sede de preliquidación (flujo legado): no sale CEI", async () => {
  nuevo();
  oficialSinConfirmar();
  await M.resolver(50, { resultado: "ok", por: "admin" });
  assert.equal(llamadas.length, 0);
});

test("resolver ok: si el CEI falla, la resolución queda guardada y no lanza", async () => {
  nuevo();
  oficialSinConfirmar();
  db.carnes_preliquidacion_sedes = [sedeSinConfirmar()];
  guion = [{ ok: false, error: "no" }];
  const data = await M.resolver(50, { resultado: "ok", por: "admin" });
  assert.equal(data.estado, "ok");
  assert.equal(cei()[0].estado, "error");
});


// ─── Piso de activación (CARNES_VISCERAS_PRELIQ_DESDE) ─────────────────────

test("piso de activación: sin la variable (o inválida) NO sale nada por la preliquidación y se avisa UNA vez", async () => {
  for (const valor of [undefined, "", "no-es-fecha"]) {
    nuevo();
    if (valor === undefined) delete process.env.CARNES_VISCERAS_PRELIQ_DESDE;
    else process.env.CARNES_VISCERAS_PRELIQ_DESDE = valor;
    const avisos = [];
    const original = console.warn;
    console.warn = (m) => avisos.push(String(m));
    try {
      const a = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
      const b = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
      assert.equal(a.estado, "sin_activacion", String(valor));
      assert.equal(b.estado, "sin_activacion");
    } finally {
      console.warn = original;
    }
    assert.equal(llamadas.length, 0);
    assert.equal(cei().length, 0);
    assert.equal(avisos.filter((m) => /CARNES_VISCERAS_PRELIQ_DESDE/.test(m)).length, 1, `un solo aviso (${valor})`);
  }
});

test("piso de activación: una oficial que quedó ok ANTES del piso no manda CEI (anterior_a_activacion)", async () => {
  nuevo();
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = "2026-11-21T00:00:00Z"; // la oficial es del 20/11
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "anterior_a_activacion");
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("piso de activación: la oficial ok justo en el piso o después sí manda; una confirmada a mano (resuelto_at) cuenta desde que se confirmó", async () => {
  nuevo();
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = "2026-11-20T02:00:00Z"; // igual al enviado_at de la oficial
  assert.equal((await M.enviarViscerasPreliquidacion(2, { restante: amplio })).estado, "ok");

  nuevo();
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = "2026-11-22T00:00:00Z";
  const oficial = db.carnes_siesa_envios.find((f) => f.tipo === "oficial");
  oficial.resuelto_at = "2026-11-23T10:00:00Z"; // se envió antes del piso pero quedó ok después
  assert.equal((await M.enviarViscerasPreliquidacion(2, { restante: amplio })).estado, "ok");
});

test("piso de activación: el reintento manual de una recepción vinculada también lo respeta", async () => {
  nuevo();
  process.env.CARNES_VISCERAS_PRELIQ_DESDE = "2026-11-21T00:00:00Z";
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "enviada" }];
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409);
  assert.equal(llamadas.length, 0);

  delete process.env.CARNES_VISCERAS_PRELIQ_DESDE;
  Cfg.reiniciarAvisoViscerasPreliquidacionDesde();
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409);
  assert.equal(llamadas.length, 0);
});

test("la recepción NO vinculada (CEI al cierre de siempre) no depende del piso", async () => {
  nuevo();
  delete process.env.CARNES_VISCERAS_PRELIQ_DESDE;
  process.env.CARNES_SIESA_VISCERAS_AL_CIERRE = "true";
  const r = await M.enviarViscerasRecepcion(2, "recibidor");
  assert.equal(r.estado, "ok");
});

// ─── Reintento manual: guarda del ajuste vigente ───────────────────────────

test("reintento manual de una recepción vinculada: un ajuste de vísceras vigente (por sede o consolidado) lo bloquea con 409", async () => {
  nuevo();
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "enviada" }];
  db.carnes_siesa_envios.push({ id: 6, tipo: "ajuste_visceras", estado: "ok", recepcion_id: 2, referencia: "TC VIS R2", enviado_at: "2026-11-20T03:00:00Z" });
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409 && /TC VIS R2/.test(e.message));
  assert.equal(llamadas.length, 0);

  nuevo();
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "enviada" }];
  db.carnes_siesa_envios.push({ id: 7, tipo: "ajuste_visceras", estado: "ok", recepcion_id: null, liquidacion_id: 9, recepcion_ids: [2, 3], referencia: "TC VIS L9", enviado_at: "2026-11-20T03:00:00Z" });
  await assert.rejects(() => M.reintentarViscerasRecepcion(2, "admin"), (e) => e.statusCode === 409 && /TC VIS L9/.test(e.message));
  assert.equal(llamadas.length, 0);
});

// ─── El tope cuenta INTENTOS, no filas ─────────────────────────────────────

const filaCei = (id, estado, extra = {}) => ({
  id, tipo: "visceras_recepcion", estado, recepcion_id: 2, referencia: "TC VISC R2", enviado_at: `2026-11-20T03:0${id % 10}:00Z`, ...extra,
});
const compensacionOk = (id, origen) => ({
  id, tipo: "ajuste_faltante", estado: "ok", recepcion_id: null, recepcion_ids: [2], envio_origen_id: origen, enviado_at: "2026-11-20T03:00:30Z",
});

test("tope: un solo intento que dejó 3 filas de error por rondas (con compensación entre ellas) NO agota el tope", async () => {
  nuevo();
  db.carnes_siesa_envios.push(
    filaCei(21, "error"), compensacionOk(31, 21),
    filaCei(22, "error"), compensacionOk(32, 22),
    filaCei(23, "error"),
  );
  guion = [{ ok: true }];
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "ok", "1 intento fallido en total: todavía se reintenta");
  assert.equal(llamadas.length, 1);
});

test("tope: tres intentos con error (una fila cada uno) sí lo agotan, aunque haya compensaciones fallidas", async () => {
  nuevo();
  db.carnes_siesa_envios.push(
    filaCei(21, "error"),
    filaCei(22, "error"),
    filaCei(23, "error"),
    { ...compensacionOk(33, 23), estado: "error" },
  );
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "agotado");
  assert.equal(llamadas.length, 0);
});

test("tope: dos intentos multironda (filas con compensaciones ok) + uno simple = 3 intentos: agotado", async () => {
  nuevo();
  db.carnes_siesa_envios.push(
    filaCei(21, "error"), compensacionOk(31, 21), filaCei(22, "error"),
    filaCei(23, "error"), compensacionOk(32, 23), filaCei(24, "error"),
    filaCei(25, "error"),
  );
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "agotado");
});

// ─── Sin compensación automática ───────────────────────────────────────────

const FALTANTE_VISCERA = {
  codigo: 1,
  detalle: [{ f_valor: "Item:0020101Bodega:00201", f_detalle: "Movto Inventario: Item sin cantidad disponible Faltante Inv.: -1.5 Faltante Adic.: 0.0000" }],
  mensaje: "Error al importar el plano",
};

test("camino automático: un rechazo por faltante NO dispara documentos de compensación (ajuste_faltante)", async () => {
  nuevo();
  guion = [{ ok: false, error: "faltante", respuesta: FALTANTE_VISCERA }, { ok: true }, { ok: true }];
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "error");
  assert.equal(llamadas.length, 1, "un solo POST: nada de compensar ni reenviar");
  assert.equal(db.carnes_siesa_envios.filter((f) => f.tipo === "ajuste_faltante").length, 0);
  assert.equal(cei().length, 1);
  assert.equal(correosError.length, 1, "la persona se entera por el correo del envío");
});

test("el reintento manual SÍ conserva la compensación por faltante (no se tocó)", async () => {
  nuevo();
  process.env.CARNES_SIESA_VISCERAS_AL_CIERRE = "true";
  guion = [{ ok: false, error: "faltante", respuesta: FALTANTE_VISCERA }, { ok: true }, { ok: true }];
  const r = await M.reintentarViscerasRecepcion(2, "admin");
  assert.equal(r.estado, "ok", JSON.stringify(r));
  assert.equal(db.carnes_siesa_envios.filter((f) => f.tipo === "ajuste_faltante").length, 1);
});

// ─── 503 "leer tardó demasiado" ───────────────────────────────────────────

test("si ejecutarAjuste no tiene tiempo para el primer POST (503) el resultado es sin_tiempo, sin fila ni POST", async () => {
  nuevo();
  const real = Date.now;
  let tras = 0;
  let armada = false;
  Date.now = () => {
    if (!armada) return real();
    tras += 1;
    return real() + (tras >= 2 ? 100_000 : 0);
  };
  try {
    const r = await M.enviarViscerasPreliquidacion(2, {
      restante: () => {
        armada = true;
        return 60_000;
      },
    });
    assert.equal(r.estado, "sin_tiempo", JSON.stringify(r));
  } finally {
    Date.now = real;
  }
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

// ─── CEA anterior al 29/09 con las vísceras adentro ────────────────────────

test("una oficial vieja que ya lleva las vísceras como renglón bloquea el CEI (no se entran dos veces)", async () => {
  nuevo();
  const oficial = db.carnes_siesa_envios.find((f) => f.tipo === "oficial");
  oficial.payload = { Movimientos: [{ ITEM: "20101", BODEGA: "00201", CANTIDAD: 33.3 }] };
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "bloqueado");
  assert.match(r.error, /Mondongo|20101/);
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("una oficial sin las vísceras en su payload no bloquea", async () => {
  nuevo();
  const oficial = db.carnes_siesa_envios.find((f) => f.tipo === "oficial");
  oficial.payload = { Movimientos: [{ ITEM: "1", BODEGA: "00201", CANTIDAD: 10 }] };
  assert.equal((await M.enviarViscerasPreliquidacion(2, { restante: amplio })).estado, "ok");
});

// ─── Sin tiempo en el CEI del cierre: resultado claro, no el 503 de la liquidación ──────

test("enviarViscerasRecepcion: si el pedido ya gastó su tiempo responde sin_tiempo (no 'Leer la liquidación tardó demasiado')", async () => {
  nuevo();
  process.env.CARNES_SIESA_VISCERAS_AL_CIERRE = "true";
  const r = await M.enviarViscerasRecepcion(2, "recibidor", { inicio: Date.now() - 10 * 60 * 1000 });
  assert.equal(r.estado, "sin_tiempo");
  assert.equal(r.error ?? null, null);
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

// ─── Compensación en vuelo: el camino automático no reenvía encima ──────────────────────

const compensacionEnVuelo = () => ({
  id: 40, tipo: "ajuste_faltante", estado: "enviando", recepcion_id: null, liquidacion_id: null, recepcion_ids: [2],
  referencia: "TC FALT R2", bodega: "00201", enviado_at: "2026-11-20T03:00:30Z",
});

test("camino automático: una compensación por faltante en vuelo bloquea el reenvío (no manda, no deja fila)", async () => {
  nuevo();
  db.carnes_siesa_envios.push(compensacionEnVuelo());
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "compensacion_en_curso");
  assert.match(r.error, /TC FALT R2/);
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});

test("camino automático: una compensación ya terminada (ok) no estorba", async () => {
  nuevo();
  db.carnes_siesa_envios.push({ ...compensacionEnVuelo(), estado: "ok" });
  const r = await M.enviarViscerasPreliquidacion(2, { restante: amplio });
  assert.equal(r.estado, "ok");
});

// ─── Reintento manual: mismo candado de "vísceras ya en la CEA" ─────────────────────────

test("reintento manual de una recepción vinculada: si la oficial anterior ya trae las vísceras, 409 (no las entra dos veces)", async () => {
  nuevo();
  db.carnes_preliquidacion_sedes = [{ id: 11, recepcion_id: 2, estado: "enviada" }];
  const oficial = db.carnes_siesa_envios.find((f) => f.tipo === "oficial");
  oficial.payload = { Movimientos: [{ ITEM: "20101", BODEGA: "00201", CANTIDAD: "33.30", UNIDAD_MEDIDA: "KL" }] };
  await assert.rejects(
    () => M.reintentarViscerasRecepcion(2, "admin"),
    (e) => e.statusCode === 409 && /Mondongo/.test(e.message),
  );
  assert.equal(llamadas.length, 0);
  assert.equal(cei().length, 0);
});
