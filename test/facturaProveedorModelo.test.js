// Foto de la factura: modelo (subida con URL firmada, vinculación, quitar, lectura con
// URL firmada) y la exigencia al FINALIZAR. Supabase y Storage falsos; usa mock.module
// (npm test corre con --experimental-test-module-mocks). Sin red.
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

const MB = 1024 * 1024;
let cabeceras = [];
let renglones = [];
let objetos = {}; // carpeta -> [{ name, metadata }]
let removidos = [];
let subidasPedidas = [];
let actualizaciones = [];
let rechazarUpdate = false;
let tictac = 0;

class Q {
  constructor(t) {
    this.t = t;
    this.f = [];
  }
  select(c) { this.columnas = c; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  order() { return this; }
  update(v) { this.upd = v; return this; }
  delete() { this.borrar = true; return this; }
  base() { return this.t === "carnes_proveedor_recepciones" ? cabeceras : renglones; }
  filas() { return this.base().filter((r) => this.f.every((g) => g(r))); }
  ejecutar() {
    if (this.upd) {
      if (rechazarUpdate) return { data: [], error: null };
      const filas = this.filas();
      for (const fila of filas) Object.assign(fila, this.upd, { updated_at: `t${++tictac}` });
      actualizaciones.push({ tabla: this.t, valores: this.upd });
      return { data: filas.map((r) => ({ id: r.id })), error: null };
    }
    if (this.borrar) {
      const filas = this.filas();
      const base = this.base();
      for (const fila of filas) base.splice(base.indexOf(fila), 1);
      return { data: filas.map((r) => ({ id: r.id })), error: null };
    }
    return { data: this.filas(), error: null };
  }
  maybeSingle() {
    const { data, error } = this.ejecutar();
    return Promise.resolve({ data: data[0] ?? null, error });
  }
  then(res, rej) { return Promise.resolve(this.ejecutar()).then(res, rej); }
}

const storage = {
  from: (bucket) => ({
    createSignedUploadUrl: async (path) => {
      subidasPedidas.push({ bucket, path });
      return { data: { signedUrl: `https://storage.test/subir/${path}?token=tk`, token: "tk", path }, error: null };
    },
    list: async (carpeta) => ({ data: objetos[carpeta] || [], error: null }),
    remove: async (rutas) => {
      removidos.push(...rutas);
      return { data: [], error: null };
    },
    createSignedUrls: async (rutas, segundos) => ({
      data: rutas.map((path) => ({ path, signedUrl: `https://storage.test/ver/${path}?exp=${segundos}`, error: null })),
      error: null,
    }),
  }),
};

mock.module(url("config/supabase.js"), {
  namedExports: { supabase: { from: (t) => new Q(t), storage } },
});
const Factura = await import(url("models/FacturaProveedor.model.js"));
const Recepcion = await import(url("models/RecepcionProveedor.model.js"));

const archivo = (n, extra) => ({
  path: `recepcion-7/17300000000${n}0-0.jpg`,
  nombre: `f${n}.jpg`,
  tipo: "image/jpeg",
  tamano: MB,
  subido_at: "2026-11-06T10:00:00.000Z",
  subido_por: "ana@x.co",
  ...extra,
});
const cabecera = (extra) => ({
  id: 7, estado: "Borrador", updated_at: "t0", factura_archivos: [], recibido_por: "ana@x.co", ...extra,
});
const status = (codigo, extra = {}) => (e) =>
  e.statusCode === (extra.status ?? e.statusCode) && (codigo === undefined || e.codigo === codigo);

beforeEach(() => {
  cabeceras = [cabecera()];
  renglones = [];
  objetos = {};
  removidos = [];
  subidasPedidas = [];
  actualizaciones = [];
  rechazarUpdate = false;
});

// ─── Paso 1: URLs firmadas de subida ───────────────────────────────────────

test("solicitarSubidas: devuelve una URL firmada por archivo en recepcion-<id>/<timestamp>-<n>.<ext> del bucket privado", async () => {
  const ahora = new Date(1730000000000);
  const { subidas } = await Factura.solicitarSubidas(
    7,
    { archivos: [{ nombre: "a.jpg", tipo: "image/jpeg", tamano: 3 * MB }, { nombre: "b.pdf", tipo: "application/pdf", tamano: 9 * MB }] },
    ahora,
  );
  assert.deepEqual(subidas.map((s) => s.path), ["recepcion-7/1730000000000-0.jpg", "recepcion-7/1730000000000-1.pdf"]);
  assert.ok(subidas.every((s) => s.url.startsWith("https://storage.test/subir/") && s.token === "tk"));
  assert.ok(subidasPedidas.every((s) => s.bucket === "carnes-facturas-proveedor"));
  assert.equal(actualizaciones.length, 0, "pedir URLs no escribe en la base");
});

test("solicitarSubidas: rechaza más de 5 en total, tipo inválido y >10 MB sin pedir ninguna URL", async () => {
  cabeceras = [cabecera({ factura_archivos: [archivo(1), archivo(2), archivo(3), archivo(4)] })];
  const dos = [{ nombre: "a.jpg", tipo: "image/jpeg", tamano: MB }, { nombre: "b.jpg", tipo: "image/jpeg", tamano: MB }];
  await assert.rejects(() => Factura.solicitarSubidas(7, { archivos: dos }), status("FACTURA_MUCHOS_ARCHIVOS"));

  cabeceras = [cabecera()];
  await assert.rejects(
    () => Factura.solicitarSubidas(7, { archivos: [{ nombre: "a.exe", tipo: "application/x-msdownload", tamano: MB }] }),
    status("FACTURA_TIPO_INVALIDO"),
  );
  await assert.rejects(
    () => Factura.solicitarSubidas(7, { archivos: [{ nombre: "a.jpg", tipo: "image/jpeg", tamano: 10 * MB + 1 }] }),
    status("FACTURA_GRANDE", { status: 413 }),
  );
  assert.equal(subidasPedidas.length, 0);
});

test("solicitarSubidas / confirmar / quitar: solo en borrador (409); inexistente es 404", async () => {
  for (const estado of ["Finalizada", "Enviada_SIESA", "Anulada"]) {
    cabeceras = [cabecera({ estado })];
    const a = [{ nombre: "a.jpg", tipo: "image/jpeg", tamano: MB }];
    await assert.rejects(() => Factura.solicitarSubidas(7, { archivos: a }), status("RECEPCION_NO_BORRADOR"), estado);
    await assert.rejects(() => Factura.confirmar(7, { archivos: [{ path: "x" }] }), status("RECEPCION_NO_BORRADOR"), estado);
    await assert.rejects(() => Factura.quitar(7, { path: "x" }), status("RECEPCION_NO_BORRADOR"), estado);
  }
  await assert.rejects(() => Factura.solicitarSubidas(99, { archivos: [] }), status(undefined, { status: 404 }));
});

// ─── Paso 3: confirmar ─────────────────────────────────────────────────────

test("confirmar: vincula con el tamaño y tipo REALES de Storage y deja quién y cuándo", async () => {
  objetos["recepcion-7"] = [{ name: "1730000000001-0.jpg", metadata: { size: 4 * MB, mimetype: "image/jpeg" } }];
  const ruta = "recepcion-7/1730000000001-0.jpg";
  const r = await Factura.confirmar(
    7,
    { archivos: [{ path: ruta, nombre: "factura.jpg" }], por: "ana@x.co" },
    new Date("2026-11-06T12:00:00Z"),
  );
  assert.equal(r.factura_archivos.length, 1);
  assert.deepEqual(r.factura_archivos[0], {
    path: ruta,
    nombre: "factura.jpg",
    tipo: "image/jpeg",
    tamano: 4 * MB,
    subido_at: "2026-11-06T12:00:00.000Z",
    subido_por: "ana@x.co",
  });
  assert.equal(cabeceras[0].factura_archivos.length, 1, "quedó guardado en la recepción");
});

test("confirmar: un archivo que no llegó a Storage es 422 y no se guarda nada", async () => {
  await assert.rejects(
    () => Factura.confirmar(7, { archivos: [{ path: "recepcion-7/1730000000001-0.jpg" }], por: null }),
    status("FACTURA_NO_SUBIDA", { status: 422 }),
  );
  assert.equal(actualizaciones.length, 0);
});

test("confirmar: si lo subido supera 10 MB o no es del tipo permitido, se borra de Storage y no se vincula", async () => {
  objetos["recepcion-7"] = [{ name: "1730000000001-0.jpg", metadata: { size: 11 * MB, mimetype: "image/jpeg" } }];
  await assert.rejects(
    () => Factura.confirmar(7, { archivos: [{ path: "recepcion-7/1730000000001-0.jpg" }], por: null }),
    status("FACTURA_GRANDE", { status: 413 }),
  );
  assert.deepEqual(removidos, ["recepcion-7/1730000000001-0.jpg"]);
  assert.equal(actualizaciones.length, 0);

  removidos = [];
  objetos["recepcion-7"] = [{ name: "1730000000001-0.jpg", metadata: { size: MB, mimetype: "text/html" } }];
  await assert.rejects(
    () => Factura.confirmar(7, { archivos: [{ path: "recepcion-7/1730000000001-0.jpg" }], por: null }),
    status("FACTURA_TIPO_INVALIDO"),
  );
  assert.deepEqual(removidos, ["recepcion-7/1730000000001-0.jpg"]);
});

test("confirmar: rutas de otra recepción son 400 y no se leen ni se vinculan", async () => {
  objetos["recepcion-8"] = [{ name: "1730000000001-0.jpg", metadata: { size: MB, mimetype: "image/jpeg" } }];
  await assert.rejects(
    () => Factura.confirmar(7, { archivos: [{ path: "recepcion-8/1730000000001-0.jpg" }], por: null }),
    status("FACTURA_RUTA_INVALIDA", { status: 400 }),
  );
  assert.equal(actualizaciones.length, 0);
});

test("confirmar: si la recepción cambió mientras se confirmaba, 409 REINTENTAR; reconfirmar lo ya vinculado no escribe", async () => {
  objetos["recepcion-7"] = [{ name: "1730000000001-0.jpg", metadata: { size: MB, mimetype: "image/jpeg" } }];
  const ruta = "recepcion-7/1730000000001-0.jpg";
  rechazarUpdate = true;
  await assert.rejects(() => Factura.confirmar(7, { archivos: [{ path: ruta }], por: null }), status("REINTENTAR", { status: 409 }));

  rechazarUpdate = false;
  cabeceras = [cabecera({ factura_archivos: [archivo(1, { path: ruta })] })];
  const r = await Factura.confirmar(7, { archivos: [{ path: ruta }], por: null });
  assert.equal(r.factura_archivos.length, 1);
  assert.equal(actualizaciones.length, 0);
});

test("quitar: saca el archivo del borrador y lo borra de Storage; uno ajeno es 404", async () => {
  const a = archivo(1);
  const b = archivo(2);
  cabeceras = [cabecera({ factura_archivos: [a, b] })];
  const r = await Factura.quitar(7, { path: a.path });
  assert.deepEqual(r.factura_archivos.map((x) => x.path), [b.path]);
  assert.deepEqual(removidos, [a.path]);
  await assert.rejects(() => Factura.quitar(7, { path: "recepcion-7/9999999999999-0.jpg" }), status("FACTURA_ARCHIVO_NO_ENCONTRADO", { status: 404 }));
});

test("descartar un borrador borra sus archivos del bucket (mejor esfuerzo)", async () => {
  objetos["recepcion-7"] = [{ name: "1730000000001-0.jpg" }, { name: "1730000000002-0.pdf" }];
  await Recepcion.descartar(7);
  assert.deepEqual(removidos.sort(), ["recepcion-7/1730000000001-0.jpg", "recepcion-7/1730000000002-0.pdf"]);
  assert.equal(cabeceras.length, 0);
});

// ─── Finalizar ─────────────────────────────────────────────────────────────

const cuerpoFinalizar = { recibido_por: "ana@x.co", recibidor: { otro: true, nombre: "Ana Pérez", cedula: "12345678" }, firma_data: "x" };

test("finalizar: SIN factura vinculada es 422 FACTURA_REQUERIDA y no firma nada", async () => {
  cabeceras = [cabecera({ factura_archivos: [] })];
  await assert.rejects(() => Recepcion.finalizar(7, cuerpoFinalizar), status("FACTURA_REQUERIDA", { status: 422 }));
  assert.equal(actualizaciones.length, 0, "no se escribió la firma");
  assert.equal(cabeceras[0].estado, "Borrador");
});

test("finalizar: con factura vinculada pasa esa puerta (el siguiente freno es la validación de renglones)", async () => {
  cabeceras = [cabecera({ factura_archivos: [archivo(1)] })];
  renglones = [];
  await assert.rejects(
    () => Recepcion.finalizar(7, cuerpoFinalizar),
    (e) => e.codigo !== "FACTURA_REQUERIDA",
  );
});

test("finalizar: una recepción ya firmada (legada, sin factura) sigue siendo un reintento y no se bloquea", async () => {
  cabeceras = [cabecera({ estado: "Enviada_SIESA", factura_archivos: [] })];
  const r = await Recepcion.finalizar(7, cuerpoFinalizar);
  assert.equal(r.yaFinalizada, true);
});

// ─── Lectura con URL firmada ───────────────────────────────────────────────

test("urlsDeFactura (admin): cualquier estado, URL firmada de 10 minutos y sin la ruta interna", async () => {
  cabeceras = [cabecera({ estado: "Finalizada", factura_archivos: [archivo(1), archivo(2, { tipo: "application/pdf", nombre: "f.pdf" })] })];
  const r = await Factura.urlsDeFactura(7);
  assert.equal(r.expiraEn, 600);
  assert.equal(r.archivos.length, 2);
  assert.ok(r.archivos[0].url.includes("exp=600"));
  assert.equal(r.archivos[1].tipo, "application/pdf");
  assert.ok(r.archivos.every((a) => !("path" in a)));
});

test("urlsDeFactura (contabilidad/consulta): solo Enviada_SIESA; en otro estado 404 como el acta", async () => {
  for (const estado of ["Borrador", "Finalizada", "Anulada"]) {
    cabeceras = [cabecera({ estado, factura_archivos: [archivo(1)] })];
    await assert.rejects(() => Factura.urlsDeFactura(7, { soloEnviada: true }), status(undefined, { status: 404 }), estado);
  }
  cabeceras = [cabecera({ estado: "Enviada_SIESA", factura_archivos: [archivo(1)] })];
  const r = await Factura.urlsDeFactura(7, { soloEnviada: true });
  assert.equal(r.archivos.length, 1);
});

test("urlsDeFactura: una recepción legada (sin factura) devuelve la lista vacía, sin pedir URLs", async () => {
  cabeceras = [cabecera({ estado: "Enviada_SIESA", factura_archivos: [] })];
  const r = await Factura.urlsDeFactura(7, { soloEnviada: true });
  assert.deepEqual(r.archivos, []);
  cabeceras = [cabecera({ estado: "Enviada_SIESA", factura_archivos: null })];
  assert.deepEqual((await Factura.urlsDeFactura(7)).archivos, []);
});
