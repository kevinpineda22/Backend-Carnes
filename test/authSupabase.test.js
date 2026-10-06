import test from "node:test";
import assert from "node:assert/strict";

import {
  crearVerificar,
  crearExistePerfil,
  crearPuedeAdministrar,
} from "../src/middleware/authSupabase.js";

/**
 * Cableado contra Supabase con un cliente falso: sin red ni variables de entorno.
 */

/** Cliente falso: `tablas[nombre]` es `{ data, error }` o una función `(filtros) => {data, error}`. */
function clienteFalso({ getUser, tablas = {} } = {}) {
  const consultas = [];
  return {
    consultas,
    auth: { getUser: async (token) => getUser(token) },
    from(tabla) {
      const filtros = {};
      const cadena = {
        select: () => cadena,
        eq: (columna, valor) => {
          filtros[columna] = valor;
          return cadena;
        },
        maybeSingle: async () => {
          consultas.push({ tabla, ...filtros });
          const r = tablas[tabla];
          return typeof r === "function" ? r(filtros) : r ?? { data: null, error: null };
        },
      };
      return cadena;
    },
  };
}

const ok = (data) => ({ data, error: null });

// ─── getUser ────────────────────────────────────────────────────────────────

test("verificar: usuario válido devuelve { id, email }", async () => {
  const c = clienteFalso({ getUser: () => ({ data: { user: { id: "u1", email: "a@x.com", otro: 1 } }, error: null }) });
  assert.deepEqual(await crearVerificar(c)("t"), { id: "u1", email: "a@x.com" });
});

test("verificar: 4xx (salvo 429) es token inválido → null", async () => {
  for (const status of [400, 401, 403, 404]) {
    const c = clienteFalso({ getUser: () => ({ data: { user: null }, error: { status, message: "x" } }) });
    assert.equal(await crearVerificar(c)("t"), null, String(status));
  }
});

test("verificar: sin error pero sin usuario → null", async () => {
  const c = clienteFalso({ getUser: () => ({ data: { user: null }, error: null }) });
  assert.equal(await crearVerificar(c)("t"), null);
});

test("verificar: 429, 5xx o error sin status LANZAN (error del proveedor, no del token)", async () => {
  for (const error of [{ status: 429 }, { status: 500 }, { status: 503 }, { status: 0 }, { message: "fetch failed" }]) {
    const c = clienteFalso({ getUser: () => ({ data: { user: null }, error }) });
    await assert.rejects(() => crearVerificar(c)("t"), undefined, JSON.stringify(error));
  }
});

test("verificar: si getUser lanza (red/timeout), se propaga", async () => {
  const c = clienteFalso({
    getUser: () => {
      throw new Error("ECONNRESET");
    },
  });
  await assert.rejects(() => crearVerificar(c)("t"), /ECONNRESET/);
});

// ─── existePerfil ───────────────────────────────────────────────────────────

test("existePerfil: true con fila, false sin fila, lanza si la consulta falla", async () => {
  const con = clienteFalso({ tablas: { profiles: ok({ user_id: "u1" }) } });
  assert.equal(await crearExistePerfil(con)("u1"), true);
  assert.deepEqual(con.consultas, [{ tabla: "profiles", user_id: "u1" }]);

  const sin = clienteFalso({ tablas: { profiles: ok(null) } });
  assert.equal(await crearExistePerfil(sin)("u1"), false);

  const falla = clienteFalso({ tablas: { profiles: { data: null, error: new Error("db") } } });
  await assert.rejects(() => crearExistePerfil(falla)("u1"), /db/);
});

// ─── puedeAdministrar ───────────────────────────────────────────────────────

const ADMIN = [{ path: "/carnes/admin" }];

function conTablas({ perfil, roles = {} }) {
  return clienteFalso({
    tablas: {
      profiles: ok(perfil),
      role_permissions: (f) => ok(roles[f.role] ?? null),
    },
  });
}

test("puedeAdministrar: sin perfil es false (y no consulta roles)", async () => {
  const c = conTablas({ perfil: null });
  assert.equal(await crearPuedeAdministrar(c)("u1"), false);
  assert.equal(c.consultas.some((q) => q.tabla === "role_permissions"), false);
});

test("puedeAdministrar: permiso del rol que cubre /carnes/admin", async () => {
  const c = conTablas({
    perfil: { role: "carnes", personal_routes: [] },
    roles: { carnes: { permissions: ADMIN, redirect: "/x" } },
  });
  assert.equal(await crearPuedeAdministrar(c)("u1"), true);
});

test("puedeAdministrar: admin_clientes sin config propia usa la de admin_proveedores", async () => {
  const c = conTablas({
    perfil: { role: "admin_clientes", personal_routes: [] },
    roles: { admin_proveedores: { permissions: ADMIN, redirect: "/acceso" } },
  });
  assert.equal(await crearPuedeAdministrar(c)("u1"), true);
  assert.deepEqual(
    c.consultas.filter((q) => q.tabla === "role_permissions").map((q) => q.role),
    ["admin_clientes", "admin_proveedores"],
  );
});

test("puedeAdministrar: admin_clientes con permissions null también cae al respaldo", async () => {
  const c = conTablas({
    perfil: { role: "admin_clientes", personal_routes: [] },
    roles: {
      admin_clientes: { permissions: null, redirect: "/acceso" },
      admin_proveedores: { permissions: ADMIN, redirect: "/acceso" },
    },
  });
  assert.equal(await crearPuedeAdministrar(c)("u1"), true);
});

test("puedeAdministrar: el respaldo NO aplica a otros roles", async () => {
  const c = conTablas({
    perfil: { role: "otro", personal_routes: [] },
    roles: { admin_proveedores: { permissions: ADMIN, redirect: "/acceso" } },
  });
  assert.equal(await crearPuedeAdministrar(c)("u1"), false);
});

test("puedeAdministrar: rol null no consulta role_permissions; sin rutas personales es false", async () => {
  const c = conTablas({ perfil: { role: null, personal_routes: [] } });
  assert.equal(await crearPuedeAdministrar(c)("u1"), false);
  assert.equal(c.consultas.some((q) => q.tabla === "role_permissions"), false);
});

test("puedeAdministrar: rol null pero con ruta personal que cubre /carnes/admin es true", async () => {
  const c = conTablas({ perfil: { role: null, personal_routes: ADMIN } });
  assert.equal(await crearPuedeAdministrar(c)("u1"), true);
});

test("puedeAdministrar: permissions null con redirect a /carnes/admin abre (rol común) y NO abre en roles admin_*", async () => {
  const comun = conTablas({
    perfil: { role: "carnes", personal_routes: null },
    roles: { carnes: { permissions: null, redirect: "/carnes/admin" } },
  });
  assert.equal(await crearPuedeAdministrar(comun)("u1"), true);

  const admin = conTablas({
    perfil: { role: "admin_proveedores", personal_routes: null },
    roles: { admin_proveedores: { permissions: null, redirect: "/carnes/admin" } },
  });
  assert.equal(await crearPuedeAdministrar(admin)("u1"), false, "el Login les pisa el redirect con /acceso");
});

test("puedeAdministrar: un error de Supabase en profiles o en role_permissions LANZA (no es un «no»)", async () => {
  const perfilFalla = clienteFalso({ tablas: { profiles: { data: null, error: new Error("profiles caída") } } });
  await assert.rejects(() => crearPuedeAdministrar(perfilFalla)("u1"), /profiles caída/);

  const rolFalla = clienteFalso({
    tablas: {
      profiles: ok({ role: "carnes", personal_routes: [] }),
      role_permissions: { data: null, error: new Error("roles caída") },
    },
  });
  await assert.rejects(() => crearPuedeAdministrar(rolFalla)("u1"), /roles caída/);
});
