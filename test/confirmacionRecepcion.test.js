import test from "node:test";
import assert from "node:assert/strict";

import { armarConfirmacion, correoDestinatario } from "../src/shared/confirmacionRecepcion.js";
import { resumenRecepcion } from "../src/shared/proveedorValores.js";

const talleres = (extra = {}) => ({
  id: 41,
  sede_id: 3,
  sede: { nombre: "Sede Centro" },
  especie: "res",
  recibido_por: "ana@empresa.com",
  recibido_at: "2026-10-19T15:00:00Z",
  recibidor_nombre: "Ana Pérez",
  ...extra,
});

const itemsTalleres = [
  { descripcion: "Lomo fino", cantidad: 12.5, unidad: "KL" },
  { descripcion: "Costilla", cantidad: 0, unidad: "KL" },
];

const proveedor = (extra = {}) => ({
  id: 7,
  sede_id: 3,
  sede: { nombre: "Sede Centro" },
  bodega_siesa: "B01",
  proveedor_razon_social: "Bucanero S.A.S.",
  factura: "FV-123",
  recibido_por: "ana@empresa.com",
  finalizado_at: "2026-10-19T15:00:00Z",
  recibidor_nombre: "Ana Pérez",
  descuento_pct: 0,
  ...extra,
});

const itemsProveedor = [
  { descripcion_item: "Pierna", cantidad: 10, unidad: "KL", valor_total: 100000 },
  { descripcion_item: "Cuello", cantidad: 0, unidad: "KL", valor_total: null },
];

test("correoDestinatario acepta un correo y descarta vacío o inválido", () => {
  assert.equal(correoDestinatario("  ana@empresa.com "), "ana@empresa.com");
  for (const malo of ["", null, undefined, "ana", "ana@empresa", "a@b.co, c@d.co", "a b@c.co"]) {
    assert.equal(correoDestinatario(malo), null);
  }
});

test("talleres: destinatario válido arma asunto y cuerpo", () => {
  const c = armarConfirmacion("talleres", talleres(), itemsTalleres);
  assert.equal(c.to, "ana@empresa.com");
  assert.equal(c.subject, "Recepción registrada · Sede Centro · #41");
  assert.match(c.html, /Lomo fino/);
  assert.match(c.html, /Ana Pérez/);
  assert.match(c.html, /Este correo es automático, no hace falta responderlo\./);
});

test("destinatario vacío o inválido no genera correo", () => {
  assert.equal(armarConfirmacion("talleres", talleres({ recibido_por: "" }), itemsTalleres), null);
  assert.equal(armarConfirmacion("talleres", talleres({ recibido_por: "no-es-correo" }), itemsTalleres), null);
  assert.equal(armarConfirmacion("proveedor", proveedor({ recibido_por: null }), itemsProveedor), null);
});

test("los renglones con cantidad 0 no aparecen", () => {
  const t = armarConfirmacion("talleres", talleres(), itemsTalleres);
  assert.doesNotMatch(t.html, /Costilla/);
  const p = armarConfirmacion("proveedor", proveedor(), itemsProveedor, resumenRecepcion(itemsProveedor));
  assert.doesNotMatch(p.html, /Cuello/);
  assert.match(p.html, /Pierna/);
});

test("proveedor sin descuento muestra solo el total", () => {
  const resumen = resumenRecepcion(itemsProveedor, { descuentoPct: 0 });
  const c = armarConfirmacion("proveedor", proveedor(), itemsProveedor, resumen);
  assert.equal(c.subject, "Recepción de proveedor registrada · Bucanero S.A.S. · Factura FV-123");
  assert.match(c.html, /Total/);
  assert.doesNotMatch(c.html, /Subtotal|Descuento|Total neto/);
});

test("proveedor con descuento muestra subtotal, descuento y total neto", () => {
  const resumen = resumenRecepcion(itemsProveedor, { descuentoPct: 5 });
  const c = armarConfirmacion("proveedor", proveedor({ descuento_pct: 5 }), itemsProveedor, resumen);
  assert.match(c.html, /Subtotal/);
  assert.match(c.html, /\$ 100\.000/);
  assert.match(c.html, /Descuento \(5%\)/);
  assert.match(c.html, /- \$ 5\.000/);
  assert.match(c.html, /Total neto/);
  assert.match(c.html, /\$ 95\.000/);
});

test("proveedor con devoluciones lo menciona", () => {
  const items = [{ ...itemsProveedor[0], cantidad_devuelta: 2, valor_total: 100000 }];
  const resumen = resumenRecepcion(items);
  const c = armarConfirmacion("proveedor", proveedor(), items, resumen);
  assert.match(c.html, /incluye devoluciones/);
  const sin = armarConfirmacion("proveedor", proveedor(), itemsProveedor, resumenRecepcion(itemsProveedor));
  assert.doesNotMatch(sin.html, /devoluciones/);
});

test("escapa el HTML de textos escritos por personas", () => {
  const items = [{ descripcion: '<script>alert("x")</script>', cantidad: 1, unidad: "KL" }];
  const c = armarConfirmacion("talleres", talleres({ recibidor_nombre: "<b>Ana</b> & Cía" }), items);
  assert.doesNotMatch(c.html, /<script>|<b>Ana/);
  assert.match(c.html, /&lt;script&gt;/);
  assert.match(c.html, /&lt;b&gt;Ana&lt;\/b&gt; &amp; Cía/);
  const p = armarConfirmacion("proveedor", proveedor({ proveedor_razon_social: "A&B <i>", factura: "<x>" }), itemsProveedor, resumenRecepcion(itemsProveedor));
  assert.match(p.html, /A&amp;B &lt;i&gt;/);
  assert.doesNotMatch(p.html, /<x>/);
});
