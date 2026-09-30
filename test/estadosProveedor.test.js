import test from "node:test";
import assert from "node:assert/strict";

import {
  ESTADOS,
  puedeTransicionar,
  validarTransicion,
  puedeEditarCantidades,
  puedeDescartar,
  estaFirmada,
  puedeAnular,
  puedeEnviarASiesa,
  esEstadoValido,
} from "../src/shared/estadosProveedor.js";

test("el camino feliz: Borrador → Finalizada → Enviada_SIESA", () => {
  assert.ok(puedeTransicionar(ESTADOS.BORRADOR, ESTADOS.FINALIZADA));
  assert.ok(puedeTransicionar(ESTADOS.FINALIZADA, ESTADOS.ENVIADA_SIESA));
});

test("Finalizada y Enviada_SIESA salen solo a Anulada (Finalizada también a Enviada_SIESA)", () => {
  for (const destino of Object.values(ESTADOS)) {
    assert.equal(
      puedeTransicionar(ESTADOS.ENVIADA_SIESA, destino),
      destino === ESTADOS.ANULADA,
      `Enviada_SIESA → ${destino}`,
    );
    assert.equal(
      puedeTransicionar(ESTADOS.FINALIZADA, destino),
      destino === ESTADOS.ANULADA || destino === ESTADOS.ENVIADA_SIESA,
      `Finalizada → ${destino}`,
    );
  }
});

test("Anulada es terminal", () => {
  for (const destino of Object.values(ESTADOS)) {
    assert.equal(puedeTransicionar(ESTADOS.ANULADA, destino), false, `Anulada → ${destino}`);
  }
});

test("un borrador no se anula ni se envía: se descarta", () => {
  assert.equal(puedeTransicionar(ESTADOS.BORRADOR, ESTADOS.ANULADA), false);
  assert.equal(puedeTransicionar(ESTADOS.BORRADOR, ESTADOS.ENVIADA_SIESA), false);
});

test("un estado con nombre de propiedad heredada no revienta", () => {
  assert.equal(puedeTransicionar("constructor", ESTADOS.FINALIZADA), false);
  assert.equal(puedeTransicionar("toString", ESTADOS.ANULADA), false);
});

test("después de firmar no se vuelve a borrador", () => {
  for (const desde of [ESTADOS.FINALIZADA, ESTADOS.ENVIADA_SIESA, ESTADOS.ANULADA]) {
    assert.equal(puedeTransicionar(desde, ESTADOS.BORRADOR), false, `${desde} → Borrador`);
  }
});

test("el motivo del rechazo es texto para una persona", () => {
  const r = validarTransicion(ESTADOS.ENVIADA_SIESA, ESTADOS.FINALIZADA);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya se subió a SIESA/);

  const firmada = validarTransicion(ESTADOS.FINALIZADA, ESTADOS.BORRADOR);
  assert.match(firmada.motivo, /ya la firmó el recibidor/);

  const anulada = validarTransicion(ESTADOS.ANULADA, ESTADOS.FINALIZADA);
  assert.match(anulada.motivo, /está anulada/);
});

test("una transición permitida devuelve ok y sin motivo", () => {
  assert.deepEqual(validarTransicion(ESTADOS.BORRADOR, ESTADOS.FINALIZADA), { ok: true, motivo: null });
});

test("quedarse en el mismo estado no es una transición", () => {
  const r = validarTransicion(ESTADOS.FINALIZADA, ESTADOS.FINALIZADA);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya está/);
});

test("un estado inventado no pasa (ni uno de Talleres)", () => {
  assert.equal(esEstadoValido("Pendiente"), false);
  assert.equal(esEstadoValido("Aprobado"), false);
  assert.equal(esEstadoValido("Costeado"), false);
  assert.equal(validarTransicion("Pendiente", ESTADOS.FINALIZADA).ok, false);
  assert.equal(validarTransicion(ESTADOS.BORRADOR, "Pendiente").ok, false);
  assert.equal(validarTransicion(undefined, ESTADOS.FINALIZADA).ok, false);
});

test("los valores de ESTADOS coinciden con el CHECK de sql/022", () => {
  assert.deepEqual(Object.values(ESTADOS), ["Borrador", "Finalizada", "Enviada_SIESA", "Anulada"]);
});

test("las cantidades y el descarte solo en borrador", () => {
  assert.ok(puedeEditarCantidades(ESTADOS.BORRADOR));
  assert.ok(puedeDescartar(ESTADOS.BORRADOR));
  for (const e of [ESTADOS.FINALIZADA, ESTADOS.ENVIADA_SIESA, ESTADOS.ANULADA]) {
    assert.equal(puedeEditarCantidades(e), false, `${e} no debería ser editable`);
    assert.equal(puedeDescartar(e), false, `${e} no debería poder descartarse`);
  }
});

test("estaFirmada: Finalizada y Enviada_SIESA (el reintento de finalizar no vuelve a firmar)", () => {
  assert.ok(estaFirmada(ESTADOS.FINALIZADA));
  assert.ok(estaFirmada(ESTADOS.ENVIADA_SIESA));
  assert.equal(estaFirmada(ESTADOS.BORRADOR), false);
  assert.equal(estaFirmada(ESTADOS.ANULADA), false);
});

test("el admin anula Finalizada o Enviada_SIESA, no un borrador ni una ya anulada", () => {
  assert.ok(puedeAnular(ESTADOS.FINALIZADA));
  assert.ok(puedeAnular(ESTADOS.ENVIADA_SIESA));
  assert.equal(puedeAnular(ESTADOS.BORRADOR), false);
  assert.equal(puedeAnular(ESTADOS.ANULADA), false);
});

test("(re)enviar a SIESA solo desde Finalizada", () => {
  assert.ok(puedeEnviarASiesa(ESTADOS.FINALIZADA));
  for (const e of [ESTADOS.BORRADOR, ESTADOS.ENVIADA_SIESA, ESTADOS.ANULADA]) {
    assert.equal(puedeEnviarASiesa(e), false, `${e} no debería poder (re)enviarse`);
  }
});
