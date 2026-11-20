import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// El modelo importa el cliente real de Supabase, que exige variables de entorno al
// cargarse. Son valores de relleno: los tests inyectan un cliente falso (`db`) y
// nunca hablan con la red.
process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_KEY ||= "clave-de-prueba";

const { validarNovillosCierre } = await import("../src/shared/novillosObligatorio.js");
const { finalizar } = await import("../src/models/Recepcion.model.js");
const { validators } = await import("../src/middleware/validators.js");

const FIRMA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const OTRO = { otro: true, nombre: "Maria Perez", cedula: "12345678" };

// ─── Regla pura ────────────────────────────────────────────────────────────

test("validarNovillosCierre: vacío, 0, decimal, negativo, texto y NaN se rechazan", () => {
  const malos = [undefined, null, "", "   ", 0, "0", "0.00", 2.5, "2.5", -1, "-1", "abc", NaN, Infinity, {}, []];
  for (const valor of malos) {
    const r = validarNovillosCierre(valor);
    assert.equal(r.ok, false, `debió rechazar ${JSON.stringify(valor)}`);
    assert.equal(r.codigo, "NOVILLOS_INVALIDOS");
    assert.match(r.mensaje, /novillos|canales/i);
  }
});

test("validarNovillosCierre: entero positivo se acepta (número, texto y NUMERIC de Postgres)", () => {
  for (const valor of [4, 1, "4", "4.00", 120]) {
    const r = validarNovillosCierre(valor);
    assert.equal(r.ok, true, `debió aceptar ${JSON.stringify(valor)}`);
  }
  assert.equal(validarNovillosCierre("4.00").valor, 4);
  assert.equal(validarNovillosCierre(4).valor, 4);
});

// ─── Cierre de la recepción de talleres (res y cerdo) ──────────────────────

/** Cliente falso mínimo: lee la cabecera con `novillos` y registra cada UPDATE. */
function crearDb({ novillos }) {
  const updates = [];
  return {
    updates,
    from(tabla) {
      const q = {
        _update: null,
        _filtros: [],
        select() {
          return q;
        },
        order() {
          return q;
        },
        eq(col, val) {
          q._filtros.push([col, val]);
          return q;
        },
        update(cambios) {
          q._update = cambios;
          return q;
        },
        maybeSingle() {
          return Promise.resolve({ data: { id: 1, estado: "Borrador", novillos }, error: null });
        },
        then(resolve, reject) {
          if (q._update) {
            updates.push({ tabla, cambios: q._update, filtros: q._filtros });
            return Promise.resolve({ data: [{ id: 1 }], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [{ id: 10, tipo: "corte", cantidad: 5 }], error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const CIERRE = { recibido_por: "a@b.co", recibidor: OTRO, firma_data: FIRMA };

test("finalizar talleres: novillos vacío, 0, decimal o negativo -> 400 NOVILLOS_INVALIDOS y NO se emite ningún UPDATE", async () => {
  for (const novillos of [null, 0, 2.5, -1]) {
    const db = crearDb({ novillos });
    await assert.rejects(
      finalizar(1, CIERRE, db),
      (e) => e.statusCode === 400 && e.codigo === "NOVILLOS_INVALIDOS",
      `novillos=${novillos}`,
    );
    assert.equal(db.updates.length, 0, `novillos=${novillos}`);
  }
});

test("finalizar talleres: novillos = 4 cierra la recepción", async () => {
  const db = crearDb({ novillos: 4 });
  await finalizar(1, CIERRE, db);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].cambios.estado, "Aprobado");
});

test("finalizar talleres: NUMERIC de Postgres llega como texto ('4.00') y se acepta", async () => {
  const db = crearDb({ novillos: "4.00" });
  await finalizar(1, CIERRE, db);
  assert.equal(db.updates.length, 1);
});

// ─── Lo que NO cambia ──────────────────────────────────────────────────────

test("recepción de proveedor no usa la regla de novillos (no es taller)", () => {
  const origen = readFileSync(new URL("../src/models/RecepcionProveedor.model.js", import.meta.url), "utf8");
  assert.doesNotMatch(origen, /novillosObligatorio|validarNovillosCierre/);
});

test("filas ya cerradas con novillos = 0 no se tocan: la regla solo corre al finalizar", () => {
  // Ninguna lectura/listado importa la regla: solo `finalizar` del modelo de talleres.
  const modelo = readFileSync(new URL("../src/models/Recepcion.model.js", import.meta.url), "utf8");
  const usos = modelo.match(/validarNovillosCierre\(/g) ?? [];
  assert.equal(usos.length, 1);
});

// ─── Corrección del admin (PATCH /:id/novillos) ────────────────────────────

function correrEditarNovillos(body) {
  const req = { body };
  let error;
  validators.editarNovillos(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("editarNovillos (admin): 0, decimal y negativo -> 400; entero positivo pasa", () => {
  const editado_por = "admin@merkahorro.com";
  for (const novillos of [0, 2.5, -1]) {
    assert.equal(correrEditarNovillos({ novillos, editado_por }).error?.statusCode, 400, String(novillos));
  }
  assert.equal(correrEditarNovillos({ novillos: 4, editado_por }).error, undefined);
});
