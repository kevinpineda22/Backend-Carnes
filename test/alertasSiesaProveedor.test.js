// Alerta por correo de recepciones de proveedor que no llegaron a SIESA: clasificación,
// barrido, dedupe (reclamo / liberación), destinatarios vacíos, sandbox y paginación.
// Base y correo FALSOS (se inyectan): nada sale a la red ni toca Supabase.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const {
  clasificarRecepcion,
  armarCorreoAlerta,
  alertarRecepcion,
  alertarEnvioProveedorFallido,
  limpiarAlertaSiesa,
  barrerProveedoresSinSiesa,
  minutosDeAlerta,
  reiniciarAvisoSinDestinatarios,
  MOTIVOS,
} = await import("../src/services/alertasSiesaProveedor.js");
const { destinatariosSiesaProveedores } = await import("../src/services/email.service.js");

// ─── Base falsa con los filtros que usa el servicio ───
let db;
let consultas;
let fallo;
const MAX_FILAS = 1000; // PostgREST corta en silencio a 1000 filas

class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.pay = null; this.ord = null; this.lim = null; this.rng = null; this.one = false; }
  select() { return this; }
  update(p) { this.op = "update"; this.pay = p; return this; }
  eq(c, v) { this.f.push((r) => r[c] != null && String(r[c]) === String(v)); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, _op, v) { this.f.push((r) => (v === null ? r[c] != null : r[c] !== v)); return this; }
  in(c, a) { this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  gt(c, v) { this.f.push((r) => r[c] > v); return this; }
  gte(c, v) { this.f.push((r) => r[c] != null && new Date(r[c]) >= new Date(v)); return this; }
  lte(c, v) { this.f.push((r) => r[c] != null && new Date(r[c]) <= new Date(v)); return this; }
  order(c, o) { this.ord = [c, o?.ascending !== false]; return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  maybeSingle() { this.one = true; return this; }
  run() {
    consultas.push({ t: this.t, op: this.op });
    const error = fallo?.(this.t, this.op);
    if (error) return { data: null, error };
    const tabla = (db[this.t] ??= []);
    let rows = tabla.filter((r) => this.f.every((g) => g(r)));
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.pay);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    if (this.ord) {
      const [c, asc] = this.ord;
      rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
    rows = rows.slice(0, Math.min(this.lim ?? MAX_FILAS, MAX_FILAS));
    return this.one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  }
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
}
const dbFalsa = { from: (t) => new Q(t) };

// ─── Correo falso ───
let correos;
let respuestaCorreo;
const enviar = async (mail) => {
  correos.push(mail);
  if (respuestaCorreo instanceof Error) throw respuestaCorreo;
  return respuestaCorreo;
};
const DESTINOS = ["inventarios@ejemplo.test", "logistica@ejemplo.test"];
let destinos;
const deps = () => ({ db: dbFalsa, enviar, destinatarios: () => destinos });

const AHORA = new Date("2026-11-27T15:00:00Z");
const hace = (min) => new Date(AHORA.getTime() - min * 60_000).toISOString();

const recepcion = (id, over = {}) => ({
  id,
  estado: "Finalizada",
  proveedor_razon_social: `PROVEEDOR ${id}`,
  proveedor_nit: "900123456",
  proveedor_sucursal: "001",
  factura: `FE-${id}`,
  factura_siesa: null,
  bodega_siesa: "B07",
  codigo_co: "07",
  fecha_recepcion: "2026-11-25",
  finalizado_at: hace(120),
  recibido_por: "recibidor@ejemplo.test",
  recibidor_nombre: "ANA PEREZ",
  sede: { nombre: "Lopez", codigo_co: "07" },
  alerta_siesa_at: null,
  alerta_siesa_motivo: null,
  ...over,
});
let seqEnvio;
const envio = (recepcionId, estado, over = {}) => ({
  id: ++seqEnvio,
  recepcion_proveedor_id: recepcionId,
  tipo: "entrada_proveedor",
  estado,
  referencia: `CEA-${recepcionId}`,
  error: estado === "error" ? "SIESA dijo no" : null,
  enviado_at: hace(100),
  ...over,
});

const silenciar = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  db = { carnes_proveedor_recepciones: [], carnes_siesa_envios: [] };
  consultas = [];
  fallo = null;
  correos = [];
  respuestaCorreo = { success: true };
  destinos = DESTINOS;
  seqEnvio = 0;
  reiniciarAvisoSinDestinatarios();
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});
test.after(() => Object.assign(console, silenciar));

// ─── Clasificación ───

test("clasificar: sin ningún envío → sin_envio, y anota si SIESA está apagado", () => {
  const encendido = clasificarRecepcion({ envios: [], ahora: AHORA, activo: true });
  assert.equal(encendido.motivo, MOTIVOS.SIN_ENVIO);
  assert.doesNotMatch(encendido.detalle, /apagado/);
  const apagado = clasificarRecepcion({ envios: [], ahora: AHORA, activo: false });
  assert.equal(apagado.motivo, MOTIVOS.SIN_ENVIO);
  assert.match(apagado.detalle, /apagado/);
});

test("clasificar: error y sin_confirmar usan el último envío y su mensaje", () => {
  const e = clasificarRecepcion({ envios: [envio(1, "error", { error: "NIT inválido" })], ahora: AHORA });
  assert.equal(e.motivo, MOTIVOS.ERROR);
  assert.match(e.detalle, /NIT inválido/);
  const s = clasificarRecepcion({ envios: [envio(1, "sin_confirmar", { error: "timeout" })], ahora: AHORA });
  assert.equal(s.motivo, MOTIVOS.SIN_CONFIRMAR);
  assert.match(s.detalle, /timeout/);
});

test("clasificar: con una entrada ok no hay nada que avisar, aunque haya errores viejos", () => {
  const envios = [envio(1, "error", { enviado_at: hace(90) }), envio(1, "ok", { enviado_at: hace(60) })];
  assert.equal(clasificarRecepcion({ envios, ahora: AHORA }), null);
});

test("clasificar: enviando joven se salta; enviando de más de 6 minutos es abandonado", () => {
  assert.equal(clasificarRecepcion({ envios: [envio(1, "enviando", { enviado_at: hace(5) })], ahora: AHORA }), null);
  const viejo = clasificarRecepcion({ envios: [envio(1, "enviando", { enviado_at: hace(7) })], ahora: AHORA });
  assert.equal(viejo.motivo, MOTIVOS.ENVIANDO_ABANDONADO);
});

test("clasificar: ignora entradas anuladas y notas crédito", () => {
  const anulada = envio(1, "anulado", { enviado_at: hace(50) });
  const nc = envio(1, "ok", { tipo: "nc_proveedor" });
  const r = clasificarRecepcion({ envios: [anulada, nc], ahora: AHORA });
  assert.equal(r.motivo, MOTIVOS.SIN_ENVIO);
});

test("minutosDeAlerta: 30 por defecto y respeta CARNES_ALERTA_SIESA_MIN", () => {
  assert.equal(minutosDeAlerta({}), 30);
  assert.equal(minutosDeAlerta({ CARNES_ALERTA_SIESA_MIN: "45" }), 45);
  assert.equal(minutosDeAlerta({ CARNES_ALERTA_SIESA_MIN: "abc" }), 30);
  assert.equal(minutosDeAlerta({ CARNES_ALERTA_SIESA_MIN: "0" }), 30);
});

// ─── Correo ───

test("correo: asunto y cuerpo con proveedor, factura, sede, recibidor, motivo y enlace al panel", () => {
  const { subject, html } = armarCorreoAlerta({
    recepcion: recepcion(7, { factura_siesa: "FE7-SIESA" }),
    motivo: MOTIVOS.ERROR,
    detalle: "Falló <b>algo</b>",
    panel: "https://panel.ejemplo.test/admin",
  });
  assert.equal(subject, "Recepción de proveedor sin subir a SIESA — #7 PROVEEDOR 7");
  for (const texto of ["PROVEEDOR 7", "900123456 / 001", "FE-7", "FE7-SIESA", "Lopez", "07 / B07", "ANA PEREZ", "recibidor@ejemplo.test", "25/11/2026", "https://panel.ejemplo.test/admin", "Actualizar estado con SIESA / reintentar"]) {
    assert.ok(html.includes(texto), `falta "${texto}"`);
  }
  assert.ok(html.includes("Falló &lt;b&gt;algo&lt;/b&gt;"), "el detalle debe ir escapado");
});

test("destinatarios: sin valor por defecto ni respaldo a CARNES_MAIL_ADMIN / CARNES_MAIL_PROVEEDORES", () => {
  const previo = { ...process.env };
  try {
    process.env.CARNES_MAIL_ADMIN = "admin@ejemplo.test";
    process.env.CARNES_MAIL_PROVEEDORES = "prov@ejemplo.test";
    delete process.env.CARNES_MAIL_SIESA_PROVEEDORES;
    assert.deepEqual(destinatariosSiesaProveedores(), []);
    process.env.CARNES_MAIL_SIESA_PROVEEDORES = "a@x.test, b@x.test;A@x.test";
    assert.deepEqual(destinatariosSiesaProveedores(), ["a@x.test", "b@x.test"]);
  } finally {
    for (const k of ["CARNES_MAIL_ADMIN", "CARNES_MAIL_PROVEEDORES", "CARNES_MAIL_SIESA_PROVEEDORES"]) {
      if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k];
    }
  }
});

// ─── Reclamo, envío y liberación ───

test("alertarRecepcion: reclama antes de mandar y deja la marca puesta si el correo salió", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  const r = await alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
  assert.equal(r.estado, "enviada");
  assert.equal(correos.length, 1);
  assert.deepEqual(correos[0].to, DESTINOS);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, AHORA.toISOString());
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, "error");
});

test("alertarRecepcion: ya alertada no manda nada (el reclamo atómico pierde)", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1, { alerta_siesa_at: hace(10) })];
  const r = await alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
  assert.equal(r.estado, "ya_alertada");
  assert.equal(correos.length, 0);
});

test("alertarRecepcion: dos llamadas simultáneas mandan UN solo correo", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  const una = () => alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
  const [a, b] = await Promise.all([una(), una()]);
  assert.deepEqual([a.estado, b.estado].sort(), ["enviada", "ya_alertada"]);
  assert.equal(correos.length, 1);
});

test("alertarRecepcion: si el correo falla (success:false) libera el reclamo para el siguiente barrido", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  respuestaCorreo = { success: false, error: "SMTP caído" };
  const r = await alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
  assert.equal(r.estado, "fallida");
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, null);
});

test("alertarRecepcion: si el correo LANZA, no lanza y libera el reclamo", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  respuestaCorreo = new Error("boom");
  const r = await alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
  assert.equal(r.estado, "fallida");
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
});

test("alertarRecepcion: sandbox (no salió de verdad) libera el reclamo", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  respuestaCorreo = { success: true, sandbox: true };
  const r = await alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
  assert.equal(r.estado, "sandbox");
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
});

test("sandbox real: con CARNES_SANDBOX=true el correo no sale y el reclamo se libera", async () => {
  const previo = process.env.CARNES_SANDBOX;
  process.env.CARNES_SANDBOX = "true";
  try {
    db.carnes_proveedor_recepciones = [recepcion(1)];
    const r = await alertarRecepcion(
      { recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" },
      { ahora: AHORA, db: dbFalsa, destinatarios: () => DESTINOS }, // `enviar` real: sendEmail
    );
    assert.equal(r.estado, "sandbox");
    assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
  } finally {
    if (previo === undefined) delete process.env.CARNES_SANDBOX; else process.env.CARNES_SANDBOX = previo;
  }
});

test("alertarRecepcion: sin destinatarios no toca la base ni manda, y avisa UNA vez en el log", async () => {
  destinos = [];
  db.carnes_proveedor_recepciones = [recepcion(1)];
  const avisos = [];
  console.warn = (m) => avisos.push(m);
  for (let i = 0; i < 3; i += 1) {
    const r = await alertarRecepcion({ recepcion: recepcion(1), motivo: MOTIVOS.ERROR, detalle: "x" }, { ahora: AHORA, ...deps() });
    assert.equal(r.estado, "sin_destinatarios");
  }
  assert.equal(correos.length, 0);
  assert.equal(consultas.length, 0);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /CARNES_MAIL_SIESA_PROVEEDORES/);
});

// ─── Alerta inmediata ───

test("inmediata: un envío en error avisa con el mensaje de SIESA y sella la recepción", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3)];
  const r = await alertarEnvioProveedorFallido(envio(3, "error", { error: "Tercero no existe" }), { ahora: AHORA, ...deps() });
  assert.equal(r.estado, "enviada");
  assert.match(correos[0].html, /Tercero no existe/);
  assert.match(correos[0].subject, /#3 PROVEEDOR 3/);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, "error");
});

test("inmediata: sin_confirmar avisa con motivo sin_confirmar", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3)];
  await alertarEnvioProveedorFallido(envio(3, "sin_confirmar", { error: "timeout" }), { ahora: AHORA, ...deps() });
  assert.equal(correos.length, 1);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, "sin_confirmar");
});

test("inmediata: una nota crédito fallida avisa como Nota crédito", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3, { estado: "Enviada_SIESA" })];
  await alertarEnvioProveedorFallido(envio(3, "error", { tipo: "nc_proveedor" }), { ahora: AHORA, ...deps() });
  assert.equal(correos.length, 1);
  assert.match(correos[0].html, /Nota crédito/);
});

test("inmediata: no avisa de envíos ok, de recepciones anuladas ni de dos fallos seguidos", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3), recepcion(4, { estado: "Anulada" })];
  assert.equal((await alertarEnvioProveedorFallido(envio(3, "ok"), deps())).estado, "no_aplica");
  assert.equal((await alertarEnvioProveedorFallido(envio(4, "error"), deps())).estado, "no_aplica");
  await alertarEnvioProveedorFallido(envio(3, "error"), { ahora: AHORA, ...deps() });
  const otra = await alertarEnvioProveedorFallido(envio(3, "error"), { ahora: AHORA, ...deps() });
  assert.equal(otra.estado, "ya_alertada");
  assert.equal(correos.length, 1);
});

test("inmediata: nunca lanza (base caída, correo que lanza) para no cambiar el resultado del envío", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3)];
  fallo = () => ({ code: "XX000", message: "base caída" });
  assert.deepEqual(await alertarEnvioProveedorFallido(envio(3, "error"), deps()), { estado: "error" });
  fallo = null;
  respuestaCorreo = new Error("smtp");
  await assert.doesNotReject(alertarEnvioProveedorFallido(envio(3, "error"), deps()));
  await assert.doesNotReject(alertarEnvioProveedorFallido(null, deps()));
});

test("inmediata: sin las columnas de sql/045 (42703) igual avisa, sin dedupe y sin romper", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3)];
  fallo = (t, op) => (t === "carnes_proveedor_recepciones" && op === "update" ? { code: "42703", message: "column alerta_siesa_at does not exist" } : null);
  const r = await alertarEnvioProveedorFallido(envio(3, "error"), deps());
  assert.equal(r.estado, "enviada");
  assert.equal(correos.length, 1);
});

test("limpiarAlertaSiesa: borra la marca; si falla o faltan las columnas, no lanza", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1, { alerta_siesa_at: hace(5), alerta_siesa_motivo: "error" })];
  await limpiarAlertaSiesa(1, deps());
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_motivo, null);
  fallo = () => ({ code: "42703", message: "column does not exist" });
  await assert.doesNotReject(limpiarAlertaSiesa(1, deps()));
  fallo = () => { throw new Error("red"); };
  await assert.doesNotReject(limpiarAlertaSiesa(1, deps()));
});

test("tras limpiar (reintento del admin) un nuevo fallo vuelve a avisar", async () => {
  db.carnes_proveedor_recepciones = [recepcion(3)];
  await alertarEnvioProveedorFallido(envio(3, "error"), { ahora: AHORA, ...deps() });
  await limpiarAlertaSiesa(3, deps());
  await alertarEnvioProveedorFallido(envio(3, "error"), { ahora: AHORA, ...deps() });
  assert.equal(correos.length, 2);
});

// ─── Barrido ───

test("barrido: avisa solo de las finalizadas hace más de N min, sin ok, dentro de 14 días y sin alertar", async () => {
  db.carnes_proveedor_recepciones = [
    recepcion(1), // sin envío → avisa
    recepcion(2), // error → avisa
    recepcion(3), // ok → no
    recepcion(4, { finalizado_at: hace(10) }), // reciente → no
    recepcion(5, { alerta_siesa_at: hace(60) }), // ya alertada → no
    recepcion(6, { finalizado_at: hace(15 * 24 * 60) }), // más de 14 días → no
    recepcion(7, { estado: "Enviada_SIESA" }), // ya enviada → no
    recepcion(8), // enviando joven → no
    recepcion(9), // enviando abandonado → avisa
    recepcion(10), // sin_confirmar → avisa
  ];
  db.carnes_siesa_envios = [
    envio(2, "error"),
    envio(3, "ok"),
    envio(8, "enviando", { enviado_at: hace(2) }),
    envio(9, "enviando", { enviado_at: hace(20) }),
    envio(10, "sin_confirmar"),
  ];
  const r = await barrerProveedoresSinSiesa({ minutos: 30, ahora: AHORA, activo: false }, deps());
  assert.equal(r.ok, true);
  assert.equal(r.enviadas, 4);
  assert.deepEqual(
    correos.map((c) => Number(c.subject.match(/#(\d+)/)[1])).sort((a, b) => a - b),
    [1, 2, 9, 10],
  );
  const motivos = Object.fromEntries(db.carnes_proveedor_recepciones.map((x) => [x.id, x.alerta_siesa_motivo]));
  assert.deepEqual([motivos[1], motivos[2], motivos[9], motivos[10]], ["sin_envio", "error", "enviando_abandonado", "sin_confirmar"]);
  assert.match(correos.find((c) => c.subject.includes("#1 ")).html, /apagado/);
});

test("barrido: es idempotente (el segundo no repite correos) y no toca las ya enviadas", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1), recepcion(2)];
  await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.equal(correos.length, 2);
  const r = await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.equal(correos.length, 2);
  assert.equal(r.candidatas, 0);
});

test("barrido: si el correo no sale, la recepción se reintenta en el siguiente barrido", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  respuestaCorreo = { success: false, error: "SMTP" };
  const r1 = await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.equal(r1.fallidas, 1);
  respuestaCorreo = { success: true };
  const r2 = await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.equal(r2.enviadas, 1);
  assert.equal(correos.length, 2);
});

test("barrido: en sandbox cuenta sandbox y no deja marca", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  respuestaCorreo = { success: true, sandbox: true };
  const r = await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.equal(r.sandbox, 1);
  assert.equal(db.carnes_proveedor_recepciones[0].alerta_siesa_at, null);
});

test("barrido: sin destinatarios no lee ni manda nada", async () => {
  destinos = [];
  db.carnes_proveedor_recepciones = [recepcion(1)];
  const r = await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.equal(r.omitido, "sin_destinatarios");
  assert.equal(r.ok, true);
  assert.equal(consultas.length, 0);
  assert.equal(correos.length, 0);
});

test("barrido: sin las columnas de sql/045 (42703) se omite con ok:true, sin lanzar ni mandar", async () => {
  db.carnes_proveedor_recepciones = [recepcion(1)];
  fallo = () => ({ code: "42703", message: "column carnes_proveedor_recepciones.alerta_siesa_at does not exist" });
  const r = await barrerProveedoresSinSiesa({ ahora: AHORA }, deps());
  assert.deepEqual([r.ok, r.omitido], [true, "migracion_faltante"]);
  assert.equal(correos.length, 0);
});

test("barrido: un fallo de lectura que no es de migración LANZA (el cron responde 500)", async () => {
  fallo = () => ({ code: "XX000", message: "base caída" });
  await assert.rejects(barrerProveedoresSinSiesa({ ahora: AHORA }, deps()), /base caída/);
});

test("barrido: pagina las recepciones y los envíos (no se queda en el tope de 1000 de PostgREST)", async () => {
  const N = 1250;
  db.carnes_proveedor_recepciones = Array.from({ length: N }, (_, i) => recepcion(i + 1));
  // La mitad con error (un envío cada una), la otra mitad sin envío.
  db.carnes_siesa_envios = Array.from({ length: N / 2 }, (_, i) => envio(i + 1, "error"));
  const r = await barrerProveedoresSinSiesa({ ahora: AHORA, maxAlertas: Infinity, pagina: 1000, lote: 1250 }, deps());
  assert.equal(r.revisadas, N, "debe leer las 1250 recepciones, no solo 1000");
  assert.equal(r.enviadas, N);
  const marcadas = db.carnes_proveedor_recepciones.filter((x) => x.alerta_siesa_at).length;
  assert.equal(marcadas, N);
  const motivos = new Set(db.carnes_proveedor_recepciones.slice(0, N / 2).map((x) => x.alerta_siesa_motivo));
  assert.deepEqual([...motivos], ["error"]);
});

test("barrido: pagina con tamaños chicos y lotes de ids", async () => {
  db.carnes_proveedor_recepciones = Array.from({ length: 7 }, (_, i) => recepcion(i + 1));
  db.carnes_siesa_envios = [envio(1, "ok"), envio(4, "ok"), envio(7, "ok")];
  const r = await barrerProveedoresSinSiesa({ ahora: AHORA, pagina: 2, lote: 3 }, deps());
  assert.equal(r.revisadas, 7);
  assert.equal(r.enviadas, 4);
});

test("barrido: respeta el tope por corrida y deja el resto como pendientes", async () => {
  db.carnes_proveedor_recepciones = Array.from({ length: 5 }, (_, i) => recepcion(i + 1));
  const r1 = await barrerProveedoresSinSiesa({ ahora: AHORA, maxAlertas: 2 }, deps());
  assert.deepEqual([r1.enviadas, r1.pendientes], [2, 3]);
  const r2 = await barrerProveedoresSinSiesa({ ahora: AHORA, maxAlertas: 2 }, deps());
  assert.deepEqual([r2.enviadas, r2.pendientes], [2, 1]);
  assert.equal(correos.length, 4);
});
