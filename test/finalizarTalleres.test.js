import test from "node:test";
import assert from "node:assert/strict";

// El modelo importa el cliente real de Supabase, que exige variables de entorno al
// cargarse. Son valores de relleno: los tests inyectan un cliente falso (`db`) y
// nunca hablan con la red.
process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_KEY ||= "clave-de-prueba";

const { finalizar, reabrir } = await import("../src/models/Recepcion.model.js");

const FIRMA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const OTRO = { otro: true, nombre: "Maria Perez", cedula: "12345678" };

/**
 * Cliente falso con la forma mínima que usa el modelo: `from(t).select()...` para
 * leer y `from(t).update(c).eq().eq().select()` para escribir. Registra cada UPDATE.
 */
function crearDb({ estado = "Borrador", filasActualizadas = [{ id: 1 }], errorUpdate = null } = {}) {
  const updates = [];
  const db = {
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
          return Promise.resolve({ data: { id: 1, estado, novillos: 0 }, error: null });
        },
        then(resolve, reject) {
          if (q._update) {
            updates.push({ tabla, cambios: q._update, filtros: q._filtros });
            return Promise.resolve({ data: filasActualizadas, error: errorUpdate }).then(resolve, reject);
          }
          // Lectura de renglones.
          return Promise.resolve({ data: [{ id: 10, tipo: "corte", cantidad: 5 }], error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}

const mensajeColumna = { code: "42703", message: 'column "firma_data" of relation "carnes_recepciones" does not exist' };

test("finalizar talleres: sin firma o con firma inválida -> 400 y NO se emite ningún UPDATE", async () => {
  for (const firma of [undefined, "", "no-es-una-firma"]) {
    const db = crearDb();
    await assert.rejects(
      finalizar(1, { recibido_por: "a@b.co", recibidor: OTRO, firma_data: firma }, db),
      (e) => e.statusCode === 400 && /^FIRMA_/.test(e.codigo),
    );
    assert.equal(db.updates.length, 0);
  }
});

test("finalizar talleres: sin recibidor -> 400 y NO se emite ningún UPDATE", async () => {
  const db = crearDb();
  await assert.rejects(
    finalizar(1, { recibido_por: "a@b.co", firma_data: FIRMA }, db),
    (e) => e.statusCode === 400 && /^RECIBIDOR_/.test(e.codigo),
  );
  assert.equal(db.updates.length, 0);
});

test("finalizar talleres: válido -> exactamente un UPDATE con estado, firma y recibidor, condicionado al estado de origen", async () => {
  const db = crearDb();
  await finalizar(1, { recibido_por: "a@b.co", recibidor: OTRO, firma_data: FIRMA }, db);
  assert.equal(db.updates.length, 1);
  const [u] = db.updates;
  assert.equal(u.cambios.estado, "Aprobado");
  assert.equal(u.cambios.firma_data, FIRMA);
  assert.equal(u.cambios.recibidor_nombre, "Maria Perez");
  assert.ok(u.filtros.some(([c, v]) => c === "estado" && v === "Borrador"));
});

test("finalizar talleres: 0 filas actualizadas (otra petición ganó) -> 409 RECEPCION_CAMBIO", async () => {
  const db = crearDb({ filasActualizadas: [] });
  await assert.rejects(
    finalizar(1, { recibido_por: "a@b.co", recibidor: OTRO, firma_data: FIRMA }, db),
    (e) => e.statusCode === 409 && e.codigo === "RECEPCION_CAMBIO",
  );
});

test("finalizar talleres: columna faltante (sin sql/027) -> 503 MIGRACION_PENDIENTE", async () => {
  const db = crearDb({ errorUpdate: mensajeColumna });
  await assert.rejects(
    finalizar(1, { recibido_por: "a@b.co", recibidor: OTRO, firma_data: FIRMA }, db),
    (e) => e.statusCode === 503 && e.codigo === "MIGRACION_PENDIENTE" && /migración 027/.test(e.message),
  );
});

test("finalizar talleres: otro error de la base no se disfraza de migración pendiente", async () => {
  const db = crearDb({ errorUpdate: { code: "XX000", message: "boom" } });
  await assert.rejects(
    finalizar(1, { recibido_por: "a@b.co", recibidor: OTRO, firma_data: FIRMA }, db),
    (e) => e.codigo !== "MIGRACION_PENDIENTE" && !e.expose,
  );
});

test("reabrir: Rechazado -> Borrador limpia recibidor y firma en el mismo UPDATE", async () => {
  const db = crearDb({ estado: "Rechazado" });
  await reabrir(1, db);
  assert.equal(db.updates.length, 1);
  assert.deepEqual(db.updates[0].cambios, {
    estado: "Borrador",
    recibidor_id: null,
    recibidor_cedula: null,
    recibidor_nombre: null,
    recibidor_otro: false,
    firma_data: null,
  });
  assert.ok(db.updates[0].filtros.some(([c, v]) => c === "estado" && v === "Rechazado"));
});

test("reabrir: sin sql/027 reintenta sin las columnas y no se rompe", async () => {
  const db = crearDb({ estado: "Rechazado" });
  // Primer UPDATE falla por columna; el segundo pasa.
  let llamadas = 0;
  const from = db.from.bind(db);
  db.from = (t) => {
    const q = from(t);
    const then = q.then;
    q.then = (res, rej) => {
      if (q._update) {
        llamadas += 1;
        if (llamadas === 1) {
          db.updates.push({ tabla: t, cambios: q._update, filtros: q._filtros });
          return Promise.resolve({ data: null, error: mensajeColumna }).then(res, rej);
        }
      }
      return then(res, rej);
    };
    return q;
  };
  await reabrir(1, db);
  assert.equal(db.updates.length, 2);
  assert.deepEqual(db.updates[1].cambios, { estado: "Borrador" });
});
