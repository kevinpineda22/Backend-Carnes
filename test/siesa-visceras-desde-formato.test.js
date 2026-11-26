// Formato estricto de CARNES_VISCERAS_PRELIQ_DESDE: solo `YYYY-MM-DD` (00:00 Bogotá) o fecha y hora con
// zona explícita (Z o ±HH:MM). Cualquier otra cosa es inválida (falla seguro: desde = null).
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { viscerasPreliquidacionDesde, reiniciarAvisoViscerasPreliquidacionDesde } from "../src/config/siesa.js";

const AHORA = new Date("2026-11-25T12:00:00Z");

function evaluar(valor, ahora = AHORA) {
  if (valor === undefined) delete process.env.CARNES_VISCERAS_PRELIQ_DESDE;
  else process.env.CARNES_VISCERAS_PRELIQ_DESDE = valor;
  const avisos = [];
  const log = { warn: (m) => avisos.push(String(m)) };
  const r = viscerasPreliquidacionDesde({ log, ahora });
  return { r, avisos };
}

beforeEach(() => reiniciarAvisoViscerasPreliquidacionDesde());

test("YYYY-MM-DD se interpreta como 00:00 de Bogotá (UTC-05:00), no como UTC ni hora del servidor", () => {
  const { r } = evaluar("2026-11-26");
  assert.equal(r.desde.toISOString(), "2026-11-26T05:00:00.000Z");
  assert.equal(r.motivo, null);
});

test("fecha y hora con Z o con offset explícito se aceptan (con o sin segundos)", () => {
  assert.equal(evaluar("2026-11-26T00:00:00-05:00").r.desde.toISOString(), "2026-11-26T05:00:00.000Z");
  assert.equal(evaluar("2026-11-26T00:00Z").r.desde.toISOString(), "2026-11-26T00:00:00.000Z");
  assert.equal(evaluar("2026-11-26T10:30:15+02:00").r.desde.toISOString(), "2026-11-26T08:30:15.000Z");
  // la salida de Date#toISOString (con milisegundos) también es válida
  assert.equal(evaluar("2026-11-26T05:00:00.000Z").r.desde.toISOString(), "2026-11-26T05:00:00.000Z");
});

test("formatos ambiguos o sin zona son inválidos: desde null y un aviso", () => {
  for (const valor of [
    "01/12/2026", // Date.parse lo leería como 12 de enero
    "12", // Date.parse lo leería como 2001
    "2026-11-26T00:00:00", // sin offset: dependería de la hora del servidor
    "2026-11-26T00:00", // idem
    "2026-11-26 00:00:00", // espacio, sin zona
    "Nov 26 2026",
    "2026-11",
    "2026",
    "2026-11-26T00:00:00-0500", // offset sin dos puntos
    "no-es-fecha",
  ]) {
    reiniciarAvisoViscerasPreliquidacionDesde();
    const { r, avisos } = evaluar(valor);
    assert.equal(r.desde, null, valor);
    assert.equal(r.motivo, "invalida", valor);
    assert.equal(avisos.length, 1, `un aviso (${valor})`);
  }
});

test("fechas imposibles del calendario son inválidas", () => {
  for (const valor of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-11-31", "2026-11-26T25:00:00Z", "2026-11-26T10:61:00Z", "2026-11-26T10:00:61Z", "2026-11-26T10:00:00+25:00"]) {
    reiniciarAvisoViscerasPreliquidacionDesde();
    const { r } = evaluar(valor);
    assert.equal(r.desde, null, valor);
  }
});

test("sin definir: null, motivo sin_definir y un solo aviso", () => {
  const a = evaluar(undefined);
  assert.equal(a.r.desde, null);
  assert.equal(a.r.motivo, "sin_definir");
  assert.equal(a.avisos.length, 1);
});

test("piso en el futuro por más de 1 día: se acepta pero se avisa una sola vez", () => {
  const futuro = evaluar("2026-12-10");
  assert.ok(futuro.r.desde instanceof Date);
  assert.equal(futuro.avisos.length, 1);
  assert.match(futuro.avisos[0], /CARNES_VISCERAS_PRELIQ_DESDE/);
  // segunda llamada: no repite
  const log2 = [];
  viscerasPreliquidacionDesde({ log: { warn: (m) => log2.push(m) }, ahora: AHORA });
  assert.equal(log2.length, 0);
});

test("piso de hasta 1 día en el futuro o hasta 14 días atrás: sin aviso", () => {
  assert.equal(evaluar("2026-11-26T00:00:00-05:00").avisos.length, 0);
  assert.equal(evaluar("2026-11-20").avisos.length, 0);
});

test("piso de más de 14 días atrás: se acepta y se avisa una sola vez", () => {
  const viejo = evaluar("2026-10-01");
  assert.ok(viejo.r.desde instanceof Date);
  assert.equal(viejo.avisos.length, 1);
});
