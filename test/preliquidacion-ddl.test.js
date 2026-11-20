import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/038_preliquidacion.sql: no ejecuta nada contra una base.
 * Verifica orden de creación seguro para FKs, que la migración sea solo aditiva e
 * idempotente, y que estén todas las tablas, columnas y CHECKs del diseño. La
 * aplicación real la cubre test/sql/038_check.sql (manual, solo en QA).
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "038_preliquidacion.sql");

const crudo = existsSync(RUTA) ? readFileSync(RUTA, "utf8") : "";
// Sin comentarios de línea: las reglas se evalúan sobre el SQL ejecutable.
const sql = crudo
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const ORDEN_TABLAS = [
  "carnes_preliquidacion_config",
  "carnes_preliquidacion_corridas",
  "carnes_preliquidaciones",
  "carnes_preliquidacion_gastos",
  "carnes_preliquidacion_retomas",
  "carnes_preliquidacion_alternas",
  "carnes_preliquidacion_sedes",
  "carnes_preliquidacion_saldos",
  "carnes_preliquidacion_alertas",
];

/** Cuerpo de `CREATE TABLE IF NOT EXISTS <tabla> ( ... );` */
function cuerpoTabla(tabla) {
  const inicio = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tabla} (`);
  if (inicio < 0) return "";
  const fin = sql.indexOf("\n);", inicio);
  return sql.slice(inicio, fin + 3);
}

test("el archivo existe y corre dentro de una transacción", () => {
  assert.ok(existsSync(RUTA), "falta sql/038_preliquidacion.sql");
  assert.match(sql, /^\s*BEGIN;/m);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.ok(sql.indexOf("BEGIN;") < sql.indexOf("COMMIT;"));
});

test("las tablas se crean en orden seguro para las FK (T6)", () => {
  const posiciones = ORDEN_TABLAS.map((t) => sql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`));
  posiciones.forEach((p, i) => assert.ok(p >= 0, `falta la tabla ${ORDEN_TABLAS[i]}`));
  for (let i = 1; i < posiciones.length; i++) {
    assert.ok(posiciones[i] > posiciones[i - 1], `${ORDEN_TABLAS[i]} debe crearse después de ${ORDEN_TABLAS[i - 1]}`);
  }
  // El ALTER de carnes_recepciones es lo último: apunta a carnes_preliquidaciones.
  const alter = sql.indexOf("ALTER TABLE carnes_recepciones");
  assert.ok(alter > posiciones.at(-1), "ALTER carnes_recepciones debe ir después de la última tabla");
});

test("cada tabla solo referencia tablas que ya existen en ese punto", () => {
  const creadas = new Set([
    "carnes_recepciones",
    "carnes_siesa_envios",
    "carnes_viceras_items",
    "carnes_sedes",
  ]);
  for (const tabla of ORDEN_TABLAS) {
    const cuerpo = cuerpoTabla(tabla);
    const refs = [...cuerpo.matchAll(/REFERENCES\s+(\w+)/g)].map((m) => m[1]);
    for (const ref of refs) {
      assert.ok(creadas.has(ref) || ref === tabla, `${tabla} referencia ${ref} antes de crearla`);
    }
    creadas.add(tabla);
  }
});

test("la migración es solo aditiva e idempotente", () => {
  assert.doesNotMatch(sql, /\bDROP\b/i, "no se permite ningún DROP");
  assert.doesNotMatch(sql, /\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN/i, "no se altera ninguna columna existente");
  assert.doesNotMatch(sql, /RENAME/i);
  // Todo CREATE usa IF NOT EXISTS.
  for (const m of sql.matchAll(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF NOT EXISTS)/gi)) {
    assert.fail(`CREATE sin IF NOT EXISTS: ${m[0]}`);
  }
  // Toda columna agregada a una tabla existente usa IF NOT EXISTS.
  for (const m of sql.matchAll(/ADD\s+COLUMN\s+(?!IF NOT EXISTS)/gi)) {
    assert.fail(`ADD COLUMN sin IF NOT EXISTS: ${m[0]}`);
  }
  // Lo único que se toca de las tablas existentes es carnes_recepciones.
  const altered = [...sql.matchAll(/ALTER\s+TABLE\s+(\w+)/gi)].map((m) => m[1]);
  for (const t of altered) assert.equal(t, "carnes_recepciones");
});

const COLUMNAS = {
  carnes_preliquidacion_config: ["especie", "servicio_por_animal", "ventana_dias"],
  carnes_preliquidacion_corridas: [
    "origen", "gh_run_id", "estado", "preliquidacion_ids", "iniciada_at", "terminada_at", "dry_run", "resumen", "error",
  ],
  carnes_preliquidaciones: [
    "especie", "animales", "animal_en_pie", "servicio", "servicio_at", "servicio_precorte", "servicio_precorte_at",
    "servicio_por_animal", "tercero_id", "estado", "fecha_primer_ingreso", "ventana_fin", "liquidada_at",
    "servicio_aplicado", "gasto_total_aplicado", "costo_por_animal", "version", "orden_version", "aviso_ventana_at",
    "cerrada_at", "monto_no_asignado", "anulada_at", "anulada_por", "motivo_anulacion", "creado_por",
    "created_at", "updated_at",
  ],
  carnes_preliquidacion_gastos: ["preliquidacion_id", "concepto", "valor", "signo"],
  carnes_preliquidacion_retomas: ["preliquidacion_id", "nombre", "unidad", "precio_catalogo", "precio", "kilos"],
  carnes_preliquidacion_alternas: [
    "preliquidacion_id", "servicio_real", "servicio_at", "servicio_aplicado", "por_sede", "diferencia", "created_at",
  ],
  carnes_preliquidacion_sedes: [
    "preliquidacion_id", "recepcion_id", "animales", "orden", "estado", "motivo_bloqueo", "detalle_bloqueo",
    "liberada_at", "motivo_pendiente", "requiere_correccion", "gasto_sede", "utilidad", "servicio_compra",
    "valor_viceras", "valor_retomas", "costeo", "envio_id", "claim_token", "claimed_at", "calculado_at", "version",
    "costeo_orden_version", "costeo_animales", "claim_costeo_orden_version", "correccion_orden_version", "intentos",
    "ultimo_intento_at", "error_tipo", "ultima_corrida",
  ],
  carnes_preliquidacion_saldos: [
    "origen_preliquidacion_id", "especie", "valor", "destino_preliquidacion_id", "estado", "ajuste_de_saldo_id",
    "movido_a_saldo_id", "alterna_id", "editado_por",
  ],
  carnes_preliquidacion_alertas: [
    "evento", "preliquidacion_id", "sede_id", "ocurrencia", "detalle", "enviado_ok", "intentos_envio", "reclamada_at",
    "enviado_at", "created_at",
  ],
};

for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
  test(`${tabla}: trae todas las columnas del diseño`, () => {
    const cuerpo = cuerpoTabla(tabla);
    assert.ok(cuerpo, `falta la tabla ${tabla}`);
    for (const c of columnas) {
      assert.match(cuerpo, new RegExp(`^\\s+${c}\\s`, "m"), `${tabla}.${c}`);
    }
  });
}

test("columnas de M2 en las sedes (claim_costeo_orden_version, correccion_orden_version)", () => {
  const sedes = cuerpoTabla("carnes_preliquidacion_sedes");
  assert.match(sedes, /claim_costeo_orden_version\s+INTEGER/);
  assert.match(sedes, /correccion_orden_version\s+INTEGER/);
});

test("CHECKs de estados de preliquidaciones, sedes, saldos, corridas y alertas", () => {
  assert.match(cuerpoTabla("carnes_preliquidaciones"), /estado\s+VARCHAR\(\d+\)\s+NOT NULL[^,]*CHECK \(estado IN \('abierta', 'cerrada', 'anulada'\)\)/s);
  const sedes = cuerpoTabla("carnes_preliquidacion_sedes");
  for (const e of [
    "vinculada", "bloqueada", "lista_para_enviar", "calculada", "enviando", "enviada", "error", "sin_confirmar",
    "anulada", "simulada",
  ]) {
    assert.ok(sedes.includes(`'${e}'`), `estado de sede ${e}`);
  }
  for (const m of ["excede_animales", "utilidad_negativa", "costeo_invalido", "armado_invalido", "servicio_cero"]) {
    assert.ok(sedes.includes(`'${m}'`), `motivo_bloqueo ${m}`);
  }
  for (const m of ["inicial_pendiente", "reintentos_agotados", "transitorio", "permanente"]) {
    assert.ok(sedes.includes(`'${m}'`), m);
  }
  const saldos = cuerpoTabla("carnes_preliquidacion_saldos");
  for (const e of ["pendiente", "aplicado", "movido", "descartado"]) assert.ok(saldos.includes(`'${e}'`), e);
  const corridas = cuerpoTabla("carnes_preliquidacion_corridas");
  for (const o of ["schedule", "sweep", "dispatch", "admin", "inmediato", "en_curso", "ok", "error"]) {
    assert.ok(corridas.includes(`'${o}'`), o);
  }
});

test("restricciones de integridad: unicidades, FKs y valores por defecto", () => {
  assert.match(cuerpoTabla("carnes_preliquidacion_sedes"), /recepcion_id\s+BIGINT\s+NOT NULL\s+UNIQUE\s+REFERENCES carnes_recepciones\(id\)/);
  assert.match(cuerpoTabla("carnes_preliquidacion_sedes"), /REFERENCES carnes_preliquidacion_corridas\(id\)/);
  assert.match(cuerpoTabla("carnes_preliquidacion_sedes"), /REFERENCES carnes_siesa_envios\(id\)/);
  assert.match(cuerpoTabla("carnes_preliquidacion_alternas"), /UNIQUE \(preliquidacion_id, servicio_at\)/);
  assert.match(cuerpoTabla("carnes_preliquidacion_alertas"), /UNIQUE \(evento, preliquidacion_id, sede_id, ocurrencia\)/);
  assert.match(cuerpoTabla("carnes_preliquidacion_alertas"), /preliquidacion_id\s+BIGINT\s+NOT NULL DEFAULT 0/);
  assert.match(cuerpoTabla("carnes_preliquidacion_config"), /ventana_dias\s+INTEGER\s+NOT NULL DEFAULT 2/);
  assert.match(cuerpoTabla("carnes_preliquidacion_config"), /servicio_por_animal\s+NUMERIC\(14,2\)\s+NOT NULL DEFAULT 0/);
  assert.match(cuerpoTabla("carnes_preliquidaciones"), /version\s+INTEGER\s+NOT NULL DEFAULT 0/);
  assert.match(cuerpoTabla("carnes_preliquidaciones"), /orden_version\s+INTEGER\s+NOT NULL DEFAULT 0/);
});

test("índice único parcial: a lo sumo una preliquidación sin iniciar por especie", () => {
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_preliquidaciones_sin_iniciar\s+ON carnes_preliquidaciones \(especie\)\s+WHERE estado = 'abierta' AND fecha_primer_ingreso IS NULL/,
  );
});

test("carnes_recepciones: preliquidacion_id con ON DELETE RESTRICT y los dos CHECKs del diseño", () => {
  assert.match(
    sql,
    /ALTER TABLE carnes_recepciones\s+ADD COLUMN IF NOT EXISTS preliquidacion_id BIGINT\s+REFERENCES carnes_preliquidaciones\(id\) ON DELETE RESTRICT/,
  );
  // Exclusión mutua con la liquidación legada.
  assert.match(sql, /NOT \(liquidacion_id IS NOT NULL AND preliquidacion_id IS NOT NULL\)/);
  // novillos entero > 0 solo para recepciones vinculadas: las filas legadas con 0 no se tocan.
  assert.match(sql, /preliquidacion_id IS NULL OR \(novillos > 0 AND novillos = trunc\(novillos\)\)/);
  // La columna novillos NO cambia de tipo.
  assert.doesNotMatch(sql, /novillos\s+(INTEGER|INT)\b/i);
});

test("los CHECKs sobre carnes_recepciones son idempotentes (DO + pg_constraint)", () => {
  assert.match(sql, /pg_constraint/);
  assert.match(sql, /ck_carnes_recepciones_liq_xor_preliq/);
  assert.match(sql, /ck_carnes_recepciones_preliq_novillos/);
});

test("triggers updated_at para las tablas con esa columna", () => {
  for (const t of [
    "carnes_preliquidacion_config",
    "carnes_preliquidaciones",
    "carnes_preliquidacion_gastos",
    "carnes_preliquidacion_retomas",
    "carnes_preliquidacion_sedes",
    "carnes_preliquidacion_saldos",
  ]) {
    assert.ok(sql.includes(`'${t}'`), `trigger updated_at para ${t}`);
  }
  assert.match(sql, /carnes_set_updated_at\(\)/);
});

test("sin fórmulas de negocio ni inserciones de datos distintas de la configuración inicial", () => {
  const inserts = [...sql.matchAll(/INSERT\s+INTO\s+(\w+)/gi)].map((m) => m[1]);
  for (const t of inserts) assert.equal(t, "carnes_preliquidacion_config");
});

test("existe el script manual de verificación en test/sql", () => {
  assert.ok(existsSync(join(RAIZ, "test", "sql", "038_check.sql")));
});
