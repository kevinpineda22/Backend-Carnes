import test from "node:test";
import assert from "node:assert/strict";

import {
  puedeAbrirAdminCarnes,
  puedeAbrirConsultaRecepcionesCarnes,
  puedeAbrirContabilidadCarnes,
  puedeAprobarContabilidadCarnes,
  puedeObservarLogisticaCarnes,
  puedeVerContabilidadCarnes,
} from "../src/shared/permisoAdminCarnes.js";
import {
  COLUMNAS_DETALLE_ADMIN,
  COLUMNAS_LISTA_ADMIN,
  aprobacionParaContabilidad,
  MAX_OBSERVACION_LOGISTICA,
  decidirAprobacionContabilidad,
  decidirObservacionLogistica,
  detalleParaContabilidad,
  normalizarObservacionLogistica,
} from "../src/shared/adminProveedor.js";

// Contabilidad: quién entra a su página, quién aprueba, qué se puede aprobar y qué
// NO se le entrega (firma, cédula, acciones de admin). Todo puro, sin red.

const perfil = (personal_routes = [], role = "contabilidad") => ({ role, personal_routes });
const rol = (permissions = [], redirect = "/acceso") => ({ permissions, redirect });
const CONTAB = [{ path: "/carnes/contabilidad" }];
const ADMIN = [{ path: "/carnes/admin" }];
const CONSULTA = [{ path: "/carnes/consulta-recepciones" }];

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

test("consulta de recepciones (logistica): lista y detalle SI; aprobar NO; no gana admin ni contabilidad", () => {
  const ctx = { profile: perfil(CONSULTA, "logistica"), roleConfig: rol() };
  assert.equal(puedeAbrirConsultaRecepcionesCarnes(ctx), true);
  assert.equal(puedeVerContabilidadCarnes(ctx), true);
  assert.equal(puedeAprobarContabilidadCarnes(ctx), false);
  assert.equal(puedeAbrirAdminCarnes(ctx), false);
  assert.equal(puedeAbrirContabilidadCarnes(ctx), false);
});

test("consulta: contabilidad y admin NO abren la consulta por si solos (rutas independientes)", () => {
  assert.equal(puedeAbrirConsultaRecepcionesCarnes({ profile: perfil(CONTAB), roleConfig: rol() }), false);
  assert.equal(puedeAbrirConsultaRecepcionesCarnes({ profile: perfil(ADMIN, "carnes"), roleConfig: rol() }), false);
});

test("consulta: segmento, no prefijo (/carnes/consulta-recepciones-x no cuenta)", () => {
  const ctx = { profile: perfil([{ path: "/carnes/consulta-recepciones-x" }], "logistica"), roleConfig: rol() };
  assert.equal(puedeAbrirConsultaRecepcionesCarnes(ctx), false);
  assert.equal(puedeVerContabilidadCarnes(ctx), false);
});

test("consulta + contabilidad en el mismo usuario: contabilidad sigue aprobando", () => {
  const ctx = { profile: perfil([...CONSULTA, ...CONTAB]), roleConfig: rol() };
  assert.equal(puedeAprobarContabilidadCarnes(ctx), true);
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

// ─── Observación de logística ───────────────────────────────────────────────

test("observar: solo con la consulta; ni admin ni contabilidad por sí solos", () => {
  assert.equal(puedeObservarLogisticaCarnes({ profile: perfil(CONSULTA, "logistica"), roleConfig: rol() }), true);
  assert.equal(puedeObservarLogisticaCarnes({ profile: perfil(CONTAB), roleConfig: rol() }), false);
  assert.equal(puedeObservarLogisticaCarnes({ profile: perfil(ADMIN, "carnes"), roleConfig: rol() }), false);
  assert.equal(puedeObservarLogisticaCarnes({}), false);
});

test("observar: consulta junto con otras rutas sigue pudiendo", () => {
  const ctx = { profile: perfil([...CONSULTA, ...CONTAB]), roleConfig: rol() };
  assert.equal(puedeObservarLogisticaCarnes(ctx), true);
  assert.equal(puedeObservarLogisticaCarnes({ profile: perfil([...CONSULTA, ...ADMIN]), roleConfig: rol() }), true);
});

test("observar: el texto se recorta y vacío o no-texto es null (borrar)", () => {
  assert.equal(normalizarObservacionLogistica("  hola  "), "hola");
  assert.equal(normalizarObservacionLogistica("   "), null);
  assert.equal(normalizarObservacionLogistica(""), null);
  assert.equal(normalizarObservacionLogistica(null), null);
  assert.equal(normalizarObservacionLogistica(undefined), null);
});

test("observar: en Enviada_SIESA guarda texto, quién y cuándo", () => {
  const ahora = new Date("2026-11-03T15:00:00Z");
  const r = decidirObservacionLogistica(
    { estado: "Enviada_SIESA" },
    { observacion: "  Llegó con 2 cajas golpeadas ", por: "logistica@merkahorrosas.com" },
    ahora,
  );
  assert.deepEqual(r, {
    accion: "guardar",
    valores: {
      observacion_logistica: "Llegó con 2 cajas golpeadas",
      observacion_logistica_por: "logistica@merkahorrosas.com",
      observacion_logistica_at: "2026-11-03T15:00:00.000Z",
    },
  });
});

test("observar: texto vacío borra las tres columnas (NULL)", () => {
  for (const observacion of ["", "   ", null]) {
    const r = decidirObservacionLogistica({ estado: "Enviada_SIESA" }, { observacion, por: "x@y.co" });
    assert.deepEqual(r.valores, {
      observacion_logistica: null,
      observacion_logistica_por: null,
      observacion_logistica_at: null,
    });
  }
});

test("observar: el máximo es 1000 y pasarse se rechaza", () => {
  assert.equal(MAX_OBSERVACION_LOGISTICA, 1000);
  const ok = decidirObservacionLogistica({ estado: "Enviada_SIESA" }, { observacion: "a".repeat(1000), por: "x@y.co" });
  assert.equal(ok.accion, "guardar");
  const mal = decidirObservacionLogistica({ estado: "Enviada_SIESA" }, { observacion: "a".repeat(1001), por: "x@y.co" });
  assert.equal(mal.accion, "rechazar");
  assert.equal(mal.codigo, "OBSERVACION_MUY_LARGA");
});

test("observar: solo Enviada_SIESA (409 ESTADO_NO_OBSERVABLE), también para borrar", () => {
  for (const estado of ["Borrador", "Finalizada", "Anulada"]) {
    for (const observacion of ["hola", ""]) {
      const r = decidirObservacionLogistica({ estado }, { observacion, por: "x@y.co" });
      assert.equal(r.accion, "rechazar", estado);
      assert.equal(r.status, 409, estado);
      assert.equal(r.codigo, "ESTADO_NO_OBSERVABLE", estado);
    }
  }
});

test("columnas: la lista y el detalle traen la observación de logística", () => {
  for (const c of ["observacion_logistica", "observacion_logistica_por", "observacion_logistica_at"]) {
    assert.ok(COLUMNAS_LISTA_ADMIN.includes(c), `lista sin ${c}`);
    assert.ok(COLUMNAS_DETALLE_ADMIN.includes(c), `detalle sin ${c}`);
  }
});

test("detalle de contabilidad conserva la observación de logística", () => {
  const r = detalleParaContabilidad({
    recepcion: {
      estado: "Enviada_SIESA",
      aprobado_contabilidad_at: null,
      observacion_logistica: "nota",
      observacion_logistica_por: "l@m.co",
      observacion_logistica_at: "2026-11-03T15:00:00Z",
    },
    envios: [],
    siesa: null,
    notaCredito: null,
  });
  assert.equal(r.recepcion.observacion_logistica, "nota");
  assert.equal(r.recepcion.observacion_logistica_por, "l@m.co");
});
