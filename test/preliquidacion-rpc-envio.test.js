import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/040_preliquidacion_rpc_envio.sql (RPC de envío a SIESA).
 * Como en 039: persistencia fina, sin fórmulas de negocio. Las carreras reales (dos
 * reclamos concurrentes, guarda de costeo obsoleto) las cubre el script manual
 * test/sql/040_rpc_envio.sql en el proyecto de QA.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "040_preliquidacion_rpc_envio.sql");
const RUTA_039 = join(RAIZ, "sql", "039_preliquidacion_rpc.sql");

const limpiar = (t) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = existsSync(RUTA) ? limpiar(readFileSync(RUTA, "utf8")) : "";
const s039 = limpiar(readFileSync(RUTA_039, "utf8"));

function cuerpoFuncion(nombre, texto = sql) {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`).exec(texto);
  if (!m) return "";
  const resto = texto.slice(m.index + 1);
  const sig = resto.search(/CREATE OR REPLACE FUNCTION/);
  return sig < 0 ? texto.slice(m.index) : texto.slice(m.index, m.index + 1 + sig);
}

const FUNCIONES = {
  carnes_preliq_reclamar_sede: {
    parametros: ["p_sede_id", "p_sede_version", "p_desde", "p_token", "p_corrida_id", "p_origen", "p_reset_intentos"],
    codigos: [
      "ok", "corrida_requerida", "origen_invalido", "desde_invalido", "no_encontrada", "no_reclamada",
      "costeo_desactualizado", "inicial_pendiente", "no_abierta",
    ],
  },
  carnes_preliq_cerrar_envio: {
    parametros: ["p_sede_id", "p_token", "p_plan"],
    codigos: ["ok", "token_invalido", "no_encontrada", "hacia_invalido", "recepcion_estado_invalido"],
  },
  carnes_preliq_sincronizar_envio: {
    parametros: ["p_envio_id", "p_sede_version", "p_desde", "p_hacia", "p_campos"],
    codigos: ["sin_sede"],
  },
  carnes_preliq_cerrar: {
    parametros: ["p_id", "p_orden_version", "p_monto_no_asignado"],
    codigos: ["ok", "no_encontrada", "no_abierta", "no_liquidada", "version_cambiada", "monto_invalido", "no_cerrable"],
  },
  carnes_preliq_transicionar_sede: {
    parametros: ["p_sede_id", "p_sede_version", "p_desde", "p_hacia", "p_campos"],
    codigos: ["ok", "version_cambiada", "no_encontrada", "recepcion_estado_invalido"],
  },
};

test("el archivo 040 existe, es una transacción con lock_timeout y todo es CREATE OR REPLACE", () => {
  assert.ok(existsSync(RUTA), "falta sql/040_preliquidacion_rpc_envio.sql");
  assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.doesNotMatch(sql, /CREATE FUNCTION/);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i, "las RPC son SECURITY INVOKER");
  assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE/i, "040 no cambia el esquema: solo funciones");
});

test("040 exige que 039 ya esté aplicada", () => {
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

test("reclamar_sede: p_corrida_id NULL se rechaza antes de tocar nada (R14)", () => {
  const f = cuerpoFuncion("carnes_preliq_reclamar_sede");
  assert.match(f, /IF p_corrida_id IS NULL THEN\s*RETURN jsonb_build_object\('resultado', 'corrida_requerida'\)/);
  assert.ok(f.indexOf("'corrida_requerida'") < f.indexOf("SELECT preliquidacion_id"));
});

test("reclamar_sede: FOR SHARE en la cabecera, FOR UPDATE en la sede y CAS por estado y versión", () => {
  const f = cuerpoFuncion("carnes_preliq_reclamar_sede");
  assert.match(f, /FROM carnes_preliquidaciones WHERE id = v_pid FOR SHARE/);
  assert.match(f, /FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE/);
  assert.ok(f.indexOf("FOR SHARE") < f.indexOf("FOR UPDATE"), "orden de bloqueo: cabecera -> sede");
  assert.match(f, /v_sede\.estado <> p_desde OR v_sede\.version <> p_sede_version/);
});

test("reclamar_sede (JD S2): con la cabecera no abierta devuelve no_abierta, bajo el lock y antes de reclamar", () => {
  const f = cuerpoFuncion("carnes_preliq_reclamar_sede");
  assert.match(f, /IF v_header\.estado <> 'abierta' THEN\s*RETURN jsonb_build_object\('resultado', 'no_abierta'\)/);
  assert.ok(f.indexOf("FOR SHARE") < f.indexOf("'no_abierta'"), "se evalúa tras tomar el lock de la cabecera");
  assert.ok(f.indexOf("'no_abierta'") < f.indexOf("SET estado = 'enviando'"), "antes de escribir el reclamo");
});

test("cerrar (JD S2): bajo el lock revalida que ninguna sede esté pendiente o en vuelo y devuelve no_cerrable", () => {
  const f = cuerpoFuncion("carnes_preliq_cerrar");
  assert.match(f, /FROM carnes_preliquidacion_sedes/);
  for (const e of ["vinculada", "calculada", "lista_para_enviar", "error", "simulada", "anulada", "enviando", "sin_confirmar"]) {
    assert.ok(f.includes(`'${e}'`), `no_cerrable debe considerar ${e}`);
  }
  assert.match(f, /RETURN jsonb_build_object\('resultado', 'no_cerrable'\)/);
  assert.ok(f.indexOf("FOR UPDATE") < f.indexOf("'no_cerrable'"), "tras el lock de la cabecera");
  assert.ok(f.indexOf("'no_cerrable'") < f.indexOf("estado = 'cerrada'"), "antes de cerrar");
});

test("reclamar_sede: guarda de costeo obsoleto con las tres condiciones (T2)", () => {
  const f = cuerpoFuncion("carnes_preliq_reclamar_sede");
  assert.match(f, /v_sede\.gasto_sede IS NULL/);
  assert.match(f, /v_sede\.costeo_orden_version IS DISTINCT FROM v_header\.orden_version/);
  assert.match(f, /v_sede\.costeo_animales IS DISTINCT FROM v_sede\.animales/);
  // La guarda va antes de la compuerta de la inicial y antes de escribir el reclamo.
  assert.ok(f.indexOf("'costeo_desactualizado'") < f.indexOf("'inicial_pendiente'"));
  assert.ok(f.indexOf("'inicial_pendiente'") < f.indexOf("claim_token = p_token"));
});

test("reclamar_sede: compuerta de la inicial marca inicial_pendiente una sola vez", () => {
  const f = cuerpoFuncion("carnes_preliq_reclamar_sede");
  assert.match(f, /e\.tipo = 'inicial' AND e\.estado = 'ok'/);
  assert.match(f, /IF v_sede\.motivo_pendiente IS DISTINCT FROM 'inicial_pendiente' THEN/);
  assert.match(f, /SET motivo_pendiente = 'inicial_pendiente', version = version \+ 1/);
});

test("reclamar_sede (M2): guarda claim_costeo_orden_version y escribe el reclamo completo", () => {
  const f = cuerpoFuncion("carnes_preliq_reclamar_sede");
  assert.match(f, /claim_costeo_orden_version = v_sede\.costeo_orden_version/);
  for (const col of ["estado = 'enviando'", "claim_token = p_token", "claimed_at = now()", "ultima_corrida = p_corrida_id", "ultimo_intento_at = now()"]) {
    assert.ok(f.includes(col), col);
  }
  assert.match(f, /COALESCE\(p_reset_intentos, false\) THEN 0 ELSE v_sede\.intentos END \+ 1/);
  assert.match(f, /error_tipo = CASE WHEN COALESCE\(p_reset_intentos, false\) THEN NULL/);
});

test("cerrar_envio: exige estado enviando y el token del reclamo", () => {
  const f = cuerpoFuncion("carnes_preliq_cerrar_envio");
  assert.match(f, /FOR UPDATE/);
  assert.match(f, /v_sede\.estado <> 'enviando' OR p_token IS NULL OR v_sede\.claim_token IS DISTINCT FROM p_token/);
  assert.match(f, /version\s*=\s*v_nueva/);
});

test("cerrar_envio: solo destinos y columnas permitidos, libera el reclamo al salir de enviando", () => {
  const f = cuerpoFuncion("carnes_preliq_cerrar_envio");
  assert.match(f, /NOT IN \('enviada', 'enviando', 'sin_confirmar', 'error', 'bloqueada'\)/);
  assert.match(f, /claim_token = CASE WHEN v_hacia = 'enviando' THEN claim_token ELSE NULL END/);
  assert.match(f, /claimed_at = CASE WHEN v_hacia = 'enviando' THEN claimed_at ELSE NULL END/);
  for (const c of ["envio_id", "error_tipo", "intentos", "motivo_pendiente", "motivo_bloqueo", "requiere_correccion", "correccion_orden_version"]) {
    assert.ok(f.includes(`'${c}'`), `columna permitida ${c}`);
  }
  assert.match(f, /NOT IN \('Costeado', 'Enviado_SIESA'\)/);
});

test("sincronizar_envio: no-op sin sede y reutiliza el CAS de transicionar_sede", () => {
  const f = cuerpoFuncion("carnes_preliq_sincronizar_envio");
  assert.match(f, /WHERE envio_id = p_envio_id/);
  assert.match(f, /RETURN carnes_preliq_transicionar_sede\(v_sede_id, p_sede_version, p_desde, p_hacia, p_campos\)/);
});

test("cerrar: cabecera FOR UPDATE, abierta y liquidada, valida orden_version y guarda monto_no_asignado", () => {
  const f = cuerpoFuncion("carnes_preliq_cerrar");
  assert.match(f, /FOR UPDATE/);
  assert.match(f, /v_header\.estado <> 'abierta'/);
  assert.match(f, /v_header\.liquidada_at IS NULL/);
  assert.match(f, /v_header\.orden_version <> p_orden_version/);
  assert.match(f, /estado = 'cerrada'/);
  assert.match(f, /cerrada_at = now\(\)/);
  assert.match(f, /monto_no_asignado = p_monto_no_asignado/);
});

test("transicionar_sede de 040: misma firma que 039 y whitelist ampliada con M1/M2", () => {
  const nueva = cuerpoFuncion("carnes_preliq_transicionar_sede");
  const vieja = cuerpoFuncion("carnes_preliq_transicionar_sede", s039);
  const firma = (c) => /\(([^)]*)\)/.exec(c)[1].replace(/\s+/g, " ").trim();
  assert.equal(firma(nueva), firma(vieja));
  for (const c of ["correccion_orden_version", "claim_costeo_orden_version", "claim_token", "claimed_at"]) {
    assert.ok(nueva.includes(`'${c}'`), `040 debe permitir ${c}`);
    assert.ok(!vieja.includes(`'${c}'`), `039 no la permitía: ${c}`);
  }
  // Todo lo que permitía 039 sigue permitido.
  for (const c of ["motivo_bloqueo", "detalle_bloqueo", "liberada_at", "motivo_pendiente", "requiere_correccion", "error_tipo", "intentos", "envio_id", "recepcion_estado"]) {
    assert.ok(nueva.includes(`'${c}'`) || nueva.includes(`>'${c}'`), `se perdió ${c}`);
  }
});

test("M2: transicionar_sede, cerrar_envio y reclamar_sede conservan el aviso requiere_correccion mientras el flag siga activo", () => {
  for (const n of ["carnes_preliq_transicionar_sede", "carnes_preliq_cerrar_envio", "carnes_preliq_reclamar_sede"]) {
    assert.match(cuerpoFuncion(n), /AND NOT \(evento = 'requiere_correccion' AND (?:v_requiere|v_sede\.requiere_correccion)\)/, n);
  }
});

test("M2 (carrera): cerrar_envio no pisa un aviso levantado durante el envío (compare-and-set sobre correccion_orden_version)", () => {
  const cuerpo = cuerpoFuncion("carnes_preliq_cerrar_envio");
  assert.match(cuerpo, /p_plan \? 'correccion_orden_version_esperada'/);
  assert.match(cuerpo, /v_sede\.correccion_orden_version IS DISTINCT FROM NULLIF\(p_plan->>'correccion_orden_version_esperada', ''\)::INTEGER/);
  assert.match(cuerpo, /v_campos \? 'requiere_correccion' AND NOT v_conserva/);
  assert.match(cuerpo, /v_campos \? 'correccion_orden_version' AND NOT v_conserva/);
  const manual = readFileSync(join(RAIZ, "test", "sql", "040_rpc_envio.sql"), "utf8");
  assert.match(manual, /correccion_orden_version_esperada/, "el script manual ejercita la carrera");
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
  ];
  for (const re of prohibido) assert.doesNotMatch(sql, re, `fórmula de negocio prohibida: ${re}`);
});

test("existe el script manual de 040 en test/sql, envuelto en BEGIN ... ROLLBACK", () => {
  const ruta = join(RAIZ, "test", "sql", "040_rpc_envio.sql");
  assert.ok(existsSync(ruta), "falta test/sql/040_rpc_envio.sql");
  const t = limpiar(readFileSync(ruta, "utf8"));
  assert.match(t, /^\s*BEGIN;/m);
  assert.match(t, /^\s*ROLLBACK;/m);
  assert.doesNotMatch(t, /^\s*COMMIT;/m);
  for (const f of ["carnes_preliq_reclamar_sede", "carnes_preliq_cerrar_envio", "carnes_preliq_sincronizar_envio", "carnes_preliq_cerrar", "carnes_preliq_transicionar_sede"]) {
    assert.ok(t.includes(f), `el script no ejercita ${f}`);
  }
});
