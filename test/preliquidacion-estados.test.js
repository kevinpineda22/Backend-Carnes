import test from "node:test";
import assert from "node:assert/strict";

import { transicionSede } from "../src/shared/preliquidacionEstados.js";

const AHORA = new Date("2026-11-20T03:00:00.000Z");

const hay = (efectos, esperado) =>
  efectos.some((e) => Object.entries(esperado).every(([k, v]) => e[k] === v));

// ═══ PARTE A: costeo y bloqueos ═════════════════════════════════════════════

// ─── costeo_ok ─────────────────────────────────────────────────────────────

test("vinculada + costeo_ok -> calculada y la recepción pasa a Costeado", () => {
  const r = transicionSede("vinculada", "costeo_ok");
  assert.equal(r.estado, "calculada");
  assert.equal(r.campos.estado, "calculada");
  assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Costeado" }));
});

test("calculada + costeo_ok (recosteo) -> calculada, sin tocar la recepción (R2)", () => {
  const r = transicionSede("calculada", "costeo_ok");
  assert.equal(r.estado, "calculada");
  assert.ok(!r.efectos.some((e) => e.tipo === "recepcion"));
});

test("error + costeo_ok (admin / recalcular) -> calculada con intentos y error limpios (R2)", () => {
  for (const origen of ["admin", "recalcular"]) {
    const r = transicionSede("error", "costeo_ok", { origen });
    assert.equal(r.estado, "calculada");
    assert.equal(r.campos.intentos, 0);
    assert.equal(r.campos.error_tipo, null);
    assert.equal(r.campos.motivo_pendiente, null);
  }
});

test("error + costeo_ok desde un origen automático lanza", () => {
  for (const origen of ["schedule", "sweep", "dispatch", "inmediato", undefined]) {
    assert.throws(() => transicionSede("error", "costeo_ok", { origen }), /transición inválida/);
  }
});

test("lista_para_enviar + costeo_ok -> lista_para_enviar (recosteo, el envío sigue manual)", () => {
  const r = transicionSede("lista_para_enviar", "costeo_ok");
  assert.equal(r.estado, "lista_para_enviar");
});

test("anulada + costeo_ok (corregida_recalculada) -> lista_para_enviar, nunca automático", () => {
  const r = transicionSede("anulada", "costeo_ok");
  assert.equal(r.estado, "lista_para_enviar");
});

test("simulada + costeo_ok con SIESA apagado -> simulada", () => {
  const r = transicionSede("simulada", "costeo_ok", { siesaActivo: false });
  assert.equal(r.estado, "simulada");
});

test("simulada + costeo_ok con SIESA activo -> calculada (T1/T2)", () => {
  const r = transicionSede("simulada", "costeo_ok", { siesaActivo: true });
  assert.equal(r.estado, "calculada");
});

for (const motivo of ["servicio_cero", "armado_invalido", "costeo_invalido"]) {
  test(`bloqueada(${motivo}) + costeo_ok -> calculada, limpia el motivo y borra alertas (T1)`, () => {
    const r = transicionSede("bloqueada", "costeo_ok", { motivoBloqueo: motivo });
    assert.equal(r.estado, "calculada");
    assert.equal(r.campos.motivo_bloqueo, null);
    assert.equal(r.campos.detalle_bloqueo, null);
    assert.ok(hay(r.efectos, { tipo: "borrar_alertas" }));
    assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Costeado" }));
  });
}

test("bloqueada(utilidad_negativa) + costeo_ok -> lista_para_enviar (R13)", () => {
  const r = transicionSede("bloqueada", "costeo_ok", { motivoBloqueo: "utilidad_negativa" });
  assert.equal(r.estado, "lista_para_enviar");
  assert.equal(r.campos.motivo_bloqueo, null);
  assert.ok(hay(r.efectos, { tipo: "borrar_alertas" }));
});

test("bloqueada(excede_animales, liberada) + costeo_ok -> lista_para_enviar y limpia liberada_at", () => {
  const r = transicionSede("bloqueada", "costeo_ok", { motivoBloqueo: "excede_animales", liberada: true });
  assert.equal(r.estado, "lista_para_enviar");
  assert.equal(r.campos.liberada_at, null);
});

test("bloqueada(excede_animales) sin liberar + costeo_ok lanza no_liberada", () => {
  assert.throws(
    () => transicionSede("bloqueada", "costeo_ok", { motivoBloqueo: "excede_animales", liberada: false }),
    /no_liberada/,
  );
});

test("costeo_ok desde enviando / enviada / sin_confirmar lanza", () => {
  for (const estado of ["enviando", "enviada", "sin_confirmar"]) {
    assert.throws(() => transicionSede(estado, "costeo_ok"), /transición inválida/);
  }
});

// ─── costeo_bloqueado ──────────────────────────────────────────────────────

const ORIGENES_BLOQUEABLES = [
  ["vinculada", {}],
  ["calculada", {}],
  ["error", {}],
  ["lista_para_enviar", {}],
  ["anulada", {}],
  ["simulada", {}],
];

for (const [estado, ctxBase] of ORIGENES_BLOQUEABLES) {
  test(`${estado} + costeo_bloqueado(utilidad_negativa) -> bloqueada con alerta deduplicada`, () => {
    const r = transicionSede(estado, "costeo_bloqueado", {
      ...ctxBase,
      motivo: "utilidad_negativa",
      detalle: "utilidad -10",
    });
    assert.equal(r.estado, "bloqueada");
    assert.equal(r.campos.motivo_bloqueo, "utilidad_negativa");
    assert.equal(r.campos.detalle_bloqueo, "utilidad -10");
    assert.ok(hay(r.efectos, { tipo: "alerta", evento: "utilidad_negativa" }));
  });
}

test("bloqueada + costeo_bloqueado -> bloqueada: el motivo puede cambiar y se limpia liberada_at", () => {
  const r = transicionSede("bloqueada", "costeo_bloqueado", {
    motivoBloqueo: "excede_animales",
    liberada: true,
    motivo: "costeo_invalido",
  });
  assert.equal(r.estado, "bloqueada");
  assert.equal(r.campos.motivo_bloqueo, "costeo_invalido");
  assert.equal(r.campos.liberada_at, null);
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "costeo_invalido" }));
});

test("costeo_bloqueado acepta servicio_cero y armado_invalido, rechaza otros motivos", () => {
  for (const motivo of ["servicio_cero", "armado_invalido", "costeo_invalido", "utilidad_negativa"]) {
    assert.equal(transicionSede("vinculada", "costeo_bloqueado", { motivo }).campos.motivo_bloqueo, motivo);
  }
  assert.throws(() => transicionSede("vinculada", "costeo_bloqueado", { motivo: "excede_animales" }), /motivo/);
  assert.throws(() => transicionSede("vinculada", "costeo_bloqueado", {}), /motivo/);
});

test("costeo_bloqueado desde estados de envío lanza", () => {
  for (const estado of ["enviando", "enviada", "sin_confirmar"]) {
    assert.throws(
      () => transicionSede(estado, "costeo_bloqueado", { motivo: "costeo_invalido" }),
      /transición inválida/,
    );
  }
});

// ─── excede / liberada / corregida ─────────────────────────────────────────

test("vinculada + excede -> bloqueada(excede_animales) sin liberar, con alerta", () => {
  const r = transicionSede("vinculada", "excede");
  assert.equal(r.estado, "bloqueada");
  assert.equal(r.campos.motivo_bloqueo, "excede_animales");
  assert.equal(r.campos.liberada_at, null);
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "excede_animales" }));
});

test("bloqueada(excede_animales) + liberada -> sigue bloqueada con liberada_at puesto (T1)", () => {
  const r = transicionSede("bloqueada", "liberada", { motivoBloqueo: "excede_animales", ahora: AHORA });
  assert.equal(r.estado, "bloqueada");
  assert.equal(r.campos.liberada_at, AHORA.toISOString());
  assert.equal(r.campos.motivo_bloqueo, undefined); // sigue siendo excede_animales: no se reescribe
});

test("liberada lanza si ya estaba liberada, si el motivo no es excede o si falta ahora", () => {
  assert.throws(
    () => transicionSede("bloqueada", "liberada", { motivoBloqueo: "excede_animales", liberada: true, ahora: AHORA }),
    /transición inválida/,
  );
  assert.throws(
    () => transicionSede("bloqueada", "liberada", { motivoBloqueo: "utilidad_negativa", ahora: AHORA }),
    /transición inválida/,
  );
  assert.throws(() => transicionSede("bloqueada", "liberada", { motivoBloqueo: "excede_animales" }), /ahora/);
  assert.throws(() => transicionSede("calculada", "liberada", { ahora: AHORA }), /transición inválida/);
});

for (const motivo of ["servicio_cero", "armado_invalido", "costeo_invalido"]) {
  test(`bloqueada(${motivo}) + corregida -> vinculada y borra alertas (R13)`, () => {
    const r = transicionSede("bloqueada", "corregida", { motivoBloqueo: motivo });
    assert.equal(r.estado, "vinculada");
    assert.equal(r.campos.motivo_bloqueo, null);
    assert.ok(hay(r.efectos, { tipo: "borrar_alertas" }));
  });
}

test("corregida no aplica a excede_animales ni utilidad_negativa (esas pasan por el costeo)", () => {
  for (const motivoBloqueo of ["excede_animales", "utilidad_negativa"]) {
    assert.throws(() => transicionSede("bloqueada", "corregida", { motivoBloqueo }), /transición inválida/);
  }
});

// ─── reclamada (automática) ────────────────────────────────────────────────

test("calculada + reclamada -> enviando con intentos+1", () => {
  const r = transicionSede("calculada", "reclamada", { intentos: 0 });
  assert.equal(r.estado, "enviando");
  assert.equal(r.campos.intentos, 1);
});

test("simulada + reclamada solo con SIESA activo", () => {
  assert.equal(transicionSede("simulada", "reclamada", { siesaActivo: true, intentos: 0 }).estado, "enviando");
  assert.throws(() => transicionSede("simulada", "reclamada", { siesaActivo: false }), /transición inválida/);
});

test("error(transitorio, intentos<3, otra corrida) + reclamada -> enviando con intentos+1", () => {
  const r = transicionSede("error", "reclamada", {
    errorTipo: "transitorio",
    intentos: 1,
    ultimaCorrida: 7,
    corridaId: 8,
  });
  assert.equal(r.estado, "enviando");
  assert.equal(r.campos.intentos, 2);
});

test("error nunca reclamado (ultima_corrida NULL) es reclamable", () => {
  const r = transicionSede("error", "reclamada", {
    errorTipo: "transitorio",
    intentos: 1,
    ultimaCorrida: null,
    corridaId: 8,
  });
  assert.equal(r.estado, "enviando");
});

test("error + reclamada lanza si es permanente, intentos>=3 o ya se probó en esta corrida", () => {
  const base = { errorTipo: "transitorio", intentos: 1, ultimaCorrida: 7, corridaId: 8 };
  assert.throws(() => transicionSede("error", "reclamada", { ...base, errorTipo: "permanente" }), /transición inválida/);
  assert.throws(() => transicionSede("error", "reclamada", { ...base, intentos: 3 }), /transición inválida/);
  assert.throws(() => transicionSede("error", "reclamada", { ...base, ultimaCorrida: 8 }), /transición inválida/);
});

test("enviando abandonado (envio_id NULL) + reclamada -> enviando con intentos+1", () => {
  const r = transicionSede("enviando", "reclamada", { envioId: null, intentos: 1 });
  assert.equal(r.estado, "enviando");
  assert.equal(r.campos.intentos, 2);
});

test("enviando con envio_id + reclamada lanza", () => {
  assert.throws(() => transicionSede("enviando", "reclamada", { envioId: 55 }), /transición inválida/);
});

test("reclamada automática lanza desde lista_para_enviar, bloqueada, sin_confirmar, anulada, enviada, vinculada", () => {
  for (const estado of ["lista_para_enviar", "bloqueada", "sin_confirmar", "anulada", "enviada", "vinculada"]) {
    assert.throws(() => transicionSede(estado, "reclamada", {}), /transición inválida/);
  }
});

// ─── reclamada_admin ───────────────────────────────────────────────────────

for (const [estado, ctx] of [
  ["lista_para_enviar", {}],
  ["error", { errorTipo: "transitorio", intentos: 1 }],
  ["error", { errorTipo: "permanente", intentos: 5 }],
  ["simulada", {}],
]) {
  test(`${estado}${ctx.errorTipo ? `(${ctx.errorTipo}, intentos ${ctx.intentos})` : ""} + reclamada_admin -> enviando, intentos reiniciados (R1)`, () => {
    const r = transicionSede(estado, "reclamada_admin", ctx);
    assert.equal(r.estado, "enviando");
    assert.equal(r.campos.intentos, 1); // se reinicia a 0 y esta tentativa cuenta
    assert.equal(r.campos.error_tipo, null);
    assert.equal(r.campos.motivo_pendiente, null);
  });
}

test("reclamada_admin lanza desde los demás estados", () => {
  for (const estado of ["vinculada", "calculada", "bloqueada", "enviando", "enviada", "sin_confirmar", "anulada"]) {
    assert.throws(() => transicionSede(estado, "reclamada_admin", {}), /transición inválida/);
  }
});

// ─── inicial_no_ok / siesa_apagado ─────────────────────────────────────────

test("calculada + inicial_no_ok -> calculada con motivo_pendiente inicial_pendiente y alerta", () => {
  const r = transicionSede("calculada", "inicial_no_ok");
  assert.equal(r.estado, "calculada");
  assert.equal(r.campos.motivo_pendiente, "inicial_pendiente");
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "inicial_pendiente" }));
});

test("calculada + siesa_apagado -> simulada (R10), sin SIESA ni cambio de recepción", () => {
  const r = transicionSede("calculada", "siesa_apagado");
  assert.equal(r.estado, "simulada");
  assert.ok(!r.efectos.some((e) => e.tipo === "recepcion"));
});

test("inicial_no_ok y siesa_apagado solo desde calculada", () => {
  for (const estado of ["vinculada", "bloqueada", "lista_para_enviar", "enviando", "enviada", "error", "simulada"]) {
    assert.throws(() => transicionSede(estado, "inicial_no_ok", {}), /transición inválida/);
    assert.throws(() => transicionSede(estado, "siesa_apagado", {}), /transición inválida/);
  }
});

// ─── entradas inválidas ────────────────────────────────────────────────────

test("evento o estado desconocidos lanzan", () => {
  assert.throws(() => transicionSede("calculada", "no_existe"), /evento desconocido/);
  assert.throws(() => transicionSede("volando", "costeo_ok"), /estado desconocido/);
});

test("transicionSede es pura: no muta el contexto y devuelve objetos nuevos", () => {
  const ctx = Object.freeze({ motivoBloqueo: "utilidad_negativa" });
  const a = transicionSede("bloqueada", "costeo_ok", ctx);
  const b = transicionSede("bloqueada", "costeo_ok", ctx);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});
