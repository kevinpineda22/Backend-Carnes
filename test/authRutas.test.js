import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Cobertura de rutas: qué endpoints NO llevan `requireAdminCarnes` y que
 * `autenticar` se monta antes que cualquier router.
 *
 * Recorre las pilas internas de Express (`router.stack`), así que si alguien
 * agrega una ruta sin guard de admin, o un router nuevo, este test falla hasta
 * que se decida a conciencia (y se agregue a la lista de abajo) si es del
 * recibidor/público o si le falta el guard.
 *
 * Importa las rutas reales: se fuerzan variables de entorno FALSAS antes de
 * cargarlas para que ni `config/supabase.js` ni `dotenv` toquen el `.env`
 * (producción) ni haya red. Crear el cliente de Supabase no hace ninguna llamada.
 */
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_KEY = "clave-falsa-de-test";
process.env.DOTENV_CONFIG_PATH = "no-existe.env";

const { default: indice } = await import("../src/routes/index.js");
const { autenticar, requireAdminCarnes, requireContabilidadCarnes, requireAprobarContabilidadCarnes } =
  await import("../src/middleware/authCarnes.js");

/**
 * Los guards que cuentan como "protegido". El de admin es el normal; los dos de
 * contabilidad protegen SOLO las rutas de la página de contabilidad y se afirman
 * por separado más abajo (cuáles son, y que nada más los use).
 */
const GUARDS = new Map([
  [requireAdminCarnes, "admin"],
  [requireContabilidadCarnes, "contabilidad"],
  [requireAprobarContabilidadCarnes, "aprobar"],
]);

const ARCHIVOS_DE_RUTAS = {
  "sedes.routes.js": ["/sedes", (await import("../src/routes/sedes.routes.js")).default],
  "plantilla.routes.js": ["/plantilla", (await import("../src/routes/plantilla.routes.js")).default],
  "recepciones.routes.js": ["/recepciones", (await import("../src/routes/recepciones.routes.js")).default],
  "liquidaciones.routes.js": ["/liquidaciones", (await import("../src/routes/liquidaciones.routes.js")).default],
  "siesa.routes.js": ["/siesa", (await import("../src/routes/siesa.routes.js")).default],
  "transformaciones.routes.js": [
    "/transformaciones",
    (await import("../src/routes/transformaciones.routes.js")).default,
  ],
  "desposte.routes.js": ["/desposte", (await import("../src/routes/desposte.routes.js")).default],
  "proveedores.routes.js": ["/proveedores", (await import("../src/routes/proveedores.routes.js")).default],
  "recibidores.routes.js": ["/recibidores", (await import("../src/routes/recibidores.routes.js")).default],
  "recepcionesProveedor.routes.js": [
    "/recepciones-proveedor",
    (await import("../src/routes/recepcionesProveedor.routes.js")).default,
  ],
};

/**
 * LO ÚNICO que no pasa por `requireAdminCarnes`. Cada una es del flujo del
 * recibidor (basta con sesión), público, o está cerrada por otro mecanismo.
 */
const SIN_GUARD_DE_ADMIN = [
  // Monitoreo: autenticar los deja pasar (RUTAS_SIN_SESION).
  "GET /health",
  "GET /health/email",
  // Sedes: lista y verificación de QR son del recibidor; los dos de tokens van por X-Admin-Key.
  "GET /sedes",
  "POST /sedes/verificar",
  "GET /sedes/tokens",
  "POST /sedes/:id/regenerar-token",
  // Recibidores: la lista para elegir quién recibió.
  "GET /recibidores",
  // Proveedores: el listado también lo usa el selector del recibidor.
  "GET /proveedores",
  // Recepciones de talleres: flujo del recibidor.
  "POST /recepciones/abrir",
  "GET /recepciones/mias",
  "GET /recepciones/:id",
  "DELETE /recepciones/:id",
  "PATCH /recepciones/:id",
  "POST /recepciones/:id/items",
  "DELETE /recepciones/:id/items/:itemId",
  "POST /recepciones/:id/finalizar",
  // Recepciones de proveedor: flujo del recibidor.
  "POST /recepciones-proveedor/abrir",
  "GET /recepciones-proveedor/mias",
  "GET /recepciones-proveedor/en-curso",
  "GET /recepciones-proveedor/catalogo-cortes",
  "GET /recepciones-proveedor/:id",
  "GET /recepciones-proveedor/:id/acta",
  "PATCH /recepciones-proveedor/:id",
  "POST /recepciones-proveedor/:id/cortes-adicionales",
  "DELETE /recepciones-proveedor/:id/cortes-adicionales/:item_id",
  "POST /recepciones-proveedor/:id/finalizar",
  "DELETE /recepciones-proveedor/:id",
];

/** Aplana un router a `{ clave: "METODO /ruta", protegido }`, respetando el orden de declaración. */
function recorrer(router, prefijo, salida, montajes) {
  let protegido = false;
  for (const capa of router.stack) {
    if (capa.route) {
      const base = capa.route.path === "/" ? "" : capa.route.path;
      const propio = capa.route.stack.map((c) => GUARDS.get(c.handle)).find(Boolean) ?? null;
      for (const metodo of Object.keys(capa.route.methods)) {
        salida.push({
          clave: `${metodo.toUpperCase()} ${prefijo}${base}` || "/",
          protegido: Boolean(protegido || propio),
          guard: propio ?? (protegido ? "admin" : null),
        });
      }
    } else if (capa.handle === requireAdminCarnes) {
      // `router.use(requireAdminCarnes)`: protege todo lo declarado DESPUÉS.
      protegido = true;
    } else if (capa.handle?.stack) {
      const prefijoHijo = montajes.get(capa.handle);
      assert.ok(prefijoHijo !== undefined, "router montado que el test no conoce");
      recorrer(capa.handle, prefijo + prefijoHijo, salida, montajes);
    }
  }
  return salida;
}

const montajes = new Map(Object.values(ARCHIVOS_DE_RUTAS).map(([prefijo, router]) => [router, prefijo]));

test("index.js monta `autenticar` ANTES que cualquier router y que /health", () => {
  const pila = indice.stack;
  assert.equal(pila[0].handle, autenticar, "autenticar es la primera capa");
  const primerRouter = pila.findIndex((c) => c.handle?.stack);
  const primeraRuta = pila.findIndex((c) => c.route);
  assert.ok(primerRouter > 0 && primeraRuta > 0);
});

test("index.js monta cada archivo de src/routes en su prefijo", () => {
  const archivos = fs
    .readdirSync(new URL("../src/routes/", import.meta.url))
    .filter((f) => f.endsWith(".routes.js"))
    .sort();
  assert.deepEqual(archivos, Object.keys(ARCHIVOS_DE_RUTAS).sort(), "hay un router nuevo (o uno menos): actualizar el test");

  for (const [archivo, [prefijo, router]] of Object.entries(ARCHIVOS_DE_RUTAS)) {
    const capa = indice.stack.find((c) => c.handle === router);
    assert.ok(capa, `${archivo} no está montado`);
    assert.ok(capa.regexp.test(`${prefijo}/x`), `${archivo} montado en otro prefijo`);
  }
});

test("rutas: EXACTAMENTE estas quedan sin requireAdminCarnes; todas las demás lo llevan", () => {
  const todas = recorrer(indice, "", [], montajes);
  const sinGuard = todas.filter((r) => !r.protegido).map((r) => r.clave).sort();
  assert.deepEqual(sinGuard, [...SIN_GUARD_DE_ADMIN].sort());

  const protegidas = todas.filter((r) => r.protegido);
  // Piso, no número exacto: el test falla si el recorrido deja de ver las rutas.
  assert.ok(protegidas.length >= 40, `solo se vieron ${protegidas.length} rutas protegidas`);
  const claves = todas.map((r) => r.clave);
  assert.equal(new Set(claves).size, claves.length, "ruta repetida: el recorrido o el router está mal");
});

test("rutas: los routers de panel completo (plantilla, liquidaciones, siesa, desposte, transformaciones) están protegidos de punta a punta", () => {
  const todas = recorrer(indice, "", [], montajes);
  for (const prefijo of ["/plantilla", "/liquidaciones", "/siesa", "/desposte", "/transformaciones"]) {
    const deRouter = todas.filter((r) => r.clave.split(" ")[1].startsWith(prefijo));
    assert.ok(deRouter.length > 0, prefijo);
    assert.ok(deRouter.every((r) => r.protegido), `${prefijo} tiene una ruta sin guard`);
  }
});

test("rutas: contabilidad tiene EXACTAMENTE estas rutas, cada una con su guard, y ninguna es de admin a la vez", () => {
  const todas = recorrer(indice, "", [], montajes);
  const de = (guard) => todas.filter((r) => r.guard === guard).map((r) => r.clave).filter((c) => /contabilidad/.test(c)).sort();

  // Lectura: contabilidad o admin.
  assert.deepEqual(de("contabilidad"), [
    "GET /recepciones-proveedor/:id/contabilidad",
    "GET /recepciones-proveedor/:id/contabilidad/acta",
    "GET /recepciones-proveedor/contabilidad",
  ].sort());
  // Aprobar: SOLO contabilidad (un admin no).
  assert.deepEqual(de("aprobar"), ["POST /recepciones-proveedor/:id/aprobar-contabilidad"]);

  // Y nada más usa esos dos guards: contabilidad no puede quedar con acceso a rutas de admin.
  for (const guard of ["contabilidad", "aprobar"]) {
    const fuera = todas.filter((r) => r.guard === guard && !/contabilidad/.test(r.clave));
    assert.deepEqual(fuera, [], `el guard "${guard}" protege rutas que no son de contabilidad`);
  }
});

test("rutas: \"/contabilidad\" se declara ANTES de \"/:id\" (si no, se leería como un id)", () => {
  const rutas = recorrer(indice, "", [], montajes).map((r) => r.clave);
  const lista = rutas.indexOf("GET /recepciones-proveedor/contabilidad");
  const porId = rutas.indexOf("GET /recepciones-proveedor/:id");
  assert.ok(lista >= 0 && porId >= 0 && lista < porId);
});
