import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/041_preliquidacion_rpc_correcciones.sql (alterna, saldos y
 * correcciones). Como en 039/040: persistencia fina, sin fórmulas de negocio. Las carreras
 * y los resultados reales los cubren los scripts manuales test/sql/041*.sql en QA.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "041_preliquidacion_rpc_correcciones.sql");

const limpiar = (t) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = existsSync(RUTA) ? limpiar(readFileSync(RUTA, "utf8")) : "";

function cuerpoFuncion(nombre, texto = sql) {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`).exec(texto);
  if (!m) return "";
  const resto = texto.slice(m.index + 1);
  const sig = resto.search(/CREATE OR REPLACE FUNCTION/);
  return sig < 0 ? texto.slice(m.index) : texto.slice(m.index, m.index + 1 + sig);
}

const FUNCIONES = {
  carnes_preliq_registrar_alterna: {
    parametros: ["p_id", "p_servicio", "p_servicio_at", "p_por_sede", "p_diferencia", "p_saldo_plan"],
    codigos: [
      "ok", "ya_registrada", "no_encontrada", "no_liquidada", "datos_invalidos", "saldo_invalido",
      "destino_invalido", "version_cambiada",
    ],
  },
  carnes_preliq_saldo_editar: {
    parametros: ["p_saldo_id", "p_valor", "p_por"],
    codigos: ["ok", "sin_cambios", "no_encontrada", "no_pendiente", "valor_invalido", "version_cambiada"],
  },
  carnes_preliq_saldo_descartar: {
    parametros: ["p_saldo_id", "p_por"],
    codigos: ["ok", "no_encontrada", "no_pendiente", "version_cambiada"],
  },
  carnes_preliq_saldo_mover: {
    parametros: ["p_saldo_id", "p_destino_id", "p_por"],
    codigos: [
      "ok", "sin_cambios", "no_encontrada", "no_pendiente", "destino_invalido", "especie_distinta",
      "destino_liquidada", "version_cambiada",
    ],
  },
};

test("el archivo 041 existe, es una transacción con lock_timeout y todo es CREATE OR REPLACE", () => {
  assert.ok(existsSync(RUTA), "falta sql/041_preliquidacion_rpc_correcciones.sql");
  assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.doesNotMatch(sql, /CREATE FUNCTION/);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i, "las RPC son SECURITY INVOKER");
  assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE/i, "041 no cambia el esquema: solo funciones");
});

test("041 exige que 039 ya esté aplicada", () => {
  assert.match(sql, /proname = 'carnes_preliq_transicionar_sede'/);
});

for (const [nombre, def] of Object.entries(FUNCIONES)) {
  test(`${nombre}: existe con sus parámetros, devuelve JSONB y declara sus códigos`, () => {
    const f = cuerpoFuncion(nombre);
    assert.ok(f, `falta la función ${nombre}`);
    for (const p of def.parametros) assert.ok(f.includes(p), `${nombre} sin parámetro ${p}`);
    assert.match(f, /RETURNS JSONB/);
    assert.match(f, /LANGUAGE plpgsql/);
    for (const c of def.codigos) assert.ok(f.includes(`'${c}'`), `${nombre} no devuelve '${c}'`);
  });
}

test("registrar_alterna: idempotente por (preliquidacion_id, servicio_at) y bloquea la cabecera", () => {
  const f = cuerpoFuncion("carnes_preliq_registrar_alterna");
  assert.match(f, /ON CONFLICT \(preliquidacion_id, servicio_at\) DO NOTHING/);
  assert.match(f, /FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE/);
  assert.match(f, /v_header\.liquidada_at IS NULL/);
  // La repetición se detecta ANTES de validar o escribir el saldo.
  assert.ok(f.indexOf("'ya_registrada'") < f.indexOf("'saldo_invalido'", f.indexOf("'ya_registrada'")), "ya_registrada primero");
  assert.ok(f.indexOf("'ya_registrada'") < f.indexOf("INSERT INTO carnes_preliquidacion_alternas"));
});

test("registrar_alterna: el servicio aplicado sale de la cabecera y todo se valida antes de insertar", () => {
  const f = cuerpoFuncion("carnes_preliq_registrar_alterna");
  assert.match(f, /v_header\.servicio_aplicado/);
  const insertar = f.indexOf("INSERT INTO carnes_preliquidacion_alternas");
  for (const codigo of ["'destino_invalido'", "'version_cambiada'"]) {
    assert.ok(f.indexOf(codigo) < insertar, `${codigo} debe evaluarse antes de escribir la alterna`);
  }
});

test("registrar_alterna: acciones de saldo permitidas y destino válido (misma especie, abierta, sin liquidar)", () => {
  const f = cuerpoFuncion("carnes_preliq_registrar_alterna");
  assert.match(f, /NOT IN \('nada', 'actualizar_pendiente', 'crear_ajuste'\)/);
  assert.match(f, /v_dest\.especie <> v_header\.especie/);
  assert.match(f, /v_dest\.liquidada_at IS NOT NULL/);
  assert.match(f, /v_dest\.estado <> 'abierta'/);
  // El destino se bloquea antes de leer/escribir el saldo.
  assert.ok(f.indexOf("FROM carnes_preliquidaciones WHERE id = v_destino_id FOR UPDATE") < f.indexOf("FROM carnes_preliquidacion_saldos WHERE id = v_saldo_id FOR UPDATE"));
});

test("registrar_alterna: un ajuste nuevo nace pendiente con la fila aplicada que ajusta y sube la versión del destino", () => {
  const f = cuerpoFuncion("carnes_preliq_registrar_alterna");
  assert.match(f, /INSERT INTO carnes_preliquidacion_saldos/);
  assert.match(f, /ajuste_de_saldo_id/);
  assert.match(f, /'pendiente'/);
  assert.match(f, /UPDATE carnes_preliquidaciones SET version = version \+ 1 WHERE id = v_destino_id/);
  // Un saldo aplicado nunca se reescribe: solo se actualiza uno pendiente.
  assert.match(f, /v_saldo\.estado <> 'pendiente'/);
});

for (const nombre of ["carnes_preliq_saldo_editar", "carnes_preliq_saldo_descartar", "carnes_preliq_saldo_mover"]) {
  test(`${nombre}: solo opera saldos pendientes, bloquea destino antes que saldo y sube la versión`, () => {
    const f = cuerpoFuncion(nombre);
    assert.match(f, /v_saldo\.estado <> 'pendiente'/);
    assert.match(f, /FROM carnes_preliquidaciones WHERE id\b[^;]*FOR UPDATE/);
    assert.match(f, /FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id FOR UPDATE/);
    assert.ok(
      f.indexOf("FROM carnes_preliquidaciones WHERE id") < f.indexOf("FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id FOR UPDATE"),
      "orden de bloqueo: cabecera destino -> saldo",
    );
    assert.match(f, /UPDATE carnes_preliquidaciones SET version = version \+ 1 WHERE id/);
  });
}

test("saldo_mover (E-S6): rechaza otra especie y un destino liquidado; vieja fila movido con enlace a la nueva", () => {
  const f = cuerpoFuncion("carnes_preliq_saldo_mover");
  assert.match(f, /v_dest\.especie <> v_saldo\.especie/);
  assert.match(f, /v_dest\.liquidada_at IS NOT NULL/);
  assert.match(f, /v_dest\.estado <> 'abierta'/);
  assert.match(f, /estado = 'movido'/);
  assert.match(f, /movido_a_saldo_id = v_nuevo_id/);
  // Fila nueva pendiente con el mismo valor y origen.
  assert.match(f, /v_saldo\.origen_preliquidacion_id, v_saldo\.especie, v_saldo\.valor, p_destino_id, 'pendiente'/);
  // Cabeceras bloqueadas por id ascendente (sin bloqueos cruzados).
  assert.match(f, /WHERE id IN \(p_destino_id, v_anterior\) ORDER BY id FOR UPDATE/);
});

test("saldo_descartar: la fila queda descartada, no se borra", () => {
  const f = cuerpoFuncion("carnes_preliq_saldo_descartar");
  assert.match(f, /estado = 'descartado'/);
  assert.doesNotMatch(f, /\bDELETE\b/i);
});

test("sin fórmulas de negocio en plpgsql (R8)", () => {
  const prohibido = [
    /\bround\s*\(/i,
    /\bsum\s*\(/i,
    /servicio_por_animal\s*\*/i,
    /animal_en_pie\s*\+/i,
    /gasto_total_aplicado\s*[-+*/]/i,
    /utilidad\s*[-+*/]/i,
    /\bgasto_sede\s*[-+*/]/i,
    /servicio_compra\s*[-+*/]/i,
    /\bvalor\s*[-+*/]\s*\w/i,
    /diferencia\s*[-+*/]/i,
  ];
  for (const re of prohibido) assert.doesNotMatch(sql, re, `fórmula de negocio prohibida: ${re}`);
});

test("existe el script manual de la parte A en test/sql, envuelto en BEGIN ... ROLLBACK", () => {
  const ruta = join(RAIZ, "test", "sql", "041a_rpc_alterna_saldos.sql");
  assert.ok(existsSync(ruta), "falta test/sql/041a_rpc_alterna_saldos.sql");
  const t = limpiar(readFileSync(ruta, "utf8"));
  assert.match(t, /^\s*BEGIN;/m);
  assert.match(t, /^\s*ROLLBACK;/m);
  assert.doesNotMatch(t, /^\s*COMMIT;/m);
  for (const f of Object.keys(FUNCIONES)) assert.ok(t.includes(f), `el script no ejercita ${f}`);
});
