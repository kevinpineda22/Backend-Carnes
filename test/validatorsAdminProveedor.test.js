import test from "node:test";
import assert from "node:assert/strict";

import { validators } from "../src/middleware/validators.js";

// La FORMA de lo que aceptan el listado del admin, la corrección de la referencia
// de factura y la anulación. Las reglas de contenido (12 caracteres, estados) se
// prueban en adminProveedor.test.js.

const CORREO = "admin@merkahorro.com";

/** Corre un middleware de `validar` y devuelve el error, el body y lo validado de query/params. */
function correr(middleware, { body, query, params } = {}) {
  const req = { body, query, params };
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body, datos: req.datosValidados };
}

// ─── Listado ───────────────────────────────────────────────────────────────

test("listar: sin filtros usa el límite por defecto", () => {
  const { error, datos } = correr(validators.listarRecepcionesProveedor, { query: {} });
  assert.equal(error, undefined);
  assert.equal(datos.limite, 100);
  assert.equal(datos.estado, undefined);
});

test("listar: acepta todos los filtros; los ids y el límite llegan como número", () => {
  const { error, datos } = correr(validators.listarRecepcionesProveedor, {
    query: {
      estado: "Finalizada",
      proveedor_id: "4",
      sede_id: "2",
      desde: "2026-09-01",
      hasta: "2026-09-30",
      factura: "fe-12",
      limite: "50",
    },
  });
  assert.equal(error, undefined);
  assert.deepEqual(datos, {
    estado: "Finalizada",
    proveedor_id: 4,
    sede_id: 2,
    desde: "2026-09-01",
    hasta: "2026-09-30",
    factura: "fe-12",
    limite: 50,
  });
});

test("listar: un filtro vacío es 'sin filtro' (un <select> en Todos manda cadena vacía)", () => {
  const { error, datos } = correr(validators.listarRecepcionesProveedor, {
    query: { estado: "", proveedor_id: "", sede_id: "", desde: "", hasta: "", factura: "", limite: "" },
  });
  assert.equal(error, undefined);
  assert.equal(datos.estado, undefined);
  assert.equal(datos.proveedor_id, undefined);
  assert.equal(datos.desde, undefined);
  assert.equal(datos.factura, undefined);
  assert.equal(datos.limite, 100);
});

test("listar: rechaza lo inválido con 400 y el nombre del campo", () => {
  const casos = [
    [{ estado: "Pendiente" }, /estado/],
    [{ estado: ["Borrador", "Finalizada"] }, /estado/],
    [{ proveedor_id: "abc" }, /proveedor_id/],
    [{ proveedor_id: "0" }, /proveedor_id/],
    [{ sede_id: "-3" }, /sede_id/],
    [{ desde: "01/09/2026" }, /desde/],
    [{ hasta: "2026-02-31" }, /hasta/],
    [{ desde: "2026-10-01", hasta: "2026-09-01" }, /desde no puede ser posterior/],
    [{ factura: "---" }, /factura/],
    [{ limite: "0" }, /limite/],
    [{ limite: "201" }, /limite/],
    [{ limite: "x" }, /limite/],
  ];
  for (const [query, patron] of casos) {
    const { error } = correr(validators.listarRecepcionesProveedor, { query });
    assert.equal(error?.statusCode, 400, JSON.stringify(query));
    assert.match(error.message, patron, JSON.stringify(query));
  }
});

test("listar: desde igual a hasta es válido (un solo día)", () => {
  const { error } = correr(validators.listarRecepcionesProveedor, {
    query: { desde: "2026-09-30", hasta: "2026-09-30" },
  });
  assert.equal(error, undefined);
});

// ─── Corregir la referencia de factura ─────────────────────────────────────

test("factura-siesa: pide correo y la referencia; recorta espacios", () => {
  const ok = correr(validators.corregirFacturaSiesaProveedor, {
    body: { por: CORREO, factura_siesa: "  F123  " },
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.body.factura_siesa, "F123");

  for (const body of [
    { factura_siesa: "F123" },
    { por: "no-es-correo", factura_siesa: "F123" },
    { por: CORREO },
    { por: CORREO, factura_siesa: "   " },
    { por: CORREO, factura_siesa: 123 },
    { por: CORREO, factura_siesa: "X".repeat(41) },
  ]) {
    const { error } = correr(validators.corregirFacturaSiesaProveedor, { body });
    assert.equal(error?.statusCode, 400, JSON.stringify(body));
  }
});

// ─── Anular ────────────────────────────────────────────────────────────────

test("anular: pide correo y motivo; anulado_en_siesa es opcional y booleano de verdad", () => {
  const sin = correr(validators.anularRecepcionProveedor, {
    body: { por: CORREO, motivo: "  Factura mal digitada  " },
  });
  assert.equal(sin.error, undefined);
  assert.equal(sin.body.motivo, "Factura mal digitada");
  assert.equal(sin.body.anulado_en_siesa, undefined);

  const con = correr(validators.anularRecepcionProveedor, {
    body: { por: CORREO, motivo: "Duplicada", anulado_en_siesa: true },
  });
  assert.equal(con.error, undefined);
  assert.equal(con.body.anulado_en_siesa, true);
});

test("anular: rechaza motivo vacío o corto, correo malo y un 'true' de texto", () => {
  for (const body of [
    { por: CORREO },
    { por: CORREO, motivo: "  " },
    { por: CORREO, motivo: "ab" },
    { por: CORREO, motivo: "x".repeat(501) },
    { motivo: "Duplicada" },
    { por: "nadie", motivo: "Duplicada" },
    { por: CORREO, motivo: "Duplicada", anulado_en_siesa: "true" },
    { por: CORREO, motivo: "Duplicada", anulado_en_siesa: 1 },
  ]) {
    const { error } = correr(validators.anularRecepcionProveedor, { body });
    assert.equal(error?.statusCode, 400, JSON.stringify(body));
  }
});
