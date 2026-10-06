import test from "node:test";
import assert from "node:assert/strict";

import {
  crearAutenticar,
  crearRequireAdmin,
  crearBitacora,
  quienHace,
  conQuienHace,
} from "../src/middleware/auth.js";

/**
 * Endurecimiento de la autenticación: timeouts, perfil, abuso (precheck, caché
 * negativa, deduplicación), bitácora agregada y el contrato de `off` como no-op.
 * Sin red: todo el proveedor es falso.
 */

// ─── Utilidades ─────────────────────────────────────────────────────────────

function jwt(exp = Math.floor(Date.now() / 1000) + 3600, extra = "") {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ exp, extra })}.firma`;
}

function pedido(sobre = {}) {
  const { token, ...resto } = sobre;
  return {
    method: "GET",
    path: "/recepciones",
    originalUrl: "/api/recepciones/123/items?x=1",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...resto,
  };
}

function correr(mw, req) {
  return new Promise((resolve) => {
    Promise.resolve(mw(req, {}, (err) => resolve({ err, req }))).catch((e) => resolve({ err: e, req }));
  });
}

const modo = (m) => () => m;
const USUARIO = { id: "u-1", email: "Ana.Perez@Merkahorro.COM" };
const conUsuario = (extra = {}) => pedido({ usuario: { id: "u-1", correo: "ana@x.com" }, ...extra });
const colgado = () => new Promise(() => {});

function verificadorFalso(respuesta) {
  const f = async (token) => {
    f.llamadas.push(token);
    if (respuesta instanceof Error) throw respuesta;
    return typeof respuesta === "function" ? respuesta(token) : respuesta;
  };
  f.llamadas = [];
  return f;
}

function conEnv(valor, fn) {
  const previo = process.env.CARNES_AUTH;
  if (valor === undefined) delete process.env.CARNES_AUTH;
  else process.env.CARNES_AUTH = valor;
  try {
    return fn();
  } finally {
    if (previo === undefined) delete process.env.CARNES_AUTH;
    else process.env.CARNES_AUTH = previo;
  }
}

// ─── Timeouts del proveedor ─────────────────────────────────────────────────

test("timeout: verificar colgado en reportar pasa y registra proveedor_no_disponible", async () => {
  const log = [];
  const mw = crearAutenticar({
    verificar: colgado,
    modo: modo("reportar"),
    timeoutMs: 20,
    log: (l) => log.push(l),
  });
  const { err, req } = await correr(mw, pedido({ token: jwt() }));
  assert.equal(err, undefined);
  assert.equal(req.usuario, undefined);
  assert.equal(log[0].motivo, "proveedor_no_disponible");
});

test("timeout: verificar colgado en exigir es 503 AUTH_NO_DISPONIBLE, y no se cachea", async () => {
  let cuelga = true;
  const verificar = verificadorFalso(() => (cuelga ? colgado() : USUARIO));
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), timeoutMs: 20, log: () => {} });
  const token = jwt();
  const { err } = await correr(mw, pedido({ token }));
  assert.equal(err.statusCode, 503);
  assert.equal(err.codigo, "AUTH_NO_DISPONIBLE");
  cuelga = false;
  assert.equal((await correr(mw, pedido({ token }))).err, undefined, "el timeout no deja a nadie afuera");
});

test("timeout: la consulta de permisos de admin colgada es 503 en exigir y pasa en reportar", async () => {
  const exigir = crearRequireAdmin({ puedeAdministrar: colgado, modo: modo("exigir"), timeoutMs: 20, log: () => {} });
  const r = await correr(exigir, conUsuario());
  assert.equal(r.err.statusCode, 503);
  assert.equal(r.err.codigo, "AUTH_NO_DISPONIBLE");

  const log = [];
  const reportar = crearRequireAdmin({
    puedeAdministrar: colgado,
    modo: modo("reportar"),
    timeoutMs: 20,
    log: (l) => log.push(l),
  });
  assert.equal((await correr(reportar, conUsuario())).err, undefined);
  assert.equal(log[0].motivo, "proveedor_no_disponible");
});

// ─── Códigos de error estables ──────────────────────────────────────────────

test("códigos: cada rechazo lleva su `codigo` estable", async () => {
  const exigir = (verificar, extra = {}) =>
    crearAutenticar({ verificar, modo: modo("exigir"), log: () => {}, ...extra });

  assert.equal((await correr(exigir(verificadorFalso(USUARIO)), pedido())).err.codigo, "AUTH_REQUERIDA");
  assert.equal((await correr(exigir(verificadorFalso(null)), pedido({ token: jwt() }))).err.codigo, "AUTH_INVALIDA");
  assert.equal(
    (await correr(exigir(verificadorFalso(new Error("x"))), pedido({ token: jwt() }))).err.codigo,
    "AUTH_NO_DISPONIBLE",
  );

  const admin = (puedeAdministrar) => crearRequireAdmin({ puedeAdministrar, modo: modo("exigir"), log: () => {} });
  assert.equal((await correr(admin(async () => true), pedido())).err.codigo, "AUTH_REQUERIDA");
  assert.equal((await correr(admin(async () => false), conUsuario())).err.codigo, "AUTH_SIN_PERMISO");
});

// ─── Perfil (solo personal) ─────────────────────────────────────────────────

test("perfil: sin fila en profiles, reportar pasa y registra sin_perfil; exigir es 403 AUTH_SIN_PERFIL", async () => {
  const log = [];
  const existePerfil = async () => false;
  const reportar = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    existePerfil,
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  const r = await correr(reportar, pedido({ token: jwt() }));
  assert.equal(r.err, undefined);
  assert.equal(r.req.usuario.id, "u-1");
  assert.equal(log[0].motivo, "sin_perfil");

  const exigir = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    existePerfil,
    modo: modo("exigir"),
    log: () => {},
  });
  const e = await correr(exigir, pedido({ token: jwt() }));
  assert.equal(e.err.statusCode, 403);
  assert.equal(e.err.codigo, "AUTH_SIN_PERFIL");
});

test("perfil: el resultado se cachea 60 s y un «sin perfil» solo 15 s", async () => {
  let t = 1_000_000;
  let tiene = false;
  let consultas = 0;
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    existePerfil: async () => (consultas++, tiene),
    modo: modo("exigir"),
    ahora: () => t,
    ttlMs: 60_000,
    log: () => {},
  });
  const token = jwt(Math.floor(t / 1000) + 99_999);

  assert.equal((await correr(mw, pedido({ token }))).err.statusCode, 403);
  assert.equal((await correr(mw, pedido({ token }))).err.statusCode, 403);
  assert.equal(consultas, 1, "el «no» sale de la caché");

  tiene = true; // le crearon el perfil
  t += 16_000;
  assert.equal((await correr(mw, pedido({ token }))).err, undefined);
  t += 59_000;
  await correr(mw, pedido({ token }));
  assert.equal(consultas, 2, "el «sí» dura el TTL completo");
});

test("perfil: si la consulta de perfil falla es 503 y no se cachea", async () => {
  let falla = true;
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    existePerfil: async () => {
      if (falla) throw new Error("db caída");
      return true;
    },
    modo: modo("exigir"),
    log: () => {},
  });
  const token = jwt();
  assert.equal((await correr(mw, pedido({ token }))).err.statusCode, 503);
  falla = false;
  assert.equal((await correr(mw, pedido({ token }))).err, undefined);
});

// ─── Abuso: precheck, caché negativa, deduplicación ─────────────────────────

test("precheck: lo que no parece JWT o es enorme es 401 AUTH_INVALIDA sin llamar al proveedor", async () => {
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });
  for (const token of ["abc", "a.b", "a.b.c.d", "a..c", `a.b.${"x".repeat(5000)}`]) {
    const { err } = await correr(mw, pedido({ headers: { authorization: `Bearer ${token}` } }));
    assert.equal(err.statusCode, 401, token.slice(0, 20));
    assert.equal(err.codigo, "AUTH_INVALIDA");
  }
  assert.equal(verificar.llamadas.length, 0);
});

test("caché negativa: un token inválido se pregunta una vez y de nuevo tras el TTL corto", async () => {
  let t = 1_000_000;
  const verificar = verificadorFalso(null);
  const mw = crearAutenticar({
    verificar,
    modo: modo("exigir"),
    ahora: () => t,
    ttlInvalidoMs: 10_000,
    log: () => {},
  });
  const token = jwt();
  for (let i = 0; i < 5; i++) assert.equal((await correr(mw, pedido({ token }))).err.codigo, "AUTH_INVALIDA");
  assert.equal(verificar.llamadas.length, 1);
  t += 11_000;
  await correr(mw, pedido({ token }));
  assert.equal(verificar.llamadas.length, 2);
});

test("caché negativa: está acotada en tamaño", async () => {
  const verificar = verificadorFalso(null);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), max: 2, log: () => {} });
  const [a, b, c] = [jwt(undefined, "a"), jwt(undefined, "b"), jwt(undefined, "c")];
  for (const token of [a, b, c]) await correr(mw, pedido({ token }));
  await correr(mw, pedido({ token: a })); // desalojado: vuelve a preguntar
  assert.equal(verificar.llamadas.length, 4);
});

test("deduplicación: pedidos simultáneos con el mismo token hacen UNA verificación", async () => {
  let liberar;
  const compuerta = new Promise((r) => (liberar = r));
  const verificar = verificadorFalso(async () => {
    await compuerta;
    return USUARIO;
  });
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });
  const token = jwt();
  const pendientes = Array.from({ length: 5 }, () => correr(mw, pedido({ token })));
  liberar();
  const resultados = await Promise.all(pendientes);
  assert.equal(verificar.llamadas.length, 1);
  for (const r of resultados) assert.equal(r.req.usuario.id, "u-1");
});

test("deduplicación: la consulta de permisos simultánea del mismo usuario es UNA", async () => {
  let liberar;
  const compuerta = new Promise((r) => (liberar = r));
  let consultas = 0;
  const mw = crearRequireAdmin({
    puedeAdministrar: async () => {
      consultas++;
      await compuerta;
      return true;
    },
    modo: modo("exigir"),
    log: () => {},
  });
  const pendientes = Array.from({ length: 4 }, () => correr(mw, conUsuario()));
  liberar();
  for (const r of await Promise.all(pendientes)) assert.equal(r.err, undefined);
  assert.equal(consultas, 1);
});

// ─── Bitácora: resumen + muestreo ───────────────────────────────────────────

test("bitácora: cuenta todo, detalla una vez por tipo y por minuto, y resume al vencer la ventana", () => {
  let t = 0;
  const lineas = [];
  const b = crearBitacora({
    escribir: (l) => lineas.push(l),
    ahora: () => t,
    intervaloMs: 300_000,
    detalleCadaMs: 60_000,
  });
  for (let i = 0; i < 10; i++) b.anomalia("sin_token", { evento: "auth_anomalia", motivo: "sin_token" });
  b.anomalia("sin_perfil", { evento: "auth_anomalia", motivo: "sin_perfil" });
  b.ok();
  b.ok();
  assert.equal(lineas.filter((l) => l.evento === "auth_anomalia").length, 2, "una línea de detalle por tipo");
  assert.equal(lineas.some((l) => l.evento === "auth_resumen"), false);

  t = 61_000;
  b.anomalia("sin_token", { evento: "auth_anomalia", motivo: "sin_token" });
  assert.equal(lineas.filter((l) => l.motivo === "sin_token").length, 2, "pasado el minuto vuelve a detallar");

  t = 301_000;
  b.ok(); // vence la ventana: se escribe el resumen de la anterior y se arranca otra
  const resumen = lineas.find((l) => l.evento === "auth_resumen");
  assert.ok(resumen);
  assert.equal(resumen.sin_token, 11);
  assert.equal(resumen.sin_perfil, 1);
  assert.equal(resumen.ok, 2);
  assert.equal(resumen.token_invalido, 0, "los contadores conocidos salen aunque estén en cero");
  assert.equal(resumen.ventana_s, 301);
});

test("bitácora: también resume por cantidad de eventos", () => {
  const lineas = [];
  const b = crearBitacora({ escribir: (l) => lineas.push(l), maxEventos: 3 });
  b.ok();
  b.ok();
  assert.equal(lineas.length, 0);
  b.ok();
  assert.equal(lineas.length, 1);
  assert.equal(lineas[0].ok, 3);
});

test("bitácora: el middleware cuenta ok y anomalías, sin una línea por pedido", async () => {
  const lineas = [];
  const bitacora = crearBitacora({ escribir: (l) => lineas.push(l), maxEventos: 8 });
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    modo: modo("reportar"),
    bitacora,
  });
  const token = jwt();
  for (let i = 0; i < 3; i++) await correr(mw, pedido({ token })); // 3 ok
  for (let i = 0; i < 5; i++) await correr(mw, pedido()); // 5 sin_token
  const resumen = lineas.find((l) => l.evento === "auth_resumen");
  assert.ok(resumen, "se alcanzó el tope de eventos");
  assert.equal(resumen.ok, 3);
  assert.equal(resumen.sin_token, 5);
  assert.equal(lineas.filter((l) => l.evento === "auth_anomalia").length, 1, "una sola línea de detalle");
});

test("logs: nunca llevan el token ni el correo del usuario", async () => {
  const lineas = [];
  const bitacora = crearBitacora({ escribir: (l) => lineas.push(l) });
  const token = jwt(undefined, "secreto");
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    existePerfil: async () => false,
    modo: modo("reportar"),
    bitacora,
  });
  await correr(mw, pedido({ token }));
  const texto = JSON.stringify(lineas);
  assert.equal(texto.includes("secreto") || texto.includes(token), false);
  assert.equal(texto.toLowerCase().includes("merkahorro.com"), false);
  assert.equal(lineas[0].usuario, "u-1");
});

// ─── Off: no-op exacto ──────────────────────────────────────────────────────

test("off: ni autenticar, ni requireAdmin, ni quienHace tocan nada (cero llamadas, cero logs, cero conteos)", async () => {
  const lineas = [];
  const bitacora = crearBitacora({ escribir: (l) => lineas.push(l), maxEventos: 1 });
  const verificar = verificadorFalso(USUARIO);
  let perfiles = 0;
  let permisos = 0;
  const autenticar = crearAutenticar({
    verificar,
    existePerfil: async () => {
      perfiles++;
      return true;
    },
    modo: modo("off"),
    bitacora,
  });
  const admin = crearRequireAdmin({
    puedeAdministrar: async () => {
      permisos++;
      return true;
    },
    modo: modo("off"),
    bitacora,
  });

  for (const req of [pedido(), pedido({ token: jwt() }), pedido({ token: "basura" }), pedido({ method: "OPTIONS" })]) {
    assert.equal((await correr(autenticar, req)).err, undefined);
    assert.equal((await correr(admin, req)).err, undefined);
    assert.equal(req.usuario, undefined, "no se agrega req.usuario");
  }
  const body = { por: "x@y.com" };
  const reqConUsuario = { usuario: { id: "u", correo: "t@x.com" } };
  assert.equal(quienHace(reqConUsuario, "x@y.com", "por", { modo: "off", bitacora }), "x@y.com");
  assert.equal(quienHace({ usuario: { id: "u", correo: "" } }, "x@y.com", "por", { modo: "off", bitacora }), "x@y.com");
  conEnv(undefined, () => assert.equal(conQuienHace(reqConUsuario, body, "por"), body));

  assert.equal(verificar.llamadas.length, 0);
  assert.equal(perfiles + permisos, 0);
  assert.equal(lineas.length, 0);
});
