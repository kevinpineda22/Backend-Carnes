import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/042_preliquidacion_corte_manual.sql (corte manual). Como en 039-041: la
 * base no decide reglas nuevas; revalida bajo lock. Los resultados reales y la carrera con la
 * liquidación los cubre el script manual test/sql/042_corte_manual.sql en QA.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "042_preliquidacion_corte_manual.sql");
const RUTA_ROLLBACK = join(RAIZ, "sql", "042_rollback.sql");

const limpiar = (t) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = existsSync(RUTA) ? limpiar(readFileSync(RUTA, "utf8")) : "";
const sql039 = limpiar(readFileSync(join(RAIZ, "sql", "039_preliquidacion_rpc.sql"), "utf8"));

function cuerpoFuncion(nombre, texto = sql) {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`).exec(texto);
  if (!m) return "";
  const resto = texto.slice(m.index);
  const fin = resto.indexOf("LANGUAGE plpgsql;");
  return fin < 0 ? resto : resto.slice(0, fin + "LANGUAGE plpgsql;".length);
}

const normalizar = (t) => t.replace(/\s+/g, " ").trim();

test("042: transacción con lock_timeout, guarda de 039, columnas idempotentes y sin SECURITY DEFINER", () => {
  assert.ok(existsSync(RUTA), "falta sql/042_preliquidacion_corte_manual.sql");
  assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.match(sql, /proname = 'carnes_preliq_liquidar'/);
  assert.match(sql, /proname = 'carnes_preliq_actualizar_servicio'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS corte_manual\s+TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS corte_manual_por\s+VARCHAR\(120\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS corte_manual_at\s+TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /CREATE FUNCTION/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
  assert.doesNotMatch(sql, /\bDROP\b/i, "la migración no borra nada");
});

test("fijar_corte: parámetros, JSONB y todos los códigos de resultado", () => {
  const f = cuerpoFuncion("carnes_preliq_fijar_corte");
  assert.ok(f, "falta carnes_preliq_fijar_corte");
  for (const p of ["p_id", "p_version", "p_orden_version", "p_corte", "p_corte_automatico", "p_ventana_fin", "p_por"]) {
    assert.ok(f.includes(p), `sin parámetro ${p}`);
  }
  assert.match(f, /RETURNS JSONB/);
  assert.match(f, /LANGUAGE plpgsql/);
  for (const c of [
    "ok", "no_encontrada", "no_abierta", "ya_liquidada", "version_cambiada", "corte_sin_primer_ingreso",
    "corte_pasado", "corte_excede_limite", "corte_automatico_pasado", "datos_invalidos",
  ]) {
    assert.ok(f.includes(`'${c}'`), `no devuelve '${c}'`);
  }
});

test("fijar_corte: bloquea la cabecera y revalida estado, liquidación y versiones ANTES de escribir", () => {
  const f = cuerpoFuncion("carnes_preliq_fijar_corte");
  const lock = f.indexOf("FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE");
  const escribir = f.indexOf("UPDATE carnes_preliquidaciones");
  assert.ok(lock > 0 && escribir > lock, "FOR UPDATE antes del UPDATE");
  for (const regla of [
    "v_header.estado <> 'abierta'",
    "v_header.liquidada_at IS NOT NULL",
    "v_header.version <> p_version",
    "v_header.orden_version <> p_orden_version",
    "v_header.fecha_primer_ingreso IS NULL",
  ]) {
    const i = f.indexOf(regla);
    assert.ok(i > lock && i < escribir, `${regla} debe evaluarse bajo lock y antes de escribir`);
  }
});

test("fijar_corte: futuro y tope de 7 días con el reloj de la base; restablecer exige automático futuro", () => {
  const f = cuerpoFuncion("carnes_preliq_fijar_corte");
  assert.match(f, /p_corte <= now\(\)/);
  assert.match(f, /p_corte > p_corte_automatico \+ interval '7 days'/);
  assert.match(f, /p_corte_automatico <= now\(\)/);
});

test("fijar_corte: sube version, escribe la ventana de JS, audita y borra alertas corrida_perdida sin enviar", () => {
  const f = cuerpoFuncion("carnes_preliq_fijar_corte");
  assert.match(f, /corte_manual = p_corte/);
  assert.match(f, /ventana_fin = p_ventana_fin/);
  assert.match(f, /version = version \+ 1/);
  assert.match(f, /orden_version = orden_version \+ 1/);
  assert.match(f, /corte_manual_por = CASE WHEN p_corte IS NULL THEN NULL/);
  assert.match(f, /DELETE FROM carnes_preliquidacion_alertas[\s\S]*enviado_ok = false[\s\S]*evento = 'corrida_perdida'/);
});

test("fijar_corte: el servicio cargado entre el corte anterior y el nuevo pasa a precorte", () => {
  const f = cuerpoFuncion("carnes_preliq_fijar_corte");
  assert.match(f, /servicio_at > v_anterior AND servicio_at <= v_nuevo/);
  assert.match(f, /servicio_precorte = CASE/);
  assert.match(f, /servicio_precorte_at = CASE/);
});

test("liquidar y actualizar_servicio: el corte de la cabecera manda sobre p_corte (la base es la fuente de verdad)", () => {
  const liquidar = cuerpoFuncion("carnes_preliq_liquidar");
  const servicio = cuerpoFuncion("carnes_preliq_actualizar_servicio");
  assert.match(liquidar, /v_corte := COALESCE\(v_header\.corte_manual, p_corte\)/);
  assert.match(liquidar, /v_corte IS NULL OR now\(\) < v_corte/);
  assert.match(servicio, /v_corte := COALESCE\(v_header\.corte_manual, p_corte\)/);
  assert.match(servicio, /v_corte IS NOT NULL AND now\(\) > v_corte/);
});

test("liquidar y actualizar_servicio de 042 son los de 039 salvo el cambio del corte (no se pierde ninguna regla)", () => {
  const sinCorte = (t) =>
    normalizar(
      t
        .replace(/\s*v_corte\s+TIMESTAMPTZ;/, "")
        .replace(/\s*v_corte := COALESCE\(v_header\.corte_manual, p_corte\);/, "")
        .replace(/v_corte IS NOT NULL AND now\(\) > v_corte/, "p_corte IS NOT NULL AND now() > p_corte")
        .replace(/v_corte IS NULL OR now\(\) < v_corte/, "p_corte IS NULL OR now() < p_corte"),
    );
  for (const nombre of ["carnes_preliq_liquidar", "carnes_preliq_actualizar_servicio"]) {
    assert.equal(sinCorte(cuerpoFuncion(nombre)), normalizar(cuerpoFuncion(nombre, sql039)), nombre);
  }
});

test("el rollback existe, restaura las funciones de 039 y elimina fijar_corte y las columnas", () => {
  assert.ok(existsSync(RUTA_ROLLBACK), "falta sql/042_rollback.sql");
  const rb = limpiar(readFileSync(RUTA_ROLLBACK, "utf8"));
  assert.match(rb, /DROP FUNCTION IF EXISTS carnes_preliq_fijar_corte/);
  assert.match(rb, /DROP COLUMN IF EXISTS corte_manual\b/);
  assert.doesNotMatch(cuerpoFuncion("carnes_preliq_liquidar", rb), /corte_manual/);
  for (const nombre of ["carnes_preliq_liquidar", "carnes_preliq_actualizar_servicio"]) {
    assert.equal(normalizar(cuerpoFuncion(nombre, rb)), normalizar(cuerpoFuncion(nombre, sql039)), `${nombre} igual a 039`);
  }
});
