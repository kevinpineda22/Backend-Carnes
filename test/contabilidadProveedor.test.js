import test from "node:test";
import assert from "node:assert/strict";

import {
  puedeAbrirAdminCarnes,
  puedeAbrirContabilidadCarnes,
  puedeAprobarContabilidadCarnes,
  puedeVerContabilidadCarnes,
} from "../src/shared/permisoAdminCarnes.js";
import {
  COLUMNAS_DETALLE_ADMIN,
  COLUMNAS_LISTA_ADMIN,
  aprobacionParaContabilidad,
  decidirAprobacionContabilidad,
  detalleParaContabilidad,
} from "../src/shared/adminProveedor.js";

// Contabilidad: quién entra a su página, quién aprueba, qué se puede aprobar y qué
// NO se le entrega (firma, cédula, acciones de admin). Todo puro, sin red.

const perfil = (personal_routes = [], role = "contabilidad") => ({ role, personal_routes });
const rol = (permissions = [], redirect = "/acceso") => ({ permissions, redirect });
const CONTAB = [{ path: "/carnes/contabilidad" }];
const ADMIN = [{ path: "/carnes/admin" }];

// ─── Permisos ───────────────────────────────────────────────────────────────

test("contabilidad pura: abre su página, la ve y aprueba; no abre el admin", () => {
  const ctx = { profile: perfil(CONTAB), roleConfig: rol() };
  assert.equal(puedeAbrirContabilidadCarnes(ctx), true);
  assert.equal(puedeAbrirAdminCarnes(ctx), false);
  assert.equal(puedeVerContabilidadCarnes(ctx), true);
  assert.equal(puedeAprobarContabilidadCarnes(ctx), true);
});

test("admin normal: ve la página de contabilidad (lectura) pero NO aprueba", () => {
  const ctx = { profile: perfil(ADMIN, "carnes"), roleConfig: rol() };
  assert.equal(puedeAbrirContabilidadCarnes(ctx), false);
  assert.equal(puedeVerContabilidadCarnes(ctx), true);
  assert.equal(puedeAprobarContabilidadCarnes(ctx), false);
});

test("quien tiene /carnes completo cubre las dos rutas: ve, pero NO aprueba", () => {
  const ctx = { profile: perfil([{ path: "/carnes" }], "carnes"), roleConfig: rol() };
  assert.equal(puedeAbrirContabilidadCarnes(ctx), true);
  assert.equal(puedeAbrirAdminCarnes(ctx), true);
  assert.equal(puedeAprobarContabilidadCarnes(ctx), false);
});

test("sin rutas personales usa las del rol (misma regla del Login)", () => {
  const ctx = { profile: perfil([]), roleConfig: rol(CONTAB) };
  assert.equal(puedeAprobarContabilidadCarnes(ctx), true);
});

test("rutas personales PISAN las del rol: agregar una sola ruta personal le quita lo del rol", () => {
  // La trampa que explica sql/032b: personal_routes no vacío reemplaza al rol.
  const ctx = { profile: perfil([{ path: "/epp" }]), roleConfig: rol(CONTAB) };
  assert.equal(puedeAbrirContabilidadCarnes(ctx), false);
});

test("el redirect del rol a /carnes/contabilidad también abre la página", () => {
  const ctx = { profile: perfil([], "carnes"), roleConfig: rol([], "/carnes/contabilidad") };
  assert.equal(puedeAbrirContabilidadCarnes(ctx), true);
});

test("segmento, no prefijo: /carnes/contabilidad-x no cuenta", () => {
  const ctx = { profile: perfil([{ path: "/carnes/contabilidad-x" }]), roleConfig: rol() };
  assert.equal(puedeAbrirContabilidadCarnes(ctx), false);
});

test("sin perfil nadie entra", () => {
  assert.equal(puedeVerContabilidadCarnes({}), false);
  assert.equal(puedeAprobarContabilidadCarnes({ profile: null, roleConfig: rol(CONTAB) }), false);
});

test("sin permiso de carnes no ve ni aprueba", () => {
  const ctx = { profile: perfil([{ path: "/epp" }], "otro"), roleConfig: rol() };
  assert.equal(puedeVerContabilidadCarnes(ctx), false);
  assert.equal(puedeAprobarContabilidadCarnes(ctx), false);
});

// ─── Qué se puede aprobar ───────────────────────────────────────────────────

test("aprobar: una factura en SIESA y sin marca se aprueba", () => {
  assert.deepEqual(decidirAprobacionContabilidad({ estado: "Enviada_SIESA", aprobado_contabilidad_at: null }), {
    accion: "aprobar",
  });
});

test("aprobar: dos veces es 409 YA_APROBADA y dice quién (no re-escribe)", () => {
  const r = decidirAprobacionContabilidad({
    estado: "Enviada_SIESA",
    aprobado_contabilidad_at: "2026-10-30T15:00:00Z",
    aprobado_contabilidad_por: "contabilidad@merkahorrosas.com",
  });
  assert.equal(r.accion, "rechazar");
  assert.equal(r.status, 409);
  assert.equal(r.codigo, "YA_APROBADA");
  assert.match(r.mensaje, /contabilidad@merkahorrosas\.com/);
});

test("aprobar: solo Enviada_SIESA (borrador, finalizada y anulada se rechazan)", () => {
  for (const estado of ["Borrador", "Finalizada", "Anulada"]) {
    const r = decidirAprobacionContabilidad({ estado, aprobado_contabilidad_at: null });
    assert.equal(r.accion, "rechazar", estado);
    assert.equal(r.status, 409, estado);
    assert.equal(r.codigo, "ESTADO_NO_APROBABLE", estado);
  }
});

test("aprobacionParaContabilidad: dice si el botón aplica y por qué no", () => {
  assert.deepEqual(aprobacionParaContabilidad({ estado: "Enviada_SIESA", aprobado_contabilidad_at: null }), {
    puede_aprobar: true,
    codigo: null,
    motivo: null,
  });
  const ya = aprobacionParaContabilidad({ estado: "Enviada_SIESA", aprobado_contabilidad_at: "2026-10-30T15:00:00Z" });
  assert.equal(ya.puede_aprobar, false);
  assert.equal(ya.codigo, "YA_APROBADA");
});

// ─── Qué NO se le entrega a contabilidad ────────────────────────────────────

test("detalle de contabilidad: sin firma, cédula, documento del proveedor ni acciones", () => {
  const completo = {
    recepcion: {
      id: 7,
      estado: "Enviada_SIESA",
      factura: "F-1",
      aprobado_contabilidad_at: null,
      firma_data: "data:image/png;base64,AAA",
      recibidor_cedula: "123",
      proveedor_firma: "data:image/png;base64,BBB",
      proveedor_firma_documento: "456",
      proveedor_firma_nombre: "Proveedor Uno",
    },
    envios: [{ id: 1 }],
    siesa: { estado: "ok" },
    notaCredito: { estado: "no_requerida" },
    acciones: { anular: { permitido: true } },
  };
  const r = detalleParaContabilidad(completo);
  for (const k of ["firma_data", "recibidor_cedula", "proveedor_firma", "proveedor_firma_documento"]) {
    assert.equal(k in r.recepcion, false, `${k} no debe salir`);
  }
  assert.equal("acciones" in r, false);
  assert.equal(r.recepcion.factura, "F-1");
  assert.equal(r.recepcion.aprobacion.puede_aprobar, true);
  assert.deepEqual(r.envios, [{ id: 1 }]);
});

test("columnas: la lista y el detalle traen la marca de aprobación", () => {
  for (const c of ["aprobado_contabilidad_at", "aprobado_contabilidad_por"]) {
    assert.ok(COLUMNAS_LISTA_ADMIN.includes(c), `lista sin ${c}`);
    assert.ok(COLUMNAS_DETALLE_ADMIN.includes(c), `detalle sin ${c}`);
  }
});
