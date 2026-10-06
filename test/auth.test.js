import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import {
  modoAuth,
  crearAutenticar,
  crearRequireAdmin,
  crearBitacora,
  quienHace,
  conQuienHace,
} from "../src/middleware/auth.js";
import {
  puedeAbrirAdminCarnes,
  cubre,
} from "../src/shared/permisoAdminCarnes.js";
import { corsMerkahorro } from "../src/config/cors.js";

// ─── Utilidades ─────────────────────────────────────────────────────────────

/** JWT de mentira: solo importa que el payload se pueda leer (campo `exp`). */
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

/** Corre un middleware y devuelve lo que le pasó a `next`. */
function correr(mw, req) {
  return new Promise((resolve) => {
    Promise.resolve(mw(req, {}, (err) => resolve({ err, req }))).catch((e) => resolve({ err: e, req }));
  });
}

const modo = (m) => () => m;

/** Verificador falso: cuenta llamadas y devuelve lo que se le diga. */
function verificadorFalso(respuesta) {
  const f = async (token) => {
    f.llamadas.push(token);
    if (respuesta instanceof Error) throw respuesta;
    return typeof respuesta === "function" ? respuesta(token) : respuesta;
  };
  f.llamadas = [];
  return f;
}

const USUARIO = { id: "u-1", email: "Ana.Perez@Merkahorro.COM" };

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

// ─── modoAuth ───────────────────────────────────────────────────────────────

test("modoAuth: sin variable o con valor desconocido es off", () => {
  assert.equal(modoAuth({}), "off");
  assert.equal(modoAuth({ CARNES_AUTH: "" }), "off");
  const avisos = [];
  const original = console.warn;
  console.warn = (m) => avisos.push(m);
  try {
    assert.equal(modoAuth({ CARNES_AUTH: "exigr" }), "off");
  } finally {
    console.warn = original;
  }
  assert.equal(avisos.length, 1, "un valor con typo se avisa");
});

test("modoAuth: acepta los tres modos sin importar mayúsculas ni espacios", () => {
  assert.equal(modoAuth({ CARNES_AUTH: "off" }), "off");
  assert.equal(modoAuth({ CARNES_AUTH: " Reportar " }), "reportar");
  assert.equal(modoAuth({ CARNES_AUTH: "EXIGIR" }), "exigir");
});

// ─── autenticar: off ────────────────────────────────────────────────────────

test("off: pasa sin llamar al verificador, ni con token ni sin él", async () => {
  const verificar = verificadorFalso(USUARIO);
  const log = [];
  const mw = crearAutenticar({ verificar, modo: modo("off"), log: (l) => log.push(l) });

  for (const req of [pedido(), pedido({ token: jwt() })]) {
    const { err, req: r } = await correr(mw, req);
    assert.equal(err, undefined);
    assert.equal(r.usuario, undefined);
  }
  assert.equal(verificar.llamadas.length, 0);
  assert.equal(log.length, 0);
});

// ─── autenticar: reportar ───────────────────────────────────────────────────

test("reportar: sin token pasa y deja una línea de log", async () => {
  const log = [];
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  const { err, req } = await correr(
    mw,
    pedido({ headers: { origin: "https://merkahorro.com" } }),
  );
  assert.equal(err, undefined);
  assert.equal(req.usuario, undefined);
  assert.equal(log.length, 1);
  assert.equal(log[0].motivo, "sin_token");
  assert.equal(log[0].metodo, "GET");
  assert.equal(log[0].origen, "https://merkahorro.com");
  assert.equal(log[0].ruta, "/api/recepciones/:id/items", "sin query y con el id tapado");
});

test("reportar: token inválido pasa y se registra, sin filtrar el token", async () => {
  const log = [];
  const token = jwt(undefined, "secreto-que-no-debe-salir");
  const mw = crearAutenticar({
    verificar: verificadorFalso(null),
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  const { err } = await correr(mw, pedido({ token }));
  assert.equal(err, undefined);
  assert.equal(log[0].motivo, "token_invalido");
  assert.equal(JSON.stringify(log).includes(token), false);
  assert.equal(JSON.stringify(log).includes("secreto-que-no-debe-salir"), false);
});

test("reportar: si el proveedor falla, pasa y se registra", async () => {
  const log = [];
  const mw = crearAutenticar({
    verificar: verificadorFalso(new Error("ECONNRESET")),
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  const { err } = await correr(mw, pedido({ token: jwt() }));
  assert.equal(err, undefined);
  assert.equal(log[0].motivo, "proveedor_no_disponible");
});

test("reportar: token válido deja req.usuario { id, correo } y nada más", async () => {
  const log = [];
  const token = jwt();
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  const { err, req } = await correr(mw, pedido({ token }));
  assert.equal(err, undefined);
  assert.deepEqual(req.usuario, { id: "u-1", correo: "ana.perez@merkahorro.com" });
  assert.equal(JSON.stringify(req.usuario).includes(token), false);
  assert.equal(log.length, 0);
});

// ─── autenticar: exigir ─────────────────────────────────────────────────────

test("exigir: sin token es 401", async () => {
  const mw = crearAutenticar({
    verificar: verificadorFalso(USUARIO),
    modo: modo("exigir"),
    log: () => {},
  });
  const { err } = await correr(mw, pedido());
  assert.equal(err.statusCode, 401);
  assert.equal(err.expose, true);
});

test("exigir: cabecera que no es Bearer es 401", async () => {
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });
  const { err } = await correr(mw, pedido({ headers: { authorization: "Basic abc" } }));
  assert.equal(err.statusCode, 401);
  assert.equal(verificar.llamadas.length, 0);
});

test("exigir: token inválido o vencido es 401", async () => {
  const mw = crearAutenticar({ verificar: verificadorFalso(null), modo: modo("exigir"), log: () => {} });
  const { err } = await correr(mw, pedido({ token: jwt() }));
  assert.equal(err.statusCode, 401);
});

test("exigir: proveedor caído es 503, no 401", async () => {
  const mw = crearAutenticar({
    verificar: verificadorFalso(new Error("timeout")),
    modo: modo("exigir"),
    log: () => {},
  });
  const { err } = await correr(mw, pedido({ token: jwt() }));
  assert.equal(err.statusCode, 503);
});

test("exigir: token válido pasa y deja usuario", async () => {
  const mw = crearAutenticar({ verificar: verificadorFalso(USUARIO), modo: modo("exigir"), log: () => {} });
  const { err, req } = await correr(mw, pedido({ token: jwt() }));
  assert.equal(err, undefined);
  assert.equal(req.usuario.correo, "ana.perez@merkahorro.com");
});

test("exigir: OPTIONS (preflight) y /health nunca se bloquean", async () => {
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });

  for (const req of [
    pedido({ method: "OPTIONS" }),
    pedido({ path: "/health" }),
    pedido({ path: "/health/email" }),
    pedido({ path: "/api/health" }),
  ]) {
    const { err } = await correr(mw, req);
    assert.equal(err, undefined, `${req.method} ${req.path}`);
  }
  assert.equal(verificar.llamadas.length, 0);
});

test("exigir: los endpoints de tokens de QR se dejan a X-Admin-Key (sin JWT)", async () => {
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });
  for (const [method, path] of [
    ["GET", "/sedes/tokens"],
    ["POST", "/sedes/3/regenerar-token"],
  ]) {
    assert.equal((await correr(mw, pedido({ method, path }))).err, undefined, path);
  }
  // Pero el resto de /sedes sí se exige.
  assert.equal((await correr(mw, pedido({ path: "/sedes" }))).err.statusCode, 401);
  assert.equal((await correr(mw, pedido({ method: "PATCH", path: "/sedes/3" }))).err.statusCode, 401);
  assert.equal(verificar.llamadas.length, 0);
});

test("exigir: una ruta que solo empieza parecido a health SÍ se exige", async () => {
  const mw = crearAutenticar({ verificar: verificadorFalso(USUARIO), modo: modo("exigir"), log: () => {} });
  const { err } = await correr(mw, pedido({ path: "/healthy" }));
  assert.equal(err.statusCode, 401);
});

// ─── autenticar: caché ──────────────────────────────────────────────────────

test("caché: el mismo token se verifica una sola vez dentro del TTL", async () => {
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });
  const token = jwt();
  await correr(mw, pedido({ token }));
  const { err, req } = await correr(mw, pedido({ token }));
  assert.equal(err, undefined);
  assert.equal(req.usuario.id, "u-1");
  assert.equal(verificar.llamadas.length, 1);
});

test("caché: vence al pasar el TTL y vuelve a verificar", async () => {
  let t = 1_000_000;
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({
    verificar,
    modo: modo("exigir"),
    ahora: () => t,
    ttlMs: 60_000,
    log: () => {},
  });
  const token = jwt(Math.floor(t / 1000) + 99_999);
  await correr(mw, pedido({ token }));
  t += 59_000;
  await correr(mw, pedido({ token }));
  assert.equal(verificar.llamadas.length, 1);
  t += 2_000;
  await correr(mw, pedido({ token }));
  assert.equal(verificar.llamadas.length, 2);
});

test("caché: no se guarda más allá del vencimiento del propio token", async () => {
  let t = 1_000_000_000;
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({
    verificar,
    modo: modo("exigir"),
    ahora: () => t,
    ttlMs: 60_000,
    log: () => {},
  });
  const token = jwt(Math.floor(t / 1000) + 10); // vence en 10 s
  await correr(mw, pedido({ token }));
  t += 11_000;
  await correr(mw, pedido({ token }));
  assert.equal(verificar.llamadas.length, 2);
});

test("caché: los fallos NO se guardan (un corte breve no deja a nadie afuera)", async () => {
  let falla = true;
  const verificar = verificadorFalso(() => {
    if (falla) throw new Error("caído");
    return USUARIO;
  });
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), log: () => {} });
  const token = jwt();
  assert.equal((await correr(mw, pedido({ token }))).err.statusCode, 503);
  falla = false;
  assert.equal((await correr(mw, pedido({ token }))).err, undefined);

});

test("caché: tiene tope de tamaño (descarta la entrada más vieja)", async () => {
  const verificar = verificadorFalso(USUARIO);
  const mw = crearAutenticar({ verificar, modo: modo("exigir"), max: 2, log: () => {} });
  const [a, b, c] = [jwt(undefined, "a"), jwt(undefined, "b"), jwt(undefined, "c")];
  for (const token of [a, b, c]) await correr(mw, pedido({ token }));
  assert.equal(verificar.llamadas.length, 3);
  await correr(mw, pedido({ token: c })); // sigue en caché
  assert.equal(verificar.llamadas.length, 3);
  await correr(mw, pedido({ token: a })); // fue desalojado
  assert.equal(verificar.llamadas.length, 4);
});

// ─── requireAdminCarnes ─────────────────────────────────────────────────────

const conUsuario = (extra = {}) => pedido({ usuario: { id: "u-1", correo: "ana@x.com" }, ...extra });

test("admin off: pasa sin consultar permisos", async () => {
  let consultas = 0;
  const mw = crearRequireAdmin({
    puedeAdministrar: async () => (consultas++, false),
    modo: modo("off"),
    log: () => {},
  });
  const { err } = await correr(mw, pedido());
  assert.equal(err, undefined);
  assert.equal(consultas, 0);
});

test("admin reportar: sin permiso PASA pero registra «denegaría» con el correo", async () => {
  const log = [];
  const mw = crearRequireAdmin({
    puedeAdministrar: async () => false,
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  const { err } = await correr(mw, conUsuario());
  assert.equal(err, undefined);
  assert.equal(log[0].evento, "admin_denegaria");
  assert.equal(log[0].motivo, "sin_permiso_admin");
  assert.equal(log[0].usuario, "u-1", "el log lleva el id, nunca el correo");
  assert.equal(JSON.stringify(log).includes("ana@x.com"), false);
});

test("admin reportar: con permiso pasa sin registrar; sin usuario pasa y registra", async () => {
  const log = [];
  const mw = crearRequireAdmin({
    puedeAdministrar: async () => true,
    modo: modo("reportar"),
    log: (l) => log.push(l),
  });
  assert.equal((await correr(mw, conUsuario())).err, undefined);
  assert.equal(log.length, 0);
  assert.equal((await correr(mw, pedido())).err, undefined);
  assert.equal(log[0].motivo, "sin_usuario");
});

test("admin reportar: si la consulta de permisos falla, pasa", async () => {
  const mw = crearRequireAdmin({
    puedeAdministrar: async () => {
      throw new Error("db caída");
    },
    modo: modo("reportar"),
    log: () => {},
  });
  assert.equal((await correr(mw, conUsuario())).err, undefined);
});

test("admin exigir: 403 sin permiso, 401 sin usuario, 503 si falla la consulta, pasa con permiso", async () => {
  const hacer = (puedeAdministrar) =>
    crearRequireAdmin({ puedeAdministrar, modo: modo("exigir"), log: () => {} });

  assert.equal((await correr(hacer(async () => false), conUsuario())).err.statusCode, 403);
  assert.equal((await correr(hacer(async () => true), pedido())).err.statusCode, 401);
  assert.equal(
    (
      await correr(
        hacer(async () => {
          throw new Error("x");
        }),
        conUsuario(),
      )
    ).err.statusCode,
    503,
  );
  assert.equal((await correr(hacer(async () => true), conUsuario())).err, undefined);
});

test("admin exigir: OPTIONS no se bloquea", async () => {
  const mw = crearRequireAdmin({ puedeAdministrar: async () => false, modo: modo("exigir"), log: () => {} });
  assert.equal((await correr(mw, pedido({ method: "OPTIONS" }))).err, undefined);
});

test("admin: el permiso se cachea por usuario; un «no» se recuerda menos", async () => {
  let t = 1_000_000;
  let consultas = 0;
  let permitido = false;
  const mw = crearRequireAdmin({
    puedeAdministrar: async () => (consultas++, permitido),
    modo: modo("exigir"),
    ahora: () => t,
    ttlMs: 60_000,
    log: () => {},
  });

  assert.equal((await correr(mw, conUsuario())).err.statusCode, 403);
  assert.equal((await correr(mw, conUsuario())).err.statusCode, 403);
  assert.equal(consultas, 1, "segundo pedido sale de la caché");

  permitido = true; // el admin le acaba de dar el permiso
  t += 16_000; // el «no» ya venció (15 s)
  assert.equal((await correr(mw, conUsuario())).err, undefined);
  t += 30_000;
  await correr(mw, conUsuario());
  assert.equal(consultas, 2, "el «sí» dura el TTL completo");
});

// ─── quienHace / conQuienHace ───────────────────────────────────────────────

test("quienHace: off devuelve siempre el valor del body", () => {
  conEnv(undefined, () => {
    const req = { usuario: { id: "u", correo: "token@x.com" } };
    assert.equal(quienHace(req, "body@x.com"), "body@x.com");
    assert.equal(quienHace(req, undefined), undefined);
  });
});

test("quienHace: reportar devuelve el body y registra si difiere del token (sin correos en claro)", () => {
  const lineas = [];
  const bitacora = crearBitacora({ escribir: (l) => lineas.push(l) });
  const opciones = { modo: "reportar", bitacora };
  const req = {
    method: "PATCH",
    originalUrl: "/api/recepciones/5/novillos",
    headers: {},
    usuario: { id: "u-9", correo: "token@x.com" },
  };
  assert.equal(quienHace(req, "otro@x.com", "editado_por", opciones), "otro@x.com");
  assert.equal(quienHace(req, " TOKEN@x.com ", "editado_por", opciones), " TOKEN@x.com ", "mismo correo: no se registra");
  assert.equal(quienHace({ headers: {} }, "otro@x.com", null, opciones), "otro@x.com", "sin token no hay con qué comparar");
  assert.equal(lineas.length, 1);
  assert.equal(lineas[0].evento, "identidad_distinta");
  assert.equal(lineas[0].campo, "editado_por");
  assert.equal(lineas[0].usuario, "u-9");
  assert.match(lineas[0].body_hash, /^[0-9a-f]{8}$/);
  const texto = JSON.stringify(lineas);
  assert.equal(texto.includes("otro@x.com") || texto.includes("token@x.com"), false);
});

test("quienHace: modo inyectable; off ignora al usuario aunque haya token", () => {
  const req = { usuario: { id: "u", correo: "token@x.com" } };
  assert.equal(quienHace(req, "body@x.com", "por", { modo: "off" }), "body@x.com");
  assert.equal(quienHace(req, "body@x.com", "por", { modo: "exigir" }), "token@x.com");
});

test("quienHace: exigir con usuario SIN correo lanza 403 (no cae al body)", () => {
  const req = { usuario: { id: "u", correo: "" } };
  assert.throws(
    () => quienHace(req, "otro@x.com", "por", { modo: "exigir" }),
    (e) => e.statusCode === 403 && e.codigo === "AUTH_SIN_PERMISO" && e.expose === true,
  );
  conEnv("exigir", () => {
    assert.throws(() => conQuienHace(req, { por: "x" }, "por"), (e) => e.statusCode === 403);
  });
});

test("quienHace: reportar con usuario sin correo devuelve el body sin lanzar", () => {
  const req = { usuario: { id: "u", correo: "" } };
  assert.equal(quienHace(req, "otro@x.com", "por", { modo: "reportar", bitacora: crearBitacora({ escribir: () => {} }) }), "otro@x.com");
});

test("quienHace: exigir devuelve el correo del token e ignora el body", () => {
  conEnv("exigir", () => {
    const req = { usuario: { id: "u", correo: "token@x.com" } };
    assert.equal(quienHace(req, "otro@x.com"), "token@x.com");
    assert.equal(quienHace(req, undefined), "token@x.com");
    assert.equal(quienHace({}, "body@x.com"), "body@x.com", "sin usuario cae al body");
  });
});

test("conQuienHace: en off y reportar devuelve el MISMO objeto", () => {
  const body = { por: "otro@x.com", motivo: "m" };
  const req = { headers: {}, usuario: { id: "u", correo: "token@x.com" } };
  const original = console.warn;
  console.warn = () => {};
  try {
    for (const m of [undefined, "off", "reportar"]) {
      conEnv(m, () => assert.equal(conQuienHace(req, body, "por"), body));
    }
  } finally {
    console.warn = original;
  }
});

test("conQuienHace: en exigir copia el body pisando solo los campos pedidos", () => {
  conEnv("exigir", () => {
    const body = { por: "otro@x.com", motivo: "m" };
    const req = { usuario: { id: "u", correo: "token@x.com" } };
    const r = conQuienHace(req, body, "por");
    assert.deepEqual(r, { por: "token@x.com", motivo: "m" });
    assert.equal(body.por, "otro@x.com", "no muta el original");
    assert.deepEqual(conQuienHace(req, undefined, "por"), { por: "token@x.com" });
  });
});

// ─── Regla de admin (espejo del front) ──────────────────────────────────────

test("admin: ruta de rol que cubre /carnes/admin", () => {
  const roleConfig = { permissions: [{ path: "/carnes/admin" }], redirect: "/acceso" };
  assert.equal(puedeAbrirAdminCarnes({ profile: { role: "r", personal_routes: [] }, roleConfig }), true);
  assert.equal(puedeAbrirAdminCarnes({ profile: { role: "r", personal_routes: null }, roleConfig }), true);
});

test("admin: un permiso de sección (/carnes) cubre a los hijos, un prefijo de texto no", () => {
  const perfil = { role: "r", personal_routes: [] };
  assert.equal(puedeAbrirAdminCarnes({ profile: perfil, roleConfig: { permissions: [{ path: "/carnes" }] } }), true);
  assert.equal(puedeAbrirAdminCarnes({ profile: perfil, roleConfig: { permissions: [{ path: "/carnes/adm" }] } }), false);
  assert.equal(puedeAbrirAdminCarnes({ profile: perfil, roleConfig: { permissions: [{ path: "/carnes/recibidor" }] } }), false);
  assert.equal(cubre("/carnes", "/carnes/admin"), true);
  assert.equal(cubre("/carne", "/carnes/admin"), false);
});

test("admin: personal_routes manda sobre los permisos del rol", () => {
  const roleConfig = { permissions: [{ path: "/carnes/admin" }], redirect: "/x" };
  // Con rutas personales que no incluyen carnes, el rol deja de contar.
  assert.equal(
    puedeAbrirAdminCarnes({ profile: { role: "r", personal_routes: [{ path: "/epp" }] }, roleConfig }),
    false,
  );
  // Y al revés: la ruta personal abre aunque el rol no la tenga.
  assert.equal(
    puedeAbrirAdminCarnes({
      profile: { role: "r", personal_routes: [{ path: "/carnes/admin" }] },
      roleConfig: { permissions: [], redirect: "/x" },
    }),
    true,
  );
});

test("admin: el redirect del rol a /carnes/admin abre, salvo roles admin_* (el Login lo pisa con /acceso)", () => {
  const roleConfig = { permissions: [], redirect: "/carnes/admin" };
  assert.equal(puedeAbrirAdminCarnes({ profile: { role: "carnes", personal_routes: [] }, roleConfig }), true);
  assert.equal(puedeAbrirAdminCarnes({ profile: { role: "admin_proveedores", personal_routes: [] }, roleConfig }), false);
});

test("admin: sin perfil, sin rutas o con datos raros no abre", () => {
  assert.equal(puedeAbrirAdminCarnes({}), false);
  assert.equal(puedeAbrirAdminCarnes({ profile: null, roleConfig: null }), false);
  assert.equal(puedeAbrirAdminCarnes({ profile: { role: "r" }, roleConfig: null }), false);
  assert.equal(
    puedeAbrirAdminCarnes({ profile: { role: "r", personal_routes: ["/carnes/admin", null, {}] } }),
    false,
    "solo cuentan objetos con `path`",
  );
});

// ─── CORS: la preflight de Authorization pasa ───────────────────────────────

test("CORS: la preflight que pide Authorization se permite desde el origen de producción", async () => {
  const app = express();
  app.use(corsMerkahorro);
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://merkahorro.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(res.status, 204);
    const permitidas = String(res.headers.get("access-control-allow-headers") || "").toLowerCase();
    assert.ok(permitidas.includes("authorization"), `allow-headers: ${permitidas}`);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://merkahorro.com");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
