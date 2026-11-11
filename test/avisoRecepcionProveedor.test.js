// Aviso interno "recepción de proveedor" (CARNES_MAIL_PROVEEDORES): destinatarios,
// armado del correo, envío y su integración en `finalizar`. Sin red: el correo, los
// modelos y Supabase se simulan con mock.module (npm test corre con
// --experimental-test-module-mocks).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../src/", import.meta.url));
const url = (p) => pathToFileURL(RAIZ + p).href;

// ─── Destinatarios (módulo real) ────────────────────────────────────────────
const Email = await import(url("services/email.service.js"));

test("destinatariosProveedores: separa por coma o punto y coma, recorta y deduplica", () => {
  process.env.CARNES_MAIL_PROVEEDORES = " a@x.co ; B@x.co, a@X.co ,, c@x.co;";
  assert.deepEqual(Email.destinatariosProveedores(), ["a@x.co", "B@x.co", "c@x.co"]);
});

test("destinatariosProveedores: vacía o ausente da lista vacía y NO cae al admin", () => {
  process.env.CARNES_MAIL_ADMIN = "admin@x.co";
  process.env.CARNES_MAIL_PROVEEDORES = "";
  assert.deepEqual(Email.destinatariosProveedores(), []);
  delete process.env.CARNES_MAIL_PROVEEDORES;
  assert.deepEqual(Email.destinatariosProveedores(), []);
  delete process.env.CARNES_MAIL_ADMIN;
});

// ─── Simulaciones para servicio y controlador ───────────────────────────────
const enviados = [];
let fallaEnvio = false;
mock.module(url("services/email.service.js"), {
  namedExports: {
    ...Email,
    sendEmail: async (mail) => {
      if (fallaEnvio) throw new Error("SMTP caído");
      enviados.push(mail);
      return { success: true };
    },
  },
});

let finalizada = { ya: false };
const llamadasDespues = [];
mock.module(url("config/supabase.js"), { namedExports: { supabase: { from: () => ({}) } } });
mock.module(url("models/RecepcionProveedor.model.js"), {
  namedExports: {
    finalizar: async () => ({ recepcion: recepcionBase(), resumen: resumenBase(), yaFinalizada: finalizada.ya }),
  },
});
mock.module(url("models/PostFinalizarProveedor.model.js"), {
  namedExports: {
    despuesDeFinalizar: async (args) => {
      llamadasDespues.push(args);
      return {
        referencias: { entrada: "PR-7", nota_credito: "PR-7-NC" },
        siesa: { estado: "error", referencia: null, error: "Bodega <inválida>", envio_id: 1 },
        notaCredito: { requerida: true, estado: "pendiente", bloqueo: "La entrada no está en SIESA", referencia: null },
        cambios: null,
        aviso: null,
      };
    },
  },
});
mock.module(url("models/SiesaEnvio.model.js"), { namedExports: {} });

const Notif = await import(url("services/notificaciones.service.js"));
const Ctrl = await import(url("controllers/recepcionesProveedor.controller.js"));
const { armarAvisoProveedores } = await import(url("shared/avisoRecepcionProveedor.js"));

function recepcionBase(extra = {}) {
  return {
    id: 7,
    sede_id: 3,
    sede: { nombre: "Sede <Centro>" },
    proveedor_razon_social: "Bucanero & Cía",
    proveedor_nit: "900123456",
    factura: "FV-<1>",
    recibido_por: "ana@empresa.com",
    recibidor_nombre: "Ana Pérez",
    finalizado_at: "2026-10-19T15:00:00Z",
    recibido_at: null,
    factura_archivos: [{ nombre: "a.jpg" }, { nombre: "b.jpg" }],
    items: [
      { descripcion_item: "Pierna <x>", seccion: "despresado", cantidad: 10, unidad: "KL", valor_total: 100000, cantidad_devuelta: 2, motivo_devolucion: "Mal olor & golpes" },
      { descripcion_item: "Cuello", cantidad: 0, unidad: "KL", valor_total: null },
    ],
    ...extra,
  };
}
const resumenBase = (extra = {}) => ({ renglones: 1, total: 90000, subtotal: 100000, descuento: 10000, descuento_pct: 10, total_devuelto: 18000, renglones_con_devolucion: 1, ...extra });
const siesaEjemplo = (extra = {}) => ({
  referencias: { entrada: "PR-7", nota_credito: "PR-7-NC" },
  siesa: { estado: "ok", referencia: "CEP-100", error: null },
  notaCredito: { requerida: true, estado: "ok", referencia: "NCP-5" },
  ...extra,
});

// ─── Armado ─────────────────────────────────────────────────────────────────
test("armarAvisoProveedores: asunto, datos, productos con sección, devoluciones y totales", () => {
  const r = recepcionBase();
  const { subject, html } = armarAvisoProveedores(r, r.items, resumenBase(), siesaEjemplo());
  assert.equal(subject, "Carnes · Recepción de proveedor · Bucanero & Cía · Factura FV-<1> · Sede <Centro>");
  assert.match(html, /900123456/);
  assert.match(html, /Ana Pérez/);
  assert.match(html, /Pierna &lt;x&gt; · Con alas/);
  assert.doesNotMatch(html, /Cuello/); // renglón en 0 no se lista
  assert.match(html, /Mal olor &amp; golpes/);
  assert.match(html, /Subtotal/);
  assert.match(html, /Descuento/);
  assert.match(html, /En SIESA/);
  assert.match(html, /CEP-100/);
  assert.match(html, /NCP-5/);
  assert.match(html, /\(2 archivos\) está en el panel de Proveedores/);
});

test("armarAvisoProveedores: escapa HTML en todos los campos de texto", () => {
  const r = recepcionBase();
  const { html } = armarAvisoProveedores(r, r.items, resumenBase(), siesaEjemplo());
  assert.doesNotMatch(html, /<x>/);
  assert.doesNotMatch(html, /FV-<1>/);
  assert.doesNotMatch(html, /Sede <Centro>/);
  assert.match(html, /FV-&lt;1&gt;/);
  assert.match(html, /Bucanero &amp; Cía/);
});

test("armarAvisoProveedores: error de SIESA (escapado) y nota crédito pendiente con su bloqueo", () => {
  const r = recepcionBase();
  const { html } = armarAvisoProveedores(r, r.items, resumenBase(), {
    referencias: { entrada: "PR-7", nota_credito: "PR-7-NC" },
    siesa: { estado: "error", referencia: null, error: "Bodega <inválida>" },
    notaCredito: { requerida: true, estado: "pendiente", bloqueo: "La entrada no está en SIESA" },
  });
  assert.match(html, /Error al subir a SIESA: Bodega &lt;inválida&gt;/);
  assert.match(html, /Pendiente: La entrada no está en SIESA/);
  assert.match(html, /PR-7-NC/);
});

test("armarAvisoProveedores: sin devoluciones, sin NC, sin descuento y sin foto", () => {
  const r = recepcionBase({
    factura_archivos: [],
    items: [{ descripcion_item: "Pierna", cantidad: 5, unidad: "KL", valor_total: 50000 }],
  });
  const { html } = armarAvisoProveedores(
    r,
    r.items,
    { total: 50000, total_devuelto: 0 },
    { siesa: { estado: "apagado" }, notaCredito: { requerida: false } },
  );
  assert.doesNotMatch(html, /Devoluciones/);
  assert.doesNotMatch(html, /Nota crédito/);
  assert.doesNotMatch(html, /Subtotal/);
  assert.match(html, /Sin foto de factura/);
  assert.match(html, /el envío a SIESA está apagado/);
});

test("armarAvisoProveedores: una sola foto va en singular y sin_confirmar se describe", () => {
  const r = recepcionBase({ factura_archivos: [{ nombre: "a.jpg" }] });
  const { html } = armarAvisoProveedores(r, r.items, resumenBase(), {
    siesa: { estado: "sin_confirmar", referencia: "CEP-9" },
    notaCredito: { requerida: false },
  });
  assert.match(html, /\(1 archivo\)/);
  assert.match(html, /SIESA no confirmó/);
});

// ─── Servicio ───────────────────────────────────────────────────────────────
test("notificarRecepcionProveedor: sin destinatarios no envía y devuelve omitido", async () => {
  enviados.length = 0;
  process.env.CARNES_MAIL_PROVEEDORES = "";
  const r = recepcionBase();
  const res = await Notif.notificarRecepcionProveedor(r, r.items, resumenBase(), siesaEjemplo());
  assert.deepEqual(res, { success: false, omitido: true });
  assert.equal(enviados.length, 0);
});

test("notificarRecepcionProveedor: con destinatarios envía una vez a todos", async () => {
  enviados.length = 0;
  process.env.CARNES_MAIL_PROVEEDORES = "a@x.co;b@x.co";
  const r = recepcionBase();
  const res = await Notif.notificarRecepcionProveedor(r, r.items, resumenBase(), siesaEjemplo());
  assert.equal(res.success, true);
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0].to, ["a@x.co", "b@x.co"]);
  assert.match(enviados[0].subject, /^Carnes · Recepción de proveedor/);
});

test("notificarRecepcionProveedor: nunca lanza si el envío o el armado fallan", async () => {
  process.env.CARNES_MAIL_PROVEEDORES = "a@x.co";
  const r = recepcionBase();
  fallaEnvio = true;
  const silencio = mock.method(console, "error", () => {});
  try {
    const res = await Notif.notificarRecepcionProveedor(r, r.items, resumenBase(), siesaEjemplo());
    assert.equal(res.success, false);
    assert.match(res.error, /SMTP caído/);
  } finally {
    fallaEnvio = false;
    silencio.mock.restore();
  }
});

// ─── Controlador ────────────────────────────────────────────────────────────
function respuesta() {
  const res = { statusCode: 200 };
  res.json = (cuerpo) => { res.cuerpo = cuerpo; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  return res;
}
const peticion = () => ({ datosValidados: { id: 7 }, body: { recibido_por: "ana@empresa.com" }, headers: {} });

test("finalizar: avisa a proveedores UNA vez, después de SIESA y con su resultado", async () => {
  enviados.length = 0;
  llamadasDespues.length = 0;
  finalizada.ya = false;
  process.env.CARNES_MAIL_PROVEEDORES = "compras@x.co";
  const res = respuesta();
  let error;
  await Ctrl.finalizar(peticion(), res, (e) => { error = e; });
  assert.equal(error, undefined);
  assert.equal(llamadasDespues.length, 1);
  const paraProveedores = enviados.filter((m) => m.to.includes("compras@x.co"));
  assert.equal(paraProveedores.length, 1);
  assert.match(paraProveedores[0].html, /Error al subir a SIESA: Bodega &lt;inválida&gt;/);
  assert.equal(res.cuerpo.aviso_proveedores.success, true);
  assert.equal(res.cuerpo.ok, true);
});

test("finalizar: un reintento (ya finalizada) NO manda el aviso a proveedores", async () => {
  enviados.length = 0;
  finalizada.ya = true;
  process.env.CARNES_MAIL_PROVEEDORES = "compras@x.co";
  const res = respuesta();
  await Ctrl.finalizar(peticion(), res, () => {});
  assert.equal(enviados.filter((m) => m.to.includes("compras@x.co")).length, 0);
  assert.equal(res.cuerpo.aviso_proveedores, null);
  assert.equal(res.cuerpo.ya_finalizada, true);
  finalizada.ya = false;
});

test("finalizar: si el correo falla la respuesta sigue siendo 200 ok", async () => {
  enviados.length = 0;
  finalizada.ya = false;
  fallaEnvio = true;
  process.env.CARNES_MAIL_PROVEEDORES = "compras@x.co";
  const silencio = mock.method(console, "error", () => {});
  const res = respuesta();
  let error;
  try {
    await Ctrl.finalizar(peticion(), res, (e) => { error = e; });
  } finally {
    fallaEnvio = false;
    silencio.mock.restore();
  }
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.ok, true);
  assert.equal(res.cuerpo.aviso_proveedores.success, false);
  assert.equal(res.cuerpo.siesa.estado, "error");
});

test("finalizar: sin CARNES_MAIL_PROVEEDORES la respuesta lleva omitido", async () => {
  enviados.length = 0;
  finalizada.ya = false;
  process.env.CARNES_MAIL_PROVEEDORES = "";
  const res = respuesta();
  await Ctrl.finalizar(peticion(), res, () => {});
  assert.deepEqual(res.cuerpo.aviso_proveedores, { success: false, omitido: true });
});
