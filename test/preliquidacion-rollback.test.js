import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/038_039_rollback.sql: cada objeto que crean sql/038 y
 * sql/039 tiene su DROP, en el orden correcto de dependencias, dentro de una sola
 * transacción y sin CASCADE. Los nombres se extraen con expresiones regulares de
 * los propios archivos, así que un objeto nuevo en 038/039 sin su DROP rompe esta
 * prueba. No ejecuta SQL.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const leer = (f) =>
  readFileSync(join(RAIZ, f), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

const s038 = leer("038_preliquidacion.sql");
const s039 = leer("039_preliquidacion_rpc.sql");
const s040 = leer("040_preliquidacion_rpc_envio.sql");
const rollback040 = leer("040_rollback.sql");
const rollback = leer("038_039_rollback.sql");

const TIPOS = { INT: "INTEGER", INT4: "INTEGER", INTEGER: "INTEGER", BIGINT: "BIGINT", TEXT: "TEXT", JSONB: "JSONB",
  NUMERIC: "NUMERIC", DATE: "DATE", TIMESTAMPTZ: "TIMESTAMPTZ", BOOLEAN: "BOOLEAN", BOOL: "BOOLEAN" };
const normalizar = (t) => {
  const base = t.trim().toUpperCase().replace(/\(.*\)/, "");
  return TIPOS[base] ?? base;
};

// ─── Lo que crean 038 y 039 ────────────────────────────────────────────────

const tablas = [...s038.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const indices = [...s038.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const checks = [...s038.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]);
const columnasRecepciones = [...s038.matchAll(/ALTER TABLE carnes_recepciones\s+ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

/** Firma `nombre(tipos...)` de cada función del archivo SQL dado, en el orden de declaración. */
function firmasFunciones(sql) {
  const out = [];
  const re = /CREATE OR REPLACE FUNCTION (\w+)\s*\(([^)]*)\)/g;
  for (const m of sql.matchAll(re)) {
    const tipos = m[2]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => normalizar(p.split(/\s+/)[1]));
    out.push({ nombre: m[1], tipos });
  }
  return out;
}
const funciones039 = firmasFunciones(s039);
const funciones040 = firmasFunciones(s040);
// 040 redefine carnes_preliq_transicionar_sede (ya cubierta por el DROP de 039): no cuenta dos veces.
const funciones040Nuevas = funciones040.filter((f) => !funciones039.some((g) => g.nombre === f.nombre));
const s041 = leer("041_preliquidacion_rpc_correcciones.sql");
const rollback041 = leer("041_rollback.sql");
// 041 solo agrega funciones nuevas (no redefine las de 039/040).
const funciones041 = firmasFunciones(s041);
const funciones = [...funciones039, ...funciones040Nuevas, ...funciones041];

/** `DROP FUNCTION IF EXISTS nombre(tipos)` del rollback. */
const dropsFunciones = [...rollback.matchAll(/DROP FUNCTION IF EXISTS (\w+)\s*\(([^)]*)\)/g)].map((m) => ({
  nombre: m[1],
  tipos: m[2].split(",").map((t) => normalizar(t)).filter(Boolean),
  posicion: m.index,
}));
const dropsTablas = [...rollback.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map((m) => ({ nombre: m[1], posicion: m.index }));

test("los regex de extracción ven los objetos esperados (piso, para no pasar en vacío)", () => {
  assert.equal(tablas.length, 9);
  assert.ok(indices.length >= 8, `índices: ${indices.length}`);
  assert.deepEqual(checks.sort(), ["ck_carnes_recepciones_liq_xor_preliq", "ck_carnes_recepciones_preliq_novillos"]);
  assert.deepEqual(columnasRecepciones, ["preliquidacion_id"]);
  assert.equal(funciones039.length, 10);
  assert.equal(funciones040Nuevas.length, 4);
});

test("cada función de 039 y las nuevas de 040 tienen su DROP con la firma exacta", () => {
  for (const f of funciones) {
    const drop = dropsFunciones.find((d) => d.nombre === f.nombre);
    assert.ok(drop, `falta DROP FUNCTION de ${f.nombre}`);
    assert.deepEqual(drop.tipos, f.tipos, `firma de ${f.nombre}`);
  }
  assert.equal(dropsFunciones.length, funciones.length, "el rollback borra funciones que 039/040 no crean");
});

test("cada tabla de 038 tiene su DROP TABLE IF EXISTS y no sobra ninguno", () => {
  assert.deepEqual([...dropsTablas.map((d) => d.nombre)].sort(), [...tablas].sort());
});

test("las tablas se borran antes que las tablas a las que apuntan (FK)", () => {
  // Cada tabla de 038 que referencia a otra de 038 debe caer ANTES que la referenciada.
  const bloques = s038.split(/CREATE TABLE IF NOT EXISTS /).slice(1);
  const posicion = new Map(dropsTablas.map((d) => [d.nombre, d.posicion]));
  let pares = 0;
  for (const b of bloques) {
    const nombre = /^(\w+)/.exec(b)[1];
    const cuerpo = b.slice(0, b.indexOf(");"));
    for (const ref of cuerpo.matchAll(/REFERENCES (\w+)/g)) {
      if (!tablas.includes(ref[1]) || ref[1] === nombre) continue;
      pares += 1;
      assert.ok(posicion.get(nombre) < posicion.get(ref[1]), `${nombre} debe borrarse antes que ${ref[1]}`);
    }
  }
  assert.ok(pares >= 8, `solo se verificaron ${pares} dependencias`);
});

test("cada índice, CHECK y la columna de carnes_recepciones se revierten", () => {
  for (const idx of indices) {
    // Los índices de tablas que se borran caen con la tabla; solo se exige DROP explícito
    // para el de carnes_recepciones, que sobrevive.
    if (/carnes_recepciones/.test(s038.slice(s038.indexOf(idx), s038.indexOf(idx) + 200))) {
      assert.match(rollback, new RegExp(`DROP INDEX IF EXISTS ${idx}`), idx);
    }
  }
  for (const c of checks) assert.match(rollback, new RegExp(`DROP CONSTRAINT IF EXISTS ${c}`), c);
  for (const col of columnasRecepciones) {
    assert.match(rollback, new RegExp(`ALTER TABLE carnes_recepciones DROP COLUMN IF EXISTS ${col}`));
  }
});

test("orden: funciones, luego CHECKs/columna de recepciones, luego tablas", () => {
  const ultimaFuncion = Math.max(...dropsFunciones.map((d) => d.posicion));
  const primerCheck = rollback.indexOf("DROP CONSTRAINT IF EXISTS");
  const columna = rollback.indexOf("DROP COLUMN IF EXISTS preliquidacion_id");
  const primeraTabla = Math.min(...dropsTablas.map((d) => d.posicion));
  assert.ok(ultimaFuncion < primerCheck, "las funciones caen antes que los CHECKs");
  assert.ok(primerCheck < columna, "los CHECKs caen antes que la columna");
  assert.ok(columna < primeraTabla, "la columna (y su FK) cae antes que las tablas");
});

test("una sola transacción, todo con IF EXISTS y sin CASCADE", () => {
  assert.equal([...rollback.matchAll(/^\s*BEGIN;/gm)].length, 1);
  assert.equal([...rollback.matchAll(/^\s*COMMIT;/gm)].length, 1);
  assert.doesNotMatch(rollback, /\bCASCADE\b/i);
  const drops = rollback.match(/^\s*(?:ALTER TABLE \w+ )?DROP [^;]*;/gim) ?? [];
  assert.ok(drops.length >= 20, `drops vistos: ${drops.length}`);
  for (const d of drops) assert.match(d, /IF EXISTS/i, d.trim());
  assert.ok(rollback.indexOf("BEGIN;") < rollback.indexOf("DROP FUNCTION"));
  assert.ok(rollback.lastIndexOf("DROP TABLE") < rollback.indexOf("COMMIT;"));
});

test("no toca objetos anteriores a 038", () => {
  assert.doesNotMatch(rollback, /carnes_set_updated_at/);
  const tocadas = [...rollback.matchAll(/(?:DROP TABLE IF EXISTS|ALTER TABLE) (\w+)/g)].map((m) => m[1]);
  for (const t of tocadas) assert.ok(tablas.includes(t) || t === "carnes_recepciones", `toca ${t}`);
  assert.doesNotMatch(rollback, /\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
});

test("aborta si hay sedes enviadas a SIESA (guarda) antes de borrar nada", () => {
  const guarda = rollback.indexOf("RAISE EXCEPTION");
  assert.ok(guarda > 0);
  assert.match(rollback, /'enviando', 'enviada', 'sin_confirmar'/);
  assert.ok(guarda < rollback.indexOf("DROP FUNCTION"));
});

test("la guarda replica la de carnes_preliq_desvincular (estados, envíos SIESA y recepciones enviadas)", () => {
  const guarda = rollback.slice(rollback.indexOf("BEGIN;"), rollback.indexOf("UPDATE carnes_recepcion_items"));
  assert.match(guarda, /'enviando', 'enviada', 'sin_confirmar', 'anulada'/);
  assert.match(guarda, /carnes_siesa_envios/);
  assert.match(guarda, /e\.estado IN \('ok', 'enviando', 'sin_confirmar'\)/);
  assert.match(guarda, /'Enviado_SIESA'/);
  assert.match(guarda, /preliquidacion_id IS NOT NULL/);
  // Debe seguir funcionando si las tablas ya no existen.
  assert.match(guarda, /to_regclass\('carnes_preliquidacion_sedes'\)/);
  assert.match(guarda, /to_regclass\('carnes_siesa_envios'\)/);
  assert.match(guarda, /information_schema\.columns/);
});

test("la limpieza de costos solo toca ítems de recepciones Costeado", () => {
  const paso2 = rollback.slice(rollback.indexOf("UPDATE carnes_recepcion_items"), rollback.indexOf("DROP FUNCTION"));
  const items = /UPDATE carnes_recepcion_items[\s\S]*?\$q\$;/.exec(paso2)[0];
  assert.match(items, /preliquidacion_id IS NOT NULL AND estado = 'Costeado'/);
});

test("038 y el rollback fijan lock_timeout justo después de BEGIN", () => {
  for (const [nombre, sql] of [["038", s038], ["rollback", rollback]]) {
    assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/, nombre);
  }
});

test("devuelve al flujo legado las recepciones vinculadas no enviadas, antes de borrar la columna", () => {
  assert.match(rollback, /SET costo_ajustado = NULL, costo_total = NULL/);
  assert.match(rollback, /SET estado = 'Aprobado', costeado_at = NULL/);
  assert.ok(rollback.indexOf("SET estado = 'Aprobado'") < rollback.indexOf("DROP COLUMN"));
});

test("el encabezado avisa que es solo para revertir el lunes y que borra datos", () => {
  const crudo = readFileSync(join(RAIZ, "038_039_rollback.sql"), "utf8");
  assert.match(crudo, /2026-11-23/);
  assert.match(crudo, /SOLO si hay que revertir/i);
  assert.match(crudo, /borra TODOS los datos/i);
});

// ─── sql/040_rollback.sql ──────────────────────────────────────────────────

test("038_039_rollback también elimina las funciones nuevas de 040 (no quedan huérfanas)", () => {
  for (const f of funciones040Nuevas) {
    const drop = dropsFunciones.find((d) => d.nombre === f.nombre);
    assert.ok(drop, `falta DROP de ${f.nombre} en 038_039_rollback`);
    assert.deepEqual(drop.tipos, f.tipos);
  }
});

test("040_rollback: una transacción con lock_timeout, DROP IF EXISTS de cada función nueva y sin CASCADE", () => {
  assert.match(rollback040, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.equal([...rollback040.matchAll(/^\s*COMMIT;/gm)].length, 1);
  assert.doesNotMatch(rollback040, /\bCASCADE\b/i);
  const drops = [...rollback040.matchAll(/DROP FUNCTION IF EXISTS (\w+)\s*\(([^)]*)\)/g)].map((m) => ({
    nombre: m[1],
    tipos: m[2].split(",").map((t) => normalizar(t)),
  }));
  assert.equal(drops.length, funciones040Nuevas.length);
  for (const f of funciones040Nuevas) {
    const d = drops.find((x) => x.nombre === f.nombre);
    assert.ok(d, `040_rollback sin DROP de ${f.nombre}`);
    assert.deepEqual(d.tipos, f.tipos, `firma de ${f.nombre}`);
  }
  assert.doesNotMatch(rollback040, /DROP TABLE|DROP COLUMN|DROP CONSTRAINT/i, "040 no toca tablas ni columnas");
});

/** Cuerpo de carnes_preliq_transicionar_sede en un SQL, normalizado en espacios. */
function cuerpoTransicionar(sql) {
  const i = sql.indexOf("CREATE OR REPLACE FUNCTION carnes_preliq_transicionar_sede");
  const fin = sql.indexOf("$fn$ LANGUAGE plpgsql;", i);
  return sql.slice(i, fin).replace(/\s+/g, " ").trim();
}

test("040_rollback restaura carnes_preliq_transicionar_sede idéntica a la de 039", () => {
  assert.equal(cuerpoTransicionar(rollback040), cuerpoTransicionar(s039));
  assert.notEqual(cuerpoTransicionar(s040), cuerpoTransicionar(s039), "040 sí debe cambiarla");
});

// ─── sql/041_rollback.sql ──────────────────────────────────────────────────

test("041 solo crea funciones nuevas: ninguna redefine una de 039/040", () => {
  const previas = [...funciones039, ...funciones040].map((f) => f.nombre);
  assert.equal(funciones041.length, 6, `funciones de 041: ${funciones041.length}`);
  for (const f of funciones041) assert.ok(!previas.includes(f.nombre), `${f.nombre} ya existe en 039/040`);
});

test("041_rollback: una transacción con lock_timeout, DROP IF EXISTS de cada función y sin CASCADE", () => {
  assert.match(rollback041, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.equal([...rollback041.matchAll(/^\s*COMMIT;/gm)].length, 1);
  assert.doesNotMatch(rollback041, /\bCASCADE\b/i);
  const drops = [...rollback041.matchAll(/DROP FUNCTION IF EXISTS (\w+)\s*\(([^)]*)\)/g)].map((m) => ({
    nombre: m[1],
    tipos: m[2].split(",").map((t) => normalizar(t)),
  }));
  assert.equal(drops.length, funciones041.length);
  for (const f of funciones041) {
    const d = drops.find((x) => x.nombre === f.nombre);
    assert.ok(d, `041_rollback sin DROP de ${f.nombre}`);
    assert.deepEqual(d.tipos, f.tipos, `firma de ${f.nombre}`);
  }
  assert.doesNotMatch(rollback041, /DROP TABLE|DROP COLUMN|DROP CONSTRAINT|\bDELETE\b|\bTRUNCATE\b/i, "041 no toca tablas ni datos");
});

test("041_rollback va antes que 040_rollback y 038/039 y el encabezado lo documenta", () => {
  const crudo = readFileSync(join(RAIZ, "041_rollback.sql"), "utf8");
  assert.match(crudo, /sql\/040_rollback\.sql/);
  assert.match(crudo, /sql\/038_039_rollback\.sql/);
  assert.match(crudo, /ESTE archivo primero/i);
});

test("040_rollback va antes de revertir 038/039 y el encabezado lo documenta", () => {
  const crudo = readFileSync(join(RAIZ, "040_rollback.sql"), "utf8");
  assert.match(crudo, /sql\/038_039_rollback\.sql/);
  assert.match(crudo, /ANTES|primero/i);
});
