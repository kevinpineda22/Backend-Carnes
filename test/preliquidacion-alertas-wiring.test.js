// Cableado de las alertas (4.3): el transporte real de la cola (contexto enriquecido + correo), el
// despacho desde el camino inmediato y los endpoints de admin, y las eliminaciones de alertas
// obsoletas en las RPC (estático; el recorrido real está en test/sql/alertas_obsolescencia.sql).
// Nada de esto toca la red: la base y el correo se inyectan.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { armarContextoAlerta, enviarAlerta } = await import("../src/services/preliquidacionAlertasEnvio.js");
const { encolarAlerta, despacharAlertas } = await import("../src/services/preliquidacionAlertas.js");
const { alFinalizar } = await import("../src/services/preliquidacionInmediato.js");
const { despacharTrasAccion } = await import("../src/controllers/preliquidaciones.controller.js");

const leer = (ruta) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
const silencio = { info() {}, warn() {}, error() {} };

// ─── Base falsa de lectura (enriquecimiento) ───────────────────────────────

function baseLectura(tablas, { falla = false } = {}) {
  return {
    from: (t) => {
      const filtros = [];
      const q = {
        select: () => q,
        eq: (c, v) => (filtros.push((r) => String(r[c]) === String(v)), q),
        maybeSingle: async () => {
          if (falla) return { data: null, error: { message: "base caída" } };
          return { data: (tablas[t] || []).find((r) => filtros.every((f) => f(r))) ?? null, error: null };
        },
      };
      return q;
    },
  };
}

const TABLAS = {
  carnes_preliquidaciones: [{ id: 7, especie: "res", ventana_fin: "2026-11-25T04:59:59.999Z" }],
  carnes_preliquidacion_sedes: [
    { id: 12, preliquidacion_id: 7, recepcion_id: 301, animales: 3, gasto_sede: "3800000.00", utilidad: "-40000.00", motivo_bloqueo: "utilidad_negativa", motivo_pendiente: null, intentos: 2, envio_id: 55 },
  ],
  carnes_recepciones: [{ id: 301, sede_id: 4, fecha_ingreso: "2026-11-23", novillos: 3 }],
  carnes_sedes: [{ id: 4, nombre: "Sede Centro" }],
  carnes_siesa_envios: [{ id: 55, error: "SIESA rechazó el documento", novedad: null }],
};

test("armarContextoAlerta completa especie, sede, cifras y error del envío desde la base", async () => {
  const ctx = await armarContextoAlerta({ preliquidacion_id: 7, sede_id: 12, ocurrencia: 3 }, { db: baseLectura(TABLAS), log: silencio });
  assert.equal(ctx.especie, "res");
  assert.equal(ctx.sede_nombre, "Sede Centro");
  assert.equal(ctx.recepcion_id, 301);
  assert.equal(ctx.animales, 3);
  assert.equal(ctx.utilidad, "-40000.00");
  assert.equal(ctx.gasto_sede, "3800000.00");
  assert.equal(ctx.motivo, "utilidad_negativa");
  assert.equal(ctx.error, "SIESA rechazó el documento");
  assert.equal(ctx.intentos, 2);
  assert.equal(ctx.ventana_fin, "2026-11-25T04:59:59.999Z");
});

test("el detalle de la alerta manda sobre lo leído de la base", async () => {
  const ctx = await armarContextoAlerta(
    { preliquidacion_id: 7, sede_id: 12, ocurrencia: 3, animales: 9, solicitados: 3, restantes: 1 },
    { db: baseLectura(TABLAS), log: silencio },
  );
  assert.equal(ctx.animales, 9);
  assert.equal(ctx.solicitados, 3);
  assert.equal(ctx.restantes, 1);
});

test("alertas por recepción (sede 0): el nombre de la sede sale de la recepción de la ocurrencia", async () => {
  const ctx = await armarContextoAlerta({ preliquidacion_id: 0, sede_id: 0, ocurrencia: 301, evento: "sin_preliquidacion" }, { db: baseLectura(TABLAS), log: silencio });
  assert.equal(ctx.sede_nombre, "Sede Centro");
  assert.equal(ctx.recepcion_id, 301);
  assert.equal(ctx.fecha_ingreso, "2026-11-23");
});

test("si la base falla el contexto llega igual (sin enriquecer) y no lanza", async () => {
  const ctx = await armarContextoAlerta({ preliquidacion_id: 7, sede_id: 12, ocurrencia: 3, restantes: 1 }, { db: baseLectura(TABLAS, { falla: true }), log: silencio });
  assert.equal(ctx.restantes, 1);
  assert.equal(ctx.sede_nombre, undefined);
});

test("enviarAlerta arma el contexto y llama al correo con el tipo de la alerta", async () => {
  const llamadas = [];
  const notificar = async (tipo, ctx) => (llamadas.push({ tipo, ctx }), { success: true });
  const r = await enviarAlerta("utilidad_negativa", { preliquidacion_id: 7, sede_id: 12, ocurrencia: 3 }, { db: baseLectura(TABLAS), notificar, log: silencio });
  assert.equal(r.success, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].tipo, "utilidad_negativa");
  assert.equal(llamadas[0].ctx.sede_nombre, "Sede Centro");
  assert.equal(llamadas[0].ctx.especie, "res");
});

test("enviarAlerta nunca lanza: si el correo lanza devuelve success:false", async () => {
  const r = await enviarAlerta("cerrada", { preliquidacion_id: 7 }, { db: baseLectura(TABLAS), notificar: async () => { throw new Error("boom"); }, log: silencio });
  assert.equal(r.success, false);
});

// ─── R4 de punta a punta: encolar -> despachar con el transporte por defecto ───

function colaEnMemoria() {
  const tabla = [];
  let id = 0;
  const db = {
    from: (t) => {
      if (t !== "carnes_preliquidacion_alertas") return baseLectura(TABLAS).from(t);
      const filtros = [];
      let modo = "select";
      let valores;
      let devuelve = false;
      const q = {
        upsert: (fila, op) => {
          modo = "upsert";
          valores = { fila, op };
          return q;
        },
        select: () => ((devuelve = true), q),
        update: (v) => ((modo = "update"), (valores = v), q),
        eq: (c, v) => (filtros.push((r) => String(r[c]) === String(v)), q),
        is: (c, v) => (filtros.push((r) => (v === null ? r[c] == null : r[c] === v)), q),
        lt: (c, v) => (filtros.push((r) => Number(r[c]) < Number(v)), q),
        order: () => q,
        limit: () => q,
        then: (res, rej) => {
          let salida;
          if (modo === "upsert") {
            const f = valores.fila;
            const existe = tabla.some((r) => ["evento", "preliquidacion_id", "sede_id", "ocurrencia"].every((c) => r[c] === f[c]));
            if (existe) salida = { data: [], error: null };
            else {
              const nueva = { id: ++id, intentos_envio: 0, reclamada_at: null, enviado_at: null, ...f };
              tabla.push(nueva);
              salida = { data: [{ id: nueva.id }], error: null };
            }
          } else {
            const filas = tabla.filter((r) => filtros.every((g) => g(r)));
            if (modo === "update") filas.forEach((r) => Object.assign(r, valores));
            salida = { data: filas.map((r) => ({ ...r })), error: null };
          }
          return Promise.resolve(salida).then(res, rej);
        },
      };
      return q;
    },
  };
  return { db, tabla };
}

test("R4 de punta a punta: una alerta de sede sin detalle sale por correo con la sede y una sola vez", async () => {
  const { db, tabla } = colaEnMemoria();
  const env = { CARNES_PRELIQUIDACION: "on", CARNES_MAIL_PRELIQUIDACION: "ops@example.test" };
  await encolarAlerta({ evento: "utilidad_negativa", preliquidacionId: 7, sedeId: 12, ocurrencia: 3 }, { db, env, log: silencio });
  await encolarAlerta({ evento: "utilidad_negativa", preliquidacionId: 7, sedeId: 12, ocurrencia: 3 }, { db, env, log: silencio });
  assert.equal(tabla.length, 1);

  const correos = [];
  const notificar = async (tipo, ctx) => (correos.push({ tipo, ctx }), { success: true });
  const opciones = { db, env, log: silencio, notificar, sandbox: () => false, destinatarios: () => ["ops@example.test"] };
  const r1 = await despacharAlertas({ ahora: new Date("2026-11-24T03:00:00Z") }, opciones);
  const r2 = await despacharAlertas({ ahora: new Date("2026-11-24T04:00:00Z") }, opciones);
  assert.equal(r1.enviadas, 1);
  assert.equal(r2.enviadas, 0);
  assert.equal(correos.length, 1);
  assert.equal(correos[0].tipo, "utilidad_negativa");
  assert.equal(correos[0].ctx.sede_nombre, "Sede Centro");
  assert.equal(tabla[0].enviado_ok, true);
});

test("el transporte por defecto del despacho es el de enviarAlerta (no un no-op)", () => {
  const fuente = leer("../src/services/preliquidacionAlertas.js");
  assert.match(fuente, /preliquidacionAlertasEnvio\.js/);
  assert.doesNotMatch(fuente, /\(no-op\)/);
  const cron = leer("../src/services/preliquidacionCron.js");
  assert.match(cron, /despacharAlertas/);
  assert.match(cron, /deps\.despacharAlertas\(/);
});

// ─── Camino inmediato: despacho tras procesar y para las alertas sin envío ───

const recepcion = (extra = {}) => ({ id: 101, especie: "res", fecha_ingreso: "2026-11-23", recibido_por: "ana@x.co", ...extra });
const DESPUES = new Date("2026-11-24T15:00:00Z");

function armarInmediato({ vincular, sede = { id: 11, estado: "vinculada", version: 4, preliquidacion_id: 1 }, falloDespacho = false } = {}) {
  const registro = { despachos: [], segundoPlano: 0, orden: [], procesar: 0 };
  const deps = {
    motivoApagado: () => null,
    siesaActivo: () => true,
    ahoraMs: () => 1000,
    vincular: vincular ?? (async () => ({ resultado: "vinculada", preliquidacion_id: 1, restantes: 2 })),
    leerSedeDeRecepcion: async () => ({ sede, cabecera: { id: 1, especie: "res", estado: "abierta", fecha_primer_ingreso: "2026-11-23", liquidada_at: "2026-11-24T02:31:00Z" } }),
    encolar: async () => ({ ok: true }),
    revisarCorridasPerdidas: async () => ({ perdidas: [] }),
    abrirCorrida: async () => ({ id: 500, preliquidacion_ids: [], resumen: {} }),
    registrarProgreso: async () => {},
    terminarCorrida: async () => registro.orden.push("terminar"),
    procesar: async () => (registro.orden.push("procesar"), { resultado: "ok", enviadas: 1, pendientes: 0 }),
    despacharAlertas: async (c) => {
      registro.orden.push("despachar");
      registro.despachos.push(c);
      if (falloDespacho) throw new Error("correo caído");
      return { ok: true, enviadas: 1 };
    },
    waitUntil: (fn) => ((registro.promesa = fn()), true),
    segundoPlano: (fn) => ((registro.segundoPlano += 1), (registro.promesaSegundoPlano = fn()), true),
    log: silencio,
  };
  return { deps, registro };
}

test("tras procesar la sede, la misma tarea en segundo plano despacha las alertas encoladas", async () => {
  const { deps, registro } = armarInmediato();
  const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.equal(r.envio, "programado");
  await registro.promesa;
  assert.deepEqual(registro.orden.slice(0, 3), ["procesar", "terminar", "despachar"], "se cierra la corrida y luego se despacha");
  assert.equal(registro.despachos.length, 1);
  assert.equal(registro.segundoPlano, 0, "el envío ya lleva su propia tarea");
});

test("un despacho que falla no rompe la corrida inmediata", async () => {
  const { deps, registro } = armarInmediato({ falloDespacho: true });
  await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
  await registro.promesa;
  assert.ok(registro.orden.includes("terminar"), "la corrida se cierra aunque el despacho falle");
});

test("desborde: no hay envío, pero la alerta se despacha en segundo plano", async () => {
  const { deps, registro } = armarInmediato({
    vincular: async () => ({ resultado: "excede", preliquidacion_id: 1, restantes: 1 }),
    sede: { id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", version: 2, preliquidacion_id: 1 },
  });
  const r = await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.deepEqual(r, { resultado: "excede", envio: "bloqueada" });
  assert.equal(registro.segundoPlano, 1);
  await registro.promesaSegundoPlano;
  assert.equal(registro.despachos.length, 1);
});

for (const codigo of ["sin_preliquidacion", "fuera_ventana", "oficial_legacy"]) {
  test(`${codigo}: la alerta por recepción se despacha en segundo plano`, async () => {
    const error = Object.assign(new Error(codigo), { codigo });
    const { deps, registro } = armarInmediato({ vincular: async () => { throw error; } });
    const r = await alFinalizar(recepcion(), { inicioPeticion: 0, ahora: DESPUES }, deps);
    assert.deepEqual(r, { resultado: codigo, envio: null });
    assert.equal(registro.segundoPlano, 1);
    await registro.promesaSegundoPlano;
    assert.equal(registro.despachos.length, 1);
  });
}

test("si no hay forma de correr en segundo plano, la alerta queda para el barrido y la respuesta no cambia", async () => {
  const { deps } = armarInmediato({
    vincular: async () => ({ resultado: "excede", preliquidacion_id: 1, restantes: 1 }),
    sede: { id: 11, estado: "bloqueada", motivo_bloqueo: "excede_animales", version: 2, preliquidacion_id: 1 },
  });
  deps.segundoPlano = async () => false;
  const r = await alFinalizar(recepcion({ novillos: 3 }), { inicioPeticion: 0, ahora: DESPUES }, deps);
  assert.deepEqual(r, { resultado: "excede", envio: "bloqueada" });
});

// ─── Endpoints de admin ────────────────────────────────────────────────────

test("despacharTrasAccion despacha con un límite acotado y nunca lanza", async () => {
  const llamadas = [];
  await despacharTrasAccion({ despachar: async (c) => llamadas.push(c) });
  assert.equal(llamadas.length, 1);
  assert.ok(llamadas[0].limite > 0 && llamadas[0].limite <= 3, "desde los controladores el límite es pequeño");
  const margen = llamadas[0].hasta - Date.now();
  assert.ok(margen > 0 && margen < 5000, "la fecha límite del despacho queda por debajo de la espera máxima");
  await despacharTrasAccion({ despachar: async () => { throw new Error("boom"); } });
});

test("despacharTrasAccion no retiene la respuesta más allá de la espera máxima", async () => {
  const inicio = Date.now();
  await despacharTrasAccion({ despachar: () => new Promise(() => {}), esperaMaximaMs: 30 });
  assert.ok(Date.now() - inicio < 1000);
});

test("el transportador SMTP tiene timeouts de conexión, saludo y socket", () => {
  const fuente = leer("../src/services/email.service.js");
  for (const clave of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
    assert.match(fuente, new RegExp(`${clave}:\\s*\\d`), clave);
  }
});

test("los handlers que pueden generar alertas despachan antes de responder", () => {
  const fuente = leer("../src/controllers/preliquidaciones.controller.js");
  for (const handler of ["actualizar", "vincular", "procesar", "procesarSede", "recalcular", "cerrar"]) {
    const m = fuente.match(new RegExp(`export async function ${handler}\\(req, res, next\\) \\{([\\s\\S]*?)\\r?\\n\\}\\r?\\n`));
    assert.ok(m, `no se encontró ${handler}`);
    assert.match(m[1], /await despacharTrasAccion\(\)/, handler);
    assert.ok(m[1].indexOf("despacharTrasAccion") < m[1].lastIndexOf("res.json("), `${handler}: despachar antes de responder`);
  }
});

// ─── Obsolescencia en las RPC (estático) ───────────────────────────────────

/** Cuerpo de la ÚLTIMA definición de la función entre los archivos dados (la que queda vigente al aplicar en orden). */
function cuerpoVigente(nombre, archivos) {
  let cuerpo = null;
  for (const archivo of archivos) {
    const sql = leer(`../sql/${archivo}`);
    const inicio = sql.indexOf(`CREATE OR REPLACE FUNCTION ${nombre}(`);
    if (inicio === -1) continue;
    const fin = sql.indexOf("LANGUAGE plpgsql", inicio);
    cuerpo = sql.slice(inicio, fin);
  }
  assert.ok(cuerpo, `no se encontró ${nombre}`);
  return cuerpo.replace(/\s+/g, " ");
}
const ORDEN = ["039_preliquidacion_rpc.sql", "040_preliquidacion_rpc_envio.sql", "041_preliquidacion_rpc_correcciones.sql"];
const BORRA = "DELETE FROM carnes_preliquidacion_alertas";

for (const funcion of [
  "carnes_preliq_transicionar_sede",
  "carnes_preliq_congelar_sede",
  "carnes_preliq_reclamar_sede",
  "carnes_preliq_cerrar_envio",
]) {
  test(`obsolescencia: ${funcion} borra las alertas sin enviar de la sede con ocurrencia anterior a la nueva versión`, () => {
    const c = cuerpoVigente(funcion, ORDEN);
    assert.ok(c.includes(BORRA), funcion);
    assert.match(c, /sede_id = p_sede_id AND enviado_ok = false AND ocurrencia < v_nueva/);
  });
}

test("obsolescencia: el reclamo, el cierre del envío y la transición conservan requiere_correccion mientras siga activo", () => {
  for (const funcion of ["carnes_preliq_reclamar_sede", "carnes_preliq_cerrar_envio", "carnes_preliq_transicionar_sede"]) {
    assert.match(cuerpoVigente(funcion, ORDEN), /NOT \(evento = 'requiere_correccion' AND v_(sede\.)?requiere(_correccion)?\)/, funcion);
  }
});

test("obsolescencia: liquidar borra corrida_perdida y servicio_cero sin enviar de la preliquidación", () => {
  const c = cuerpoVigente("carnes_preliq_liquidar", ORDEN);
  assert.ok(c.includes(BORRA));
  assert.match(c, /preliquidacion_id = p_id AND enviado_ok = false AND evento IN \('corrida_perdida', 'servicio_cero'\)/);
});

test("obsolescencia: vincular borra las alertas sin enviar de la recepción al vincularla", () => {
  const c = cuerpoVigente("carnes_preliq_vincular", ORDEN);
  assert.match(c, /enviado_ok = false AND evento IN \('sin_preliquidacion', 'fuera_ventana', 'oficial_legacy'\) AND sede_id = 0 AND ocurrencia = p_recepcion_id/);
});

test("obsolescencia: desvincular borra las alertas sin enviar de la sede que se desvincula", () => {
  assert.match(cuerpoVigente("carnes_preliq_desvincular", ORDEN), /DELETE FROM carnes_preliquidacion_alertas WHERE sede_id = p_sede_id AND enviado_ok = false/);
});

test("obsolescencia: cerrar borra solo las alertas de estado pendiente, sin reclamar (la cerrada se encola después)", () => {
  const c = cuerpoVigente("carnes_preliq_cerrar", ORDEN);
  assert.ok(c.includes(BORRA), "cerrar debe borrar las alertas obsoletas");
  assert.match(c, /WHERE preliquidacion_id = p_id AND enviado_ok = false\s+AND \(reclamada_at IS NULL OR reclamada_at < now\(\) - interval '5 minutes'\)/);
  const lista = c.match(/AND evento IN \(([^)]*)\)/);
  assert.ok(lista, "cerrar debe restringir los eventos que borra");
  const borra = [...lista[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(borra.sort(), ["corrida_perdida", "envio_en_vuelo", "inicial_pendiente", "servicio_cero", "ventana_vencida"]);
  for (const accionable of ["requiere_correccion", "envio_error", "sin_confirmar", "reintentos_agotados", "servicio_tardio"]) {
    assert.ok(!borra.includes(accionable), `cerrar no debe borrar ${accionable}`);
  }
  // Se borra al cerrar, no antes de las validaciones: un cierre rechazado no puede perder alertas.
  assert.ok(c.indexOf(BORRA) > c.indexOf("no_cerrable"), "el borrado va después de las guardas");
});

test("obsolescencia: anular borra todas las alertas sin enviar de la preliquidación y de sus sedes", () => {
  const c = cuerpoVigente("carnes_preliq_anular", ORDEN);
  assert.match(c, /enviado_ok = false AND \(preliquidacion_id = p_id OR sede_id IN \(SELECT id FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id\)\)/);
});

test("la cerrada se encola DESPUÉS del cierre, así el borrado de cerrar no se la lleva", () => {
  const fuente = leer("../src/models/PreliquidacionCierre.model.js");
  const rpc = fuente.indexOf('"carnes_preliq_cerrar"');
  const alerta = fuente.indexOf('evento: "cerrada"');
  assert.ok(rpc > 0 && alerta > rpc);
});

test("el script manual de obsolescencia existe, es transaccional y recorre cada RPC", () => {
  assert.ok(existsSync(fileURLToPath(new URL("./sql/alertas_obsolescencia.sql", import.meta.url))));
  const sql = leer("./sql/alertas_obsolescencia.sql");
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /ROLLBACK;\s*$/);
  for (const f of [
    "carnes_preliq_transicionar_sede",
    "carnes_preliq_congelar_sede",
    "carnes_preliq_reclamar_sede",
    "carnes_preliq_cerrar_envio",
    "carnes_preliq_liquidar",
    "carnes_preliq_vincular",
    "carnes_preliq_cerrar",
    "carnes_preliq_anular",
  ]) {
    assert.ok(sql.includes(f), `el script no recorre ${f}`);
  }
  assert.doesNotMatch(sql, /\bCOMMIT\b/);
});
