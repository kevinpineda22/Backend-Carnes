import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/043_preliquidacion_vincular_anterior.sql. Como en 039-042: la base no decide
 * reglas nuevas, revalida bajo lock. Las carreras reales se prueban a mano en QA.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "043_preliquidacion_vincular_anterior.sql");
const RUTA_ROLLBACK = join(RAIZ, "sql", "043_rollback.sql");

const limpiar = (t) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = existsSync(RUTA) ? limpiar(readFileSync(RUTA, "utf8")) : "";
const sql039 = limpiar(readFileSync(join(RAIZ, "sql", "039_preliquidacion_rpc.sql"), "utf8"));
const rollback = existsSync(RUTA_ROLLBACK) ? limpiar(readFileSync(RUTA_ROLLBACK, "utf8")) : "";

function cuerpoFuncion(nombre, texto = sql) {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`).exec(texto);
  if (!m) return "";
  const resto = texto.slice(m.index);
  const fin = resto.indexOf("LANGUAGE plpgsql;");
  return fin < 0 ? resto : resto.slice(0, fin + "LANGUAGE plpgsql;".length);
}

const normalizar = (t) => t.replace(/\s+/g, " ").trim();

test("043: transacción con lock_timeout, guarda de 039 y solo redefine carnes_preliq_vincular", () => {
  assert.ok(existsSync(RUTA), "falta sql/043_preliquidacion_vincular_anterior.sql");
  assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.match(sql, /proname = 'carnes_preliq_vincular'/);
  assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((m) => m[1]), ["carnes_preliq_vincular"]);
  assert.doesNotMatch(sql, /CREATE FUNCTION/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
  assert.doesNotMatch(sql, /\bDROP\b/i);
});

test("vincular 043: misma firma y resultados que 039 (el contrato no cambia)", () => {
  const nueva = cuerpoFuncion("carnes_preliq_vincular");
  const vieja = cuerpoFuncion("carnes_preliq_vincular", sql039);
  assert.ok(nueva && vieja);
  const firma = (f) => normalizar(f.slice(0, f.indexOf("AS $fn$")));
  assert.equal(firma(nueva), firma(vieja));
  const resultados = (f) => [...new Set([...f.matchAll(/'resultado', '(\w+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(resultados(nueva), resultados(vieja));
});

test("vincular 043: conserva las guardas de 039 (estado, versión, legado, plan, ck xor)", () => {
  const f = cuerpoFuncion("carnes_preliq_vincular");
  for (const regla of [
    "v_header.estado <> 'abierta'",
    "v_header.orden_version <> p_orden_version",
    "v_rec.preliquidacion_id IS NOT NULL",
    "v_rec.liquidacion_id IS NOT NULL",
    "tipo = 'oficial'",
    "carnes_preliq_validar_plan_sedes",
    "carnes_preliq_aplicar_plan_sedes",
    "orden_version = orden_version + 1",
    "WHEN check_violation THEN",
  ]) {
    assert.ok(f.includes(regla), `perdió la guarda: ${regla}`);
  }
  assert.match(f, /FROM carnes_preliquidaciones WHERE id = p_preliquidacion_id FOR UPDATE/);
});

test("vincular 043: la excepción `anterior` se revalida bajo lock con todas sus condiciones", () => {
  const f = cuerpoFuncion("carnes_preliq_vincular");
  const lock = f.indexOf("FOR UPDATE");
  const i = f.indexOf("v_anterior := COALESCE((p_plan->>'anterior')::BOOLEAN, false)");
  assert.ok(lock > 0 && i > lock, "se lee del plan después de bloquear la cabecera");
  const bloque = normalizar(f.slice(i, f.indexOf("END IF;", i)));
  for (const cond of [
    "v_mueve",
    "v_header.liquidada_at IS NULL",
    "v_header.fecha_primer_ingreso IS NULL",
    "v_rec.especie IS DISTINCT FROM v_header.especie",
    "v_rec.fecha_ingreso >= v_header.fecha_primer_ingreso",
    "v_rec.fecha_ingreso < v_header.fecha_primer_ingreso - 2",
  ]) {
    assert.ok(bloque.includes(cond), `falta la condición: ${cond}`);
  }
  assert.match(bloque, /'resultado', 'fuera_ventana'/);
});

test("vincular 043: solo el límite inferior se salta con `anterior`; el resto de la ventana sigue igual", () => {
  const f = normalizar(cuerpoFuncion("carnes_preliq_vincular"));
  assert.ok(f.includes("OR (NOT v_anterior AND v_rec.fecha_ingreso < v_fecha_ini)"));
  assert.ok(f.includes("OR (v_mueve AND v_header.liquidada_at IS NOT NULL)"), "una liquidada sigue sin mover su fecha");
  assert.ok(f.includes("OR (v_rec.fecha_ingreso::TIMESTAMP AT TIME ZONE 'America/Bogota') > v_fin"), "el tope de ventana sigue");
});

test("vincular 043: NO mueve fecha, ventana ni corte (el UPDATE de cabecera sigue atado a mueve_fecha)", () => {
  const f = normalizar(cuerpoFuncion("carnes_preliq_vincular"));
  assert.ok(
    f.includes(
      "IF v_mueve OR v_header.fecha_primer_ingreso IS NULL THEN UPDATE carnes_preliquidaciones SET fecha_primer_ingreso = v_fecha_ini, ventana_fin = v_fin",
    ),
  );
  assert.doesNotMatch(f, /corte_manual/);
  // Los únicos UPDATE de la cabecera: fecha/ventana (condicionado) y el orden_version.
  const updates = [...f.matchAll(/UPDATE carnes_preliquidaciones SET (.*?) WHERE/g)].map((m) => m[1]);
  assert.equal(updates.length, 2);
  assert.match(updates[1], /^orden_version = orden_version \+ 1$/);
});

test("vincular 043: sin `anterior` el cuerpo es el de 039 salvo los dos puntos del cambio", () => {
  const nueva = normalizar(cuerpoFuncion("carnes_preliq_vincular"));
  const vieja = normalizar(cuerpoFuncion("carnes_preliq_vincular", sql039));
  const sinCambio = nueva
    .replace("v_mueve BOOLEAN; v_anterior BOOLEAN;", "v_mueve BOOLEAN;")
    .replace(/v_anterior := .*?; IF v_anterior AND \(.*?\) THEN RETURN jsonb_build_object\('resultado', 'fuera_ventana'\); END IF; /, "")
    .replace("OR (NOT v_anterior AND v_rec.fecha_ingreso < v_fecha_ini)", "OR v_rec.fecha_ingreso < v_fecha_ini");
  assert.equal(sinCambio, vieja);
});

test("043_rollback: restaura la versión de 039 sin la excepción", () => {
  assert.ok(existsSync(RUTA_ROLLBACK), "falta sql/043_rollback.sql");
  assert.match(rollback, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(rollback, /COMMIT;/);
  assert.equal(
    normalizar(cuerpoFuncion("carnes_preliq_vincular", rollback)),
    normalizar(cuerpoFuncion("carnes_preliq_vincular", sql039)),
  );
  assert.doesNotMatch(rollback, /v_anterior/);
});
