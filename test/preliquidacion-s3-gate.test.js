// Compuerta de salida de S3 (3.10): re-verifica M2 de punta a punta con las funciones reales
// (recalcular, anularSede, procesarSede) sobre una base falsa con RPC que mutan las tablas, y
// comprueba que nada de S3 llama a SIESA. SIESA se inyecta como función falsa: jamás sale a la red.
//
// M2: `requiere_correccion` (levantado por "recalcular no enviadas" en una sede ya enviada) NO se limpia
// con un envío cuyos montos son anteriores al recálculo; solo lo limpia un envío posterior
// (anulada -> recosteo -> lista_para_enviar -> enviada) o el descarte explícito.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;
const aqui = (ruta) => new URL(ruta, import.meta.url);
const leer = (ruta) => readFileSync(aqui(ruta), "utf8");

let tablas = {};
let rpcs = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))).map((r) => ({ ...r })); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const h = manejadores[nombre];
    return { data: h ? await h(args) : { resultado: "ok" }, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Modelo = await import(url("models/Preliquidacion.model.js"));
const Correcciones = await import(url("models/PreliquidacionCorrecciones.model.js"));

const silencio = { info() {}, warn() {}, error() {}, log() {} };

// ─── Datos ─────────────────────────────────────────────────────────────────

const cabecera = (extra = {}) => ({
  id: 1, especie: "res", estado: "abierta", animales: 10, animal_en_pie: "1000000.00",
  servicio_precorte: null, servicio_por_animal: "50000.00", fecha_primer_ingreso: "2026-11-23",
  ventana_fin: "2026-11-25T04:59:59.999Z", liquidada_at: "2026-11-24T02:31:00.000Z",
  servicio_aplicado: "500000.00", gasto_total_aplicado: "1500000.00", costo_por_animal: "150000.00",
  version: 3, orden_version: 5, tercero_id: "frigorifico", ...extra,
});
const sede = (extra = {}) => ({
  id: 11, preliquidacion_id: 1, recepcion_id: 101, animales: 4, orden: 1, estado: "calculada",
  motivo_bloqueo: null, liberada_at: null, version: 2, intentos: 0, error_tipo: null, motivo_pendiente: null,
  gasto_sede: "600000.00", costeo_orden_version: 5, costeo_animales: 4, requiere_correccion: false,
  correccion_orden_version: null, claim_costeo_orden_version: null, claim_token: null, envio_id: null, ...extra,
});
const item = (id, recepcionId) => ({
  id, recepcion_id: recepcionId, tipo: "carne", cantidad: "100", costo_base: "1000000", descripcion: "x", orden: 1,
});

/** La sede 11 (4 animales) en el estado dado y la 12 (6 animales) ya enviada. */
function escenario({ estado, extra = {} }) {
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [
      sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1, estado, ...extra }),
      sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2, estado: "enviada", gasto_sede: "900000.00", costeo_animales: 6 }),
    ],
    carnes_preliquidacion_gastos: [], carnes_preliquidacion_saldos: [], carnes_preliquidacion_retomas: [],
    carnes_recepciones: [
      { id: 101, especie: "res", estado: estado === "enviada" ? "Enviado_SIESA" : "Aprobado" },
      { id: 102, especie: "res", estado: "Enviado_SIESA" },
    ],
    carnes_recepcion_items: [item(1, 101), item(2, 102)],
  };
}

const sedeDe = (id) => tablas.carnes_preliquidacion_sedes.find((s) => s.id === id);
const header = () => tablas.carnes_preliquidaciones[0];
const ENVIADOS = ["enviando", "enviada", "sin_confirmar"];

// ─── RPC falsas (misma semántica que sql/039-041) ──────────────────────────

const rpcRecalcular = (a) => {
  const h = header();
  h.orden_version += 1;
  if (Object.keys(a.p_cambios).length) h.version += 1;
  for (const k of ["animales", "animal_en_pie", "servicio_por_animal", "tercero_id"]) if (k in a.p_cambios) h[k] = a.p_cambios[k];
  if (a.p_plan.gasto_total) Object.assign(h, { gasto_total_aplicado: a.p_plan.gasto_total, servicio_aplicado: a.p_plan.servicio_aplicado, costo_por_animal: a.p_plan.costo_por_animal });
  const marcadas = [];
  for (const s of tablas.carnes_preliquidacion_sedes) {
    if (ENVIADOS.includes(s.estado)) {
      Object.assign(s, { requiere_correccion: true, correccion_orden_version: h.orden_version, version: s.version + 1 });
      marcadas.push({ sede_id: s.id, sede_version: s.version });
    }
  }
  return { resultado: "ok", version: h.version, orden_version: h.orden_version, sedes_marcadas: marcadas };
};

const rpcCongelar = (a) => {
  const s = sedeDe(a.p_sede_id);
  Object.assign(s, {
    estado: a.p_plan.hacia, gasto_sede: a.p_plan.gasto_sede, costeo_orden_version: a.p_orden_version, costeo_animales: s.animales,
    version: s.version + 1, motivo_bloqueo: a.p_plan.motivo_bloqueo ?? null,
  });
  return { resultado: "ok" };
};

const rpcTransicionar = (a) => {
  const s = sedeDe(a.p_sede_id);
  if (!s) return { resultado: "no_encontrada" };
  if (s.estado !== a.p_desde || s.version !== a.p_sede_version) return { resultado: "version_cambiada" };
  const { recepcion_estado: recEstado, ...campos } = a.p_campos;
  Object.assign(s, campos, { estado: a.p_hacia, version: s.version + 1 });
  if (recEstado) tablas.carnes_recepciones.find((r) => r.id === s.recepcion_id).estado = recEstado;
  return { resultado: "ok", estado: a.p_hacia, sede_version: s.version };
};

let secuenciaToken = 0;
const rpcReclamar = (a) => {
  const s = sedeDe(a.p_sede_id);
  const h = header();
  if (h.estado !== "abierta") return { resultado: "no_abierta" };
  if (s.estado !== a.p_desde || s.version !== a.p_sede_version) return { resultado: "no_reclamada" };
  if (s.gasto_sede == null || s.costeo_orden_version !== h.orden_version || s.costeo_animales !== s.animales) {
    return { resultado: "costeo_desactualizado" };
  }
  Object.assign(s, {
    estado: "enviando", claim_token: a.p_token, claim_costeo_orden_version: s.costeo_orden_version,
    intentos: s.intentos + 1, version: s.version + 1, motivo_pendiente: null,
  });
  secuenciaToken += 1;
  return { resultado: "ok", sede_version: s.version, intentos: s.intentos, claim_costeo_orden_version: s.claim_costeo_orden_version };
};

/**
 * `carnes_preliq_cerrar_envio` de sql/040: escribe el plan de JS con el token. Si el plan trae
 * `correccion_orden_version_esperada` y la sede ya no la tiene (otro recálculo la cambió mientras
 * viajaba el envío), NO toca requiere_correccion ni correccion_orden_version: conserva el aviso.
 */
const rpcCerrarEnvio = (a) => {
  const s = sedeDe(a.p_sede_id);
  if (!s || s.estado !== "enviando" || s.claim_token !== a.p_token) return { resultado: "token_invalido" };
  const { hacia, campos = {}, recepcion_estado: recEstado } = a.p_plan;
  const conserva =
    "correccion_orden_version_esperada" in a.p_plan &&
    (s.correccion_orden_version ?? null) !== (a.p_plan.correccion_orden_version_esperada ?? null);
  const aplicar = { ...campos };
  if (conserva) {
    delete aplicar.requiere_correccion;
    delete aplicar.correccion_orden_version;
  }
  Object.assign(s, aplicar, { estado: hacia, claim_token: null, version: s.version + 1 });
  if (recEstado) tablas.carnes_recepciones.find((r) => r.id === s.recepcion_id).estado = recEstado;
  return { resultado: "ok", estado: hacia, sede_version: s.version };
};

beforeEach(() => {
  rpcs = [];
  secuenciaToken = 0;
  manejadores = {
    carnes_preliq_recalcular_no_enviadas: rpcRecalcular,
    carnes_preliq_congelar_sede: rpcCongelar,
    carnes_preliq_transicionar_sede: rpcTransicionar,
    carnes_preliq_reclamar_sede: rpcReclamar,
    carnes_preliq_cerrar_envio: rpcCerrarEnvio,
  };
});

// ─── Piezas de la prueba ───────────────────────────────────────────────────

let siesaLlamadas = [];
const envioOk = { fila: { id: 500, estado: "ok", repetido: false, error: null }, armadoBloqueos: [] };
/** SIESA falso: registra cada envío y, si hay `durante`, ejecuta algo MIENTRAS el envío está en vuelo. */
const siesaFalso = (durante) => async (recepcionId, opciones) => {
  siesaLlamadas.push({ recepcionId, opciones });
  if (durante) await durante();
  return envioOk;
};
const anulaciones = [];
const anularEnvio = async (recepcionId) => {
  anulaciones.push(recepcionId);
  return { anulados: [{ id: 900, tipo: "oficial" }] };
};

const recalcular = (cambios = {}, motivo = "ajuste") =>
  Modelo.recalcular(1, { cambios, motivo }, { por: "ana", siesaActivo: false, log: silencio, encolar: async () => ({ ok: true }) });

const procesar = (s, extra = {}) =>
  Modelo.procesarSede(s, {
    header: header(), origen: "admin", corridaId: 90, ahora: new Date("2026-11-24T03:00:00.000Z"), siesaActivo: true,
    encolar: async () => ({ ok: true }), por: "ana", log: silencio, ...extra,
  });

// ─── M2 de punta a punta ───────────────────────────────────────────────────

test("M2 e2e (1/3): recalcular marca la sede enviada con requiere_correccion y la orden_version del recálculo, sin tráfico a SIESA", async () => {
  siesaLlamadas = [];
  escenario({ estado: "enviada" });
  await recalcular({ animal_en_pie: "2000000" }, "precio");
  assert.equal(sedeDe(11).requiere_correccion, true);
  assert.equal(sedeDe(11).correccion_orden_version, 6);
  assert.equal(sedeDe(11).estado, "enviada", "lo ya enviado no se recostea");
  assert.deepEqual(siesaLlamadas, []);
});

test("M2 e2e (2/3): un envío reclamado ANTES del recálculo no limpia la bandera que el recálculo levantó mientras viajaba", async () => {
  siesaLlamadas = [];
  escenario({ estado: "calculada" });
  const antesDelClaim = { ...sedeDe(11) };
  const r = await procesar(antesDelClaim, {
    enviar: siesaFalso(async () => {
      // El admin recalcula mientras el CEA viaja: la sede (enviando) queda marcada.
      await recalcular({ animal_en_pie: "2000000" }, "precio");
    }),
  });
  assert.equal(r.resultado, "enviada");
  assert.equal(siesaLlamadas.length, 1);
  const s = sedeDe(11);
  assert.equal(s.estado, "enviada");
  assert.equal(s.claim_costeo_orden_version, 5, "el CEA salió con el costeo anterior al recálculo");
  assert.equal(s.correccion_orden_version, 6);
  assert.equal(s.requiere_correccion, true, "un CEA con montos viejos NO corrige nada: el aviso sigue");
  assert.equal(tablas.carnes_recepciones.find((x) => x.id === 101).estado, "Enviado_SIESA");
});

test("M2 e2e (2b): sin recálculo en medio, el envío de una sede que no tenía aviso sigue limpio (no se rompe lo normal)", async () => {
  siesaLlamadas = [];
  escenario({ estado: "calculada" });
  const r = await procesar({ ...sedeDe(11) }, { enviar: siesaFalso() });
  assert.equal(r.resultado, "enviada");
  assert.equal(sedeDe(11).estado, "enviada");
  assert.equal(sedeDe(11).requiere_correccion, false);
});

test("M2 e2e (3/3): enviada con aviso -> anulada -> recosteo -> lista_para_enviar -> envío manual -> enviada LIMPIA el aviso", async () => {
  siesaLlamadas = [];
  anulaciones.length = 0;
  escenario({ estado: "enviada" });

  // 1. Cambio de precio con la sede ya enviada: queda marcada (orden_version 6).
  await recalcular({ animal_en_pie: "2000000" }, "precio");
  assert.deepEqual([sedeDe(11).requiere_correccion, sedeDe(11).correccion_orden_version], [true, 6]);

  // 2. El admin confirma la anulación hecha en SIESA: anulada, recepción Costeado, aviso intacto.
  const anulada = await Correcciones.anularSede(11, { por: "ana", motivo: "precio" }, { anularEnvio, log: silencio });
  assert.equal(anulada.estado, "anulada");
  assert.deepEqual(anulaciones, [101]);
  assert.equal(tablas.carnes_recepciones.find((x) => x.id === 101).estado, "Costeado");
  assert.deepEqual([sedeDe(11).requiere_correccion, sedeDe(11).correccion_orden_version], [true, 6]);
  assert.deepEqual(siesaLlamadas, [], "anular no envía nada");

  // 3. Una anulada nunca se envía sola: antes de recostear no hay reclamo posible.
  const sinRecostear = await procesar({ ...sedeDe(11) }, { enviar: siesaFalso() });
  assert.equal(sinRecostear.resultado, "no_reclamable");
  assert.deepEqual(siesaLlamadas, []);

  // 4. Recalcular (recosteo puro): la anulada pasa a lista_para_enviar con la orden_version nueva (7).
  await recalcular({}, "recosteo tras anular");
  assert.equal(sedeDe(11).estado, "lista_para_enviar");
  assert.equal(sedeDe(11).costeo_orden_version, 7);
  assert.equal(sedeDe(11).requiere_correccion, true, "recostear no limpia el aviso: solo un envío nuevo o descartarlo");

  // 5. Envío manual: reclama con el costeo 7 (>= 6) y al quedar enviada limpia el aviso.
  const r = await procesar({ ...sedeDe(11) }, { enviar: siesaFalso() });
  assert.equal(r.resultado, "enviada");
  assert.equal(siesaLlamadas.length, 1);
  const s = sedeDe(11);
  assert.equal(s.estado, "enviada");
  assert.equal(s.claim_costeo_orden_version, 7);
  assert.equal(s.requiere_correccion, false);
  assert.equal(s.correccion_orden_version, null);
  assert.equal(tablas.carnes_recepciones.find((x) => x.id === 101).estado, "Enviado_SIESA");
});

test("M2 e2e: descartar la corrección limpia el aviso aunque el CEA tenga montos viejos (decisión humana)", async () => {
  escenario({ estado: "enviada" });
  await recalcular({ animal_en_pie: "2000000" }, "precio");
  const r = await Correcciones.descartarCorreccion(11, { por: "ana", motivo: "el cambio no aplica a esta sede" }, { log: silencio });
  assert.equal(r.resultado, "ok");
  assert.deepEqual([sedeDe(11).requiere_correccion, sedeDe(11).correccion_orden_version], [false, null]);
  assert.equal(sedeDe(11).estado, "enviada");
});

// ─── Compuerta: SIESA, scripts, interruptor ────────────────────────────────

test("el plan de cierre lleva la correccion_orden_version que JS vio, para que la RPC no pise un aviso nuevo", async () => {
  escenario({ estado: "calculada" });
  await procesar({ ...sedeDe(11), requiere_correccion: true, correccion_orden_version: 3 }, { enviar: siesaFalso() });
  const plan = rpcs.find((r) => r.nombre === "carnes_preliq_cerrar_envio").args.p_plan;
  assert.equal(plan.correccion_orden_version_esperada, 3);
  rpcs = [];
  escenario({ estado: "calculada" });
  await procesar({ ...sedeDe(11) }, { enviar: siesaFalso() });
  assert.equal(rpcs.find((r) => r.nombre === "carnes_preliq_cerrar_envio").args.p_plan.correccion_orden_version_esperada, null);
});

test("los módulos de S3 no importan SIESA: alterna, saldos, anulación y pura de correcciones", () => {
  for (const f of [
    "../src/models/PreliquidacionAlterna.model.js",
    "../src/models/PreliquidacionSaldos.model.js",
    "../src/shared/preliquidacionAlterna.js",
    "../src/shared/preliquidacionSaldo.js",
    "../src/shared/preliquidacionAnulacion.js",
  ]) {
    assert.doesNotMatch(leer(f), /siesa\.service|SiesaEnvio\.model|enviarASiesa/i, f);
  }
});

test("el modelo de correcciones solo usa de SiesaEnvio el registro de la anulación (nunca un envío a SIESA)", () => {
  const fuente = leer("../src/models/PreliquidacionCorrecciones.model.js");
  assert.doesNotMatch(fuente, /^import .*SiesaEnvio/m, "sin import estático de SiesaEnvio");
  assert.doesNotMatch(fuente, /siesa\.service|enviarASiesa|enviarOficial|ejecutarEnvio|registrarYEnviar/);
  const dinamicos = [...fuente.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(dinamicos, ["./SiesaEnvio.model.js"]);
  assert.match(fuente, /const \{ anularOficialRecepcion \} = await import/);
});

test("anularOficialRecepcion no llama a SIESA: solo toca la base", () => {
  const fuente = leer("../src/models/SiesaEnvio.model.js");
  const ini = fuente.indexOf("export async function anularOficialRecepcion");
  const fin = fuente.indexOf("export async function eliminarEnvioAdmin");
  const cuerpo = fuente.slice(ini, fin);
  assert.ok(ini > 0 && fin > ini);
  assert.doesNotMatch(cuerpo, /enviarASiesa|ejecutarEnvio|registrarYEnviar|fetch\(/);
});

test("el código de S3 ni sus pruebas importan nada de scripts/ (SIESA de producción)", () => {
  const fuentes = [
    "../src/models/PreliquidacionCorrecciones.model.js",
    "../src/models/PreliquidacionSaldos.model.js",
    "../src/models/PreliquidacionAlterna.model.js",
    "../src/shared/preliquidacionAnulacion.js",
    "../src/controllers/preliquidaciones.controller.js",
    "../src/routes/preliquidaciones.routes.js",
  ];
  for (const f of fuentes) assert.doesNotMatch(leer(f), /from\s+["'][^"']*scripts\//, f);
  for (const archivo of readdirSync(aqui("./")).filter((f) => f.endsWith(".test.js"))) {
    assert.doesNotMatch(leer(archivo), /import\s*\(?\s*["'][^"']*\/scripts\//, `${archivo} importa scripts/`);
  }
});

test("solo anular sede y anular preliquidación son drenaje: el resto de las escrituras nuevas respeta el interruptor", () => {
  const fuente = leer("../src/controllers/preliquidaciones.controller.js");
  const bloque = fuente.slice(fuente.indexOf("const RUTAS_DRENAJE"), fuente.indexOf("];", fuente.indexOf("const RUTAS_DRENAJE")));
  const patrones = bloque.split(/\r?\n/).filter((l) => l.trimStart().startsWith("/^")).length;
  assert.equal(patrones, 5, "procesar, procesar sede, cerrar, anular sede y anular preliquidación");
  assert.doesNotMatch(bloque, /recalcular|descartar|saldos/);
});

test("el interruptor está apagado por defecto", async () => {
  const previo = { ...process.env };
  delete process.env.CARNES_PRELIQUIDACION;
  delete process.env.VERCEL_ENV;
  try {
    const { preliquidacionHabilitada } = await import("../src/config/preliquidacion.js");
    assert.equal(preliquidacionHabilitada(), false);
  } finally {
    process.env = previo;
  }
});

test("las pruebas de S3 existen para cada tarea 3.1 a 3.9", () => {
  const archivos = readdirSync(aqui("./"));
  for (const f of [
    "preliquidacion-alterna.test.js", "preliquidacion-saldo.test.js", "preliquidacion-rpc-correcciones.test.js",
    "preliquidacion-tardio.test.js", "preliquidacion-recalcular.test.js", "preliquidacion-correcciones.test.js",
    "preliquidacion-anular.test.js", "preliquidacion-saldos-routes.test.js", "preliquidacion-cobertura-spec.test.js",
  ]) {
    assert.ok(archivos.includes(f), `falta ${f}`);
  }
});
