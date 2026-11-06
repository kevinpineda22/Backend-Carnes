// Reglas puras de la foto de la factura (cantidad, tipo, tamaño, rutas, vinculación,
// exigencia al finalizar) y la FORMA de lo que aceptan los endpoints. Sin red.
import test from "node:test";
import assert from "node:assert/strict";

import {
  BUCKET_FACTURA,
  MAX_ARCHIVOS_FACTURA,
  MAX_BYTES_FACTURA,
  archivosPublicos,
  armarVinculacion,
  conResumenFactura,
  esRutaDeRecepcion,
  normalizarNombreArchivo,
  rutaFactura,
  validarArchivo,
  validarFacturaParaFinalizar,
  validarSolicitudSubida,
} from "../src/shared/facturaProveedor.js";
import { validators } from "../src/middleware/validators.js";

const MB = 1024 * 1024;
const jpg = (extra) => ({ nombre: "foto.jpg", tipo: "image/jpeg", tamano: 2 * MB, ...extra });

// ─── Tipo y tamaño ─────────────────────────────────────────────────────────

test("validarArchivo: acepta imágenes y PDF hasta 10 MB inclusive", () => {
  for (const tipo of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]) {
    assert.equal(validarArchivo(jpg({ tipo })).ok, true, tipo);
  }
  assert.equal(validarArchivo(jpg({ tamano: MAX_BYTES_FACTURA })).ok, true);
});

test("validarArchivo: rechaza tipos no permitidos, vacíos y de más de 10 MB", () => {
  for (const tipo of ["text/html", "application/zip", "image/svg+xml", "video/mp4", "", undefined]) {
    const r = validarArchivo(jpg({ tipo }));
    assert.equal(r.ok, false, String(tipo));
    assert.equal(r.status, 400);
    assert.equal(r.codigo, "FACTURA_TIPO_INVALIDO");
  }
  const vacio = validarArchivo(jpg({ tamano: 0 }));
  assert.equal(vacio.codigo, "FACTURA_VACIA");
  const grande = validarArchivo(jpg({ tamano: MAX_BYTES_FACTURA + 1 }));
  assert.equal(grande.status, 413);
  assert.equal(grande.codigo, "FACTURA_GRANDE");
  assert.match(grande.mensaje, /10 MB/);
});

test("validarArchivo: un tipo heredado de Object.prototype no pasa como válido", () => {
  assert.equal(validarArchivo(jpg({ tipo: "constructor" })).ok, false);
  assert.equal(validarArchivo(jpg({ tipo: "__proto__" })).ok, false);
});

// ─── Solicitud de subida ───────────────────────────────────────────────────

test("validarSolicitudSubida: 1 a 5 archivos en total (cuenta los ya vinculados)", () => {
  const ok = validarSolicitudSubida({ archivos: [jpg()] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.archivos[0], { nombre: "foto.jpg", tipo: "image/jpeg", tamano: 2 * MB, ext: "jpg" });

  assert.equal(validarSolicitudSubida({ archivos: Array.from({ length: 5 }, () => jpg()) }).ok, true);

  const seis = validarSolicitudSubida({ archivos: Array.from({ length: 6 }, () => jpg()) });
  assert.equal(seis.ok, false);
  assert.equal(seis.codigo, "FACTURA_MUCHOS_ARCHIVOS");

  const existentes = Array.from({ length: 4 }, (_, i) => ({ path: `recepcion-1/1700000000000-${i}.jpg` }));
  assert.equal(validarSolicitudSubida({ existentes, archivos: [jpg()] }).ok, true);
  assert.equal(validarSolicitudSubida({ existentes, archivos: [jpg(), jpg()] }).codigo, "FACTURA_MUCHOS_ARCHIVOS");
});

test("validarSolicitudSubida: sin archivos es FACTURA_REQUERIDA; un archivo malo frena toda la tanda", () => {
  assert.equal(validarSolicitudSubida({ archivos: [] }).codigo, "FACTURA_REQUERIDA");
  assert.equal(validarSolicitudSubida({}).codigo, "FACTURA_REQUERIDA");
  const r = validarSolicitudSubida({ archivos: [jpg(), jpg({ tipo: "text/plain" })] });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, "FACTURA_TIPO_INVALIDO");
});

test("normalizarNombreArchivo: sin rutas ni caracteres de control, con largo acotado", () => {
  assert.equal(normalizarNombreArchivo("C:\\fotos\\..\\factura 1.jpg"), "factura 1.jpg");
  assert.equal(normalizarNombreArchivo("../../etc/passwd"), "passwd");
  assert.equal(normalizarNombreArchivo("a\u0000b\n.jpg"), "ab.jpg");
  assert.equal(normalizarNombreArchivo(""), "factura");
  assert.equal(normalizarNombreArchivo(undefined), "factura");
  assert.equal(normalizarNombreArchivo("x".repeat(500)).length, 150);
});

// ─── Rutas ─────────────────────────────────────────────────────────────────

test("rutaFactura / esRutaDeRecepcion: recepcion-<id>/<timestamp>-<n>.<ext> y solo de esa recepción", () => {
  const ruta = rutaFactura(42, 1, "pdf", new Date(1730000000000));
  assert.equal(ruta, "recepcion-42/1730000000000-1.pdf");
  assert.equal(esRutaDeRecepcion(42, ruta), true);
  assert.equal(esRutaDeRecepcion("42", ruta), true);
  assert.equal(esRutaDeRecepcion(43, ruta), false);
  for (const mala of [
    "recepcion-42/../recepcion-43/1730000000000-1.pdf",
    "recepcion-42/1730000000000-1.exe",
    "recepcion-42/1730000000000-1.pdf/x",
    "recepcion-42/abc-1.pdf",
    "otra/1730000000000-1.pdf",
    "",
    null,
    42,
  ]) {
    assert.equal(esRutaDeRecepcion(42, mala), false, String(mala));
  }
});

// ─── Vinculación (lo real sale de Storage) ─────────────────────────────────

const AHORA = new Date("2026-11-06T15:00:00Z");
const RUTA_A = "recepcion-7/1730000000000-0.jpg";
const RUTA_B = "recepcion-7/1730000000001-0.pdf";
const storage = (entradas) => new Map(Object.entries(entradas));

test("armarVinculacion: toma tipo y tamaño de Storage, no del cliente, y registra quién y cuándo", () => {
  const r = armarVinculacion({
    recepcionId: 7,
    solicitados: [{ path: RUTA_A, nombre: "mi foto.jpg", tipo: "application/pdf", tamano: 1 }],
    enStorage: storage({ "1730000000000-0.jpg": { size: 3 * MB, mimetype: "image/jpeg" } }),
    por: "ana@x.co",
    ahora: AHORA,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.archivos, [
    {
      path: RUTA_A,
      nombre: "mi foto.jpg",
      tipo: "image/jpeg",
      tamano: 3 * MB,
      subido_at: AHORA.toISOString(),
      subido_por: "ana@x.co",
    },
  ]);
});

test("armarVinculacion: un archivo que no llegó a Storage es 422; uno que no cumple lo marca para borrar", () => {
  const faltante = armarVinculacion({ recepcionId: 7, solicitados: [{ path: RUTA_A }], enStorage: storage({}) });
  assert.equal(faltante.status, 422);
  assert.equal(faltante.codigo, "FACTURA_NO_SUBIDA");

  const malo = armarVinculacion({
    recepcionId: 7,
    solicitados: [{ path: RUTA_A }],
    enStorage: storage({ "1730000000000-0.jpg": { size: 11 * MB, mimetype: "image/jpeg" } }),
  });
  assert.equal(malo.ok, false);
  assert.equal(malo.codigo, "FACTURA_GRANDE");
  assert.deepEqual(malo.rutasInvalidas, [RUTA_A]);
});

test("armarVinculacion: rechaza rutas de otra recepción, repetidas, y pasarse de 5 en total", () => {
  const enStorage = storage({ "1730000000000-0.jpg": { size: MB, mimetype: "image/jpeg" } });
  assert.equal(
    armarVinculacion({ recepcionId: 8, solicitados: [{ path: RUTA_A }], enStorage }).codigo,
    "FACTURA_RUTA_INVALIDA",
  );
  assert.equal(
    armarVinculacion({ recepcionId: 7, solicitados: [{ path: RUTA_A }, { path: RUTA_A }], enStorage }).codigo,
    "FACTURA_RUTA_INVALIDA",
  );
  const existentes = Array.from({ length: MAX_ARCHIVOS_FACTURA }, (_, i) => ({ path: `recepcion-7/17300000000${i}0-0.jpg` }));
  assert.equal(
    armarVinculacion({ recepcionId: 7, existentes, solicitados: [{ path: RUTA_A }], enStorage }).codigo,
    "FACTURA_MUCHOS_ARCHIVOS",
  );
  assert.equal(armarVinculacion({ recepcionId: 7, solicitados: [], enStorage }).codigo, "FACTURA_REQUERIDA");
});

test("armarVinculacion: reconfirmar un archivo ya vinculado no lo duplica (reintento idempotente)", () => {
  const existente = { path: RUTA_A, nombre: "a.jpg", tipo: "image/jpeg", tamano: MB };
  const r = armarVinculacion({
    recepcionId: 7,
    existentes: [existente],
    solicitados: [{ path: RUTA_A }, { path: RUTA_B, nombre: "b.pdf" }],
    enStorage: storage({ "1730000000001-0.pdf": { size: MB, mimetype: "application/pdf" } }),
    ahora: AHORA,
  });
  assert.equal(r.ok, true);
  assert.equal(r.archivos.length, 2);
  assert.equal(r.nuevos.length, 1);
  assert.equal(r.archivos[0], existente);
});

// ─── Finalizar ─────────────────────────────────────────────────────────────

test("validarFacturaParaFinalizar: sin archivos vinculados es 422 FACTURA_REQUERIDA", () => {
  for (const vacio of [[], null, undefined, "x", {}]) {
    const r = validarFacturaParaFinalizar(vacio);
    assert.equal(r.ok, false, JSON.stringify(vacio));
    assert.equal(r.status, 422);
    assert.equal(r.codigo, "FACTURA_REQUERIDA");
  }
  assert.equal(validarFacturaParaFinalizar([{ path: RUTA_A }]).ok, true);
});

// ─── Lo que ven los listados ───────────────────────────────────────────────

test("archivosPublicos / conResumenFactura: nunca sacan la ruta de Storage y cuentan los archivos", () => {
  const archivos = [{ path: RUTA_A, nombre: "a.jpg", tipo: "image/jpeg", tamano: MB, subido_at: "x", subido_por: "ana@x.co" }];
  assert.deepEqual(archivosPublicos(archivos), [
    { nombre: "a.jpg", tipo: "image/jpeg", tamano: MB, subido_at: "x", subido_por: "ana@x.co" },
  ]);
  const fila = conResumenFactura({ id: 1, factura_archivos: archivos });
  assert.equal(fila.factura_total, 1);
  assert.equal("path" in fila.factura_archivos[0], false);

  // Legado: sin la columna o vacía = sin factura.
  assert.equal(conResumenFactura({ id: 1 }).factura_total, 0);
  assert.equal(conResumenFactura({ id: 1, factura_archivos: [] }).factura_total, 0);
  assert.equal(conResumenFactura({ id: 1, factura_archivos: null }).factura_total, 0);
});

test("el bucket se llama como lo crea sql/036", () => {
  assert.equal(BUCKET_FACTURA, "carnes-facturas-proveedor");
});

// ─── Validadores (la forma de los cuerpos) ─────────────────────────────────

function correr(middleware, body) {
  const req = { body };
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("validators.solicitarSubidasFactura: acepta la forma y convierte el tamaño; rechaza lo imposible", () => {
  const ok = correr(validators.solicitarSubidasFactura, {
    editado_por: "ana@merkahorro.com",
    archivos: [{ nombre: "a.jpg", tipo: "image/jpeg", tamano: "1024" }],
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.body.archivos[0].tamano, 1024);

  for (const body of [
    {},
    { archivos: [] },
    { archivos: "x" },
    { archivos: [{ nombre: "a", tipo: "image/jpeg" }] },
    { archivos: [{ nombre: "a", tipo: "image/jpeg", tamano: -1 }] },
    { archivos: [{ nombre: "a", tipo: "image/jpeg", tamano: 1.5 }] },
    { archivos: Array.from({ length: 21 }, () => ({ nombre: "a", tipo: "image/jpeg", tamano: 1 })) },
    { editado_por: "yo", archivos: [{ nombre: "a", tipo: "image/jpeg", tamano: 1 }] },
  ]) {
    assert.equal(correr(validators.solicitarSubidasFactura, body).error?.statusCode, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("validators.confirmarFactura / quitarFactura: exigen rutas como texto", () => {
  assert.equal(correr(validators.confirmarFactura, { archivos: [{ path: RUTA_A, nombre: "a.jpg" }] }).error, undefined);
  assert.equal(correr(validators.confirmarFactura, { archivos: [{ path: RUTA_A }] }).error, undefined);
  for (const body of [{}, { archivos: [] }, { archivos: [{ path: 5 }] }, { archivos: [{ nombre: "a" }] }]) {
    assert.equal(correr(validators.confirmarFactura, body).error?.statusCode, 400);
  }
  assert.equal(correr(validators.quitarFactura, { path: RUTA_A }).error, undefined);
  assert.equal(correr(validators.quitarFactura, {}).error?.statusCode, 400);
  assert.equal(correr(validators.quitarFactura, { path: 3 }).error?.statusCode, 400);
});
