// Modelo de la preliquidación: mapeo de códigos de las RPC a HTTP, reintento por
// `version_cambiada`, constructores de plan (contrato de sql/039) y previsualización
// sin escrituras. Supabase falso con mock.module (npm test corre con
// --experimental-test-module-mocks). Sin red ni base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

// ─── Supabase falso ────────────────────────────────────────────────────────

let tablas = {};
let rpcs = []; // {nombre, args}
let escrituras = []; // {tabla, op, valores}
let respuestasRpc = []; // cola de respuestas; si se acaba, {resultado:'ok'}
let casRechazado = 0; // cuántos UPDATE con CAS deben devolver 0 filas

class Q {
  constructor(t) {
    this.t = t;
    this.f = [];
  }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); this.eqs = [...(this.eqs || []), [c, v]]; return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  limit() { return this; }
  update(v) { this.upd = v; return this; }
  insert(v) { this.ins = v; return this; }
  delete() { this.borrar = true; return this; }
  upsert(v) { this.ups = v; return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))); }
  ejecutar() {
    if (this.upd) {
      escrituras.push({ tabla: this.t, op: "update", valores: this.upd, filtros: this.eqs });
      if (casRechazado > 0) { casRechazado -= 1; return { data: [], error: null }; }
      const filas = this.filas();
      for (const fila of filas) Object.assign(fila, this.upd);
      return { data: filas, error: null };
    }
    if (this.ins) {
      escrituras.push({ tabla: this.t, op: "insert", valores: this.ins });
      const nuevas = (Array.isArray(this.ins) ? this.ins : [this.ins]).map((v, i) => ({ id: 900 + i, ...v }));
      tablas[this.t] = [...(tablas[this.t] || []), ...nuevas];
      return { data: nuevas, error: null };
    }
    if (this.ups) {
      escrituras.push({ tabla: this.t, op: "upsert", valores: this.ups });
      return { data: [], error: null };
    }
    if (this.borrar) {
      escrituras.push({ tabla: this.t, op: "delete" });
      const filas = this.filas();
      tablas[this.t] = (tablas[this.t] || []).filter((r) => !filas.includes(r));
      return { data: filas, error: null };
    }
    return { data: this.filas(), error: null };
  }
  maybeSingle() { const { data, error } = this.ejecutar(); return Promise.resolve({ data: data[0] ?? null, error }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve(this.ejecutar()).then(res, rej); }
}

const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const data = respuestasRpc.length ? respuestasRpc.shift() : { resultado: "ok" };
    return { data, error: null };
  },
};

mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Modelo = await import(url("models/Preliquidacion.model.js"));

// ─── Fixtures ──────────────────────────────────────────────────────────────

const cabecera = (extra = {}) => ({
  id: 1,
  especie: "res",
  estado: "abierta",
  animales: 10,
  animal_en_pie: "1000000.00",
  servicio: null,
  servicio_precorte: null,
  servicio_por_animal: "50000.00",
  tercero_id: "frigorifico",
  fecha_primer_ingreso: "2026-11-23",
  ventana_fin: "2026-11-25T04:59:59.999Z",
  liquidada_at: null,
  version: 3,
  orden_version: 5,
  ...extra,
});

const sede = (extra = {}) => ({
  id: 11,
  preliquidacion_id: 1,
  recepcion_id: 101,
  animales: 4,
  orden: 1,
  estado: "vinculada",
  motivo_bloqueo: null,
  liberada_at: null,
  version: 0,
  ...extra,
});

const recepcion = (extra = {}) => ({
  id: 101,
  especie: "res",
  fecha_ingreso: "2026-11-23",
  recibido_at: "2026-11-23T15:00:00.000Z",
  novillos: "4.00",
  preliquidacion_id: null,
  estado: "Aprobado",
  ...extra,
});

beforeEach(() => {
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [],
    carnes_preliquidacion_gastos: [],
    carnes_preliquidacion_saldos: [],
    carnes_preliquidacion_retomas: [],
    carnes_recepciones: [recepcion()],
    carnes_recepcion_items: [],
  };
  rpcs = [];
  escrituras = [];
  respuestasRpc = [];
  casRechazado = 0;
});

const falla = async (fn, estado, codigo) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.statusCode, estado, `status ${e.statusCode} (${e.message})`);
    if (codigo) assert.equal(e.codigo, codigo);
    return true;
  });
};

// ─── resultadoAError: código de RPC -> HTTP ────────────────────────────────

test("resultadoAError: los resultados exitosos no producen error", () => {
  for (const r of ["ok", "vinculada", "excede", "tardio"]) {
    assert.equal(Modelo.resultadoAError({ resultado: r }), null, r);
  }
});

test("resultadoAError: tabla de códigos de negocio a HTTP", () => {
  const esperado = {
    abierta_en_curso: 409,
    config_servicio_cero: 409,
    version_cambiada: 409,
    ya_vinculada: 409,
    oficial_legacy: 409,
    sede_enviada: 409,
    sede_no_editable: 409,
    ya_liquidada: 409,
    no_liberada: 409,
    desde_invalido: 409,
    no_liquidable: 409,
    no_vinculada: 409,
    sin_preliquidacion: 409,
    fuera_ventana: 422,
    novillos_invalido: 422,
    invalido: 422,
    datos_invalidos: 422,
    servicio_invalido: 422,
    recepcion_estado_invalido: 422,
    no_encontrada: 404,
    sin_recepcion: 404,
  };
  for (const [codigo, estado] of Object.entries(esperado)) {
    const e = Modelo.resultadoAError({ resultado: codigo });
    assert.ok(e, codigo);
    assert.equal(e.statusCode, estado, codigo);
    assert.equal(e.codigo, codigo, codigo);
    assert.equal(e.expose, true, codigo);
  }
});

test("resultadoAError: un código desconocido es un 500 sin exponer el detalle", () => {
  const e = Modelo.resultadoAError({ resultado: "inventado" });
  assert.equal(e.statusCode, 500);
  assert.notEqual(e.expose, true);
});

test("resultadoAError: la respuesta vacía también es un error", () => {
  assert.equal(Modelo.resultadoAError(null).statusCode, 500);
});

// ─── conReintentoVersion ───────────────────────────────────────────────────

test("conReintentoVersion: devuelve el primer resultado que no es version_cambiada", async () => {
  let llamadas = 0;
  const r = await Modelo.conReintentoVersion(async () => { llamadas += 1; return { resultado: "ok", x: 1 }; });
  assert.equal(llamadas, 1);
  assert.equal(r.x, 1);
});

test("conReintentoVersion: reintenta y entrega el número de intento", async () => {
  const intentos = [];
  const r = await Modelo.conReintentoVersion(async (n) => {
    intentos.push(n);
    return n < 2 ? { resultado: "version_cambiada" } : { resultado: "ok" };
  });
  assert.deepEqual(intentos, [0, 1, 2]);
  assert.equal(r.resultado, "ok");
});

test("conReintentoVersion: máximo 3 intentos y luego 409 version_cambiada", async () => {
  let llamadas = 0;
  await falla(
    () => Modelo.conReintentoVersion(async () => { llamadas += 1; return { resultado: "version_cambiada" }; }),
    409,
    "version_cambiada",
  );
  assert.equal(llamadas, 3);
});

test("conReintentoVersion: un resultado de negocio distinto no se reintenta", async () => {
  let llamadas = 0;
  const r = await Modelo.conReintentoVersion(async () => { llamadas += 1; return { resultado: "ya_vinculada" }; });
  assert.equal(llamadas, 1);
  assert.equal(r.resultado, "ya_vinculada");
});

// ─── armarPlanVincular (contrato de carnes_preliq_vincular) ────────────────

const filaSede = (extra) => ({
  recepcionId: 101, animales: 4, orden: 1, estado: "vinculada", motivoBloqueo: null, liberadaAt: null,
  fechaIngreso: "2026-11-23", recibidoAt: "2026-11-23T15:00:00.000Z", ...extra,
});

test("armarPlanVincular: primera sede de una preliquidación sin iniciar fija la ventana", () => {
  const r = Modelo.armarPlanVincular({
    cabecera: cabecera({ fecha_primer_ingreso: null, ventana_fin: null }),
    recepcion: { id: 101, fechaIngreso: "2026-11-23", recibidoAt: "2026-11-23T15:00:00.000Z", animales: 4 },
    sedes: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.ordenVersion, 5);
  assert.equal(r.plan.fecha_primer_ingreso, "2026-11-23");
  assert.equal(r.plan.ventana_fin, "2026-11-25T04:59:59.999Z");
  assert.equal(r.plan.mueve_fecha, true);
  assert.deepEqual(r.plan.candidata, { animales: 4, orden: 1, estado: "vinculada" });
  assert.deepEqual(r.plan.reordenar, []);
  assert.deepEqual(r.plan.excede, []);
  assert.deepEqual(r.plan.liberadas, []);
  assert.equal(r.plan.restantes, 6);
});

test("armarPlanVincular: una candidata que no cabe va bloqueada excede_animales y no consume", () => {
  const r = Modelo.armarPlanVincular({
    cabecera: cabecera({ animales: 5 }),
    recepcion: { id: 102, fechaIngreso: "2026-11-23", recibidoAt: "2026-11-23T16:00:00.000Z", animales: 3 },
    sedes: [filaSede({ recepcionId: 101, animales: 4, orden: 1 })],
  });
  assert.equal(r.plan.candidata.estado, "bloqueada");
  assert.equal(r.plan.candidata.motivo_bloqueo, "excede_animales");
  assert.equal(r.plan.restantes, 1);
  assert.equal(r.plan.mueve_fecha, false);
});

test("armarPlanVincular: reordena solo vinculadas y las fijas conservan su orden", () => {
  // 101 ya está calculada (fija, orden 1). 102 vinculada (orden 2) llegó después, pero 103
  // tiene fecha de ingreso anterior: toma el slot 2 y 102 pasa al slot 3.
  const r = Modelo.armarPlanVincular({
    cabecera: cabecera({ animales: 20 }),
    recepcion: { id: 103, fechaIngreso: "2026-11-23", recibidoAt: "2026-11-23T10:00:00.000Z", animales: 3 },
    sedes: [
      filaSede({ recepcionId: 101, orden: 1, estado: "calculada" }),
      filaSede({ recepcionId: 102, orden: 2, estado: "vinculada", recibidoAt: "2026-11-23T18:00:00.000Z" }),
    ],
  });
  assert.deepEqual(r.plan.reordenar, [{ recepcion_id: 102, orden: 3 }]);
  assert.equal(r.plan.candidata.orden, 2);
  assert.ok(!r.plan.reordenar.some((x) => x.recepcion_id === 101));
});

test("armarPlanVincular: una vinculada que deja de caber sale en excede (sin la candidata)", () => {
  const r = Modelo.armarPlanVincular({
    cabecera: cabecera({ animales: 6 }),
    recepcion: { id: 103, fechaIngreso: "2026-11-23", recibidoAt: "2026-11-23T10:00:00.000Z", animales: 4 },
    sedes: [filaSede({ recepcionId: 102, orden: 1, estado: "vinculada", animales: 4, recibidoAt: "2026-11-23T18:00:00.000Z" })],
  });
  assert.deepEqual(r.plan.excede, [102]);
  assert.equal(r.plan.candidata.estado, "vinculada");
});

test("armarPlanVincular: novillos no entero o <= 0 se rechaza antes de la RPC", () => {
  for (const animales of [0, -1, 2.5, NaN]) {
    const r = Modelo.armarPlanVincular({
      cabecera: cabecera(),
      recepcion: { id: 101, fechaIngreso: "2026-11-23", recibidoAt: null, animales },
      sedes: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.resultado, "novillos_invalido");
  }
});

// ─── vincularRecepcion (lectura + plan + RPC) ──────────────────────────────

test("vincularRecepcion: llama a la RPC con la versión leída y el plan", async () => {
  respuestasRpc = [{ resultado: "vinculada", preliquidacion_id: 1, restantes: 6 }];
  const r = await Modelo.vincularRecepcion(101);
  assert.equal(r.resultado, "vinculada");
  assert.equal(rpcs.length, 1);
  assert.equal(rpcs[0].nombre, "carnes_preliq_vincular");
  assert.equal(rpcs[0].args.p_recepcion_id, 101);
  assert.equal(rpcs[0].args.p_preliquidacion_id, 1);
  assert.equal(rpcs[0].args.p_orden_version, 5);
  assert.equal(rpcs[0].args.p_plan.candidata.animales, 4);
});

test("vincularRecepcion: version_cambiada relee y recalcula (máx. 3)", async () => {
  respuestasRpc = [{ resultado: "version_cambiada" }, { resultado: "vinculada", preliquidacion_id: 1 }];
  tablas.carnes_preliquidaciones[0].orden_version = 5;
  const r = await Modelo.vincularRecepcion(101);
  assert.equal(r.resultado, "vinculada");
  assert.equal(rpcs.length, 2);
});

test("vincularRecepcion: agotados los reintentos responde 409 version_cambiada", async () => {
  respuestasRpc = [{ resultado: "version_cambiada" }, { resultado: "version_cambiada" }, { resultado: "version_cambiada" }];
  await falla(() => Modelo.vincularRecepcion(101), 409, "version_cambiada");
  assert.equal(rpcs.length, 3);
});

test("vincularRecepcion: sin preliquidación abierta de la especie no llama a la RPC", async () => {
  tablas.carnes_preliquidaciones = [];
  await falla(() => Modelo.vincularRecepcion(101), 409, "sin_preliquidacion");
  assert.equal(rpcs.length, 0);
});

test("vincularRecepcion: fuera de ventana no llama a la RPC", async () => {
  tablas.carnes_recepciones[0].fecha_ingreso = "2026-12-30";
  await falla(() => Modelo.vincularRecepcion(101), 422, "fuera_ventana");
  assert.equal(rpcs.length, 0);
});

test("vincularRecepcion: una recepción ya vinculada responde 409 ya_vinculada sin RPC", async () => {
  tablas.carnes_recepciones[0].preliquidacion_id = 1;
  await falla(() => Modelo.vincularRecepcion(101), 409, "ya_vinculada");
  assert.equal(rpcs.length, 0);
});

test("vincularRecepcion: la recepción inexistente es 404", async () => {
  await falla(() => Modelo.vincularRecepcion(999), 404, "sin_recepcion");
});

test("vincularRecepcion: una recepción de otra especie no entra", async () => {
  tablas.carnes_recepciones[0].especie = "cerdo";
  await falla(() => Modelo.vincularRecepcion(101), 409, "sin_preliquidacion");
});

test("vincularRecepcion: preliquidacion_id explícito fuerza esa cabecera", async () => {
  tablas.carnes_preliquidaciones.push(cabecera({ id: 2, fecha_primer_ingreso: null, ventana_fin: null }));
  respuestasRpc = [{ resultado: "vinculada", preliquidacion_id: 1 }];
  await Modelo.vincularRecepcion(101, { preliquidacionId: 1 });
  assert.equal(rpcs[0].args.p_preliquidacion_id, 1);
});

// ─── desvincularSede (M4: p_plan con liberadas) ────────────────────────────

test("desvincularSede: manda reordenar, liberadas y restantes a la RPC (M4)", async () => {
  // animales=10: A=4, B=5 vinculadas, C=3 desborde. Al quitar B, C entra a liberadas.
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 5, orden: 2 }),
    sede({ id: 13, recepcion_id: 103, animales: 3, orden: 3, estado: "bloqueada", motivo_bloqueo: "excede_animales" }),
  ];
  tablas.carnes_recepciones = [
    recepcion({ id: 101 }),
    recepcion({ id: 102 }),
    recepcion({ id: 103 }),
  ];
  respuestasRpc = [{ resultado: "ok" }];
  await Modelo.desvincularSede(12);
  assert.equal(rpcs[0].nombre, "carnes_preliq_desvincular");
  assert.equal(rpcs[0].args.p_sede_id, 12);
  assert.equal(rpcs[0].args.p_orden_version, 5);
  assert.deepEqual(rpcs[0].args.p_plan.liberadas, [103]);
  assert.equal(rpcs[0].args.p_plan.restantes, 3);
  assert.ok(Array.isArray(rpcs[0].args.p_plan.reordenar));
});

test("desvincularSede: una sede enviada se rechaza sin llamar a la RPC", async () => {
  tablas.carnes_preliquidacion_sedes = [sede({ id: 11, estado: "enviada" })];
  await falla(() => Modelo.desvincularSede(11), 409, "sede_enviada");
  assert.equal(rpcs.length, 0);
});

test("desvincularSede: una sede de otra preliquidación es 404 y no llama a la RPC", async () => {
  tablas.carnes_preliquidacion_sedes = [sede({ id: 11, preliquidacion_id: 1 })];
  await falla(() => Modelo.desvincularSede(11, { preliquidacionId: 2 }), 404, "no_encontrada");
  assert.equal(rpcs.length, 0);
  respuestasRpc = [{ resultado: "ok" }];
  await Modelo.desvincularSede(11, { preliquidacionId: 1 });
  assert.equal(rpcs.length, 1);
});

test("desvincularSede: sede inexistente es 404", async () => {
  await falla(() => Modelo.desvincularSede(77), 404, "no_encontrada");
});

// ─── actualizarNovillos ────────────────────────────────────────────────────

test("actualizarNovillos: calcula el plan con los nuevos animales y llama a la RPC", async () => {
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 5, orden: 2 }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101, preliquidacion_id: 1 }), recepcion({ id: 102, preliquidacion_id: 1 })];
  respuestasRpc = [{ resultado: "excede" }];
  const r = await Modelo.actualizarNovillos(101, 8);
  assert.equal(r.resultado, "excede");
  const a = rpcs[0].args;
  assert.equal(rpcs[0].nombre, "carnes_preliq_actualizar_novillos");
  assert.equal(a.p_recepcion_id, 101);
  assert.equal(a.p_novillos, 8);
  assert.equal(a.p_orden_version, 5);
  assert.deepEqual(a.p_plan.excede, [102]);
});

test("actualizarNovillos: valor inválido se rechaza antes de la RPC", async () => {
  for (const n of [0, -2, 2.5, "x"]) {
    await falla(() => Modelo.actualizarNovillos(101, n), 422, "novillos_invalido");
  }
  assert.equal(rpcs.length, 0);
});

test("actualizarNovillos: una recepción sin preliquidación responde 409 no_vinculada", async () => {
  await falla(() => Modelo.actualizarNovillos(101, 3), 409, "no_vinculada");
  assert.equal(rpcs.length, 0);
});

test("actualizarNovillos (I3): una sede calculada, en error o simulada llega a la RPC", async () => {
  for (const estado of ["calculada", "error", "simulada", "lista_para_enviar", "bloqueada"]) {
    rpcs = [];
    tablas.carnes_preliquidacion_sedes = [sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1, estado })];
    tablas.carnes_recepciones = [recepcion({ id: 101, preliquidacion_id: 1 })];
    respuestasRpc = [{ resultado: "ok" }];
    const r = await Modelo.actualizarNovillos(101, 6);
    assert.equal(r.resultado, "ok", estado);
    assert.equal(rpcs.length, 1, estado);
    assert.equal(rpcs[0].args.p_novillos, 6, estado);
    // Una sede ya no vinculada conserva su orden: el plan no la reordena.
    assert.deepEqual(rpcs[0].args.p_plan.reordenar, [], estado);
    assert.equal(rpcs[0].args.p_plan.restantes, 4, estado);
  }
});

test("actualizarNovillos (I3): los estados enviados responden 409 sede_no_editable (código de la RPC)", async () => {
  for (const estado of ["enviando", "enviada", "sin_confirmar", "anulada"]) {
    rpcs = [];
    tablas.carnes_preliquidacion_sedes = [sede({ id: 11, recepcion_id: 101, animales: 4, estado })];
    tablas.carnes_recepciones = [recepcion({ id: 101, preliquidacion_id: 1 })];
    respuestasRpc = [{ resultado: "sede_no_editable", estado }];
    await falla(() => Modelo.actualizarNovillos(101, 3), 409, "sede_no_editable");
  }
});

test("actualizarNovillos (I3): una sede ya costeada que pasaría de la capacidad se rechaza sin llamar a la RPC", async () => {
  // animales = 10; 101 (calculada, 4) y 102 (calculada, 5). Subir 101 a 6 daría 11 > 10.
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1, estado: "calculada" }),
    sede({ id: 12, recepcion_id: 102, animales: 5, orden: 2, estado: "calculada" }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101, preliquidacion_id: 1 }), recepcion({ id: 102, preliquidacion_id: 1 })];
  await falla(() => Modelo.actualizarNovillos(101, 6), 409, "excede_capacidad");
  assert.equal(rpcs.length, 0);
  // 5 sí cabe (5 + 5 = 10).
  respuestasRpc = [{ resultado: "ok" }];
  await Modelo.actualizarNovillos(101, 5);
  assert.equal(rpcs.length, 1);
});

test("actualizarNovillos: sede_no_editable de la RPC sale como 409", async () => {
  tablas.carnes_preliquidacion_sedes = [sede({ id: 11, recepcion_id: 101, estado: "enviada" })];
  tablas.carnes_recepciones = [recepcion({ id: 101, preliquidacion_id: 1 })];
  respuestasRpc = [{ resultado: "sede_no_editable", estado: "enviada" }];
  await falla(() => Modelo.actualizarNovillos(101, 3), 409, "sede_no_editable");
});

// ─── crear ─────────────────────────────────────────────────────────────────

test("crear: pasa los datos a la RPC y devuelve la preliquidación", async () => {
  respuestasRpc = [{ resultado: "ok", preliquidacion_id: 1 }];
  const r = await Modelo.crear("res", { animales: 10, animal_en_pie: 1000000, servicio: 700000, tercero_id: "frigorifico" }, { por: "ana@x.co" });
  assert.equal(rpcs[0].nombre, "carnes_preliq_crear");
  assert.equal(rpcs[0].args.p_especie, "res");
  assert.equal(rpcs[0].args.p_datos.animales, 10);
  assert.equal(rpcs[0].args.p_datos.servicio, 700000);
  // Antes del primer ingreso no hay corte: el servicio también es el de precorte.
  assert.equal(rpcs[0].args.p_datos.servicio_precorte, 700000);
  assert.equal(rpcs[0].args.p_datos.creado_por, "ana@x.co");
  assert.equal(r.id, 1);
});

test("crear: config_servicio_cero y abierta_en_curso son 409", async () => {
  respuestasRpc = [{ resultado: "config_servicio_cero" }];
  await falla(() => Modelo.crear("res", { animales: 3 }), 409, "config_servicio_cero");
  respuestasRpc = [{ resultado: "abierta_en_curso", preliquidacion_id: 4 }];
  await falla(() => Modelo.crear("res", { animales: 3 }), 409, "abierta_en_curso");
});

// ─── actualizar (PATCH) ────────────────────────────────────────────────────

test("actualizar: antes de congelar edita los campos de cabecera con CAS de versión", async () => {
  await Modelo.actualizar(1, { animales: 12, tercero_id: "otro" }, { por: "ana@x.co" });
  const e = escrituras.find((x) => x.tabla === "carnes_preliquidaciones" && x.op === "update");
  assert.equal(e.valores.animales, 12);
  assert.equal(e.valores.tercero_id, "otro");
  assert.equal(e.valores.version, 4);
  assert.deepEqual(e.filtros.map(([c]) => c).sort(), ["id", "version"]);
});

test("actualizar: reintenta si otra escritura cambió la versión", async () => {
  casRechazado = 1;
  await Modelo.actualizar(1, { animales: 12 });
  const updates = escrituras.filter((x) => x.op === "update");
  assert.equal(updates.length, 2);
});

test("actualizar: reducir animales por debajo de lo ya consumido es 409", async () => {
  tablas.carnes_preliquidacion_sedes = [sede({ animales: 4 }), sede({ id: 12, recepcion_id: 102, animales: 5 })];
  await falla(() => Modelo.actualizar(1, { animales: 8 }), 409, "animales_insuficientes");
  assert.equal(escrituras.filter((x) => x.op === "update").length, 0);
});

test("actualizar: servicio va por la RPC con corte, desbloqueo y fecha de primer ingreso", async () => {
  respuestasRpc = [{ resultado: "ok", congelada: false, desbloqueo: false }];
  const r = await Modelo.actualizar(1, { servicio: 700000 }, { por: "ana@x.co" });
  assert.equal(rpcs[0].nombre, "carnes_preliq_actualizar_servicio");
  const a = rpcs[0].args;
  assert.equal(a.p_id, 1);
  assert.equal(a.p_servicio, 700000);
  assert.equal(a.p_por, "ana@x.co");
  assert.equal(a.p_fecha_primer_ingreso, "2026-11-23");
  assert.equal(a.p_corte, "2026-11-24T02:30:00.000Z");
  assert.equal(a.p_desbloqueo, false);
  assert.equal(r.resultado, "ok");
});

test("actualizar: servicio sin primer ingreso manda corte NULL", async () => {
  tablas.carnes_preliquidaciones[0].fecha_primer_ingreso = null;
  respuestasRpc = [{ resultado: "ok" }];
  await Modelo.actualizar(1, { servicio: 1 });
  assert.equal(rpcs[0].args.p_corte, null);
  assert.equal(rpcs[0].args.p_fecha_primer_ingreso, null);
});

test("actualizar: p_desbloqueo sale de desbloqueaServicioCero (M3)", async () => {
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "0";
  tablas.carnes_preliquidaciones[0].servicio_precorte = "0";
  respuestasRpc = [{ resultado: "tardio", desbloqueo: true }];
  const r = await Modelo.actualizar(1, { servicio: 500000 });
  assert.equal(rpcs[0].args.p_desbloqueo, true);
  assert.equal(r.resultado, "tardio");
});

test("actualizar: tras congelar solo se acepta servicio; lo demás es 409 preliquidacion_congelada", async () => {
  tablas.carnes_preliquidaciones[0].liquidada_at = "2026-11-24T02:31:00.000Z";
  await falla(() => Modelo.actualizar(1, { animales: 12 }), 409, "preliquidacion_congelada");
  await falla(() => Modelo.actualizar(1, { servicio: 1, tercero_id: "x" }), 409, "preliquidacion_congelada");
  assert.equal(rpcs.length, 0);
  respuestasRpc = [{ resultado: "tardio", congelada: true }];
  const r = await Modelo.actualizar(1, { servicio: 800000 });
  assert.equal(r.resultado, "tardio");
  assert.equal(rpcs[0].args.p_desbloqueo, false);
});

test("actualizar: preliquidación inexistente es 404", async () => {
  await falla(() => Modelo.actualizar(55, { animales: 3 }), 404);
});

// ─── guardarGastos ─────────────────────────────────────────────────────────

test("guardarGastos: reemplaza las filas y sube la versión de la cabecera", async () => {
  tablas.carnes_preliquidacion_gastos = [{ id: 1, preliquidacion_id: 1, concepto: "viejo", valor: 5, signo: 1 }];
  await Modelo.guardarGastos(1, [{ concepto: "Flete", valor: 100000, signo: 1 }, { concepto: "Descuento", valor: 20000, signo: -1 }]);
  const insert = escrituras.find((x) => x.tabla === "carnes_preliquidacion_gastos" && x.op === "insert");
  assert.equal(insert.valores.length, 2);
  assert.equal(insert.valores[0].preliquidacion_id, 1);
  assert.equal(insert.valores[1].orden, 1);
  assert.ok(escrituras.some((x) => x.tabla === "carnes_preliquidacion_gastos" && x.op === "delete"));
  const up = escrituras.find((x) => x.tabla === "carnes_preliquidaciones" && x.op === "update");
  assert.equal(up.valores.version, 4);
});

test("guardarGastos: congelada responde 409 y no escribe", async () => {
  tablas.carnes_preliquidaciones[0].liquidada_at = "2026-11-24T02:31:00.000Z";
  await falla(() => Modelo.guardarGastos(1, []), 409, "preliquidacion_congelada");
  assert.equal(escrituras.length, 0);
});

// ─── previsualizar: nunca escribe ──────────────────────────────────────────

test("previsualizar: calcula gasto total, montos por sede y costeo sin escribir ni llamar RPC", async () => {
  tablas.carnes_preliquidacion_gastos = [{ id: 1, preliquidacion_id: 1, concepto: "Flete", valor: "100000.00", signo: 1 }];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2 }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101 }), recepcion({ id: 102 })];
  tablas.carnes_recepcion_items = [
    { id: 1, recepcion_id: 101, tipo: "carne", cantidad: "100", costo_base: "10000", descripcion: "x", orden: 1 },
    { id: 2, recepcion_id: 102, tipo: "carne", cantidad: "150", costo_base: "10000", descripcion: "x", orden: 1 },
  ];
  const r = await Modelo.previsualizar(1);
  // 1.000.000 + servicio (50.000 x 10) + 100.000 = 1.600.000
  assert.equal(r.gasto_total, "1600000.00");
  assert.equal(r.servicio_aplicado, "500000.00");
  assert.equal(r.bloqueo, null);
  assert.equal(r.sedes.length, 2);
  assert.equal(r.sedes[0].gasto_sede, "640000.00");
  assert.equal(r.sedes[1].gasto_sede, "960000.00");
  assert.ok(r.sedes.every((s) => typeof s.utilidad === "string" && typeof s.servicio_compra === "string"));
  assert.equal(rpcs.length, 0);
  assert.equal(escrituras.length, 0);
});

test("previsualizar: servicio en cero reporta el bloqueo y no costea sedes", async () => {
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "0";
  tablas.carnes_preliquidacion_sedes = [sede()];
  const r = await Modelo.previsualizar(1);
  assert.equal(r.bloqueo, "servicio_cero");
  assert.deepEqual(r.sedes, []);
  assert.equal(escrituras.length, 0);
});

test("previsualizar: M3 un precorte en 0 con servicio por animal > 0 usa el por animal", async () => {
  tablas.carnes_preliquidaciones[0].servicio_precorte = "0";
  const r = await Modelo.previsualizar(1);
  assert.equal(r.bloqueo, null);
  assert.equal(r.servicio_aplicado, "500000.00");
});

test("previsualizar: un desborde sin liberar no consume ni recibe monto", async () => {
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 10, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 3, orden: 2, estado: "bloqueada", motivo_bloqueo: "excede_animales" }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101 }), recepcion({ id: 102 })];
  const r = await Modelo.previsualizar(1);
  assert.equal(r.sedes.length, 1);
  assert.equal(r.sedes[0].sede_id, 11);
});

test("previsualizar: preliquidación inexistente es 404", async () => {
  await falla(() => Modelo.previsualizar(99), 404);
});

// ─── config ────────────────────────────────────────────────────────────────

test("guardarConfig: exige servicio_por_animal > 0", async () => {
  await falla(() => Modelo.guardarConfig("res", { servicio_por_animal: 0 }), 422);
  await falla(() => Modelo.guardarConfig("res", { servicio_por_animal: -5 }), 422);
  await falla(() => Modelo.guardarConfig("vaca", { servicio_por_animal: 5 }), 400);
});

// ─── obtener: utilidad por sede calculada en el backend (REQ-C3) ───────────

const { gastoTotal, montoSedes, costearSede, centavosATexto } = await import(url("shared/preliquidacionCosteo.js"));
const { valorVicerasSede, valorRetomasSedes } = await import(url("shared/preliquidacionFuentes.js"));

const itemsCarne = (recepcionId, cantidad) => [
  { id: recepcionId * 10 + 1, recepcion_id: recepcionId, tipo: "carne", cantidad: String(cantidad), costo_base: "10000", descripcion: "Lomo", orden: 1 },
];

test("obtener (res): gasto_sede, utilidad y servicio_compra salen de las funciones puras, con vísceras", async () => {
  tablas.carnes_preliquidacion_gastos = [{ id: 1, preliquidacion_id: 1, concepto: "Flete", valor: "100000.00", signo: 1, orden: 0 }];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2 }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101 }), recepcion({ id: 102 })];
  const vicera = (recepcionId, cantidad) => ({
    id: recepcionId * 10 + 5, recepcion_id: recepcionId, tipo: "vicera", bloque: "bonificacion",
    cantidad: String(cantidad), costo_base: "5000", descripcion: "Higado", orden: 2,
  });
  tablas.carnes_recepcion_items = [
    ...itemsCarne(101, 100), vicera(101, 20),
    ...itemsCarne(102, 150), vicera(102, 10),
  ];

  const r = await Modelo.obtener(1);

  // Referencia: las mismas funciones puras, llamadas directo.
  const g = gastoTotal({ animalEnPie: "1000000.00", servicioPrecorte: null, servicioPorAnimal: "50000.00", animales: 10, gastos: tablas.carnes_preliquidacion_gastos, saldos: [] });
  const montos = montoSedes(
    [{ sedeId: 11, animales: 4 }, { sedeId: 12, animales: 6 }],
    { gastoTotalCent: g.gastoTotalCent, animales: 10 },
  );
  const esperada = (sedeId, recepcionId) => {
    const items = tablas.carnes_recepcion_items.filter((i) => i.recepcion_id === recepcionId);
    return costearSede({
      items: items.filter((i) => i.tipo === "carne"),
      gastoSedeCent: montos.find((m) => m.sedeId === sedeId).gastoSedeCent,
      especie: "res",
      valorVicerasCent: valorVicerasSede({ items }, "res"),
    }).plan;
  };

  assert.equal(r.calculo.gasto_total, centavosATexto(g.gastoTotalCent));
  for (const [sedeId, recepcionId] of [[11, 101], [12, 102]]) {
    const s = r.sedes.find((x) => x.id === sedeId);
    const e = esperada(sedeId, recepcionId);
    assert.equal(s.gasto_sede, e.gasto_sede, `gasto_sede ${sedeId}`);
    assert.equal(s.utilidad, e.utilidad, `utilidad ${sedeId}`);
    assert.equal(s.servicio_compra, e.servicio_compra, `servicio_compra ${sedeId}`);
    assert.equal(s.valor_viceras, e.valor_viceras);
    assert.equal(s.fuente_calculo, "previsualizado");
  }
  // Las vísceras de res entran a la utilidad (no son cero).
  assert.notEqual(r.sedes.find((x) => x.id === 11).valor_viceras, "0.00");
});

test("obtener (cerdo): la utilidad usa las retomas repartidas por animales, no vísceras", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ especie: "cerdo", animales: 10 })];
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, orden: 1 }),
    sede({ id: 12, recepcion_id: 102, animales: 6, orden: 2 }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101, especie: "cerdo" }), recepcion({ id: 102, especie: "cerdo" })];
  tablas.carnes_recepcion_items = [...itemsCarne(101, 100), ...itemsCarne(102, 150)];
  tablas.carnes_preliquidacion_retomas = [{ id: 1, preliquidacion_id: 1, kilos: "10.000", precio: "3000.00" }];

  const r = await Modelo.obtener(1);

  const g = gastoTotal({ animalEnPie: "1000000.00", servicioPrecorte: null, servicioPorAnimal: "50000.00", animales: 10, gastos: [], saldos: [] });
  const montos = montoSedes([{ sedeId: 11, animales: 4 }, { sedeId: 12, animales: 6 }], { gastoTotalCent: g.gastoTotalCent, animales: 10 });
  const retomas = valorRetomasSedes(tablas.carnes_preliquidacion_retomas, [{ sedeId: 11, animales: 4 }, { sedeId: 12, animales: 6 }], 10);
  for (const [sedeId, recepcionId] of [[11, 101], [12, 102]]) {
    const e = costearSede({
      items: itemsCarne(recepcionId, recepcionId === 101 ? 100 : 150),
      gastoSedeCent: montos.find((m) => m.sedeId === sedeId).gastoSedeCent,
      especie: "cerdo",
      valorRetomasCent: retomas.find((x) => x.sedeId === sedeId).valorRetomasCent,
    }).plan;
    const s = r.sedes.find((x) => x.id === sedeId);
    assert.equal(s.utilidad, e.utilidad);
    assert.equal(s.servicio_compra, e.servicio_compra);
    assert.equal(s.valor_viceras, "0.00");
    assert.equal(s.valor_retomas, e.valor_retomas);
  }
});

test("obtener: una sede con costeo congelado conserva sus montos guardados (no se recalculan)", async () => {
  tablas.carnes_preliquidacion_sedes = [
    sede({ id: 11, recepcion_id: 101, animales: 4, estado: "enviada", gasto_sede: "640000.00", utilidad: "12345.67", servicio_compra: "6172.84", valor_viceras: "0.00", valor_retomas: "0.00" }),
  ];
  tablas.carnes_recepciones = [recepcion({ id: 101 })];
  tablas.carnes_recepcion_items = itemsCarne(101, 100);
  const r = await Modelo.obtener(1);
  const s = r.sedes[0];
  assert.equal(s.gasto_sede, "640000.00");
  assert.equal(s.utilidad, "12345.67");
  assert.equal(s.servicio_compra, "6172.84");
  assert.equal(s.fuente_calculo, "congelado");
});

test("obtener: con servicio_cero no hay montos por sede y se informa el bloqueo", async () => {
  tablas.carnes_preliquidaciones[0].servicio_por_animal = "0";
  tablas.carnes_preliquidacion_sedes = [sede()];
  tablas.carnes_recepciones = [recepcion()];
  const r = await Modelo.obtener(1);
  assert.equal(r.calculo.bloqueo, "servicio_cero");
  assert.equal(r.sedes[0].utilidad, null);
  assert.equal(r.sedes[0].fuente_calculo, null);
});

test("obtener: un fallo del cálculo no tumba la lectura de la preliquidación", async () => {
  tablas.carnes_preliquidaciones[0].animal_en_pie = "no-es-un-numero";
  tablas.carnes_preliquidacion_sedes = [sede()];
  tablas.carnes_recepciones = [recepcion()];
  const r = await Modelo.obtener(1);
  assert.equal(r.id, 1);
  assert.equal(r.calculo, null);
  assert.match(r.calculo_error, /\S/);
});

test("obtener: no escribe nada ni llama a la RPC", async () => {
  tablas.carnes_preliquidacion_sedes = [sede()];
  tablas.carnes_recepciones = [recepcion()];
  tablas.carnes_recepcion_items = itemsCarne(101, 100);
  await Modelo.obtener(1);
  assert.equal(rpcs.length, 0);
  assert.equal(escrituras.length, 0);
});

// ─── M5: el payload expone siesa_activo para ocultar "Enviar" ──────────────

test("[M5] obtener expone siesa_activo según CARNES_SIESA_ACTIVO (true y false)", async () => {
  tablas.carnes_preliquidacion_sedes = [];
  const previo = process.env.CARNES_SIESA_ACTIVO;
  try {
    process.env.CARNES_SIESA_ACTIVO = "true";
    assert.equal((await Modelo.obtener(1)).siesa_activo, true);
    process.env.CARNES_SIESA_ACTIVO = "false";
    assert.equal((await Modelo.obtener(1)).siesa_activo, false);
  } finally {
    if (previo === undefined) delete process.env.CARNES_SIESA_ACTIVO;
    else process.env.CARNES_SIESA_ACTIVO = previo;
  }
});
