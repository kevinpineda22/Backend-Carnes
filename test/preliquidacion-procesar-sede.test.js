// procesarSede: reclamar -> enviar -> mapear -> cerrar_envio -> alertas, con Supabase y
// SIESA FALSOS (el envío se inyecta). Nada sale a la red ni toca una base real.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

let rpcs = [];
let respuestasRpc = {}; // nombre -> cola de respuestas
let versionTrasOmitir = 9;
const supabaseFalso = {
  // Lo único que procesarSede lee de una tabla: la versión de la sede tras omitir la inicial.
  from: (tabla) => {
    if (tabla !== "carnes_preliquidacion_sedes") throw new Error("procesarSede no debe leer tablas directamente");
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { version: versionTrasOmitir }, error: null }) };
    return q;
  },
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const cola = respuestasRpc[nombre];
    const data = cola?.length ? cola.shift() : { resultado: "ok" };
    return { data, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Modelo = await import(url("models/Preliquidacion.model.js"));

const AHORA = new Date("2026-11-24T03:00:00.000Z");
const header = (extra = {}) => ({ id: 1, especie: "res", orden_version: 5, liquidada_at: "2026-11-24T02:30:00Z", ...extra });
const sede = (extra = {}) => ({
  id: 11,
  preliquidacion_id: 1,
  recepcion_id: 101,
  animales: 4,
  estado: "calculada",
  version: 7,
  intentos: 0,
  gasto_sede: "400000.00",
  costeo_orden_version: 5,
  costeo_animales: 4,
  requiere_correccion: false,
  correccion_orden_version: null,
  envio_id: null,
  claim_token: null,
  ...extra,
});

let enviados = [];
let alertas = [];
let respuestaEnvio;
const enviar = async (recepcionId, opciones) => {
  enviados.push({ recepcionId, opciones });
  if (respuestaEnvio instanceof Error) throw respuestaEnvio;
  return respuestaEnvio;
};
const encolar = async (a) => {
  alertas.push(a);
  return { ok: true };
};
const reclamoOk = (extra = {}) => ({ resultado: "ok", sede_version: 8, intentos: 1, claim_costeo_orden_version: 5, ...extra });

const procesar = (s, extra = {}) =>
  Modelo.procesarSede(s, {
    header: header(),
    origen: "schedule",
    corridaId: 90,
    ahora: AHORA,
    siesaActivo: true,
    enviar,
    encolar,
    por: "cron",
    timeoutMs: 20000,
    ...extra,
  });

const rpcDe = (nombre) => rpcs.filter((r) => r.nombre === nombre);

beforeEach(() => {
  rpcs = [];
  enviados = [];
  alertas = [];
  respuestasRpc = {};
  versionTrasOmitir = 9;
  respuestaEnvio = { fila: { id: 500, estado: "ok", repetido: false, error: null }, armadoBloqueos: [] };
});

test("D-S5: reclamo perdido (no_reclamada) es no-op: no envía ni cierra", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "no_reclamada" }];
  const r = await procesar(sede());
  assert.equal(r.resultado, "no_reclamada");
  assert.equal(enviados.length, 0);
  assert.equal(rpcDe("carnes_preliq_cerrar_envio").length, 0);
});

test("JD S2: reclamo con la cabecera ya cerrada (no_abierta) es no-op, no un error", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "no_abierta" }];
  const r = await procesar(sede());
  assert.equal(r.resultado, "no_reclamada");
  assert.equal(enviados.length, 0);
});

test("reclama con CAS de estado+versión, token UUID, corrida y origen", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  await procesar(sede());
  const { args } = rpcDe("carnes_preliq_reclamar_sede")[0];
  assert.equal(args.p_sede_id, 11);
  assert.equal(args.p_sede_version, 7);
  assert.equal(args.p_desde, "calculada");
  assert.equal(args.p_corrida_id, 90);
  assert.equal(args.p_origen, "schedule");
  assert.equal(args.p_reset_intentos, false);
  assert.match(args.p_token, /^[0-9a-f-]{36}$/);
});

test("envío ok: cierra con el mismo token, hacia enviada y recepción Enviado_SIESA", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  respuestasRpc.carnes_preliq_cerrar_envio = [{ resultado: "ok", estado: "enviada", sede_version: 9 }];
  const r = await procesar(sede());
  const reclamo = rpcDe("carnes_preliq_reclamar_sede")[0].args;
  const cierre = rpcDe("carnes_preliq_cerrar_envio")[0].args;
  assert.equal(cierre.p_token, reclamo.p_token);
  assert.equal(cierre.p_plan.hacia, "enviada");
  assert.equal(cierre.p_plan.recepcion_estado, "Enviado_SIESA");
  assert.equal(cierre.p_plan.campos.envio_id, 500);
  assert.equal("estado" in cierre.p_plan.campos, false);
  assert.deepEqual(enviados[0], { recepcionId: 101, opciones: { por: "cron", terceroId: undefined, timeoutMs: 20000 } });
  assert.equal(r.resultado, "enviada");
  assert.ok(r.efectos.some((e) => e.tipo === "intentar_autocierre"));
});

test("envío repetido ok: enviada sin aviso de anulación", async () => {
  respuestaEnvio = { fila: { id: 500, estado: "ok", repetido: true }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  const r = await procesar(sede());
  assert.equal(rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan.hacia, "enviada");
  assert.equal(r.efectos.some((e) => e.tipo === "avisar_anulacion"), false);
});

test("envío repetido en vuelo: queda enviando con envio_id y alerta envio_en_vuelo", async () => {
  respuestaEnvio = { fila: { id: 501, estado: "enviando", repetido: true }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  respuestasRpc.carnes_preliq_cerrar_envio = [{ resultado: "ok", estado: "enviando", sede_version: 9 }];
  await procesar(sede());
  assert.equal(rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan.hacia, "enviando");
  assert.deepEqual(alertas.map((a) => a.evento), ["envio_en_vuelo"]);
});

test("sin confirmar: hacia sin_confirmar y alerta", async () => {
  respuestaEnvio = { fila: { id: 502, estado: "sin_confirmar", repetido: false }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  respuestasRpc.carnes_preliq_cerrar_envio = [{ resultado: "ok", estado: "sin_confirmar", sede_version: 9 }];
  await procesar(sede());
  assert.equal(rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan.hacia, "sin_confirmar");
  assert.deepEqual(alertas[0], { evento: "sin_confirmar", preliquidacionId: 1, sedeId: 11, ocurrencia: 9 });
});

test("error transitorio con intentos < 3: error sin alerta", async () => {
  respuestaEnvio = { fila: { id: 503, estado: "error", repetido: false, http_status: 503 }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk({ intentos: 1 })];
  await procesar(sede());
  const plan = rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan;
  assert.equal(plan.hacia, "error");
  assert.equal(plan.campos.error_tipo, "transitorio");
  assert.equal(alertas.length, 0);
});

test("error transitorio con 3 intentos: reintentos_agotados + alerta (intentos del reclamo)", async () => {
  respuestaEnvio = { fila: { id: 503, estado: "error", repetido: false, http_status: 503 }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk({ intentos: 3 })];
  await procesar(sede({ estado: "error", error_tipo: "transitorio", intentos: 2, ultima_corrida: 1 }));
  const plan = rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan;
  assert.equal(plan.campos.motivo_pendiente, "reintentos_agotados");
  assert.deepEqual(alertas.map((a) => a.evento), ["reintentos_agotados"]);
});

test("rechazo de SIESA (4xx): error permanente con alerta envio_error", async () => {
  respuestaEnvio = { fila: { id: 504, estado: "error", repetido: false, http_status: 400 }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  await procesar(sede());
  assert.equal(rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan.campos.error_tipo, "permanente");
  assert.deepEqual(alertas.map((a) => a.evento), ["envio_error"]);
});

test("armado bloqueado: hacia bloqueada(armado_invalido) con el detalle y alerta", async () => {
  respuestaEnvio = {
    fila: { id: 505, estado: "error", repetido: false, error: "Falta código A. Falta código B." },
    armadoBloqueos: ["Falta código A.", "Falta código B."],
  };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  await procesar(sede());
  const plan = rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan;
  assert.equal(plan.hacia, "bloqueada");
  assert.equal(plan.campos.motivo_bloqueo, "armado_invalido");
  assert.equal(plan.campos.detalle_bloqueo, "Falta código A. Falta código B.");
  assert.deepEqual(alertas.map((a) => a.evento), ["armado_invalido"]);
});

test("I4: si fila.error no coincide con los bloqueos del armado se avisa (sin lanzar)", async () => {
  respuestaEnvio = {
    fila: { id: 505, estado: "error", repetido: false, error: "otro texto" },
    armadoBloqueos: ["Falta código A."],
  };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  const avisos = [];
  const r = await procesar(sede(), { log: { warn: (m) => avisos.push(m), error() {} } });
  assert.equal(r.paridad_armado, false);
  assert.equal(avisos.length, 1);
});

test("I4: con paridad correcta no hay aviso", async () => {
  respuestaEnvio = {
    fila: { id: 505, estado: "error", repetido: false, error: "Falta código A." },
    armadoBloqueos: ["Falta código A."],
  };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  const r = await procesar(sede());
  assert.equal(r.paridad_armado, true);
});

test("inicial_pendiente sin inicial vigente: se omite como `sistema` y se reclama otra vez con la versión nueva", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "inicial_pendiente" }, reclamoOk()];
  respuestasRpc.carnes_preliq_omitir_inicial = [{ resultado: "ok", sede_id: 11, recepcion_id: 101 }];
  const r = await procesar(sede({ motivo_pendiente: "inicial_pendiente" }));
  assert.equal(r.resultado, "enviada");
  assert.equal(enviados.length, 1);
  assert.deepEqual(rpcDe("carnes_preliq_omitir_inicial").map((c) => c.args), [{ p_sede_id: 11, p_por: "sistema" }]);
  const reclamos = rpcDe("carnes_preliq_reclamar_sede");
  assert.equal(reclamos.length, 2);
  assert.equal(reclamos[0].args.p_sede_version, 7);
  assert.equal(reclamos[1].args.p_sede_version, 9);
  assert.equal(alertas.length, 0, "no se avisa de una inicial que ya no se espera");
});

test("inicial_pendiente ya omitida (ya_omitida): también se reclama otra vez", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "inicial_pendiente" }, reclamoOk()];
  respuestasRpc.carnes_preliq_omitir_inicial = [{ resultado: "ya_omitida" }];
  const r = await procesar(sede());
  assert.equal(r.resultado, "enviada");
});

test("inicial_pendiente: solo se sana una vez (no hay bucle si el reclamo vuelve a decir inicial_pendiente)", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "inicial_pendiente" }, { resultado: "inicial_pendiente" }];
  respuestasRpc.carnes_preliq_omitir_inicial = [{ resultado: "ok" }, { resultado: "ok" }];
  const r = await procesar(sede());
  assert.equal(r.resultado, "inicial_pendiente");
  assert.equal(rpcDe("carnes_preliq_omitir_inicial").length, 1);
  assert.equal(rpcDe("carnes_preliq_reclamar_sede").length, 2);
  assert.equal(enviados.length, 0);
});

for (const resultado of ["oficial_enviada", "sede_no_enviable", "no_abierta"]) {
  test(`inicial_pendiente: si la RPC responde ${resultado} no se reintenta y sigue pendiente`, async () => {
    respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "inicial_pendiente" }];
    respuestasRpc.carnes_preliq_omitir_inicial = [{ resultado }];
    const r = await procesar(sede());
    assert.equal(r.resultado, "inicial_pendiente");
    assert.equal(rpcDe("carnes_preliq_reclamar_sede").length, 1);
    assert.equal(enviados.length, 0);
  });
}

test("inicial_pendiente: si la RPC de omitir falla (migración sin correr) se comporta como antes", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "inicial_pendiente" }];
  const rpcOriginal = supabaseFalso.rpc;
  supabaseFalso.rpc = async (nombre, args) =>
    nombre === "carnes_preliq_omitir_inicial" ? { data: null, error: { message: "no existe" } } : rpcOriginal(nombre, args);
  try {
    const r = await procesar(sede(), { log: { error() {} } });
    assert.equal(r.resultado, "inicial_pendiente");
    assert.equal(enviados.length, 0);
  } finally {
    supabaseFalso.rpc = rpcOriginal;
  }
});

test("inicial_pendiente: no envía, alerta solo la primera vez", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "inicial_pendiente" }, { resultado: "inicial_pendiente" }];
  // La RPC no acepta omitirla (hay una inicial en vuelo): la sede sigue esperando.
  respuestasRpc.carnes_preliq_omitir_inicial = [{ resultado: "inicial_vigente" }, { resultado: "inicial_vigente" }];
  const primera = await procesar(sede());
  assert.equal(primera.resultado, "inicial_pendiente");
  assert.equal(enviados.length, 0);
  assert.deepEqual(alertas.map((a) => a.evento), ["inicial_pendiente"]);
  const repetida = await procesar(sede({ motivo_pendiente: "inicial_pendiente" }));
  assert.equal(repetida.resultado, "inicial_pendiente");
  assert.equal(alertas.length, 1);
});

test("costeo_desactualizado del RPC: no envía y se informa para recostear", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [{ resultado: "costeo_desactualizado" }];
  const r = await procesar(sede());
  assert.equal(r.resultado, "costeo_desactualizado");
  assert.equal(enviados.length, 0);
});

test("costeo obsoleto en la instantánea: ni siquiera se reclama", async () => {
  const r = await procesar(sede({ costeo_orden_version: 4 }));
  assert.equal(r.resultado, "no_reclamable");
  assert.equal(r.motivo, "costeo_desactualizado");
  assert.equal(rpcs.length, 0);
});

for (const estado of ["bloqueada", "lista_para_enviar", "enviada", "sin_confirmar", "anulada", "vinculada"]) {
  test(`una sede ${estado} nunca llama a SIESA ni al reclamo (origen automático)`, async () => {
    const r = await procesar(sede({ estado }));
    assert.equal(r.resultado, "no_reclamable");
    assert.equal(enviados.length, 0);
    assert.equal(rpcs.length, 0);
  });
}

test("SIESA apagado + calculada: pasa a simulada sin reclamar ni enviar", async () => {
  const r = await procesar(sede(), { siesaActivo: false });
  assert.equal(r.resultado, "simulada");
  assert.equal(enviados.length, 0);
  assert.equal(rpcDe("carnes_preliq_reclamar_sede").length, 0);
  const t = rpcDe("carnes_preliq_transicionar_sede")[0].args;
  assert.equal(t.p_desde, "calculada");
  assert.equal(t.p_hacia, "simulada");
  assert.equal(t.p_sede_version, 7);
});

test("SIESA apagado + simulada (admin): siesa_apagado, sin escribir", async () => {
  const r = await procesar(sede({ estado: "simulada" }), { siesaActivo: false, origen: "admin" });
  assert.equal(r.resultado, "no_reclamable");
  assert.equal(r.motivo, "siesa_apagado");
  assert.equal(rpcs.length, 0);
});

test("SIESA apagado + calculada con version_cambiada: no-op", async () => {
  respuestasRpc.carnes_preliq_transicionar_sede = [{ resultado: "version_cambiada" }];
  const r = await procesar(sede(), { siesaActivo: false });
  assert.equal(r.resultado, "no_reclamada");
});

test("admin reinicia intentos al reclamar una sede en error", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk({ intentos: 1 })];
  await procesar(sede({ estado: "error", error_tipo: "permanente", intentos: 3 }), { origen: "admin" });
  assert.equal(rpcDe("carnes_preliq_reclamar_sede")[0].args.p_reset_intentos, true);
});

test("M2: el reclamo pasa claim_costeo_orden_version; un CEA viejo conserva requiere_correccion", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk({ claim_costeo_orden_version: 3 })];
  await procesar(sede({ requiere_correccion: true, correccion_orden_version: 5 }));
  const plan = rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan;
  assert.equal("requiere_correccion" in plan.campos, false);
});

test("M2: un CEA posterior al recálculo limpia requiere_correccion", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk({ claim_costeo_orden_version: 5 })];
  await procesar(sede({ requiere_correccion: true, correccion_orden_version: 5 }));
  assert.equal(rpcDe("carnes_preliq_cerrar_envio")[0].args.p_plan.campos.requiere_correccion, false);
});

test("token_invalido al cerrar: no-op informado, sin lanzar", async () => {
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  respuestasRpc.carnes_preliq_cerrar_envio = [{ resultado: "token_invalido" }];
  const r = await procesar(sede());
  assert.equal(r.resultado, "token_invalido");
});

test("excepción al enviar: no cierra, la sede queda enviando (se recupera por abandono) y no lanza", async () => {
  respuestaEnvio = new Error("fallo inesperado");
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  const r = await procesar(sede(), { log: { warn() {}, error() {} } });
  assert.equal(r.resultado, "error_envio");
  assert.equal(rpcDe("carnes_preliq_cerrar_envio").length, 0);
});

test("una alerta que falla no tumba el cierre", async () => {
  respuestaEnvio = { fila: { id: 502, estado: "sin_confirmar" }, armadoBloqueos: [] };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  const r = await procesar(sede(), { encolar: async () => { throw new Error("cola caída"); }, log: { warn() {}, error() {} } });
  assert.equal(r.resultado, "sin_confirmar");
});

test("códigos 040 de la tabla de errores HTTP", () => {
  for (const codigo of ["no_reclamada", "costeo_desactualizado", "inicial_pendiente", "token_invalido", "siesa_apagado", "no_abierta", "no_liquidada"]) {
    const error = Modelo.resultadoAError({ resultado: codigo });
    assert.equal(error.statusCode, 409, codigo);
  }
});

// ─── Vísceras (CEI): procesarSede ya NO las manda; las manda la corrida tras todas las oficiales ─

let visceras = [];
let respuestaVisceras;
const enviarVisceras = async (recepcionId, opciones) => {
  visceras.push({ recepcionId, opciones });
  if (respuestaVisceras instanceof Error) throw respuestaVisceras;
  return respuestaVisceras;
};
const restanteAmplio = () => 120000;
const preparaOk = () => {
  visceras = [];
  respuestaVisceras = { estado: "ok", tipo: "visceras_recepcion", recepcion_id: 101 };
  respuestasRpc.carnes_preliq_reclamar_sede = [reclamoOk()];
  respuestasRpc.carnes_preliq_cerrar_envio = [{ resultado: "ok", estado: "enviada", sede_version: 9 }];
};
const cei = (s = sede(), extra = {}) =>
  Modelo.enviarViscerasDeSede(s, {
    especie: "res",
    sedeVersion: 9,
    por: "cron",
    restante: restanteAmplio,
    siesaActivo: true,
    enviarVisceras,
    encolar,
    log: { error() {}, warn() {} },
    ...extra,
  });

test("vísceras: procesarSede NO manda el CEI aunque la oficial quede ok (lo hace la corrida tras TODAS las oficiales)", async () => {
  preparaOk();
  const r = await procesar(sede(), { enviarVisceras, restante: restanteAmplio });
  assert.equal(r.resultado, "enviada");
  assert.equal(r.sede_version, 9);
  assert.equal(visceras.length, 0);
  assert.equal("visceras" in r, false);
});

test("vísceras: ok de una sede de res manda el CEI de su recepción con por y restante, sin alerta", async () => {
  preparaOk();
  const r = await cei();
  assert.equal(r.estado, "ok");
  assert.equal(visceras.length, 1);
  assert.equal(visceras[0].recepcionId, 101);
  assert.equal(visceras[0].opciones.por, "cron");
  assert.equal(visceras[0].opciones.restante, restanteAmplio);
  assert.equal(alertas.length, 0);
});

test("vísceras: cerdo y SIESA apagado no mandan CEI", async () => {
  preparaOk();
  assert.equal((await cei(sede(), { especie: "cerdo" })).estado, "no_aplica");
  assert.equal((await cei(sede(), { siesaActivo: false })).estado, "apagado");
  assert.equal(visceras.length, 0);
});

test("vísceras: un error SIN fila de envío (excepción, lectura fallida) encola visceras_error una vez por versión de la sede", async () => {
  preparaOk();
  respuestaVisceras = { estado: "error", error: "no se pudo leer la recepción", tipo: "visceras_recepcion", recepcion_id: 101 };
  await cei();
  const a = alertas.find((x) => x.evento === "visceras_error");
  assert.ok(a);
  assert.equal(a.sedeId, 11);
  assert.equal(a.ocurrencia, 9);
  assert.equal(a.detalle.error, "no se pudo leer la recepción");
});

test("vísceras: un error de SIESA con fila (referencia) NO duplica el correo: el envío ya avisó, no se encola visceras_error", async () => {
  preparaOk();
  respuestaVisceras = { estado: "error", error: "SIESA dijo no", referencia: "TC VISC R101", tipo: "visceras_recepcion", recepcion_id: 101 };
  const r = await cei();
  assert.equal(r.estado, "error");
  assert.equal(alertas.some((x) => x.evento === "visceras_error"), false);
});

test("vísceras: al agotar los reintentos automáticos se encola visceras_agotadas (una por versión) diciendo que una persona debe reintentar", async () => {
  preparaOk();
  respuestaVisceras = { estado: "agotado", tipo: "visceras_recepcion", recepcion_id: 101 };
  const r = await cei();
  assert.equal(r.estado, "agotado");
  const a = alertas.filter((x) => x.evento === "visceras_agotadas");
  assert.equal(a.length, 1);
  assert.equal(a[0].sedeId, 11);
  assert.equal(a[0].ocurrencia, 9);
  assert.equal(a[0].preliquidacionId, 1);
  assert.match(a[0].detalle.error, /autom[aá]tic/i);
  assert.match(a[0].detalle.error, /manual/i);
  assert.equal(a[0].detalle.recepcion_id, 101);
});

test("vísceras: una excepción del envío no tumba nada y se alerta (no hay fila que haya avisado)", async () => {
  preparaOk();
  respuestaVisceras = new Error("boom");
  const r = await cei();
  assert.equal(r.estado, "error");
  assert.equal(alertas.filter((x) => x.evento === "visceras_error").length, 1);
});

test("vísceras: sin_tiempo, repetido, ok, sin_visceras, bloqueado, anterior_a_activacion y sin_activacion no encolan alerta", async () => {
  for (const resp of [
    { estado: "sin_tiempo" },
    { estado: "error", repetido: true },
    { estado: "ok" },
    { estado: "sin_visceras" },
    { estado: "bloqueado", error: "ya hay un ajuste" },
    { estado: "anterior_a_activacion" },
    { estado: "sin_activacion" },
  ]) {
    preparaOk();
    respuestaVisceras = resp;
    await cei();
    assert.equal(alertas.length, 0, JSON.stringify(resp));
  }
});
