import test from "node:test";
import assert from "node:assert/strict";

import {
  ESTADOS,
  puedeTransicionar,
  validarTransicion,
  puedeEditarCantidades,
  puedeCostear,
  esEstadoValido,
} from "../src/shared/estados.js";

test("el camino feliz completo está permitido", () => {
  const camino = [
    ESTADOS.BORRADOR,
    ESTADOS.RECIBIDO,
    ESTADOS.APROBADO,
    ESTADOS.COSTEADO,
    ESTADOS.ENVIADO_SIESA,
  ];

  for (let i = 0; i < camino.length - 1; i++) {
    assert.ok(
      puedeTransicionar(camino[i], camino[i + 1]),
      `debería permitir ${camino[i]} → ${camino[i + 1]}`,
    );
  }
});

test("Enviado_SIESA es terminal: no sale a NINGÚN estado", () => {
  // El documento ya existe en el ERP. Cambiarlo acá crearía dos versiones de la
  // misma entrega, y la de SIESA —la que vale— seguiría diciendo lo de antes.
  for (const destino of Object.values(ESTADOS)) {
    assert.equal(
      puedeTransicionar(ESTADOS.ENVIADO_SIESA, destino),
      false,
      `no debería permitir Enviado_SIESA → ${destino}`,
    );
  }
});

test("un rechazo vuelve a borrador, pero un recibido NO", () => {
  // Si el admin ve algo mal, RECHAZA — y el rechazo deja el motivo escrito.
  // Una vuelta silenciosa a borrador borraría la razón.
  assert.ok(puedeTransicionar(ESTADOS.RECHAZADO, ESTADOS.BORRADOR));
  assert.equal(puedeTransicionar(ESTADOS.RECIBIDO, ESTADOS.BORRADOR), false);
});

test("se puede deshacer una aprobación y un costeo", () => {
  assert.ok(puedeTransicionar(ESTADOS.APROBADO, ESTADOS.RECIBIDO));
  assert.ok(puedeTransicionar(ESTADOS.COSTEADO, ESTADOS.APROBADO));
});

test("no se puede saltear pasos", () => {
  assert.equal(puedeTransicionar(ESTADOS.BORRADOR, ESTADOS.APROBADO), false);
  assert.equal(puedeTransicionar(ESTADOS.BORRADOR, ESTADOS.ENVIADO_SIESA), false);
  assert.equal(puedeTransicionar(ESTADOS.RECIBIDO, ESTADOS.COSTEADO), false);
});

test("el motivo del rechazo es texto para una persona, no para un log", () => {
  const r = validarTransicion(ESTADOS.ENVIADO_SIESA, ESTADOS.APROBADO);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya se subió a SIESA/);
});

test("quedarse en el mismo estado no es una transición", () => {
  const r = validarTransicion(ESTADOS.RECIBIDO, ESTADOS.RECIBIDO);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya está/);
});

test("un estado inventado no pasa", () => {
  assert.equal(esEstadoValido("Pendiente"), false);
  assert.equal(validarTransicion("Pendiente", ESTADOS.RECIBIDO).ok, false);
  assert.equal(validarTransicion(ESTADOS.BORRADOR, "Pendiente").ok, false);
  assert.equal(validarTransicion(undefined, ESTADOS.RECIBIDO).ok, false);
});

test("las cantidades solo se editan en borrador", () => {
  assert.ok(puedeEditarCantidades(ESTADOS.BORRADOR));
  for (const e of [
    ESTADOS.RECIBIDO,
    ESTADOS.APROBADO,
    ESTADOS.COSTEADO,
    ESTADOS.ENVIADO_SIESA,
    ESTADOS.RECHAZADO,
  ]) {
    assert.equal(puedeEditarCantidades(e), false, `${e} no debería ser editable`);
  }
});

test("el costeo solo escribe sobre aprobado o ya costeado", () => {
  assert.ok(puedeCostear(ESTADOS.APROBADO));
  assert.ok(puedeCostear(ESTADOS.COSTEADO));
  assert.equal(puedeCostear(ESTADOS.BORRADOR), false);
  assert.equal(puedeCostear(ESTADOS.RECIBIDO), false);
  // Ya está en el ERP: recostear cambiaría la plata de un documento cerrado.
  assert.equal(puedeCostear(ESTADOS.ENVIADO_SIESA), false);
});
