// La alerta inmediata dentro de `registrarYEnviar` (vía enviarEntradaProveedor): un envío de
// proveedor en error o sin_confirmar avisa; uno ok no; y el correo NUNCA cambia el resultado del
// envío (ni siquiera si lanza). También: el reintento del admin borra la marca de alerta.
// Supabase, SIESA y correo FALSOS: nada sale a la red.
import test, { mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.CARNES_SIESA_ACTIVO = "true";
process.env.CONNEKTA_BASE_URL = "http://fake.invalid/api/connekta/v3";
process.env.CONNEKTA_ID_COMPANIA = "1";
process.env.CONNI_KEY = "k";
process.env.CONNI_TOKEN = "t";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

// ─── Base falsa ───
const db = {};
let seq = 0;
const VIG = ["enviando", "ok", "sin_confirmar"];
const reiniciar = () => {
  db.carnes_proveedor_recepciones = [
    {
      id: 12, estado: "Finalizada", proveedor_id: 1, proveedor_nit: "900123456", proveedor_sucursal: "001",
      proveedor_razon_social: "NUTRESA S.A.S.", factura: "FE-00123", factura_siesa: null, sede_id: 9,
      bodega_siesa: "B07", codigo_co: "07", fecha_recepcion: "2026-11-25", recibido_por: "r@ejemplo.test",
      recibidor_nombre: "ANA", finalizado_at: "2026-11-25T15:00:00Z", siesa_at: null, descuento_pct: 0,
      sede: { id: 9, codigo_co: "07", nombre: "Lopez" }, alerta_siesa_at: null, alerta_siesa_motivo: null,
    },
  ];
  db.carnes_proveedor_recepcion_items = [
    {
      id: 1, recepcion_id: 12, orden: 1, codigo_item: "15167", descripcion_item: "CARNE PARA MOLER", unidad: "KL",
      equivalencia: "Molida", cantidad: 100, valor_unitario: 20000, valor_total: 2000000, valor_fuente: "unitario",
      cantidad_devuelta: 0, motivo_devolucion: null,
    },
  ];
  db.carnes_siesa_envios = [];
  seq = 100;
};

class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.pay = null; this.ord = []; this.lim = null; this.one = false; }
  select() { return this; }
  insert(p) { this.op = "insert"; this.pay = p; return this; }
  update(p) { this.op = "update"; this.pay = p; return this; }
  eq(c, v) { this.f.push((r) => r[c] != null && String(r[c]) === String(v)); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, _o, v) { this.f.push((r) => (v === null ? r[c] != null : r[c] !== v)); return this; }
  or(expr) {
    // Solo la forma que usa el servicio: `col.is.null,and(col.is.null,col.lt.ISO)`.
    const dividir = (txt) => {
      const partes = []; let prof = 0; let ini = 0;
      for (let i = 0; i < txt.length; i += 1) {
        if (txt[i] === "(") prof += 1;
        else if (txt[i] === ")") prof -= 1;
        else if (txt[i] === "," && prof === 0) { partes.push(txt.slice(ini, i)); ini = i + 1; }
      }
      partes.push(txt.slice(ini));
      return partes;
    };
    const evaluar = (t) => {
      if (t.startsWith("and(")) { const hs = dividir(t.slice(4, -1)).map(evaluar); return (r) => hs.every((h) => h(r)); }
      const m = /^([a-z_]+)\.(is|lt)\.(.+)$/.exec(t);
      if (m[2] === "is") return (r) => r[m[1]] == null;
      return (r) => r[m[1]] != null && new Date(r[m[1]]) < new Date(m[3]);
    };
    const hs = dividir(expr).map(evaluar);
    this.f.push((r) => hs.some((h) => h(r)));
    return this;
  }
  in(c, a) { this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  run() {
    const tabla = (db[this.t] ??= []);
    let rows = tabla.filter((r) => this.f.every((g) => g(r)));
    if (this.op === "insert") {
      const nuevo = { id: ++seq, enviado_at: new Date().toISOString(), ...this.pay };
      if (this.t === "carnes_siesa_envios" && VIG.includes(nuevo.estado) &&
        tabla.some((r) => VIG.includes(r.estado) && r.recepcion_proveedor_id === nuevo.recepcion_proveedor_id && r.tipo === nuevo.tipo)) {
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
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
}

// ─── SIESA y correo falsos ───
let guion = [];
const enviarASiesaFalso = async () => {
  const r = guion.shift() ?? { ok: true };
  return r.ok
    ? { ok: true, status: 200, respuesta: { ok: 1 }, error: null }
    : { ok: false, incierto: Boolean(r.incierto), status: r.incierto ? null : 400, respuesta: { e: 1 }, error: r.error ?? "SIESA dijo no" };
};
let correos = [];
let correoLanza = false;
let correoBloqueado = null;

mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: (t) => new Q(t) } } });
mock.module(url("services/siesa.service.js"), {
  namedExports: { enviarASiesa: enviarASiesaFalso, TIMEOUT_INICIAL_MS: 90000, TIMEOUT_OFICIAL_MS: 240000 },
});
mock.module(url("services/notificaciones.service.js"), {
  namedExports: {
    notificarAnularIniciales: async () => ({ success: true }),
    notificarAnularInicial: async () => ({ success: true }),
    notificarErrorEnvioSiesa: async () => ({ success: true }),
  },
});
mock.module(url("services/email.service.js"), {
  namedExports: {
    sendEmail: async (mail) => {
      if (correoBloqueado) await correoBloqueado;
      if (correoLanza) throw new Error("smtp roto");
      correos.push(mail);
      return { success: true };
    },
    destinatariosSiesaProveedores: () => ["alertas@ejemplo.test"],
  },
});
mock.module(url("models/PreliquidacionCierre.model.js"), {
  namedExports: { intentarAutocierre: async () => ({ cerrada: false }), cerrarPreliquidacion: async () => ({ resultado: "ok" }) },
});

const M = await import(url("models/SiesaEnvio.model.js"));
const { esperarAlertasPendientes } = await import(url("services/alertasSiesaProveedor.js"));
// La alerta corre en segundo plano (no retrasa el envío): los tests esperan a que termine.
const entrada = async (...a) => { const r = await M.enviarEntradaProveedor(...a); await esperarAlertasPendientes(); return r; };
const reintentarEntrada = async (...a) => { const r = await M.reintentarEntradaProveedor(...a); await esperarAlertasPendientes(); return r; };
const reintentarNC = async (...a) => { const r = await M.reintentarNotaCreditoProveedor(...a); await esperarAlertasPendientes(); return r; };

const silenciar = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  reiniciar();
  guion = [];
  correos = [];
  correoLanza = false;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});
after(() => Object.assign(console, silenciar));

test("entrada rechazada por SIESA (error): avisa con el mensaje y el envío queda en error", async () => {
  guion = [{ ok: false, error: "Tercero inexistente" }];
  const r = await entrada(12, "sistema");
  assert.equal(r.siesa.estado, "error");
  assert.equal(correos.length, 1);
  assert.match(correos[0].subject, /#12 NUTRESA/);
  assert.match(correos[0].html, /Tercero inexistente/);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, "error");
});

test("entrada sin_confirmar: avisa y el envío queda sin_confirmar", async () => {
  guion = [{ ok: false, incierto: true, error: "timeout de SIESA" }];
  const r = await entrada(12, "sistema");
  assert.equal(r.siesa.estado, "sin_confirmar");
  assert.equal(correos.length, 1);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, "sin_confirmar");
});

test("entrada ok: no avisa y la recepción pasa a Enviada_SIESA", async () => {
  const r = await entrada(12, "sistema");
  assert.equal(r.siesa.estado, "ok");
  assert.equal(correos.length, 0);
  assert.equal(db.carnes_proveedor_recepciones[0].estado, "Enviada_SIESA");
});

test("si el correo lanza, el resultado del envío NO cambia", async () => {
  correoLanza = true;
  guion = [{ ok: false, error: "SIESA dijo no" }];
  const r = await entrada(12, "sistema");
  assert.equal(r.siesa.estado, "error");
  assert.equal(r.siesa.error, "SIESA dijo no");
  const fila = db.carnes_siesa_envios.find((e) => e.tipo === "entrada_proveedor");
  assert.equal(fila.estado, "error");
  // El reclamo se liberó: el barrido lo reintentará.
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
});

test("entrada bloqueada antes de SIESA (ítem sin código): también avisa, con el motivo del bloqueo", async () => {
  db.carnes_proveedor_recepcion_items[0].codigo_item = "";
  const r = await entrada(12, "sistema");
  assert.equal(r.siesa.estado, "error");
  assert.equal(correos.length, 1);
  assert.equal(db.carnes_siesa_envios[0].estado, "error");
});

test("reintento del admin: borra la marca y, si vuelve a fallar, avisa otra vez", async () => {
  guion = [{ ok: false, error: "falla 1" }, { ok: false, error: "falla 2" }];
  await entrada(12, "sistema");
  assert.equal(correos.length, 1);
  // Un error no se reintenta solo: la entrada previa en error deja ocupar el lugar al reintento manual.
  db.carnes_siesa_envios.forEach((e) => { e.estado = "error"; });
  await reintentarEntrada(12, "admin@ejemplo.test");
  assert.equal(correos.length, 2);
  assert.match(correos[1].html, /falla 2/);
});

// ─── Nota crédito: la marca se borra antes de reservar, no antes de las guardas ───

const conDevolucion = () => {
  db.carnes_proveedor_recepcion_items[0].cantidad_devuelta = 10;
  db.carnes_proveedor_recepcion_items[0].motivo_devolucion = "Mal estado";
};
const entradaOk = () => ({
  id: 1, recepcion_proveedor_id: 12, tipo: "entrada_proveedor", estado: "ok", referencia: "CEA-12",
  enviado_at: "2026-11-25T15:05:00Z", error: null,
});
const marcar = () => {
  Object.assign(db.carnes_proveedor_recepciones[0], {
    alerta_siesa_at: "2026-11-25T16:00:00Z", alerta_siesa_enviada_at: "2026-11-25T16:00:01Z", alerta_siesa_motivo: "error",
  });
};

test("reintento de la nota crédito: borra la marca de la entrada y avisa como Nota crédito", async () => {
  db.carnes_proveedor_recepciones[0].estado = "Enviada_SIESA";
  conDevolucion();
  db.carnes_siesa_envios = [entradaOk()];
  marcar();
  guion = [{ ok: false, error: "NC rechazada" }];
  await reintentarNC(12, "admin@ejemplo.test");
  assert.equal(correos.length, 1);
  assert.match(correos[0].subject, /^Nota crédito de proveedor sin subir a SIESA — #12/);
  assert.match(correos[0].html, /NC rechazada/);
});

test("la guarda 409 de la nota crédito NO borra la marca", async () => {
  db.carnes_proveedor_recepciones[0].estado = "Enviada_SIESA";
  conDevolucion();
  db.carnes_siesa_envios = [entradaOk(), { ...entradaOk(), id: 2, tipo: "nc_proveedor", referencia: "NC-12" }];
  marcar();
  await assert.rejects(reintentarNC(12, "admin@ejemplo.test"), (e) => e.statusCode === 409);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, "2026-11-25T16:00:00Z");
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_enviada_at, "2026-11-25T16:00:01Z");
});

test("reconciliar una entrada ya ok: la nota crédito que sale y falla avisa aunque la marca estuviera puesta", async () => {
  conDevolucion();
  db.carnes_siesa_envios = [entradaOk()];
  marcar();
  guion = [{ ok: false, error: "NC rechazada al reconciliar" }];
  const r = await reintentarEntrada(12, "admin@ejemplo.test");
  assert.equal(r.reconciliada, true);
  assert.equal(correos.length, 1);
  assert.match(correos[0].subject, /^Nota crédito de proveedor/);
});

test("resolver una entrada sin_confirmar como ok: la nota crédito que falla avisa", async () => {
  conDevolucion();
  db.carnes_siesa_envios = [{ ...entradaOk(), estado: "sin_confirmar" }];
  marcar();
  guion = [{ ok: false, error: "NC rechazada al resolver" }];
  await M.resolver(1, { resultado: "ok", por: "admin@ejemplo.test" });
  await esperarAlertasPendientes();
  assert.equal(correos.length, 1);
  assert.match(correos[0].html, /NC rechazada al resolver/);
});

test("el correo no retrasa el envío: la alerta inmediata corre en segundo plano", async () => {
  let liberar;
  const puerta = new Promise((r) => { liberar = r; });
  correoBloqueado = puerta;
  guion = [{ ok: false, error: "SIESA dijo no" }];
  const r = await M.enviarEntradaProveedor(12, "sistema"); // sin esperar las alertas
  assert.equal(r.siesa.estado, "error");
  assert.equal(correos.length, 0, "el envío respondió sin esperar el correo");
  liberar();
  await esperarAlertasPendientes();
  correoBloqueado = null;
  assert.equal(correos.length, 1);
});
