// Anular una preliquidación YA enviada a SIESA y liberar sus recepciones (sql/046). Las guardas se deciden
// en JS y la RPC las revalida bajo lock; nada de esto toca SIESA. Incluye la prueba ESTÁTICA de la migración
// (como 042): las carreras reales las cubre QA contra la base.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;
const rutaSql = (nombre) => fileURLToPath(new URL(`../sql/${nombre}`, import.meta.url));
const limpiar = (t) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const sqlDe = (nombre) => (existsSync(rutaSql(nombre)) ? limpiar(readFileSync(rutaSql(nombre), "utf8")) : "");

let tablas = {};
let rpcs = [];
let manejadores = {};

class Q {
  constructor(t) { this.t = t; this.f = []; }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; }
  filas() { return (tablas[this.t] || []).filter((r) => this.f.every((g) => g(r))).map((r) => ({ ...r })); }
  maybeSingle() { return Promise.resolve({ data: this.filas()[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) { return Promise.resolve({ data: this.filas(), error: null }).then(res, rej); }
}
const supabaseFalso = {
  from: (t) => new Q(t),
  rpc: async (nombre, args) => {
    rpcs.push({ nombre, args });
    const h = manejadores[nombre];
    return { data: h ? await h(args) : { resultado: "ok" }, error: null };
  },
};
mock.module(url("config/supabase.js"), { namedExports: { supabase: supabaseFalso } });
const Correcciones = await import(url("models/PreliquidacionCorrecciones.model.js"));
const { decidirAnulacionEnviada } = await import(url("shared/preliquidacionAnulacion.js"));

const cabecera = (extra = {}) => ({ id: 19, especie: "cerdo", estado: "cerrada", version: 7, orden_version: 12, ...extra });
const sede = (extra = {}) => ({ id: 11, preliquidacion_id: 19, recepcion_id: 101, estado: "enviada", envio_id: 900, ...extra });
const oficial = (extra = {}) => ({ id: 900, tipo: "oficial", estado: "ok", recepcion_id: 101, recepcion_ids: null, ...extra });
const silencio = { info() {}, warn() {}, error() {}, log() {} };

// ─── Guardas puras ─────────────────────────────────────────────────────────

test("cerrada o abierta, con sedes enviadas y bloqueadas y oficiales ok, es anulable", () => {
  for (const estado of ["cerrada", "abierta"]) {
    assert.deepEqual(
      decidirAnulacionEnviada({
        cabecera: cabecera({ estado }),
        sedes: [sede(), sede({ id: 12, recepcion_id: 102, estado: "bloqueada", envio_id: null })],
        envios: [oficial()],
      }),
      { ok: true },
      estado,
    );
  }
});

test("una cabecera anulada es ya_anulada", () => {
  assert.deepEqual(decidirAnulacionEnviada({ cabecera: cabecera({ estado: "anulada" }), sedes: [] }), { ok: false, motivo: "ya_anulada" });
});

test("una sede enviando o sin_confirmar, o un oficial enviando/sin_confirmar, es sede_ambigua", () => {
  for (const estado of ["enviando", "sin_confirmar"]) {
    assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede(), sede({ id: 12, recepcion_id: 102, estado })] }).motivo, "sede_ambigua", estado);
    assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede()], envios: [oficial({ estado })] }).motivo, "sede_ambigua", `envio ${estado}`);
  }
});

test("una CEI de vísceras vigente de cualquier recepción es visceras_vigentes; anulada o error no", () => {
  for (const tipo of ["visceras_recepcion", "ajuste_visceras"]) {
    for (const estado of ["enviando", "ok", "duplicado", "sin_confirmar"]) {
      assert.equal(
        decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede()], envios: [oficial({ id: 1, estado: "anulado" }), oficial({ id: 2, tipo, estado })] }).motivo,
        "visceras_vigentes",
        `${tipo}/${estado}`,
      );
    }
  }
  for (const estado of ["anulado", "error"]) {
    assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede()], envios: [oficial({ id: 2, tipo: "visceras_recepcion", estado })] }).ok, true, estado);
  }
  // La de una recepción ajena no cuenta.
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede()], envios: [oficial({ id: 3, tipo: "visceras_recepcion", recepcion_id: 999 })] }).ok, true);
});

test("un oficial vigente que cubre recepciones ajenas es envio_compartido; uno que cubre solo las propias no", () => {
  const compartido = oficial({ recepcion_id: null, recepcion_ids: [101, 555] });
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede()], envios: [compartido] }).motivo, "envio_compartido");
  const propio = oficial({ recepcion_id: null, recepcion_ids: [101] });
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), sedes: [sede()], envios: [propio] }).ok, true);
});

test("un saldo originado por ella y aplicado en otra bloquea: saldo_aplicado; pendiente o descartado no", () => {
  const base = { cabecera: cabecera(), sedes: [sede()], envios: [oficial()] };
  assert.equal(decidirAnulacionEnviada({ ...base, saldos: [{ id: 1, estado: "aplicado" }] }).motivo, "saldo_aplicado");
  for (const estado of ["pendiente", "movido", "descartado"]) {
    assert.equal(decidirAnulacionEnviada({ ...base, saldos: [{ id: 1, estado }] }).ok, true, estado);
  }
});

test("precedencia: ya_anulada, sede_ambigua, visceras_vigentes, envio_compartido, saldo_aplicado", () => {
  const todo = {
    sedes: [sede(), sede({ id: 12, recepcion_id: 102, estado: "enviando" })],
    envios: [oficial({ id: 2, tipo: "visceras_recepcion" }), oficial({ id: 3, recepcion_id: null, recepcion_ids: [101, 555] })],
    saldos: [{ id: 1, estado: "aplicado" }],
  };
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera({ estado: "anulada" }), ...todo }).motivo, "ya_anulada");
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), ...todo }).motivo, "sede_ambigua");
  todo.sedes = [sede()];
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), ...todo }).motivo, "visceras_vigentes");
  todo.envios = [oficial({ id: 3, recepcion_id: null, recepcion_ids: [101, 555] })];
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), ...todo }).motivo, "envio_compartido");
  todo.envios = [];
  assert.equal(decidirAnulacionEnviada({ cabecera: cabecera(), ...todo }).motivo, "saldo_aplicado");
});

// ─── Modelo ────────────────────────────────────────────────────────────────

const RESPUESTA_OK = { resultado: "ok", preliquidacion_id: 19, sedes_liberadas: 2, recepciones: [101, 102], envios_anulados: 1, saldos_reasignados: 0, saldos_destino_id: null };

beforeEach(() => {
  rpcs = [];
  manejadores = { carnes_preliq_anular_enviada: () => RESPUESTA_OK };
  tablas = {
    carnes_preliquidaciones: [cabecera()],
    carnes_preliquidacion_sedes: [sede(), sede({ id: 12, recepcion_id: 102, estado: "bloqueada", envio_id: null })],
    carnes_siesa_envios: [oficial()],
    carnes_preliquidacion_saldos: [],
  };
});

const llamadasRpc = () => rpcs.filter((r) => r.nombre === "carnes_preliq_anular_enviada");
const anular = (id = 19, datos = { motivo: "conteo de animales erróneo" }) => Correcciones.anularPreliquidacionEnviada(id, datos, { log: silencio });

test("llama a la RPC con las versiones leídas, quién y el motivo (sin otras RPC ni SIESA)", async () => {
  const r = await anular(19, { por: "ana@merka.co", motivo: "  conteo de animales erróneo " });
  assert.equal(r.resultado, "ok");
  assert.deepEqual(r.recepciones, [101, 102]);
  assert.deepEqual(llamadasRpc()[0].args, {
    p_id: 19, p_version: 7, p_orden_version: 12, p_por: "ana@merka.co", p_motivo: "conteo de animales erróneo",
  });
  assert.equal(rpcs.length, 1, "toda la operación es una sola RPC atómica");
});

test("el motivo es obligatorio: sin él 422 motivo_requerido y la RPC no se llama", async () => {
  for (const motivo of [undefined, null, "", "   "]) {
    await assert.rejects(Correcciones.anularPreliquidacionEnviada(19, { motivo }, { log: silencio }), (e) => e.statusCode === 422 && e.codigo === "motivo_requerido");
  }
  assert.equal(llamadasRpc().length, 0);
});

test("una preliquidación abierta también se anula (liquidada o no)", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ estado: "abierta" })];
  assert.equal((await anular()).resultado, "ok");
  assert.equal(llamadasRpc().length, 1);
});

test("una guarda de JS que falla es 409 no_anulable con su motivo y la RPC no se llama", async () => {
  tablas.carnes_preliquidacion_sedes[1].estado = "sin_confirmar";
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "no_anulable" && e.motivo === "sede_ambigua");

  tablas.carnes_preliquidacion_sedes[1].estado = "bloqueada";
  tablas.carnes_siesa_envios.push(oficial({ id: 901, tipo: "visceras_recepcion", recepcion_id: 102 }));
  await assert.rejects(anular(), (e) => e.codigo === "no_anulable" && e.motivo === "visceras_vigentes" && /vísceras/.test(e.message));

  tablas.carnes_siesa_envios = [oficial()];
  tablas.carnes_preliquidacion_saldos = [{ id: 5, origen_preliquidacion_id: 19, estado: "aplicado", destino_preliquidacion_id: 20 }];
  await assert.rejects(anular(), (e) => e.codigo === "no_anulable" && e.motivo === "saldo_aplicado");
  assert.equal(llamadasRpc().length, 0);
});

test("anular una ya anulada es 409 no_anulable ya_anulada, sin RPC", async () => {
  tablas.carnes_preliquidaciones = [cabecera({ estado: "anulada" })];
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "no_anulable" && e.motivo === "ya_anulada");
  assert.equal(llamadasRpc().length, 0);
});

test("si la RPC revalida bajo lock y responde no_anulable (carrera), es 409 con el motivo", async () => {
  manejadores.carnes_preliq_anular_enviada = () => ({ resultado: "no_anulable", motivo: "envio_compartido" });
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "no_anulable" && e.motivo === "envio_compartido");
});

test("version_cambiada relee y reintenta hasta 3 veces; agotado es 409", async () => {
  let n = 0;
  manejadores.carnes_preliq_anular_enviada = () => (++n < 2 ? { resultado: "version_cambiada" } : RESPUESTA_OK);
  assert.equal((await anular()).resultado, "ok");
  assert.equal(n, 2);

  rpcs = [];
  manejadores.carnes_preliq_anular_enviada = () => ({ resultado: "version_cambiada" });
  await assert.rejects(anular(), (e) => e.statusCode === 409 && e.codigo === "version_cambiada");
  assert.equal(llamadasRpc().length, 3);
});

test("preliquidación inexistente es 404 y sin RPC", async () => {
  await assert.rejects(anular(999), (e) => e.statusCode === 404);
  assert.equal(llamadasRpc().length, 0);
});

// ─── La migración (estático) ───────────────────────────────────────────────

const sql = sqlDe("046_preliquidacion_anular_enviada.sql");

function cuerpoFuncion(nombre, texto = sql) {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${nombre}\\s*\\(`).exec(texto);
  if (!m) return "";
  const resto = texto.slice(m.index);
  const fin = resto.indexOf("LANGUAGE plpgsql;");
  return fin < 0 ? resto : resto.slice(0, fin + "LANGUAGE plpgsql;".length);
}
const f = cuerpoFuncion("carnes_preliq_anular_enviada");
const n = (t) => t.replace(/\s+/g, " ");

test("046: transacción con lock_timeout, guarda de 041/011, tabla de auditoría idempotente y sin SECURITY DEFINER", () => {
  assert.ok(sql, "falta sql/046_preliquidacion_anular_enviada.sql");
  assert.match(sql, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /^\s*COMMIT;/m);
  assert.match(sql, /proname = 'carnes_preliq_anular'/);
  assert.match(sql, /column_name = 'anulado_por'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS carnes_preliquidacion_sedes_anuladas/);
  assert.match(sql, /fila\s+JSONB\s+NOT NULL/);
  assert.match(sql, /motivo\s+TEXT\s+NOT NULL/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
  assert.doesNotMatch(sql, /\bDROP\b/i, "la migración no borra nada");
  assert.doesNotMatch(sql, /ck_carnes_recepciones_liq_xor_preliq/, "no toca el CHECK de liquidación XOR preliquidación");
});

test("046: la RPC bloquea cabecera, sedes y recepciones, exige motivo y devuelve todos los códigos", () => {
  assert.ok(f, "falta carnes_preliq_anular_enviada");
  for (const p of ["p_id", "p_version", "p_orden_version", "p_por", "p_motivo"]) assert.ok(f.includes(p), `sin parámetro ${p}`);
  assert.match(f, /RETURNS JSONB/);
  assert.match(n(f), /FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE/);
  assert.match(n(f), /FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id ORDER BY id FOR UPDATE/);
  assert.match(n(f), /FROM carnes_recepciones WHERE id = ANY \(v_recs\) ORDER BY id FOR UPDATE/);
  for (const c of ["ok", "no_encontrada", "motivo_requerido", "no_anulable", "version_cambiada"]) assert.ok(f.includes(`'${c}'`), `no devuelve '${c}'`);
  for (const m of ["ya_anulada", "sede_ambigua", "visceras_vigentes", "envio_compartido", "saldo_aplicado"]) assert.ok(f.includes(`'${m}'`), `sin motivo '${m}'`);
  assert.match(n(f), /estado NOT IN \('abierta', 'cerrada'\)/, "abierta y cerrada son anulables");
});

test("046: rechaza sedes/envíos ambiguos y vísceras CEI vigentes antes de escribir nada", () => {
  const antes = f.slice(0, f.indexOf("UPDATE carnes_siesa_envios"));
  assert.match(n(antes), /s\.estado IN \('enviando', 'sin_confirmar'\)/);
  assert.match(n(antes), /e\.tipo = 'oficial' AND e\.estado IN \('enviando', 'sin_confirmar'\)/);
  assert.match(n(antes), /e\.tipo IN \('visceras_recepcion', 'ajuste_visceras'\)/);
  assert.match(n(antes), /origen_preliquidacion_id = p_id AND estado = 'aplicado'/);
  assert.match(n(antes), /v_header\.version <> p_version OR v_header\.orden_version <> p_orden_version/);
});

test("046: anula los oficiales vigentes con por/motivo y libera el candado (ok/duplicado), nunca otros tipos", () => {
  const m = n(f);
  assert.match(m, /UPDATE carnes_siesa_envios SET estado = 'anulado', anulado_por = NULLIF\(p_por, ''\), anulado_at = now\(\), motivo_anulacion = v_motivo WHERE tipo = 'oficial' AND estado IN \('ok', 'duplicado'\)/);
  assert.doesNotMatch(m, /tipo = 'inicial'/, "no toca las iniciales");
});

test("046: archiva las sedes (fila completa) antes de borrarlas y limpia los avisos sin enviar", () => {
  const i = f.indexOf("INSERT INTO carnes_preliquidacion_sedes_anuladas");
  const d = f.indexOf("DELETE FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id");
  assert.ok(i > 0 && d > i, "archiva y luego borra");
  assert.match(n(f), /to_jsonb\(s\)/);
  assert.match(n(f), /DELETE FROM carnes_preliquidacion_alertas WHERE enviado_ok = false AND \(preliquidacion_id = p_id OR sede_id IN/);
});

test("046: la recepción queda libre y Aprobada (como una de talleres recién finalizada) sin tocar inicial_omitida_*", () => {
  const m = n(f);
  assert.match(m, /UPDATE carnes_recepciones SET estado = 'Aprobado', costeado_at = NULL, siesa_at = NULL WHERE id = ANY \(v_recs\) AND estado IN \('Costeado', 'Enviado_SIESA'\)/);
  assert.match(m, /UPDATE carnes_recepciones SET preliquidacion_id = NULL WHERE id = ANY \(v_recs\)/);
  assert.match(m, /UPDATE carnes_recepcion_items SET costo_ajustado = NULL, costo_total = NULL/);
  assert.doesNotMatch(f, /inicial_omitida/);
  assert.doesNotMatch(f, /(?<![a-z_])liquidacion_id/, "no toca liquidacion_id: el XOR con preliquidacion_id sigue valiendo");
});

test("046: la cabecera pasa a anulada con anulada_at/por y motivo, y sube las dos versiones", () => {
  const m = n(f);
  assert.match(m, /SET estado = 'anulada', anulada_at = now\(\), anulada_por = NULLIF\(p_por, ''\), motivo_anulacion = v_motivo, version = version \+ 1, orden_version = orden_version \+ 1/);
});

test("046: los saldos se manejan como carnes_preliq_anular (reasignar los consumidos, descartar los propios)", () => {
  assert.match(f, /SET estado = 'pendiente', destino_preliquidacion_id = v_destino_nuevo[\s\S]{0,160}estado IN \('aplicado', 'pendiente'\)/);
  assert.match(f, /SET estado = 'descartado'[\s\S]{0,200}origen_preliquidacion_id = p_id AND estado = 'pendiente'/);
});

test("046: no manda correos ni encola alertas (solo borra las pendientes)", () => {
  assert.doesNotMatch(f, /INSERT INTO carnes_preliquidacion_alertas/);
});

test("046_rollback: borra la RPC y la tabla, idempotente y en transacción", () => {
  const r = sqlDe("046_rollback.sql");
  assert.ok(r, "falta sql/046_rollback.sql");
  assert.match(r, /BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
  assert.match(r, /DROP FUNCTION IF EXISTS carnes_preliq_anular_enviada\(BIGINT, INTEGER, INTEGER, TEXT, TEXT\);/);
  assert.match(r, /DROP TABLE IF EXISTS carnes_preliquidacion_sedes_anuladas;/);
  assert.match(r, /^\s*COMMIT;/m);
});

// ─── La recepción liberada puede vincularse otra vez (guardas de carnes_preliq_vincular) ───────

test("tras liberar, ninguna guarda de vincular la bloquea: sin preliquidacion_id, sin liquidacion_id y sin oficial vigente", () => {
  const vincular = sqlDe("043_preliquidacion_vincular_anterior.sql");
  const v = cuerpoFuncion("carnes_preliq_vincular", vincular);
  const m = n(v);
  assert.match(m, /IF v_rec\.preliquidacion_id IS NOT NULL THEN RETURN jsonb_build_object\('resultado', 'ya_vinculada'/);
  assert.match(m, /v_rec\.liquidacion_id IS NOT NULL OR EXISTS \( SELECT 1 FROM carnes_siesa_envios e WHERE e\.tipo = 'oficial' AND e\.estado IN \('enviando', 'ok', 'sin_confirmar'\)/);
  // La RPC de 046 deja justo lo que esas guardas piden: vínculo NULL y los oficiales fuera del conjunto vigente.
  assert.match(n(f), /preliquidacion_id = NULL/);
  assert.match(n(f), /estado = 'anulado'/);
});

test("la compuerta de la inicial al ENVIAR pasa con inicial ok (no se toca) o inicial_omitida_at (no se toca)", () => {
  const reclamar = n(sqlDe("044_preliquidacion_oficial_sin_inicial.sql"));
  assert.match(reclamar, /e\.tipo = 'inicial' AND e\.estado = 'ok'/);
  assert.match(reclamar, /r\.inicial_omitida_at IS NOT NULL/);
  assert.doesNotMatch(n(f), /tipo = 'inicial'/);
  assert.doesNotMatch(f, /inicial_omitida/);
});
