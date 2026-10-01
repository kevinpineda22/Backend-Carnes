import test from "node:test";
import assert from "node:assert/strict";

import {
  DIAS_BORRADOR_VIEJO,
  avisosDeFactura,
  decidirApertura,
  diasDesde,
  esConflictoReintentable,
  esRecepcionNoBorrador,
  esViolacionUnica,
  formatearFechaBogota,
  mensajeFacturaEnRecepcion,
  mensajeFacturaRecibida,
  mensajeVerificacionQr,
  renglonesDesdePlantilla,
} from "../src/shared/aperturaProveedor.js";

// La regla que decide qué pasa cuando alguien abre una factura que ya existe. Si
// esto se rompe, una factura se recibe dos veces (compra doble en SIESA) o un
// recibidor queda fuera de su propio borrador tras recargar el celular.

// 30/09/2026 a las 10:00 en Bogotá (UTC-5).
const AHORA = new Date("2026-09-30T15:00:00Z");

const BELLO = { id: 7, nombre: "Bello" };
const ITAGUI = { id: 9, nombre: "Itagüí" };

const borrador = (extra = {}) => ({
  id: 1,
  estado: "Borrador",
  sede_id: 7,
  sede: BELLO,
  abierto_at: "2026-09-30T14:00:00Z",
  finalizado_at: null,
  fecha_recepcion: "2026-09-30",
  ...extra,
});
const finalizada = (extra = {}) => ({
  ...borrador(),
  id: 2,
  estado: "Finalizada",
  finalizado_at: "2026-09-28T16:30:00Z",
  fecha_recepcion: "2026-09-28",
  ...extra,
});

// ─── Fechas ────────────────────────────────────────────────────────────────

test("formatearFechaBogota: DATE tal cual, timestamptz en hora de Bogotá", () => {
  assert.equal(formatearFechaBogota("2026-09-28"), "28/09/2026");
  // 02:00 UTC del día 29 es las 9 p. m. del 28 en Bogotá: el día NO es el de UTC.
  assert.equal(formatearFechaBogota("2026-09-29T02:00:00Z"), "28/09/2026");
  assert.equal(formatearFechaBogota(new Date("2026-09-29T12:00:00Z")), "29/09/2026");
  assert.equal(formatearFechaBogota(null), "");
  assert.equal(formatearFechaBogota("no es fecha"), "");
});

test("diasDesde: por día de calendario de Bogotá, nunca negativo", () => {
  assert.equal(diasDesde("2026-09-30T14:00:00Z", AHORA), 0);
  // Abierto ayer a las 11 p. m. (Bogotá) y ahora son las 10 a. m.: 1 día, no 11 horas.
  assert.equal(diasDesde("2026-09-30T04:00:00Z", AHORA), 1);
  assert.equal(diasDesde("2026-09-25", AHORA), 5);
  assert.equal(diasDesde("2026-10-05", AHORA), 0);
  assert.equal(diasDesde(null, AHORA), 0);
});

// ─── Mensajes ──────────────────────────────────────────────────────────────

test("mensajeFacturaRecibida: literal del spec, con la fecha de la firma en Bogotá", () => {
  assert.equal(
    mensajeFacturaRecibida(finalizada()),
    "Esta factura ya se recibió el 28/09/2026 en Bello",
  );
});

test("mensajeFacturaRecibida: sin finalizado_at usa la fecha de la recepción", () => {
  assert.equal(
    mensajeFacturaRecibida(finalizada({ finalizado_at: null, fecha_recepcion: "2026-09-27" })),
    "Esta factura ya se recibió el 27/09/2026 en Bello",
  );
});

test("mensajeFacturaEnRecepcion: borrador de hoy no dice días ni sugiere descartar", () => {
  assert.equal(
    mensajeFacturaEnRecepcion(borrador(), AHORA),
    "Esta factura está en recepción desde el 30/09/2026 en Bello",
  );
});

test("[J1] mensajeFacturaEnRecepcion: dice los días que lleva abierto", () => {
  assert.equal(
    mensajeFacturaEnRecepcion(borrador({ abierto_at: "2026-09-29T15:00:00Z" }), AHORA),
    "Esta factura está en recepción desde el 29/09/2026 en Bello (hace 1 día)",
  );
  assert.equal(
    mensajeFacturaEnRecepcion(borrador({ abierto_at: "2026-09-28T15:00:00Z" }), AHORA),
    "Esta factura está en recepción desde el 28/09/2026 en Bello (hace 2 días)",
  );
});

test("[J1] mensajeFacturaEnRecepcion: pasado el umbral avisa que un admin puede descartarlo", () => {
  assert.ok(DIAS_BORRADOR_VIEJO >= 1);
  const viejo = borrador({ abierto_at: "2026-09-20T15:00:00Z" });
  const mensaje = mensajeFacturaEnRecepcion(viejo, AHORA);
  assert.match(mensaje, /^Esta factura está en recepción desde el 20\/09\/2026 en Bello \(hace 10 días\)/);
  assert.match(mensaje, /un administrador puede descartar el borrador/);

  // Justo por debajo del umbral, no.
  const reciente = borrador({ abierto_at: "2026-09-28T15:00:00Z" });
  assert.doesNotMatch(mensajeFacturaEnRecepcion(reciente, AHORA), /descartar/);
});

test("los mensajes no se rompen sin la sede embebida", () => {
  assert.match(mensajeFacturaRecibida(finalizada({ sede: null })), /en otra sede$/);
});

test("mensajeVerificacionQr: los tres casos de Talleres", () => {
  assert.match(mensajeVerificacionQr({ estado: "desconocido", sede: null }), /no está registrado/);
  assert.match(
    mensajeVerificacionQr({ estado: "sede_inactiva", sede: { nombre: "Bello" } }),
    /Bello, que está inactiva/,
  );
  assert.match(
    mensajeVerificacionQr({ estado: "sede_distinta", sede: { nombre: "Bello" } }),
    /es de Bello/,
  );
});

// ─── Decisión ──────────────────────────────────────────────────────────────

test("sin nada previo: se crea", () => {
  assert.deepEqual(decidirApertura([], 7, AHORA), { accion: "crear" });
  assert.deepEqual(decidirApertura(undefined, 7, AHORA), { accion: "crear" });
});

test("una Anulada no cuenta: la factura se puede volver a recibir", () => {
  assert.deepEqual(decidirApertura([finalizada({ estado: "Anulada" })], 7, AHORA), { accion: "crear" });
});

test("Finalizada o Enviada_SIESA: bloquea con el mensaje de duplicado", () => {
  for (const estado of ["Finalizada", "Enviada_SIESA"]) {
    const r = decidirApertura([finalizada({ estado })], 7, AHORA);
    assert.equal(r.accion, "bloquear");
    assert.equal(r.codigo, "FACTURA_YA_RECIBIDA");
    assert.equal(r.mensaje, "Esta factura ya se recibió el 28/09/2026 en Bello");
  }
});

test("la factura recibida bloquea incluso en otra sede", () => {
  const r = decidirApertura([finalizada({ sede_id: 9, sede: ITAGUI })], 7, AHORA);
  assert.equal(r.accion, "bloquear");
  assert.match(r.mensaje, /en Itagüí$/);
});

test("Borrador de ESTA sede: se reanuda (recargar el celular no deja fuera al recibidor)", () => {
  assert.deepEqual(decidirApertura([borrador({ id: 41 })], 7, AHORA), { accion: "reanudar", id: 41 });
  // sede_id puede venir como texto.
  assert.deepEqual(decidirApertura([borrador({ id: 41, sede_id: "7" })], 7, AHORA), {
    accion: "reanudar",
    id: 41,
  });
});

test("Borrador de OTRA sede: bloquea, con la antigüedad", () => {
  const r = decidirApertura(
    [borrador({ id: 41, sede_id: 9, sede: ITAGUI, abierto_at: "2026-09-27T15:00:00Z" })],
    7,
    AHORA,
  );
  assert.equal(r.accion, "bloquear");
  assert.equal(r.codigo, "FACTURA_EN_RECEPCION");
  assert.match(r.mensaje, /en Itagüí \(hace 3 días\)\. Si quedó abierta por error/);
});

test("una ya recibida pesa más que un borrador propio", () => {
  const r = decidirApertura([borrador({ id: 41 }), finalizada()], 7, AHORA);
  assert.equal(r.accion, "bloquear");
  assert.equal(r.codigo, "FACTURA_YA_RECIBIDA");
});

test("un borrador propio se reanuda aunque haya otro de otra sede", () => {
  const r = decidirApertura(
    [borrador({ id: 40, sede_id: 9, sede: ITAGUI }), borrador({ id: 41 })],
    7,
    AHORA,
  );
  assert.deepEqual(r, { accion: "reanudar", id: 41 });
});

// ─── Avisos y renglones ────────────────────────────────────────────────────

test("factura de más de 12 caracteres: aviso (no bloqueo) y nunca recortada", () => {
  assert.deepEqual(avisosDeFactura("F-100"), []);
  assert.deepEqual(avisosDeFactura("123456789012"), []);
  const [aviso, ...resto] = avisosDeFactura("FACT-2026-000123");
  assert.equal(resto.length, 0);
  assert.equal(aviso.tipo, "factura_larga");
  assert.match(aviso.mensaje, /12 caracteres/);
});

test("renglonesDesdePlantilla: snapshot completo, equivalencia vacía por defecto", () => {
  const plantilla = [
    { id: 11, codigo_item: "1234", descripcion_item: "POLLO ENTERO", unidad: "KL", equivalencia: "Pollo 1", orden: 1 },
    { id: 12, codigo_item: "5678", descripcion_item: undefined, unidad: "UND", equivalencia: undefined, orden: undefined },
  ];
  assert.deepEqual(renglonesDesdePlantilla(plantilla, 99), [
    {
      recepcion_id: 99,
      equivalencia_id: 11,
      codigo_item: "1234",
      descripcion_item: "POLLO ENTERO",
      unidad: "KL",
      equivalencia: "Pollo 1",
      orden: 1,
    },
    {
      recepcion_id: 99,
      equivalencia_id: 12,
      codigo_item: "5678",
      descripcion_item: null,
      unidad: "UND",
      equivalencia: "",
      orden: 0,
    },
  ]);
  assert.deepEqual(renglonesDesdePlantilla([], 99), []);
});

// ─── Errores de la base ────────────────────────────────────────────────────

test("esViolacionUnica: solo 23505", () => {
  assert.equal(esViolacionUnica({ code: "23505" }), true);
  assert.equal(esViolacionUnica({ code: "23503" }), false);
  assert.equal(esViolacionUnica(null), false);
});

test("esRecepcionNoBorrador: SQLSTATE PV409 del guardián, o su texto", () => {
  assert.equal(esRecepcionNoBorrador({ code: "PV409", message: "x" }), true);
  assert.equal(
    esRecepcionNoBorrador({ message: "La recepción 5 ya no está en borrador (estado Finalizada)." }),
    true,
  );
  assert.equal(esRecepcionNoBorrador({ code: "23505", message: "duplicate key" }), false);
  assert.equal(esRecepcionNoBorrador(null), false);
});

test("esConflictoReintentable: deadlock y serialización, nada más", () => {
  assert.equal(esConflictoReintentable({ code: "40P01" }), true);
  assert.equal(esConflictoReintentable({ code: "40001" }), true);
  assert.equal(esConflictoReintentable({ code: "23505" }), false);
  assert.equal(esConflictoReintentable(null), false);
});

test("decidirApertura no expone campos de más al bloquear", () => {
  const r = decidirApertura([borrador({ id: 41, sede_id: 9, sede: ITAGUI })], 7, AHORA);
  assert.deepEqual(Object.keys(r).sort(), ["accion", "codigo", "mensaje"]);
});
