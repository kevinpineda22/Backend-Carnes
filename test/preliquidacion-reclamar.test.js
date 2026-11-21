import test from "node:test";
import assert from "node:assert/strict";

import { puedeReclamar, costeoVigente } from "../src/shared/preliquidacionEstados.js";

const AHORA = new Date("2026-11-20T03:00:00.000Z");
const HACE_10_MIN = new Date(AHORA.getTime() - 600_000).toISOString();
const HACE_1_MIN = new Date(AHORA.getTime() - 60_000).toISOString();

const HEADER = { orden_version: 2, liquidada_at: "2026-11-20T02:30:00.000Z" };

/** Sede con costeo vigente: coincide con la versión de orden y los animales del header. */
const sede = (extra = {}) => ({
  id: 7,
  estado: "calculada",
  animales: 4,
  gasto_sede: "1000.00",
  costeo_orden_version: 2,
  costeo_animales: 4,
  intentos: 0,
  error_tipo: null,
  ultima_corrida: null,
  envio_id: null,
  claimed_at: null,
  ...extra,
});

const contexto = (extra = {}) => ({
  header: HEADER,
  origen: "schedule",
  corridaId: 50,
  siesaActivo: true,
  ahora: AHORA,
  ...extra,
});

const AUTOMATICOS = ["schedule", "sweep", "dispatch", "inmediato"];

// ─── costeoVigente (guarda de montos obsoletos, T2) ────────────────────────

test("costeoVigente: true cuando orden_version y animales coinciden", () => {
  assert.equal(costeoVigente(sede(), HEADER), true);
});

test("costeoVigente: false si gasto_sede es null", () => {
  assert.equal(costeoVigente(sede({ gasto_sede: null }), HEADER), false);
});

test("costeoVigente: false si el costeo usó otra orden_version", () => {
  assert.equal(costeoVigente(sede({ costeo_orden_version: 1 }), HEADER), false);
});

test("costeoVigente: false si los animales cambiaron desde el costeo", () => {
  assert.equal(costeoVigente(sede({ costeo_animales: 3 }), HEADER), false);
});

test("costeoVigente: false si costeo_orden_version o costeo_animales son null", () => {
  assert.equal(costeoVigente(sede({ costeo_orden_version: null }), HEADER), false);
  assert.equal(costeoVigente(sede({ costeo_animales: null }), HEADER), false);
});

// ─── Conjunto automático ───────────────────────────────────────────────────

for (const origen of AUTOMATICOS) {
  test(`[${origen}] calculada con costeo vigente es reclamable sin reiniciar intentos`, () => {
    assert.deepEqual(puedeReclamar(sede(), contexto({ origen })), { ok: true, resetIntentos: false });
  });
}

test("simulada es reclamable en automático solo con SIESA activo", () => {
  assert.deepEqual(puedeReclamar(sede({ estado: "simulada" }), contexto({ siesaActivo: true })), {
    ok: true,
    resetIntentos: false,
  });
  const apagado = puedeReclamar(sede({ estado: "simulada" }), contexto({ siesaActivo: false }));
  assert.equal(apagado.ok, false);
  assert.equal(apagado.motivo, "siesa_apagado");
});

test("error transitorio con intentos < 3 de otra corrida es reclamable", () => {
  const s = sede({ estado: "error", error_tipo: "transitorio", intentos: 2, ultima_corrida: 49 });
  assert.deepEqual(puedeReclamar(s, contexto()), { ok: true, resetIntentos: false });
});

test("error transitorio nunca reclamado (ultima_corrida NULL) es reclamable", () => {
  const s = sede({ estado: "error", error_tipo: "transitorio", intentos: 1, ultima_corrida: null });
  assert.equal(puedeReclamar(s, contexto()).ok, true);
});

test("error transitorio ya intentado en esta misma corrida no se reclama", () => {
  const s = sede({ estado: "error", error_tipo: "transitorio", intentos: 1, ultima_corrida: 50 });
  const r = puedeReclamar(s, contexto({ corridaId: 50 }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "ya_intentada_en_corrida");
});

test("error transitorio con 3 intentos queda solo para el admin", () => {
  const s = sede({ estado: "error", error_tipo: "transitorio", intentos: 3, ultima_corrida: 49 });
  const r = puedeReclamar(s, contexto());
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "requiere_admin");
});

test("error permanente queda solo para el admin", () => {
  const s = sede({ estado: "error", error_tipo: "permanente", intentos: 1, ultima_corrida: 49 });
  const r = puedeReclamar(s, contexto());
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "requiere_admin");
});

test("enviando abandonado (sin envio_id, claimed_at < ahora - 360 s) es reclamable", () => {
  const s = sede({ estado: "enviando", envio_id: null, claimed_at: HACE_10_MIN });
  assert.deepEqual(puedeReclamar(s, contexto()), { ok: true, resetIntentos: false });
});

test("enviando reciente (claimed_at dentro del plazo de abandono) no se reclama", () => {
  const s = sede({ estado: "enviando", envio_id: null, claimed_at: HACE_1_MIN });
  const r = puedeReclamar(s, contexto());
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "estado_no_reclamable");
});

test("el plazo de abandono es configurable (abandonoS)", () => {
  const s = sede({ estado: "enviando", envio_id: null, claimed_at: HACE_1_MIN });
  assert.equal(puedeReclamar(s, contexto({ abandonoS: 30 })).ok, true);
});

test("enviando con envio_id nunca se reclama, ni siquiera abandonado", () => {
  const s = sede({ estado: "enviando", envio_id: 99, claimed_at: HACE_10_MIN });
  for (const origen of [...AUTOMATICOS, "admin"]) {
    const r = puedeReclamar(s, contexto({ origen }));
    assert.equal(r.ok, false, origen);
    assert.equal(r.motivo, "estado_no_reclamable", origen);
  }
});

// ─── Nunca reclamables (ningún origen) ─────────────────────────────────────

for (const estado of ["vinculada", "bloqueada", "sin_confirmar", "anulada", "enviada"]) {
  test(`${estado} no es reclamable por ningún origen`, () => {
    for (const origen of [...AUTOMATICOS, "admin"]) {
      const r = puedeReclamar(sede({ estado }), contexto({ origen }));
      assert.equal(r.ok, false, `${estado}/${origen}`);
      assert.equal(r.motivo, "estado_no_reclamable", `${estado}/${origen}`);
    }
  });
}

test("lista_para_enviar no se reclama automáticamente (requiere admin)", () => {
  for (const origen of AUTOMATICOS) {
    const r = puedeReclamar(sede({ estado: "lista_para_enviar" }), contexto({ origen }));
    assert.equal(r.ok, false, origen);
    assert.equal(r.motivo, "requiere_admin", origen);
  }
});

// ─── Conjunto del admin ────────────────────────────────────────────────────

test("admin reclama lista_para_enviar y reinicia intentos", () => {
  const r = puedeReclamar(sede({ estado: "lista_para_enviar", intentos: 2 }), contexto({ origen: "admin" }));
  assert.deepEqual(r, { ok: true, resetIntentos: true });
});

test("admin reclama error de cualquier tipo e intentos y reinicia intentos", () => {
  for (const [error_tipo, intentos] of [["permanente", 1], ["transitorio", 3], ["transitorio", 5]]) {
    const s = sede({ estado: "error", error_tipo, intentos, ultima_corrida: 50 });
    assert.deepEqual(puedeReclamar(s, contexto({ origen: "admin", corridaId: 50 })), { ok: true, resetIntentos: true }, `${error_tipo}/${intentos}`);
  }
});

test("admin reclama simulada (SIESA activo) y reinicia intentos", () => {
  const r = puedeReclamar(sede({ estado: "simulada" }), contexto({ origen: "admin", siesaActivo: true }));
  assert.deepEqual(r, { ok: true, resetIntentos: true });
});

test("admin reclama calculada sin reiniciar intentos (conjunto automático)", () => {
  assert.deepEqual(puedeReclamar(sede(), contexto({ origen: "admin" })), { ok: true, resetIntentos: false });
});

// ─── Guarda de costeo desactualizado: TODOS los orígenes ───────────────────

const OBSOLETOS = [
  ["gasto_sede NULL", { gasto_sede: null }],
  ["costeo_orden_version distinto", { costeo_orden_version: 1 }],
  ["costeo_animales distinto", { costeo_animales: 3 }],
];

for (const origen of [...AUTOMATICOS, "admin"]) {
  for (const [nombre, parche] of OBSOLETOS) {
    test(`[${origen}] calculada con ${nombre} -> costeo_desactualizado`, () => {
      const r = puedeReclamar(sede(parche), contexto({ origen }));
      assert.equal(r.ok, false);
      assert.equal(r.motivo, "costeo_desactualizado");
    });
  }
}

test("admin con lista_para_enviar obsoleta -> costeo_desactualizado (debe recostear antes)", () => {
  const r = puedeReclamar(sede({ estado: "lista_para_enviar", costeo_orden_version: 1 }), contexto({ origen: "admin" }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "costeo_desactualizado");
});

test("admin con error obsoleto -> costeo_desactualizado", () => {
  const r = puedeReclamar(sede({ estado: "error", error_tipo: "permanente", costeo_animales: 9 }), contexto({ origen: "admin" }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "costeo_desactualizado");
});

test("puedeReclamar exige header y corridaId para orígenes automáticos", () => {
  assert.throws(() => puedeReclamar(sede(), { origen: "schedule", ahora: AHORA, siesaActivo: true }), /header/);
  assert.throws(() => puedeReclamar(sede(), contexto({ corridaId: null })), /corridaId/);
});
