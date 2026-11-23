// Cola real de alertas de la preliquidación (4.1): encolar con deduplicación y despachar con
// reclamo, tope de intentos y marca solo tras un envío exitoso. Sin base, sin red, sin correo:
// la base y el transporte se inyectan.
import test from "node:test";
import assert from "node:assert/strict";

import { destinatariosPreliquidacion } from "../src/services/email.service.js";
import {
  encolarAlerta,
  despacharAlertas,
  EVENTOS_ALERTA,
  REGLA_OCURRENCIA,
  MAX_INTENTOS_ALERTA,
} from "../src/services/preliquidacionAlertas.js";

const ENV_ON = { CARNES_PRELIQUIDACION: "on", CARNES_MAIL_PRELIQUIDACION: "ops@example.test" };
const AHORA = new Date("2026-11-24T03:00:00.000Z");

function logger() {
  const llamadas = { info: [], warn: [], error: [] };
  return {
    llamadas,
    info: (...a) => llamadas.info.push(a.join(" ")),
    warn: (...a) => llamadas.warn.push(a.join(" ")),
    error: (...a) => llamadas.error.push(a.join(" ")),
  };
}

/** Base en memoria con la parte del cliente de Supabase que usa el puerto. Cada operación es atómica. */
function baseFalsa({ filas = [], falla = null } = {}) {
  const tabla = filas.map((f) => ({ ...f }));
  let secuencia = tabla.reduce((m, f) => Math.max(m, f.id ?? 0), 0);
  const llamadas = [];

  class Consulta {
    constructor(modo, valores, opciones) {
      this.modo = modo;
      this.valores = valores;
      this.opciones = opciones;
      this.filtros = [];
      this.limite = null;
      this.devuelve = false;
    }
    select() {
      this.devuelve = true;
      return this;
    }
    eq(c, v) {
      this.filtros.push((r) => String(r[c]) === String(v));
      return this;
    }
    is(c, v) {
      this.filtros.push((r) => (v === null ? r[c] == null : r[c] === v));
      return this;
    }
    lt(c, v) {
      this.filtros.push((r) => Number(r[c]) < Number(v));
      return this;
    }
    order() {
      return this;
    }
    limit(n) {
      this.limite = n;
      return this;
    }
    ejecutar() {
      llamadas.push({ modo: this.modo, valores: this.valores, opciones: this.opciones });
      if (falla) return { data: null, error: { message: falla } };
      if (this.modo === "upsert") {
        const claves = String(this.opciones?.onConflict ?? "").split(",");
        const existe = tabla.some((r) => claves.every((c) => String(r[c]) === String(this.valores[c])));
        if (existe) return { data: [], error: null };
        const fila = { id: ++secuencia, enviado_ok: false, intentos_envio: 0, reclamada_at: null, enviado_at: null, ...this.valores };
        tabla.push(fila);
        return { data: this.devuelve ? [{ ...fila }] : null, error: null };
      }
      let candidatas = tabla.filter((r) => this.filtros.every((f) => f(r)));
      if (this.modo === "update") {
        for (const r of candidatas) Object.assign(r, this.valores);
        return { data: this.devuelve ? candidatas.map((r) => ({ ...r })) : null, error: null };
      }
      if (this.limite != null) candidatas = candidatas.slice(0, this.limite);
      return { data: candidatas.map((r) => ({ ...r })), error: null };
    }
    then(res, rej) {
      return Promise.resolve(this.ejecutar()).then(res, rej);
    }
  }

  const db = {
    from: () => ({
      upsert: (valores, opciones) => new Consulta("upsert", valores, opciones),
      select: () => new Consulta("select").select(),
      update: (valores) => new Consulta("update", valores),
    }),
  };
  return { db, tabla, llamadas };
}

/** Transporte falso que registra lo enviado; `respuestas` se consume en orden (la última se repite). */
function transporte(respuestas = [{ success: true }]) {
  const enviados = [];
  const enviar = async (evento, contexto) => {
    enviados.push({ evento, contexto });
    const r = respuestas[Math.min(enviados.length - 1, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { enviar, enviados };
}

const base = (extra = {}) => ({ db: extra.db, log: logger(), env: ENV_ON, ...extra });

test("EVENTOS_ALERTA lista los 18 tipos del diseño y REGLA_OCURRENCIA cubre cada uno", () => {
  assert.equal(EVENTOS_ALERTA.length, 18);
  for (const e of EVENTOS_ALERTA) assert.ok(REGLA_OCURRENCIA[e], `falta regla para ${e}`);
});

test("encolarAlerta inserta la fila sin enviar correo (enviado_ok=false) con la clave normalizada", async () => {
  const { db, tabla } = baseFalsa();
  const r = await encolarAlerta(
    { evento: "excede_animales", preliquidacionId: 3, sedeId: 8, ocurrencia: 2, detalle: { restantes: 1, solicitados: 3 } },
    base({ db }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.encolada, true);
  assert.equal(tabla.length, 1);
  assert.deepEqual(
    { e: tabla[0].evento, p: tabla[0].preliquidacion_id, s: tabla[0].sede_id, o: tabla[0].ocurrencia, ok: tabla[0].enviado_ok },
    { e: "excede_animales", p: 3, s: 8, o: 2, ok: false },
  );
  assert.deepEqual(tabla[0].detalle, { restantes: 1, solicitados: 3 });
});

test("encolarAlerta usa INSERT ... ON CONFLICT DO NOTHING sobre la clave (evento, preliquidacion, sede, ocurrencia)", async () => {
  const { db, llamadas } = baseFalsa();
  await encolarAlerta({ evento: "utilidad_negativa", preliquidacionId: 1, sedeId: 2, ocurrencia: 3 }, base({ db }));
  assert.equal(llamadas[0].modo, "upsert");
  assert.equal(llamadas[0].opciones.onConflict, "evento,preliquidacion_id,sede_id,ocurrencia");
  assert.equal(llamadas[0].opciones.ignoreDuplicates, true);
});

test("la misma clave dos veces deja una sola fila (deduplicación)", async () => {
  const { db, tabla } = baseFalsa();
  const a = { evento: "envio_error", preliquidacionId: 1, sedeId: 5, ocurrencia: 4 };
  const r1 = await encolarAlerta(a, base({ db }));
  const r2 = await encolarAlerta(a, base({ db }));
  assert.equal(r1.encolada, true);
  assert.equal(r2.encolada, false);
  assert.equal(r2.ok, true);
  assert.equal(tabla.length, 1);
});

test("ocurrencia por evento: las claves por preliquidación ignoran sede y ocurrencia sobrantes", async () => {
  const { db, tabla } = baseFalsa();
  for (const evento of ["ventana_vencida", "corrida_perdida", "cerrada"]) {
    await encolarAlerta({ evento, preliquidacionId: 9, sedeId: 77, ocurrencia: 123 }, base({ db }));
    await encolarAlerta({ evento, preliquidacionId: 9, sedeId: 0, ocurrencia: 0 }, base({ db }));
  }
  assert.equal(tabla.length, 3, "una fila por evento y preliquidación");
  assert.ok(tabla.every((f) => f.sede_id === 0 && f.ocurrencia === 0));
});

test("ocurrencia por evento: los avisos de recepción van con sede 0 y la recepción como ocurrencia", async () => {
  const { db, tabla } = baseFalsa();
  for (const evento of ["sin_preliquidacion", "fuera_ventana", "oficial_legacy"]) {
    await encolarAlerta({ evento, preliquidacionId: 0, sedeId: 55, ocurrencia: 101 }, base({ db }));
  }
  assert.ok(tabla.every((f) => f.sede_id === 0 && f.ocurrencia === 101));
});

test("ocurrencia por evento: servicio_tardio lleva el id de la alterna con sede 0; los de sede conservan sede y versión", async () => {
  const { db, tabla } = baseFalsa();
  await encolarAlerta({ evento: "servicio_tardio", preliquidacionId: 4, sedeId: 9, ocurrencia: 77 }, base({ db }));
  await encolarAlerta({ evento: "requiere_correccion", preliquidacionId: 4, sedeId: 9, ocurrencia: 6 }, base({ db }));
  assert.deepEqual([tabla[0].sede_id, tabla[0].ocurrencia], [0, 77]);
  assert.deepEqual([tabla[1].sede_id, tabla[1].ocurrencia], [9, 6]);
});

test("G4: con el flag apagado no se encola nada", async () => {
  const { db, tabla, llamadas } = baseFalsa();
  const r = await encolarAlerta(
    { evento: "excede_animales", preliquidacionId: 1, sedeId: 2, ocurrencia: 1 },
    { db, log: logger(), env: { CARNES_PRELIQUIDACION: "off", CARNES_MAIL_PRELIQUIDACION: "ops@example.test" } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.equal(tabla.length, 0);
  assert.equal(llamadas.length, 0);
});

test("la compuerta de auth en producción también apaga la cola", async () => {
  const { db, tabla } = baseFalsa();
  const env = { ...ENV_ON, VERCEL_ENV: "production" };
  const r = await encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }, { db, log: logger(), env });
  assert.equal(r.noop, true);
  assert.equal(tabla.length, 0);
});

test("G-S3: sin destinatarios se loguea la advertencia, no lanza y la alerta igual queda en cola", async () => {
  const { db, tabla } = baseFalsa();
  const log = logger();
  const r = await encolarAlerta({ evento: "utilidad_negativa", preliquidacionId: 1, sedeId: 1, ocurrencia: 1 }, { db, log, env: { CARNES_PRELIQUIDACION: "on" } });
  assert.equal(r.ok, true);
  assert.equal(log.llamadas.warn.length, 1);
  assert.match(log.llamadas.warn[0], /CARNES_MAIL_PRELIQUIDACION/);
  assert.equal(tabla.length, 1);
});

test("encolarAlerta nunca lanza: entradas rotas, evento desconocido y base caída", async () => {
  const { db } = baseFalsa();
  for (const entrada of [undefined, null, {}, { evento: 42 }, "texto", { evento: "no_existe" }]) {
    const r = await encolarAlerta(entrada, base({ db }));
    assert.equal(r.ok, true);
    assert.equal(r.noop, true);
  }
  const caida = baseFalsa({ falla: "base caída" });
  const log = logger();
  const r = await encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }, { db: caida.db, log, env: ENV_ON });
  assert.equal(r.ok, false);
  assert.match(log.llamadas.error[0], /base caída/);

  const lanza = { from: () => { throw new Error("cliente roto"); } };
  const r2 = await encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }, { db: lanza, log: logger(), env: ENV_ON });
  assert.equal(r2.ok, false);
});

test("un logger que falla tampoco rompe el flujo", async () => {
  const { db } = baseFalsa();
  const log = { info: () => { throw new Error("log roto"); }, warn: () => { throw new Error("log roto"); }, error: () => { throw new Error("log roto"); } };
  const r = await encolarAlerta({ evento: "no_existe" }, { db, log, env: {} });
  assert.equal(r.ok, true);
  const r2 = await encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }, { db: baseFalsa({ falla: "x" }).db, log, env: ENV_ON });
  assert.equal(r2.ok, false);
});

// ─── despacharAlertas ──────────────────────────────────────────────────────

async function conCola(alertas, { respuestas, ...opciones } = {}) {
  const almacen = baseFalsa();
  for (const a of alertas) await encolarAlerta(a, base({ db: almacen.db }));
  const t = transporte(respuestas);
  const despachar = (contexto = { ahora: AHORA }, extra = {}) =>
    despacharAlertas(contexto, { db: almacen.db, log: logger(), env: ENV_ON, enviar: t.enviar, destinatarios: () => ["ops@example.test"], sandbox: () => false, ...opciones, ...extra });
  return { almacen, t, despachar };
}

const ALERTA = { evento: "excede_animales", preliquidacionId: 3, sedeId: 8, ocurrencia: 2, detalle: { restantes: 1, solicitados: 3 } };

test("G-S1: el contexto del envío lleva evento, claves y el detalle (restantes=1, solicitados=3)", async () => {
  const { t, despachar } = await conCola([ALERTA]);
  const r = await despachar();
  assert.equal(r.enviadas, 1);
  assert.equal(t.enviados.length, 1);
  assert.equal(t.enviados[0].evento, "excede_animales");
  assert.deepEqual(
    { ...t.enviados[0].contexto },
    { preliquidacion_id: 3, sede_id: 8, ocurrencia: 2, restantes: 1, solicitados: 3 },
  );
});

test("marca enviado_ok y enviado_at solo después de un envío exitoso", async () => {
  const { almacen, despachar } = await conCola([ALERTA]);
  await despachar();
  assert.equal(almacen.tabla[0].enviado_ok, true);
  assert.equal(almacen.tabla[0].enviado_at, AHORA.toISOString());
  assert.equal(almacen.tabla[0].intentos_envio, 1);
});

test("G-S2: corridas repetidas sobre la misma alerta mandan un solo correo", async () => {
  const { t, despachar } = await conCola([ALERTA, ALERTA, ALERTA]);
  await despachar();
  await despachar();
  await despachar();
  assert.equal(t.enviados.length, 1);
});

test("G-S4: una ocurrencia nueva después de resuelta vuelve a alertar", async () => {
  const { almacen, t, despachar } = await conCola([ALERTA]);
  await despachar();
  await encolarAlerta({ ...ALERTA, ocurrencia: 5 }, base({ db: almacen.db }));
  await despachar();
  assert.equal(t.enviados.length, 2);
  assert.equal(almacen.tabla.length, 2);
});

test("un envío fallido deja la fila sin marcar y se reintenta en la siguiente corrida", async () => {
  const { almacen, t, despachar } = await conCola([ALERTA], { respuestas: [{ success: false, error: "smtp caído" }, { success: true }] });
  const r1 = await despachar();
  assert.equal(r1.enviadas, 0);
  assert.equal(r1.fallidas, 1);
  assert.equal(almacen.tabla[0].enviado_ok, false);
  assert.equal(almacen.tabla[0].reclamada_at, null, "el reclamo se libera para reintentar de inmediato");
  const r2 = await despachar();
  assert.equal(r2.enviadas, 1);
  assert.equal(almacen.tabla[0].enviado_ok, true);
  assert.equal(almacen.tabla[0].intentos_envio, 2);
  assert.equal(t.enviados.length, 2);
});

test("un transporte que lanza cuenta como fallo y no escapa", async () => {
  const { almacen, despachar } = await conCola([ALERTA], { respuestas: [new Error("boom")] });
  const r = await despachar();
  assert.equal(r.ok, true);
  assert.equal(r.fallidas, 1);
  assert.equal(almacen.tabla[0].enviado_ok, false);
});

test("tope de intentos: tras MAX_INTENTOS_ALERTA fallos la fila ya no se reclama", async () => {
  assert.equal(MAX_INTENTOS_ALERTA, 5);
  const { almacen, t, despachar } = await conCola([ALERTA], { respuestas: [{ success: false, error: "x" }] });
  for (let i = 0; i < 8; i += 1) await despachar();
  assert.equal(t.enviados.length, 5);
  assert.equal(almacen.tabla[0].intentos_envio, 5);
  assert.equal(almacen.tabla[0].enviado_ok, false);
});

test("al agotar los intentos queda un error en el log", async () => {
  const { despachar } = await conCola([ALERTA], { respuestas: [{ success: false, error: "x" }] });
  const log = logger();
  for (let i = 0; i < 5; i += 1) await despachar({ ahora: AHORA }, { log });
  assert.ok(log.llamadas.error.some((m) => /agot/i.test(m)));
});

test("una fila reclamada hace menos de 5 minutos por otro proceso no se toma; una vencida sí", async () => {
  const { almacen, t, despachar } = await conCola([ALERTA]);
  almacen.tabla[0].reclamada_at = new Date(AHORA.getTime() - 60 * 1000).toISOString();
  almacen.tabla[0].intentos_envio = 1;
  assert.equal((await despachar()).enviadas, 0);
  assert.equal(t.enviados.length, 0);

  almacen.tabla[0].reclamada_at = new Date(AHORA.getTime() - 6 * 60 * 1000).toISOString();
  assert.equal((await despachar()).enviadas, 1);
  assert.equal(t.enviados.length, 1);
});

test("dos despachos concurrentes sobre la misma fila: solo uno la envía (reclamo atómico)", async () => {
  const { t, despachar } = await conCola([ALERTA]);
  const [a, b] = await Promise.all([despachar(), despachar()]);
  assert.equal(t.enviados.length, 1);
  assert.equal(a.enviadas + b.enviadas, 1);
});

test("sandbox: el envío suprimido igual marca enviado_ok y deja detalle.sandbox", async () => {
  const { almacen, despachar } = await conCola([ALERTA], { respuestas: [{ success: true, sandbox: true }] });
  const r = await despachar();
  assert.equal(r.enviadas, 1);
  assert.equal(almacen.tabla[0].enviado_ok, true);
  assert.equal(almacen.tabla[0].detalle.sandbox, true);
  assert.equal(almacen.tabla[0].detalle.restantes, 1, "el detalle original se conserva");
});

test("G-S3: sin destinatarios (y sin sandbox) no gasta intentos, avisa por log y no lanza", async () => {
  const { almacen, t, despachar } = await conCola([ALERTA], { destinatarios: () => [] });
  const log = logger();
  const r = await despachar({ ahora: AHORA }, { log });
  assert.equal(r.ok, true);
  assert.equal(r.sin_destinatarios, true);
  assert.equal(t.enviados.length, 0);
  assert.equal(almacen.tabla[0].intentos_envio, 0);
  assert.match(log.llamadas.warn.join(" "), /CARNES_MAIL_PRELIQUIDACION/);
});

test("en sandbox el despacho sigue aunque no haya destinatarios", async () => {
  const { almacen, despachar } = await conCola([ALERTA], { destinatarios: () => [], sandbox: () => true, respuestas: [{ success: true, sandbox: true }] });
  const r = await despachar();
  assert.equal(r.enviadas, 1);
  assert.equal(almacen.tabla[0].detalle.sandbox, true);
});

test("G4: con el flag apagado el despacho no toca la base ni envía", async () => {
  const { almacen, t, despachar } = await conCola([ALERTA]);
  const r = await despachar({ ahora: AHORA }, { env: { CARNES_PRELIQUIDACION: "off" } });
  assert.equal(r.ok, true);
  assert.equal(r.enviadas, 0);
  assert.equal(t.enviados.length, 0);
  assert.equal(almacen.tabla[0].intentos_envio, 0);
});

test("sin transporte inyectado usa el de notificaciones (solo el correo se sustituye con `notificar`)", async () => {
  const almacen = baseFalsa();
  await encolarAlerta(ALERTA, base({ db: almacen.db }));
  const correos = [];
  const notificar = async (tipo, ctx) => (correos.push({ tipo, ctx }), { success: true });
  const r = await despacharAlertas(
    { ahora: AHORA },
    { db: almacen.db, log: logger(), env: ENV_ON, notificar, destinatarios: () => ["ops@example.test"], sandbox: () => false },
  );
  assert.equal(r.ok, true);
  assert.equal(r.enviadas, 1);
  assert.equal(correos[0].tipo, "excede_animales");
  assert.equal(correos[0].ctx.restantes, 1);
});

test("el filtro por preliquidación despacha solo las filas de esa preliquidación", async () => {
  const { t, despachar } = await conCola([
    { evento: "cerrada", preliquidacionId: 1 },
    { evento: "cerrada", preliquidacionId: 2 },
  ]);
  const r = await despachar({ ahora: AHORA, preliquidacionId: 2 });
  assert.equal(r.enviadas, 1);
  assert.equal(t.enviados[0].contexto.preliquidacion_id, 2);
});

test("el límite acota cuántas filas se despachan por invocación", async () => {
  const alertas = [1, 2, 3, 4].map((n) => ({ evento: "cerrada", preliquidacionId: n }));
  const { t, despachar } = await conCola(alertas);
  const r = await despachar({ ahora: AHORA, limite: 2 });
  assert.equal(r.enviadas, 2);
  assert.equal(t.enviados.length, 2);
});

test("despacharAlertas nunca lanza, ni con la base caída ni con contexto indefinido", async () => {
  const caida = baseFalsa({ falla: "base caída" });
  const t = transporte();
  const log = logger();
  const r = await despacharAlertas(undefined, { db: caida.db, log, env: ENV_ON, enviar: t.enviar, destinatarios: () => ["a@b.c"], sandbox: () => false });
  assert.equal(r.ok, false);
  assert.equal(t.enviados.length, 0);
  assert.match(log.llamadas.error.join(" "), /base caída/);
});

test("destinatariosPreliquidacion lee CARNES_MAIL_PRELIQUIDACION (varios, sin repetidos) y cae al admin", () => {
  assert.deepEqual(destinatariosPreliquidacion({ CARNES_MAIL_PRELIQUIDACION: "a@x.co; b@x.co, A@x.co", CARNES_MAIL_ADMIN: "z@x.co" }), ["a@x.co", "b@x.co"]);
  assert.deepEqual(destinatariosPreliquidacion({ CARNES_MAIL_ADMIN: "z@x.co" }), ["z@x.co"]);
  assert.deepEqual(destinatariosPreliquidacion({}), []);
});
