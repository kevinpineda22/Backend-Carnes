import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/044_preliquidacion_oficial_sin_inicial.sql. Como en 039-043: la base no decide
 * reglas nuevas, revalida bajo lock. Las carreras reales se prueban a mano en QA.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "044_preliquidacion_oficial_sin_inicial.sql");
const RUTA_ROLLBACK = join(RAIZ, "sql", "044_rollback.sql");

const limpiar = (t) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = existsSync(RUTA) ? limpiar(readFileSync(RUTA, "utf8")) : "";
const sql040 = limpiar(readFileSync(join(RAIZ, "sql", "040_preliquidacion_rpc_envio.sql"), "utf8"));
const rollback = existsSync(RUTA_ROLLBACK) ? limpiar(readFileSync(RUTA_ROLLBACK, "utf8")) : "";

function cuerpoFuncion(nombre, texto = sql) {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`).exec(texto);
  if (!m) return "";
  const resto = texto.slice(m.index);
  const fin = resto.indexOf("LANGUAGE plpgsql;");
  return fin < 0 ? resto : resto.slice(0, fin + "LANGUAGE plpgsql;".length);
}

const normalizar = (t) => t.replace(/\s+/g, " ").trim();

const GATE_040 =
  "IF NOT EXISTS ( SELECT 1 FROM carnes_siesa_envios e WHERE e.recepcion_id = v_sede.recepcion_id AND e.tipo = 'inicial' AND e.estado = 'ok' ) THEN";
const GATE_044 =
  "IF NOT EXISTS ( SELECT 1 FROM carnes_siesa_envios e WHERE e.recepcion_id = v_sede.recepcion_id AND e.tipo = 'inicial' AND e.estado = 'ok' ) " +
  "AND NOT EXISTS ( SELECT 1 FROM carnes_recepciones r WHERE r.id = v_sede.recepcion_id AND r.inicial_omitida_at IS NOT NULL ) THEN";

test("044: transacción con lock_timeout, guarda de 040 y solo crea las tres funciones esperadas", () => {
  assert.ok(existsSync(RUTA), "falta sql/044_preliquidacion_oficial_sin_inicial.sql");
  assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.match(sql, /proname = 'carnes_preliq_reclamar_sede'/);
  assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((m) => m[1]), [
    "carnes_preliq_omitir_inicial",
    "carnes_siesa_envios_guardar_inicial_omitida",
    "carnes_preliq_reclamar_sede",
  ]);
  assert.doesNotMatch(sql, /CREATE FUNCTION/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
});

test("044: las columnas de auditoría viven en la recepción y son idempotentes", () => {
  assert.match(sql, /ALTER TABLE carnes_recepciones\s+ADD COLUMN IF NOT EXISTS inicial_omitida_at\s+TIMESTAMPTZ,\s+ADD COLUMN IF NOT EXISTS inicial_omitida_por TEXT;/);
});

test("reclamar_sede 044: ninguna otra línea del cuerpo de 040 cambia, solo la compuerta de la inicial", () => {
  const nueva = normalizar(cuerpoFuncion("carnes_preliq_reclamar_sede"));
  const vieja = normalizar(cuerpoFuncion("carnes_preliq_reclamar_sede", sql040));
  assert.ok(nueva && vieja);
  assert.ok(vieja.includes(GATE_040), "la compuerta de 040 cambió de forma: actualice la prueba");
  assert.ok(nueva.includes(GATE_044), "falta la compuerta con inicial_omitida_at");
  assert.equal(nueva.replace(GATE_044, GATE_040), vieja);
});

test("reclamar_sede 044: misma firma y mismos resultados que 040 (el contrato no cambia)", () => {
  const nueva = cuerpoFuncion("carnes_preliq_reclamar_sede");
  const vieja = cuerpoFuncion("carnes_preliq_reclamar_sede", sql040);
  const firma = (f) => normalizar(f.slice(0, f.indexOf("AS $fn$")));
  assert.equal(firma(nueva), firma(vieja));
  const resultados = (f) => [...new Set([...f.matchAll(/'resultado', '(\w+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(resultados(nueva), resultados(vieja));
});

test("omitir_inicial: orden de bloqueo cabecera -> sede -> recepción, todo bajo lock", () => {
  const f = cuerpoFuncion("carnes_preliq_omitir_inicial");
  const cab = f.search(/FROM carnes_preliquidaciones WHERE id = v_pid FOR SHARE/);
  const sede = f.search(/FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE/);
  const rec = f.search(/FROM carnes_recepciones WHERE id = v_sede\.recepcion_id FOR UPDATE/);
  assert.ok(cab > 0 && sede > cab && rec > sede, "cabecera, luego sede, luego recepción");
  assert.ok(f.indexOf("UPDATE carnes_recepciones") > rec, "la marca se escribe después de bloquear la recepción");
});

test("omitir_inicial: rechaza con inicial vigente (enviando/ok/sin_confirmar) o con la oficial ya enviada", () => {
  const f = normalizar(cuerpoFuncion("carnes_preliq_omitir_inicial"));
  assert.ok(f.includes("e.tipo = 'inicial' AND e.estado IN ('enviando', 'ok', 'sin_confirmar')"));
  assert.ok(f.includes("'resultado', 'inicial_vigente'"));
  assert.ok(f.includes("v_sede.estado IN ('enviando', 'enviada', 'sin_confirmar')"));
  assert.ok(f.includes("e.tipo = 'oficial' AND e.estado IN ('enviando', 'ok', 'sin_confirmar')"));
  assert.ok(f.includes("v_sede.recepcion_id = ANY (e.recepcion_ids)"));
  assert.ok(f.includes("'resultado', 'oficial_enviada'"));
  assert.ok(f.includes("v_header.estado <> 'abierta'"));
});

test("omitir_inicial: rechaza las sedes que nunca podrán enviar (anulada o bloqueada) antes de tocar la recepción", () => {
  const raw = cuerpoFuncion("carnes_preliq_omitir_inicial");
  const f = normalizar(raw);
  assert.ok(f.includes("IF v_sede.estado IN ('anulada', 'bloqueada') THEN RETURN jsonb_build_object('resultado', 'sede_no_enviable'"));
  assert.ok(raw.search(/'sede_no_enviable'/) < raw.search(/FROM carnes_recepciones WHERE id = v_sede\.recepcion_id FOR UPDATE/));
});

test("omitir_inicial: idempotente y deja la marca con quién y cuándo", () => {
  const f = normalizar(cuerpoFuncion("carnes_preliq_omitir_inicial"));
  assert.ok(f.includes("IF v_rec.inicial_omitida_at IS NOT NULL THEN v_resultado := 'ya_omitida';"));
  assert.ok(f.includes("SET inicial_omitida_at = now(), inicial_omitida_por = p_por"));
  assert.deepEqual(
    [...new Set([...f.matchAll(/'resultado', '(\w+)'/g)].map((m) => m[1]))].sort(),
    ["inicial_vigente", "no_abierta", "no_encontrada", "oficial_enviada", "sede_no_enviable"],
  );
});

test("omitir_inicial: limpia inicial_pendiente subiendo la versión, y sus avisos sin enviar", () => {
  const f = normalizar(cuerpoFuncion("carnes_preliq_omitir_inicial"));
  assert.ok(
    f.includes(
      "IF v_sede.motivo_pendiente = 'inicial_pendiente' THEN UPDATE carnes_preliquidacion_sedes SET motivo_pendiente = NULL, version = version + 1 WHERE id = p_sede_id;",
    ),
  );
  assert.ok(
    f.includes("DELETE FROM carnes_preliquidacion_alertas WHERE sede_id = p_sede_id AND evento = 'inicial_pendiente' AND enviado_ok = false;"),
  );
});

test("trigger: bloquea todo INSERT de tipo inicial para una recepción omitida, serializado con FOR SHARE", () => {
  const f = normalizar(cuerpoFuncion("carnes_siesa_envios_guardar_inicial_omitida"));
  assert.ok(f.includes("NEW.tipo = 'inicial'"));
  assert.ok(f.includes("FROM carnes_recepciones WHERE id = NEW.recepcion_id FOR SHARE"), "sin filtro por la marca: espera la omisión en curso");
  assert.ok(f.includes("IF v_omitida IS NOT NULL THEN RAISE EXCEPTION 'inicial_omitida:"));
  assert.ok(f.includes("ERRCODE = 'CA044'"));
  assert.match(sql, /DROP TRIGGER IF EXISTS carnes_siesa_envios_inicial_omitida ON carnes_siesa_envios;/);
  assert.match(
    normalizar(sql),
    /CREATE TRIGGER carnes_siesa_envios_inicial_omitida BEFORE INSERT ON carnes_siesa_envios FOR EACH ROW EXECUTE FUNCTION carnes_siesa_envios_guardar_inicial_omitida\(\);/,
  );
});

test("044_rollback: restaura reclamar_sede de 040 y retira trigger, funciones y columnas", () => {
  assert.ok(existsSync(RUTA_ROLLBACK), "falta sql/044_rollback.sql");
  assert.match(rollback, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(rollback, /COMMIT;/);
  assert.equal(
    normalizar(cuerpoFuncion("carnes_preliq_reclamar_sede", rollback)),
    normalizar(cuerpoFuncion("carnes_preliq_reclamar_sede", sql040)),
  );
  assert.doesNotMatch(rollback, /inicial_omitida_at IS NOT NULL/);
  assert.match(rollback, /DROP TRIGGER IF EXISTS carnes_siesa_envios_inicial_omitida ON carnes_siesa_envios;/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS carnes_siesa_envios_guardar_inicial_omitida\(\);/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS carnes_preliq_omitir_inicial\(BIGINT, TEXT\);/);
  assert.match(rollback, /DROP COLUMN IF EXISTS inicial_omitida_at,\s+DROP COLUMN IF EXISTS inicial_omitida_por;/);
});
