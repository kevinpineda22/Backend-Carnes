import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Prueba ESTÁTICA de sql/039_preliquidacion_rpc.sql. Las RPC son persistencia fina:
 * bloquean, validan versiones y escriben el plan que calcula JS. Aquí se verifica
 * que existan, que declaren sus códigos de resultado y que NO contengan fórmulas
 * de negocio. El comportamiento real (carreras, locks) lo cubren los scripts
 * manuales test/sql/039*.sql en el proyecto de QA.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUTA = join(RAIZ, "sql", "039_preliquidacion_rpc.sql");

const crudo = existsSync(RUTA) ? readFileSync(RUTA, "utf8") : "";
const sql = crudo
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

/** Cuerpo de una función: desde su CREATE hasta el siguiente CREATE o el final. */
function cuerpoFuncion(nombre) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`);
  const m = re.exec(sql);
  if (!m) return "";
  const resto = sql.slice(m.index + 1);
  const sig = resto.search(/CREATE OR REPLACE FUNCTION/);
  return sig < 0 ? sql.slice(m.index) : sql.slice(m.index, m.index + 1 + sig);
}

/** Conjunto A (tarea 1.15a). */
const CONJUNTO_A = {
  carnes_preliq_crear: {
    parametros: ["p_especie", "p_datos"],
    codigos: ["ok", "abierta_en_curso", "config_servicio_cero", "datos_invalidos"],
  },
  carnes_preliq_vincular: {
    parametros: ["p_recepcion_id", "p_preliquidacion_id", "p_orden_version", "p_plan"],
    codigos: [
      "vinculada", "excede", "sin_preliquidacion", "sin_recepcion", "fuera_ventana", "ya_vinculada", "oficial_legacy",
      "version_cambiada", "novillos_invalido",
    ],
  },
  carnes_preliq_desvincular: {
    parametros: ["p_sede_id", "p_orden_version", "p_plan"],
    codigos: ["ok", "no_vinculada", "sede_enviada", "version_cambiada"],
  },
  carnes_preliq_actualizar_novillos: {
    parametros: ["p_recepcion_id", "p_novillos", "p_orden_version", "p_plan"],
    codigos: ["ok", "no_vinculada", "sede_no_editable", "invalido", "excede", "version_cambiada"],
  },
};

test("el archivo 039 existe, es una transacción y todo es CREATE OR REPLACE", () => {
  assert.ok(existsSync(RUTA), "falta sql/039_preliquidacion_rpc.sql");
  assert.match(sql, /^\s*BEGIN;/m);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.doesNotMatch(sql, /CREATE FUNCTION/);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i, "las RPC son SECURITY INVOKER");
});

for (const [nombre, def] of Object.entries(CONJUNTO_A)) {
  test(`${nombre}: existe con sus parámetros y devuelve JSONB`, () => {
    const cuerpo = cuerpoFuncion(nombre);
    assert.ok(cuerpo, `falta la función ${nombre}`);
    for (const p of def.parametros) assert.ok(cuerpo.includes(p), `${nombre} sin parámetro ${p}`);
    assert.match(cuerpo, /RETURNS JSONB/);
    assert.match(cuerpo, /LANGUAGE plpgsql/);
  });

  test(`${nombre}: declara todos sus códigos de resultado`, () => {
    const cuerpo = cuerpoFuncion(nombre);
    for (const c of def.codigos) {
      assert.ok(cuerpo.includes(`'${c}'`), `${nombre} no devuelve '${c}'`);
    }
  });
}

test("crear: bajo advisory lock por especie, rechaza servicio 0 y otra abierta en curso", () => {
  const f = cuerpoFuncion("carnes_preliq_crear");
  assert.match(f, /pg_advisory_xact_lock\(hashtext\('preliq:' \|\| p_especie\)\)/);
  assert.match(f, /ventana_fin IS NULL OR .*ventana_fin >= now\(\)/s);
  assert.match(f, /servicio_por_animal/);
  // Adjunta los saldos que esperaban una preliquidación de la misma especie.
  assert.match(f, /UPDATE carnes_preliquidacion_saldos/);
  assert.match(f, /destino_preliquidacion_id IS NULL/);
});

test("vincular / desvincular / actualizar_novillos: lock FOR UPDATE y versión de orden", () => {
  for (const nombre of ["carnes_preliq_vincular", "carnes_preliq_desvincular", "carnes_preliq_actualizar_novillos"]) {
    const f = cuerpoFuncion(nombre);
    assert.match(f, /FOR UPDATE/, `${nombre} sin FOR UPDATE`);
    assert.match(f, /orden_version\s*<>\s*p_orden_version/, `${nombre} no valida orden_version`);
    assert.match(f, /orden_version\s*=\s*orden_version \+ 1/, `${nombre} no incrementa orden_version`);
  }
});

test("vincular: rechaza oficial legada y reordenar sedes que no están vinculadas", () => {
  const f = cuerpoFuncion("carnes_preliq_vincular");
  assert.match(f, /recepcion_ids/);
  assert.match(f, /tipo = 'oficial'/);
  assert.match(f, /liquidacion_id IS NOT NULL/);
  // El plan solo puede mover sedes vinculada: lo valida el ayudante antes de escribir.
  assert.match(f, /carnes_preliq_validar_plan_sedes/);
  assert.match(cuerpoFuncion("carnes_preliq_validar_plan_sedes"), /estado = 'vinculada'/);
});

test("M4: desvincular recibe p_plan y libera las sedes que ahora caben", () => {
  const f = cuerpoFuncion("carnes_preliq_desvincular");
  assert.match(f, /p_plan/);
  assert.match(f, /carnes_preliq_aplicar_plan_sedes\(v_pid, p_plan\)/);
  assert.match(cuerpoFuncion("carnes_preliq_aplicar_plan_sedes"), /p_plan->'liberadas'/);
  assert.match(f, /carnes_preliq_aplicar_plan_sedes/);
  assert.match(cuerpoFuncion("carnes_preliq_aplicar_plan_sedes"), /liberada_at\s*=\s*now\(\)/);
  // Una sede enviada no se desvincula.
  assert.match(f, /'enviando', 'enviada', 'sin_confirmar'/);
});

test("actualizar_novillos (I3) edita sedes aún no enviadas y rechaza las enviadas", () => {
  const f = cuerpoFuncion("carnes_preliq_actualizar_novillos");
  const m = /v_sede\.estado\s+NOT\s+IN\s*\(([^)]*)\)/.exec(f);
  assert.ok(m, "falta la lista de estados editables");
  const editables = m[1].split(",").map((e) => e.trim().replace(/'/g, "")).sort();
  assert.deepEqual(editables, ["bloqueada", "calculada", "error", "lista_para_enviar", "simulada", "vinculada"]);
  for (const enviado of ["enviando", "enviada", "sin_confirmar", "anulada"]) {
    assert.ok(!editables.includes(enviado), enviado + " no debe ser editable");
  }
  assert.match(f, /'sede_no_editable'/);
});

test("actualizar_novillos no toca costeo_animales: el desfase marca la sede para recostear (I3)", () => {
  const f = cuerpoFuncion("carnes_preliq_actualizar_novillos");
  assert.doesNotMatch(f, /costeo_animales/);
  assert.doesNotMatch(f, /costeo_orden_version/);
  assert.match(f, /SET animales\s*=/);
  assert.match(f, /orden_version\s*=\s*orden_version\s*\+\s*1/);
});

test("las RPC convierten violaciones de CHECK en códigos, no en excepciones crudas", () => {
  assert.match(cuerpoFuncion("carnes_preliq_vincular"), /WHEN check_violation/);
  assert.match(cuerpoFuncion("carnes_preliq_crear"), /WHEN check_violation/);
});

test("sin fórmulas de negocio en plpgsql (R8: las decisiones viven en JS)", () => {
  const prohibido = [
    /\bround\s*\(/i,
    /\bsum\s*\(/i,
    /servicio_por_animal\s*\*/i,
    /\*\s*servicio_por_animal/i,
    /animal_en_pie\s*\+/i,
    /gasto_total_aplicado\s*[-+*/]/i,
    /utilidad\s*[-+*/]/i,
    /\bgasto_sede\s*[-+*/]/i,
  ];
  for (const re of prohibido) {
    assert.doesNotMatch(sql, re, `fórmula de negocio prohibida: ${re}`);
  }
});

test("existe el script manual de carreras de 039 set A en test/sql", () => {
  assert.ok(existsSync(join(RAIZ, "test", "sql", "039a_rpc_vinculacion.sql")));
});

// ═══ Conjunto B (tarea 1.15b) ═══════════════════════════════════════════════

const CONJUNTO_B = {
  carnes_preliq_actualizar_servicio: {
    parametros: ["p_id", "p_servicio", "p_por", "p_fecha_primer_ingreso", "p_corte", "p_desbloqueo"],
    codigos: ["ok", "tardio", "version_cambiada", "no_encontrada", "servicio_invalido"],
  },
  carnes_preliq_liquidar: {
    parametros: ["p_id", "p_version", "p_corte", "p_plan"],
    codigos: ["ok", "ya_liquidada", "antes_del_corte", "version_cambiada", "no_encontrada", "no_liquidable"],
  },
  carnes_preliq_congelar_sede: {
    parametros: ["p_sede_id", "p_sede_version", "p_orden_version", "p_plan"],
    codigos: ["ok", "version_cambiada", "no_liberada", "no_encontrada", "desde_invalido"],
  },
  carnes_preliq_transicionar_sede: {
    parametros: ["p_sede_id", "p_sede_version", "p_desde", "p_hacia", "p_campos"],
    codigos: ["ok", "version_cambiada", "no_encontrada", "recepcion_estado_invalido"],
  },
};

for (const [nombre, def] of Object.entries(CONJUNTO_B)) {
  test(`${nombre}: existe con sus parámetros y devuelve JSONB`, () => {
    const cuerpo = cuerpoFuncion(nombre);
    assert.ok(cuerpo, `falta la función ${nombre}`);
    for (const p of def.parametros) assert.ok(cuerpo.includes(p), `${nombre} sin parámetro ${p}`);
    assert.match(cuerpo, /RETURNS JSONB/);
    assert.match(cuerpo, /LANGUAGE plpgsql/);
  });

  test(`${nombre}: declara todos sus códigos de resultado`, () => {
    const cuerpo = cuerpoFuncion(nombre);
    for (const c of def.codigos) assert.ok(cuerpo.includes(`'${c}'`), `${nombre} no devuelve '${c}'`);
  });
}

test("M3: actualizar_servicio revalida con COALESCE(servicio_precorte,0) <= 0, igual que gastoTotal", () => {
  const f = cuerpoFuncion("carnes_preliq_actualizar_servicio");
  assert.match(f, /COALESCE\(servicio_precorte, 0\) <= 0/);
  assert.match(f, /servicio_por_animal <= 0/);
  assert.doesNotMatch(f, /COALESCE\(servicio_precorte, 0\) = 0/);
  assert.doesNotMatch(f, /servicio_por_animal = 0/);
});

test("actualizar_servicio: FOR UPDATE, fecha_primer_ingreso cubierta, tardío por liquidada_at o corte (R5)", () => {
  const f = cuerpoFuncion("carnes_preliq_actualizar_servicio");
  assert.match(f, /FOR UPDATE/);
  assert.match(f, /fecha_primer_ingreso IS DISTINCT FROM p_fecha_primer_ingreso/);
  assert.match(f, /liquidada_at IS NOT NULL OR \(p_corte IS NOT NULL AND now\(\) > p_corte\)/);
  assert.match(f, /servicio_precorte_at\s*=/);
  assert.match(f, /version\s*=\s*version \+ 1/);
});

test("liquidar: orden de chequeos ya_liquidada -> antes_del_corte -> version_cambiada, y saldos aplicados", () => {
  const f = cuerpoFuncion("carnes_preliq_liquidar");
  assert.match(f, /FOR UPDATE/);
  const a = f.indexOf("'ya_liquidada'");
  const b = f.indexOf("'antes_del_corte'");
  const c = f.indexOf("'version_cambiada'");
  assert.ok(a >= 0 && b > a && c > b, "orden de chequeos incorrecto");
  assert.match(f, /now\(\) < p_corte/);
  assert.match(f, /saldo_ids/);
  assert.match(f, /estado = 'aplicado'/);
  assert.match(f, /liquidada_at\s*=\s*now\(\)/);
  assert.match(f, /orden_version\s*=\s*orden_version \+ 1/);
  // El plan sale de JS: la RPC copia los valores, no los calcula.
  assert.match(f, /p_plan->>'gasto_total'/);
  assert.match(f, /p_plan->>'servicio_aplicado'/);
});

test("congelar_sede: bloquea cabecera y sede, valida versiones y rechaza no_liberada", () => {
  const f = cuerpoFuncion("carnes_preliq_congelar_sede");
  assert.equal((f.match(/FOR UPDATE/g) || []).length >= 2, true, "debe bloquear cabecera y sede");
  assert.match(f, /liquidada_at IS NULL/);
  assert.match(f, /orden_version <> p_orden_version/);
  assert.match(f, /version <> p_sede_version/);
  assert.match(f, /liberada_at IS NULL/);
  assert.match(f, /costeo_orden_version\s*=\s*p_orden_version/);
  assert.match(f, /costeo_animales\s*=/);
  for (const desde of ["vinculada", "calculada", "error", "lista_para_enviar", "anulada", "simulada", "bloqueada"]) {
    assert.ok(f.includes(`'${desde}'`), `desde ${desde}`);
  }
});

test("transicionar_sede: CAS por estado y versión, escribe solo columnas permitidas", () => {
  const f = cuerpoFuncion("carnes_preliq_transicionar_sede");
  assert.match(f, /FOR UPDATE/);
  assert.match(f, /estado <> p_desde/);
  assert.match(f, /version <> p_sede_version/);
  assert.match(f, /version\s*=\s*version \+ 1/);
  for (const c of ["motivo_bloqueo", "detalle_bloqueo", "liberada_at", "motivo_pendiente", "requiere_correccion", "error_tipo", "intentos", "envio_id"]) {
    assert.ok(f.includes(`'${c}'`), `columna permitida ${c}`);
  }
});

test("existe el script manual de carreras de 039 set B en test/sql", () => {
  assert.ok(existsSync(join(RAIZ, "test", "sql", "039b_rpc_liquidacion.sql")));
});
