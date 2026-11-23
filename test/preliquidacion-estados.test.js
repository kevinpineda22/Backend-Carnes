import test from "node:test";
import assert from "node:assert/strict";

import { transicionSede, mapearEnvio } from "../src/shared/preliquidacionEstados.js";

const AHORA = new Date("2026-11-20T03:00:00.000Z");

const ESTADOS_TODOS = ["vinculada", "bloqueada", "lista_para_enviar", "calculada", "enviando", "enviada", "error", "sin_confirmar", "anulada", "simulada"];
const ESTADOS_NO_ENVIANDO = ESTADOS_TODOS.filter((e) => e !== "enviando");
const ESTADOS_NO_ENVIADA = ESTADOS_TODOS.filter((e) => e !== "enviada");

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

// ═══ PARTE B: envío y cierre ═════════════════════════════════════════════════

// ─── resultados de registrarYEnviar ────────────────────────────────────────

test("enviando + envio_ok -> enviada: recepción Enviado_SIESA, avisa anulación y prueba el autocierre", () => {
  const r = transicionSede("enviando", "envio_ok", { envioId: 91 });
  assert.equal(r.estado, "enviada");
  assert.equal(r.campos.envio_id, 91);
  assert.equal(r.campos.requiere_correccion, false);
  assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Enviado_SIESA" }));
  assert.ok(hay(r.efectos, { tipo: "avisar_anulacion" }));
  assert.ok(hay(r.efectos, { tipo: "intentar_autocierre" }));
  assert.ok(hay(r.efectos, { tipo: "borrar_alertas", evento: "requiere_correccion" }));
});

test("enviando + envio_repetido_ok -> enviada con el envío existente y SIN segundo aviso de anulación", () => {
  const r = transicionSede("enviando", "envio_repetido_ok", { envioId: 77 });
  assert.equal(r.estado, "enviada");
  assert.equal(r.campos.envio_id, 77);
  assert.equal(r.campos.requiere_correccion, false);
  assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Enviado_SIESA" }));
  assert.ok(!r.efectos.some((e) => e.tipo === "avisar_anulacion"));
  assert.ok(hay(r.efectos, { tipo: "intentar_autocierre" }));
});

test("enviando + envio_repetido_enviando -> enviando con el envío existente, no reclamable, con alerta", () => {
  const r = transicionSede("enviando", "envio_repetido_enviando", { envioId: 77 });
  assert.equal(r.estado, "enviando");
  assert.equal(r.campos.envio_id, 77);
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "envio_en_vuelo" }));
  // con envio_id puesto, una nueva reclamada automática ya no procede
  assert.throws(() => transicionSede("enviando", "reclamada", { envioId: 77 }), /transición inválida/);
});

test("enviando + envio_sin_confirmar -> sin_confirmar con alerta", () => {
  const r = transicionSede("enviando", "envio_sin_confirmar", { envioId: 12 });
  assert.equal(r.estado, "sin_confirmar");
  assert.equal(r.campos.envio_id, 12);
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "sin_confirmar" }));
});

test("enviando + envio_error(transitorio, intentos<3) -> error transitorio sin alerta", () => {
  const r = transicionSede("enviando", "envio_error", { errorTipo: "transitorio", intentos: 2 });
  assert.equal(r.estado, "error");
  assert.equal(r.campos.error_tipo, "transitorio");
  assert.equal(r.campos.motivo_pendiente, undefined);
  assert.ok(!r.efectos.some((e) => e.tipo === "alerta"));
});

test("enviando + envio_error(transitorio, intentos>=3) -> error con reintentos_agotados y alerta", () => {
  const r = transicionSede("enviando", "envio_error", { errorTipo: "transitorio", intentos: 3 });
  assert.equal(r.estado, "error");
  assert.equal(r.campos.error_tipo, "transitorio");
  assert.equal(r.campos.motivo_pendiente, "reintentos_agotados");
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "reintentos_agotados" }));
  // desde ahí solo el admin: la reclamada automática ya no procede
  assert.throws(
    () => transicionSede("error", "reclamada", { errorTipo: "transitorio", intentos: 3, ultimaCorrida: 1, corridaId: 2 }),
    /transición inválida/,
  );
});

test("enviando + envio_error(permanente) -> error permanente con alerta envio_error", () => {
  const r = transicionSede("enviando", "envio_error", { errorTipo: "permanente", intentos: 1 });
  assert.equal(r.estado, "error");
  assert.equal(r.campos.error_tipo, "permanente");
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "envio_error" }));
});

test("envio_error exige un errorTipo válido", () => {
  assert.throws(() => transicionSede("enviando", "envio_error", { intentos: 1 }), /errorTipo/);
  assert.throws(() => transicionSede("enviando", "envio_error", { errorTipo: "raro" }), /errorTipo/);
});

test("enviando + armado_bloqueado -> bloqueada(armado_invalido) con detalle y alerta, nunca error", () => {
  const r = transicionSede("enviando", "armado_bloqueado", { detalle: "ítem sin código SIESA" });
  assert.equal(r.estado, "bloqueada");
  assert.equal(r.campos.motivo_bloqueo, "armado_invalido");
  assert.equal(r.campos.detalle_bloqueo, "ítem sin código SIESA");
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "armado_invalido" }));
});

test("los eventos de envío solo aplican desde enviando", () => {
  const eventos = [
    ["envio_ok", {}],
    ["envio_repetido_ok", {}],
    ["envio_repetido_enviando", {}],
    ["envio_sin_confirmar", {}],
    ["envio_error", { errorTipo: "transitorio" }],
    ["armado_bloqueado", {}],
  ];
  for (const estado of ESTADOS_NO_ENVIANDO) {
    for (const [evento, ctx] of eventos) {
      assert.throws(() => transicionSede(estado, evento, ctx), /transición inválida/, `${estado} + ${evento}`);
    }
  }
});

// ─── resolver() ────────────────────────────────────────────────────────────

for (const estado of ["enviando", "sin_confirmar"]) {
  test(`${estado} + resuelto_ok -> enviada, limpia requiere_correccion y prueba el autocierre`, () => {
    const r = transicionSede(estado, "resuelto_ok", { envioId: 5 });
    assert.equal(r.estado, "enviada");
    assert.equal(r.campos.requiere_correccion, false);
    assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Enviado_SIESA" }));
    assert.ok(hay(r.efectos, { tipo: "intentar_autocierre" }));
  });

  test(`${estado} + resuelto_error -> error permanente (solo admin, nunca reintento automático)`, () => {
    const r = transicionSede(estado, "resuelto_error", {});
    assert.equal(r.estado, "error");
    assert.equal(r.campos.error_tipo, "permanente");
    assert.throws(
      () => transicionSede("error", "reclamada", { errorTipo: "permanente", intentos: 1, ultimaCorrida: 1, corridaId: 2 }),
      /transición inválida/,
    );
  });
}

test("resuelto_ok / resuelto_error lanzan desde los demás estados", () => {
  for (const estado of ["vinculada", "bloqueada", "calculada", "lista_para_enviar", "enviada", "error", "anulada", "simulada"]) {
    assert.throws(() => transicionSede(estado, "resuelto_ok", {}), /transición inválida/);
    assert.throws(() => transicionSede(estado, "resuelto_error", {}), /transición inválida/);
  }
});

// ─── anulación y corrección ────────────────────────────────────────────────

test("enviada + anulacion_confirmada -> anulada y la recepción vuelve a Costeado", () => {
  const r = transicionSede("enviada", "anulacion_confirmada");
  assert.equal(r.estado, "anulada");
  assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Costeado" }));
});

test("anulacion_confirmada solo desde enviada", () => {
  for (const estado of ESTADOS_NO_ENVIADA) {
    assert.throws(() => transicionSede(estado, "anulacion_confirmada"), /transición inválida/);
  }
});

for (const estado of ["enviando", "enviada", "sin_confirmar"]) {
  test(`${estado} + recalcular_no_enviadas -> mismo estado con requiere_correccion y alerta`, () => {
    const r = transicionSede(estado, "recalcular_no_enviadas", { ordenVersion: 5 });
    assert.equal(r.estado, estado);
    assert.equal(r.campos.requiere_correccion, true);
    assert.ok(hay(r.efectos, { tipo: "alerta", evento: "requiere_correccion" }));
  });
}

test("recalcular_no_enviadas lanza desde los estados no enviados (esos se recostean)", () => {
  for (const estado of ["vinculada", "bloqueada", "calculada", "lista_para_enviar", "error", "anulada", "simulada"]) {
    assert.throws(() => transicionSede(estado, "recalcular_no_enviadas"), /transición inválida/);
  }
});

test("correccion_descartada: en cualquier estado con requiere_correccion limpia el flag y borra sus alertas", () => {
  for (const estado of ESTADOS_TODOS) {
    const r = transicionSede(estado, "correccion_descartada", { requiereCorreccion: true });
    assert.equal(r.estado, estado);
    assert.equal(r.campos.requiere_correccion, false);
    assert.ok(hay(r.efectos, { tipo: "borrar_alertas", evento: "requiere_correccion" }));
  }
});

test("correccion_descartada lanza si la sede no requiere corrección", () => {
  assert.throws(() => transicionSede("enviada", "correccion_descartada", { requiereCorreccion: false }), /transición inválida/);
  assert.throws(() => transicionSede("enviada", "correccion_descartada", {}), /transición inválida/);
});

// ─── mapearEnvio ───────────────────────────────────────────────────────────

test("mapearEnvio: ok no repetido -> envio_ok con el id del envío", () => {
  assert.deepEqual(mapearEnvio({ estado: "ok", id: 9 }), { evento: "envio_ok", ctx: { envioId: 9 } });
});

test("mapearEnvio: repetido ok / enviando", () => {
  assert.equal(mapearEnvio({ estado: "ok", repetido: true, id: 9 }).evento, "envio_repetido_ok");
  assert.equal(mapearEnvio({ estado: "enviando", repetido: true, id: 9 }).evento, "envio_repetido_enviando");
  assert.equal(mapearEnvio({ estado: "enviando", repetido: true, id: 9 }).ctx.envioId, 9);
});

test("mapearEnvio: sin_confirmar (timeout o corte) -> envio_sin_confirmar", () => {
  assert.deepEqual(mapearEnvio({ estado: "sin_confirmar", id: 4 }), { evento: "envio_sin_confirmar", ctx: { envioId: 4 } });
});

test("mapearEnvio: rechazo de SIESA (4xx o 200 con rechazo) -> envio_error permanente", () => {
  for (const http_status of [400, 401, 404, 422, 200]) {
    const m = mapearEnvio({ estado: "error", id: 3, http_status, error: "x" });
    assert.equal(m.evento, "envio_error");
    assert.equal(m.ctx.errorTipo, "permanente", String(http_status));
  }
});

test("mapearEnvio: red, 500 y no conectado -> envio_error transitorio", () => {
  for (const http_status of [null, undefined, 500, 501]) {
    const m = mapearEnvio({ estado: "error", id: 3, http_status, error: "x" });
    assert.equal(m.evento, "envio_error");
    assert.equal(m.ctx.errorTipo, "transitorio", String(http_status));
  }
});

test("mapearEnvio: bloqueos de armado ganan sobre el estado de la fila (nunca error)", () => {
  const m = mapearEnvio(
    { estado: "error", id: 3, http_status: undefined, error: "Falta código" },
    { armadoBloqueos: ["Falta código SIESA.", "Sin tercero."] },
  );
  assert.equal(m.evento, "armado_bloqueado");
  assert.equal(m.ctx.detalle, "Falta código SIESA. Sin tercero.");
});

test("mapearEnvio: estados no mapeables lanzan", () => {
  assert.throws(() => mapearEnvio({ estado: "apagado" }), /no mapeable/);
  assert.throws(() => mapearEnvio({ estado: "error", repetido: true }), /no mapeable/);
  assert.throws(() => mapearEnvio(null), /no mapeable/);
});

test("mapearEnvio + transicionSede: el resultado de la fila alimenta la tabla sin traducciones extra", () => {
  const { evento, ctx } = mapearEnvio({ estado: "ok", id: 9 });
  assert.equal(transicionSede("enviando", evento, ctx).estado, "enviada");
});

// ═══ M1: error transitorio / enviando abandonado con costeo obsoleto ═══════
// Sin estas filas, un cambio de orden_version (otra sede vinculada después) dejaba
// la sede sin forma de avanzar en las corridas automáticas.

test("[M1] error(transitorio, intentos<3) + costeo_ok automático -> calculada CONSERVANDO intentos", () => {
  for (const origen of ["schedule", "sweep", "dispatch", "inmediato"]) {
    for (const intentos of [0, 1, 2]) {
      const r = transicionSede("error", "costeo_ok", { origen, errorTipo: "transitorio", intentos });
      assert.equal(r.estado, "calculada", `${origen}/${intentos}`);
      assert.equal(r.campos.error_tipo, null, `${origen}/${intentos}`);
      assert.ok(!("intentos" in r.campos), `intentos no debe reiniciarse (${origen}/${intentos})`);
    }
  }
});

test("[M1] error + costeo_ok automático sigue lanzando si es permanente o ya agotó los intentos", () => {
  assert.throws(
    () => transicionSede("error", "costeo_ok", { origen: "schedule", errorTipo: "permanente", intentos: 1 }),
    /transición inválida/,
  );
  assert.throws(
    () => transicionSede("error", "costeo_ok", { origen: "schedule", errorTipo: "transitorio", intentos: 3 }),
    /transición inválida/,
  );
});

test("[M1] error(transitorio) + costeo_ok del admin / recalcular SÍ reinicia intentos", () => {
  for (const origen of ["admin", "recalcular"]) {
    const r = transicionSede("error", "costeo_ok", { origen, errorTipo: "transitorio", intentos: 2 });
    assert.equal(r.campos.intentos, 0, origen);
  }
});

test("[M1] enviando abandonado (sin envio_id) + costeo_ok -> calculada, conserva intentos y libera el reclamo", () => {
  const r = transicionSede("enviando", "costeo_ok", { abandonado: true, envioId: null, intentos: 2 });
  assert.equal(r.estado, "calculada");
  assert.equal(r.campos.claim_token, null);
  assert.equal(r.campos.claimed_at, null);
  assert.ok(!("intentos" in r.campos));
});

test("[M1] enviando no abandonado, o con envio_id, no se puede recostear", () => {
  assert.throws(() => transicionSede("enviando", "costeo_ok", { abandonado: false, envioId: null }), /transición inválida/);
  assert.throws(() => transicionSede("enviando", "costeo_ok", { abandonado: true, envioId: 9 }), /transición inválida/);
});

// ═══ M2: requiere_correccion no se limpia con un envío de montos anteriores al recálculo ═══
// El flag nace con la orden_version N del recálculo (`correccion_orden_version`). Un envío
// solo lo limpia si se reclamó con un costeo de versión >= N (`claim_costeo_orden_version`).

const EVENTOS_ENVIO_OK = [
  ["enviando", "envio_ok"],
  ["enviando", "envio_repetido_ok"],
  ["enviando", "resuelto_ok"],
  ["sin_confirmar", "resuelto_ok"],
];

test("[M2] recalcular_no_enviadas guarda la orden_version en correccion_orden_version", () => {
  for (const estado of ["enviando", "enviada", "sin_confirmar"]) {
    const r = transicionSede(estado, "recalcular_no_enviadas", { ordenVersion: 7 });
    assert.equal(r.campos.requiere_correccion, true, estado);
    assert.equal(r.campos.correccion_orden_version, 7, estado);
  }
});

test("[M2] recalcular_no_enviadas exige la orden_version del recálculo", () => {
  assert.throws(() => transicionSede("enviada", "recalcular_no_enviadas"), /ordenVersion/);
});

for (const [estado, evento] of EVENTOS_ENVIO_OK) {
  test(`[M2] ${estado} + ${evento} con claim anterior al recálculo CONSERVA requiere_correccion`, () => {
    const r = transicionSede(estado, evento, {
      envioId: 31,
      requiereCorreccion: true,
      correccionOrdenVersion: 5,
      claimCosteoOrdenVersion: 4,
    });
    assert.equal(r.estado, "enviada");
    assert.ok(!("requiere_correccion" in r.campos), "no debe tocar el flag");
    assert.ok(!("correccion_orden_version" in r.campos));
    assert.ok(!hay(r.efectos, { tipo: "borrar_alertas", evento: "requiere_correccion" }), "la alerta sigue vigente");
    assert.ok(hay(r.efectos, { tipo: "recepcion", estado: "Enviado_SIESA" }));
    assert.ok(hay(r.efectos, { tipo: "intentar_autocierre" }));
    assert.equal(r.campos.envio_id, 31);
  });

  for (const claim of [5, 6]) {
    test(`[M2] ${estado} + ${evento} con claim ${claim} >= recálculo 5 LIMPIA el flag y su alerta`, () => {
      const r = transicionSede(estado, evento, {
        requiereCorreccion: true,
        correccionOrdenVersion: 5,
        claimCosteoOrdenVersion: claim,
      });
      assert.equal(r.campos.requiere_correccion, false);
      assert.equal(r.campos.correccion_orden_version, null);
      assert.ok(hay(r.efectos, { tipo: "borrar_alertas", evento: "requiere_correccion" }));
    });
  }

  test(`[M2] ${estado} + ${evento} con flag pero sin versiones conocidas conserva el flag (lado seguro)`, () => {
    for (const ctx of [
      { requiereCorreccion: true },
      { requiereCorreccion: true, correccionOrdenVersion: 5 },
      { requiereCorreccion: true, claimCosteoOrdenVersion: 9 },
    ]) {
      const r = transicionSede(estado, evento, ctx);
      assert.ok(!("requiere_correccion" in r.campos), JSON.stringify(ctx));
    }
  });
}

test("[M2] sin requiere_correccion el envío se comporta como antes (flag en false)", () => {
  const r = transicionSede("enviando", "envio_ok", { requiereCorreccion: false });
  assert.equal(r.campos.requiere_correccion, false);
  assert.ok(hay(r.efectos, { tipo: "borrar_alertas", evento: "requiere_correccion" }));
});

test("[M2] flujo anulada -> recosteo -> lista_para_enviar -> envío limpia el flag con el claim nuevo", () => {
  // La sede enviada se marca al recalcular (orden_version 5)...
  let r = transicionSede("enviada", "recalcular_no_enviadas", { ordenVersion: 5 });
  const correccionOrdenVersion = r.campos.correccion_orden_version;
  // ...el admin anula el CEA en SIESA, se recostea con la orden_version vigente (5) y se reenvía.
  r = transicionSede("enviada", "anulacion_confirmada");
  assert.equal(r.estado, "anulada");
  assert.ok(!("requiere_correccion" in r.campos), "anular no toca el flag");
  r = transicionSede("anulada", "costeo_ok");
  assert.equal(r.estado, "lista_para_enviar");
  r = transicionSede("lista_para_enviar", "reclamada_admin");
  assert.equal(r.estado, "enviando");
  const final = transicionSede("enviando", "envio_ok", {
    requiereCorreccion: true,
    correccionOrdenVersion,
    claimCosteoOrdenVersion: 5,
  });
  assert.equal(final.estado, "enviada");
  assert.equal(final.campos.requiere_correccion, false);
});

test("[M2] correccion_descartada limpia siempre, también correccion_orden_version", () => {
  const r = transicionSede("enviada", "correccion_descartada", {
    requiereCorreccion: true,
    correccionOrdenVersion: 9,
    claimCosteoOrdenVersion: 1,
  });
  assert.equal(r.campos.requiere_correccion, false);
  assert.equal(r.campos.correccion_orden_version, null);
});

// ─── I1: no volver a bloquear lo ya bloqueado por servicio_cero ────────────

test("I1: bloqueada(servicio_cero) + costeo_bloqueado(servicio_cero) es un no-op sin escritura ni alerta", () => {
  const r = transicionSede("bloqueada", "costeo_bloqueado", {
    motivoBloqueo: "servicio_cero",
    motivo: "servicio_cero",
    detalle: "otro detalle",
  });
  assert.equal(r.estado, "bloqueada");
  assert.equal(r.sinCambios, true);
  assert.deepEqual(r.campos, {});
  assert.deepEqual(r.efectos, []);
});

test("I1: el no-op solo aplica a servicio_cero sobre servicio_cero", () => {
  const otroMotivo = transicionSede("bloqueada", "costeo_bloqueado", {
    motivoBloqueo: "utilidad_negativa",
    motivo: "servicio_cero",
  });
  assert.equal(otroMotivo.sinCambios, undefined);
  assert.equal(otroMotivo.campos.motivo_bloqueo, "servicio_cero");
  assert.ok(hay(otroMotivo.efectos, { tipo: "alerta", evento: "servicio_cero" }));

  const aOtro = transicionSede("bloqueada", "costeo_bloqueado", {
    motivoBloqueo: "servicio_cero",
    motivo: "costeo_invalido",
  });
  assert.equal(aOtro.sinCambios, undefined);
  assert.equal(aOtro.campos.motivo_bloqueo, "costeo_invalido");

  const desdeVinculada = transicionSede("vinculada", "costeo_bloqueado", { motivo: "servicio_cero" });
  assert.equal(desdeVinculada.sinCambios, undefined);
  assert.ok(hay(desdeVinculada.efectos, { tipo: "alerta", evento: "servicio_cero" }));
});

test("JD S2: enviando + abandono_agotado -> error transitorio con reintentos_agotados, libera el reclamo y alerta", () => {
  const r = transicionSede("enviando", "abandono_agotado", { intentos: 3, envioId: null });
  assert.equal(r.estado, "error");
  assert.equal(r.campos.error_tipo, "transitorio");
  assert.equal(r.campos.motivo_pendiente, "reintentos_agotados");
  assert.equal(r.campos.claim_token, null);
  assert.equal(r.campos.claimed_at, null);
  assert.ok(hay(r.efectos, { tipo: "alerta", evento: "reintentos_agotados" }));
  assert.throws(() => transicionSede("calculada", "abandono_agotado", {}), /transición inválida/);
});
