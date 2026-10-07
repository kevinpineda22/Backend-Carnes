import test from "node:test";
import assert from "node:assert/strict";

import {
  COLUMNAS_DETALLE_ADMIN,
  COLUMNAS_ENVIOS_LISTA,
  COLUMNAS_ITEMS_RESUMEN,
  COLUMNAS_LISTA_ADMIN,
  agruparPor,
  armarAcciones,
  armarFilaListado,
  datosBorrador,
  decidirAnulacion,
  decidirCorreccionFactura,
  decidirEliminacion,
  decidirEstadoCorreccion,
  enLotes,
  facturaSiesaEfectiva,
  itemsConDevuelto,
  marcarResolvibles,
  mensajeFacturaSiesaDuplicada,
  notaCreditoAdmin,
} from "../src/shared/adminProveedor.js";
import { decidirNotaCredito } from "../src/shared/siesaProveedorEnvio.js";

// Lo que decide el lado ADMIN de las recepciones de proveedor: qué columnas salen,
// qué acciones hay, qué se rechaza al corregir la referencia o anular. Todo puro.

const AHORA = new Date("2026-10-01T15:00:00Z"); // 10:00 en Bogotá

const columnas = (texto) =>
  texto
    .replace(/sede:carnes_sedes\s*\([^)]*\)/g, "sede")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

const envio = (tipo, estado, extra = {}) => ({
  id: extra.id ?? Math.floor(Math.random() * 1e6),
  tipo,
  estado,
  referencia: tipo === "entrada_proveedor" ? "TC PRV R12" : "TC PRV N12",
  enviado_at: "2026-09-30T14:00:00Z",
  ...extra,
});
const ENTRADA = (estado, extra) => envio("entrada_proveedor", estado, extra);
const NOTA = (estado, extra) => envio("nc_proveedor", estado, extra);

const item = (extra = {}) => ({
  id: 1,
  recepcion_id: 12,
  cantidad: 10,
  valor_total: 100000,
  cantidad_devuelta: 0,
  ...extra,
});

// ─── Columnas: nada sensible en la lista ───────────────────────────────────

test("columnas: la lista no pide firma, cédula, claves internas, observaciones ni `*`", () => {
  const lista = columnas(COLUMNAS_LISTA_ADMIN);
  for (const prohibida of [
    "firma_data",
    "recibidor_cedula",
    "factura_clave",
    "factura_siesa_clave",
    "observaciones",
    "recibidor_id",
    "*",
  ]) {
    assert.ok(!lista.includes(prohibida), `la lista no debe traer ${prohibida}`);
  }
  assert.ok(!COLUMNAS_LISTA_ADMIN.includes("*"));
  for (const necesaria of ["id", "estado", "factura", "factura_siesa", "proveedor_razon_social", "abierto_at", "recibidor_nombre", "anulado_por", "motivo_anulacion"]) {
    assert.ok(lista.includes(necesaria), `la lista debe traer ${necesaria}`);
  }
});

test("columnas: el detalle SÍ trae firma y cédula, y sigue sin claves internas ni `*`", () => {
  const detalle = columnas(COLUMNAS_DETALLE_ADMIN);
  assert.ok(detalle.includes("firma_data"));
  assert.ok(detalle.includes("recibidor_cedula"));
  assert.ok(detalle.includes("observaciones"));
  assert.ok(!detalle.includes("factura_clave"));
  assert.ok(!detalle.includes("factura_siesa_clave"));
  assert.ok(!COLUMNAS_DETALLE_ADMIN.includes("*"));
  // La lista es un subconjunto del detalle: no hay una columna que solo exista en una.
  for (const c of columnas(COLUMNAS_LISTA_ADMIN)) assert.ok(detalle.includes(c), `${c} falta en el detalle`);
});

test("columnas: las consultas auxiliares de la lista no traen payload ni respuesta ni firma", () => {
  assert.ok(!COLUMNAS_ENVIOS_LISTA.includes("payload"));
  assert.ok(!COLUMNAS_ENVIOS_LISTA.includes("respuesta"));
  assert.ok(!COLUMNAS_ENVIOS_LISTA.includes("*"));
  assert.ok(!COLUMNAS_ITEMS_RESUMEN.includes("*"));
  assert.ok(!COLUMNAS_ITEMS_RESUMEN.includes("firma"));
});

// ─── Utilidades ────────────────────────────────────────────────────────────

test("enLotes: parte en tandas y no pierde ni repite", () => {
  assert.deepEqual(enLotes([], 3), []);
  assert.deepEqual(enLotes([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(enLotes([1, 2], 5), [[1, 2]]);
});

test("agruparPor: agrupa por el valor como texto", () => {
  const grupos = agruparPor([{ r: 1, a: "x" }, { r: 2, a: "y" }, { r: 1, a: "z" }], "r");
  assert.deepEqual(Object.keys(grupos).sort(), ["1", "2"]);
  assert.equal(grupos["1"].length, 2);
  assert.deepEqual(agruparPor([], "r"), {});
});

test("facturaSiesaEfectiva: la corregida si existe, si no la factura", () => {
  assert.equal(facturaSiesaEfectiva({ factura: "FEV-2026-000123", factura_siesa: null }), "FEV-2026-000123");
  assert.equal(facturaSiesaEfectiva({ factura: "FEV-2026-000123", factura_siesa: " F123 " }), "F123");
  assert.equal(facturaSiesaEfectiva({ factura: "A1", factura_siesa: "   " }), "A1");
});

// ─── Borrador viejo ────────────────────────────────────────────────────────

test("datosBorrador: solo un borrador cuenta días; 3 días o más es 'viejo'", () => {
  const ahora = AHORA;
  assert.deepEqual(datosBorrador({ estado: "Finalizada", abierto_at: "2026-09-01T10:00:00Z" }, ahora), {
    dias_abierta: null,
    borrador_viejo: false,
  });
  assert.deepEqual(datosBorrador({ estado: "Borrador", abierto_at: "2026-10-01T13:00:00Z" }, ahora), {
    dias_abierta: 0,
    borrador_viejo: false,
  });
  assert.deepEqual(datosBorrador({ estado: "Borrador", abierto_at: "2026-09-29T20:00:00Z" }, ahora), {
    dias_abierta: 2,
    borrador_viejo: false,
  });
  assert.deepEqual(datosBorrador({ estado: "Borrador", abierto_at: "2026-09-28T20:00:00Z" }, ahora), {
    dias_abierta: 3,
    borrador_viejo: true,
  });
});

// ─── Fila del listado ──────────────────────────────────────────────────────

test("armarFilaListado: borrador sin envíos, con días abierto y atención 'borrador_viejo'", () => {
  const fila = armarFilaListado({
    cabecera: { id: 5, estado: "Borrador", abierto_at: "2026-09-20T10:00:00Z", factura: "F1", factura_siesa: null },
    items: [item({ recepcion_id: 5 })],
    envios: [],
    ahora: AHORA,
  });
  assert.equal(fila.siesa, null);
  assert.equal(fila.nota_credito_estado, null);
  assert.equal(fila.borrador_viejo, true);
  assert.equal(fila.dias_abierta, 11);
  assert.deepEqual(fila.atencion, ["borrador_viejo"]);
  assert.deepEqual(fila.resumen, { renglones: 1, total: 100000, total_devuelto: 0, renglones_con_devolucion: 0 });
  assert.equal(fila.factura_siesa_efectiva, "F1");
});

test("armarFilaListado: Finalizada con la entrada sin enviar pide atención; el error no viaja en la lista", () => {
  const base = { id: 7, estado: "Finalizada", factura: "F1" };
  const pendiente = armarFilaListado({ cabecera: base, items: [], envios: [], ahora: AHORA });
  assert.deepEqual(pendiente.siesa, { estado: "pendiente", referencia: null, envio_id: null });
  assert.deepEqual(pendiente.atencion, ["siesa_pendiente"]);

  const conError = armarFilaListado({
    cabecera: base,
    items: [],
    envios: [ENTRADA("error", { id: 3, error: "Texto largo de SIESA" })],
    ahora: AHORA,
  });
  assert.equal(conError.siesa.estado, "error");
  assert.ok(!("error" in conError.siesa), "el texto del error solo se ve en el detalle");
  assert.deepEqual(conError.atencion, ["siesa_error"]);

  const sinConfirmar = armarFilaListado({
    cabecera: base,
    items: [],
    envios: [ENTRADA("sin_confirmar", { id: 3 })],
    ahora: AHORA,
  });
  assert.deepEqual(sinConfirmar.atencion, ["siesa_sin_confirmar"]);
});

test("armarFilaListado: Enviada_SIESA con devolución y sin nota crédito ok pide atención", () => {
  const cabecera = { id: 9, estado: "Enviada_SIESA", factura: "F9" };
  const items = [item({ cantidad_devuelta: 2 })];

  const sinNota = armarFilaListado({ cabecera, items, envios: [ENTRADA("ok", { id: 1 })], ahora: AHORA });
  assert.equal(sinNota.siesa.estado, "ok");
  assert.equal(sinNota.nota_credito_estado, null);
  assert.deepEqual(sinNota.atencion, ["nota_credito_pendiente"]);
  assert.equal(sinNota.resumen.renglones_con_devolucion, 1);
  assert.equal(sinNota.resumen.total_devuelto, 20000);

  const conNota = armarFilaListado({
    cabecera,
    items,
    envios: [ENTRADA("ok", { id: 1 }), NOTA("ok", { id: 2 })],
    ahora: AHORA,
  });
  assert.equal(conNota.nota_credito_estado, "ok");
  assert.deepEqual(conNota.atencion, []);

  const sinDevolucion = armarFilaListado({ cabecera, items: [item()], envios: [ENTRADA("ok", { id: 1 })], ahora: AHORA });
  assert.deepEqual(sinDevolucion.atencion, []);
});

test("armarFilaListado: una anulada no pide nada y no se pierde la cabecera", () => {
  const fila = armarFilaListado({
    cabecera: { id: 4, estado: "Anulada", factura: "F4", motivo_anulacion: "error de digitación" },
    items: [item()],
    envios: [ENTRADA("anulado", { id: 1 })],
    ahora: AHORA,
  });
  assert.equal(fila.motivo_anulacion, "error de digitación");
  assert.deepEqual(fila.atencion, []);
  assert.equal(fila.siesa.estado, "anulado");
});

// ─── Detalle ───────────────────────────────────────────────────────────────

test("itemsConDevuelto: valor_devuelto calculado, 0 sin cantidad", () => {
  const [a, b, c] = itemsConDevuelto([
    item({ cantidad: 10, valor_total: 1_000_000, cantidad_devuelta: 1 }),
    item({ cantidad: 0, valor_total: null, cantidad_devuelta: 0 }),
    item({ cantidad: 3, valor_total: 100, cantidad_devuelta: 0 }),
  ]);
  assert.equal(a.valor_devuelto, 100000);
  assert.equal(b.valor_devuelto, 0);
  assert.equal(c.valor_devuelto, 0);
  assert.equal(a.cantidad, 10, "el resto del renglón queda igual");
});

test("marcarResolvibles: sin_confirmar y enviando abandonado se pueden resolver; el resto no", () => {
  const limiteMs = 6 * 60 * 1000;
  const ahora = new Date("2026-10-01T12:00:00Z").getTime();
  const hace = (min) => new Date(ahora - min * 60_000).toISOString();
  const r = marcarResolvibles(
    [
      { id: 1, estado: "sin_confirmar", enviado_at: hace(1) },
      { id: 2, estado: "enviando", enviado_at: hace(2) },
      { id: 3, estado: "enviando", enviado_at: hace(7) },
      { id: 4, estado: "ok", enviado_at: hace(100) },
      { id: 5, estado: "error", enviado_at: hace(100) },
    ],
    { ahora, limiteMs },
  );
  assert.deepEqual(
    r.map((e) => [e.id, e.resolvible, e.abandonado]),
    [
      [1, true, false],
      [2, false, false],
      [3, true, true],
      [4, false, false],
      [5, false, false],
    ],
  );
});

test("notaCreditoAdmin: pendiente = requerida y no ok; borrador/anulada no aplica", () => {
  const bloqueada = { requerida: true, estado: "bloqueada", bloqueo: "Conector sin configurar", referencia: null, error: null };
  assert.equal(notaCreditoAdmin(bloqueada, "Enviada_SIESA").pendiente, true);
  assert.equal(notaCreditoAdmin(bloqueada, "Enviada_SIESA").bloqueo, "Conector sin configurar");
  assert.equal(notaCreditoAdmin({ ...bloqueada, estado: "ok" }, "Enviada_SIESA").pendiente, false);
  assert.equal(notaCreditoAdmin({ requerida: false, estado: "no_requerida" }, "Finalizada").pendiente, false);
  assert.deepEqual(notaCreditoAdmin(bloqueada, "Borrador"), {
    requerida: false,
    estado: "no_aplica",
    bloqueo: null,
    referencia: null,
    error: null,
    pendiente: false,
  });
  assert.equal(notaCreditoAdmin(bloqueada, "Anulada").requerida, false);
});

// ─── Corregir la referencia de factura ─────────────────────────────────────

test("corregir factura: formato — vacía o solo símbolos es 400, más de 12 es 400", () => {
  for (const invalida of ["", "   ", "---", null, undefined]) {
    const d = decidirCorreccionFactura({ estado: "Finalizada", envios: [], factura_siesa: invalida });
    assert.equal(d.accion, "rechazar");
    assert.equal(d.status, 400);
    assert.equal(d.codigo, "FACTURA_SIESA_INVALIDA");
  }
  const larga = decidirCorreccionFactura({ estado: "Finalizada", envios: [], factura_siesa: "FEV-2026-000123" });
  assert.equal(larga.status, 400);
  assert.equal(larga.codigo, "FACTURA_SIESA_NO_CABE");
  assert.match(larga.mensaje, /12 caracteres/);
  assert.match(larga.mensaje, /15/);
});

test("corregir factura: normaliza (mayúsculas, espacios) y devuelve la clave solo A-Z/0-9", () => {
  const d = decidirCorreccionFactura({ estado: "Finalizada", envios: [], factura_siesa: " fe-123  45 " });
  assert.deepEqual(d, { accion: "corregir", factura: "FE-123 45", clave: "FE12345" });
  // 12 exactos caben.
  assert.equal(
    decidirCorreccionFactura({ estado: "Finalizada", envios: [], factura_siesa: "ABCDEFGHIJKL" }).accion,
    "corregir",
  );
});

test("corregir factura: solo en Finalizada y sin entrada vigente ni ok", () => {
  const f = (estado, envios = []) => decidirCorreccionFactura({ estado, envios, factura_siesa: "F123" });

  assert.equal(f("Finalizada").accion, "corregir");
  // Un error o un anulado NO ocupan el lugar: se puede corregir (es el caso normal tras el bloqueo).
  assert.equal(f("Finalizada", [ENTRADA("error")]).accion, "corregir");
  assert.equal(f("Finalizada", [ENTRADA("anulado")]).accion, "corregir");

  const casos = [
    ["Borrador", [], "RECEPCION_BORRADOR"],
    ["Anulada", [], "RECEPCION_ANULADA"],
    ["Enviada_SIESA", [ENTRADA("ok")], "RECEPCION_ENVIADA"],
    ["Finalizada", [ENTRADA("ok")], "ENVIO_VIGENTE"],
    ["Finalizada", [ENTRADA("enviando")], "ENVIO_VIGENTE"],
    ["Finalizada", [ENTRADA("sin_confirmar")], "ENVIO_VIGENTE"],
    ["Rara", [], "ESTADO_DESCONOCIDO"],
  ];
  for (const [estado, envios, codigo] of casos) {
    const d = f(estado, envios);
    assert.equal(d.accion, "rechazar", estado);
    assert.equal(d.status, 409, estado);
    assert.equal(d.codigo, codigo, estado);
    assert.ok(!("ok" in d), "el rechazo no arrastra el `ok` interno");
  }
});

test("corregir factura: un envío de nota crédito no bloquea la corrección de la entrada", () => {
  assert.equal(decidirEstadoCorreccion({ estado: "Finalizada", envios: [NOTA("error")] }).ok, true);
});

test("mensajeFacturaSiesaDuplicada: nombra la otra recepción, su sede y su estado", () => {
  const m = mensajeFacturaSiesaDuplicada("F123", {
    id: 40,
    factura: "FEV-2026-000123",
    factura_siesa: "F123",
    estado: "Enviada_SIESA",
    sede: { nombre: "Calle 5" },
  });
  assert.match(m, /"F123"/);
  assert.match(m, /#40/);
  assert.match(m, /FEV-2026-000123/);
  assert.match(m, /Enviada_SIESA/);
  assert.match(m, /Calle 5/);
  assert.match(mensajeFacturaSiesaDuplicada("F123", null), /otra recepción/);
});

// ─── Anular ────────────────────────────────────────────────────────────────

test("decidirAnulacion: Finalizada y Enviada_SIESA sí; Borrador y Anulada no", () => {
  assert.deepEqual(decidirAnulacion({ estado: "Finalizada" }), { accion: "anular" });
  assert.deepEqual(decidirAnulacion({ estado: "Enviada_SIESA" }), { accion: "anular" });

  const borrador = decidirAnulacion({ estado: "Borrador" });
  assert.equal(borrador.accion, "rechazar");
  assert.equal(borrador.status, 409);
  assert.equal(borrador.codigo, "RECEPCION_BORRADOR");
  assert.match(borrador.mensaje, /descarta/);

  assert.equal(decidirAnulacion({ estado: "Anulada" }).codigo, "RECEPCION_ANULADA");
  assert.equal(decidirAnulacion({ estado: "Rara" }).codigo, "ESTADO_NO_ANULABLE");
});

// ─── Acciones ──────────────────────────────────────────────────────────────

const decisionNC = (estado, items, envios, { activo = true, bloqueos = [] } = {}) =>
  decidirNotaCredito({ estado, items, envios, activo, bloqueos, manual: true });

test("acciones: borrador — solo descartar", () => {
  const a = armarAcciones({
    estado: "Borrador",
    envios: [],
    activo: true,
    decisionNotaCredito: decisionNC("Borrador", [], []),
  });
  assert.equal(a.descartar.permitido, true);
  assert.equal(a.anular.permitido, false);
  assert.equal(a.anular.codigo, "RECEPCION_BORRADOR");
  assert.equal(a.corregir_factura.permitido, false);
  assert.equal(a.reintentar_siesa.permitido, false);
  assert.equal(a.reintentar_nota_credito.permitido, false);
});

test("acciones: Finalizada con la entrada en error — corregir, reintentar y anular directo", () => {
  const envios = [ENTRADA("error")];
  const a = armarAcciones({
    estado: "Finalizada",
    envios,
    activo: true,
    decisionNotaCredito: decisionNC("Finalizada", [item()], envios),
  });
  assert.equal(a.descartar.permitido, false);
  assert.deepEqual(a.anular, { permitido: true, codigo: null, motivo: null, requiere_anulado_en_siesa: false });
  assert.equal(a.corregir_factura.permitido, true);
  assert.equal(a.reintentar_siesa.permitido, true);
  assert.equal(a.reintentar_siesa.accion, "enviar");
});

test("acciones: SIESA apagado — no se puede reintentar pero sí corregir y anular", () => {
  const a = armarAcciones({
    estado: "Finalizada",
    envios: [],
    activo: false,
    decisionNotaCredito: decisionNC("Finalizada", [], [], { activo: false }),
  });
  assert.equal(a.reintentar_siesa.permitido, false);
  assert.equal(a.reintentar_siesa.codigo, "SIESA_APAGADO");
  assert.equal(a.reintentar_siesa.accion, null);
  assert.equal(a.corregir_factura.permitido, true);
  assert.equal(a.anular.permitido, true);
});

test("acciones: entrada sin_confirmar — anular y corregir bloqueados, reintentar bloqueado", () => {
  const envios = [ENTRADA("sin_confirmar")];
  const a = armarAcciones({
    estado: "Finalizada",
    envios,
    activo: true,
    decisionNotaCredito: decisionNC("Finalizada", [], envios),
  });
  assert.equal(a.anular.permitido, false);
  assert.equal(a.anular.codigo, "ENVIO_SIN_RESOLVER");
  assert.equal(a.corregir_factura.codigo, "ENVIO_VIGENTE");
  assert.equal(a.reintentar_siesa.codigo, "ENVIO_VIGENTE");
});

test("acciones: Enviada_SIESA con entrada ok — anular pide confirmar SIESA; reintentar reconcilia", () => {
  const envios = [ENTRADA("ok")];
  const a = armarAcciones({
    estado: "Enviada_SIESA",
    envios,
    activo: true,
    decisionNotaCredito: decisionNC("Enviada_SIESA", [item()], envios),
  });
  assert.equal(a.anular.permitido, true);
  assert.equal(a.anular.requiere_anulado_en_siesa, true);
  assert.match(a.anular.motivo, /Anulá el documento en SIESA/);
  assert.equal(a.corregir_factura.codigo, "RECEPCION_ENVIADA");
  assert.equal(a.reintentar_siesa.permitido, true);
  assert.equal(a.reintentar_siesa.accion, "reconciliar");
  // Sin devoluciones no hay nota crédito que reintentar.
  assert.equal(a.reintentar_nota_credito.permitido, false);
  assert.equal(a.reintentar_nota_credito.codigo, "SIN_DEVOLUCIONES");
});

test("acciones: nota crédito — bloqueada por conector, permitida cuando se puede enviar", () => {
  const envios = [ENTRADA("ok")];
  const items = [item({ cantidad_devuelta: 1 })];

  const bloqueada = armarAcciones({
    estado: "Enviada_SIESA",
    envios,
    activo: true,
    decisionNotaCredito: decisionNC("Enviada_SIESA", items, envios, { bloqueos: ["Conector de nota crédito no configurado."] }),
  });
  assert.equal(bloqueada.reintentar_nota_credito.permitido, false);
  assert.equal(bloqueada.reintentar_nota_credito.codigo, "NOTA_CREDITO_BLOQUEADA");
  assert.match(bloqueada.reintentar_nota_credito.motivo, /Conector de nota crédito/);

  const libre = armarAcciones({
    estado: "Enviada_SIESA",
    envios,
    activo: true,
    decisionNotaCredito: decisionNC("Enviada_SIESA", items, envios),
  });
  assert.equal(libre.reintentar_nota_credito.permitido, true);

  const yaOk = armarAcciones({
    estado: "Enviada_SIESA",
    envios: [...envios, NOTA("ok")],
    activo: true,
    decisionNotaCredito: decisionNC("Enviada_SIESA", items, [...envios, NOTA("ok")]),
  });
  assert.equal(yaOk.reintentar_nota_credito.codigo, "NOTA_CREDITO_VIGENTE");
});

test("acciones: anulada — nada de nada; sin decisión de nota crédito no se asume que se puede", () => {
  const a = armarAcciones({ estado: "Anulada", envios: [ENTRADA("anulado")], activo: true });
  assert.equal(a.descartar.permitido, false);
  assert.equal(a.anular.permitido, false);
  assert.equal(a.anular.codigo, "RECEPCION_ANULADA");
  assert.equal(a.corregir_factura.permitido, false);
  assert.equal(a.reintentar_siesa.permitido, false);
  assert.equal(a.reintentar_nota_credito.permitido, false);
  assert.equal(a.reintentar_nota_credito.codigo, "SIN_DATOS");
});

test("acciones: la anulación con un envío ok y otro sin confirmar lo bloquea el sin confirmar", () => {
  const envios = [ENTRADA("ok"), NOTA("sin_confirmar")];
  const a = armarAcciones({ estado: "Enviada_SIESA", envios, activo: true, decisionNotaCredito: null });
  assert.equal(a.anular.permitido, false);
  assert.equal(a.anular.codigo, "ENVIO_SIN_RESOLVER");
});

test("decidirEliminacion: solo una Anulada, y sin envíos vigentes", () => {
  for (const estado of ["Borrador", "Finalizada", "Enviada_SIESA"]) {
    const d = decidirEliminacion({ estado });
    assert.equal(d.accion, "rechazar", estado);
    assert.equal(d.codigo, "RECEPCION_NO_ANULADA");
  }
  assert.deepEqual(decidirEliminacion({ estado: "Anulada" }), { accion: "eliminar" });
  assert.deepEqual(
    decidirEliminacion({ estado: "Anulada", envios: [{ estado: "anulado" }, { estado: "error" }] }),
    { accion: "eliminar" },
  );
  for (const estado of ["ok", "enviando", "sin_confirmar", "duplicado"]) {
    const d = decidirEliminacion({ estado: "Anulada", envios: [{ estado: "anulado" }, { estado }] });
    assert.equal(d.accion, "rechazar", estado);
    assert.equal(d.codigo, "ENVIO_VIGENTE");
  }
});

test("armarAcciones: eliminar solo se permite en una Anulada", () => {
  assert.equal(armarAcciones({ estado: "Anulada", envios: [{ estado: "anulado" }], activo: true }).eliminar.permitido, true);
  const finalizada = armarAcciones({ estado: "Finalizada", envios: [], activo: true }).eliminar;
  assert.equal(finalizada.permitido, false);
  assert.equal(finalizada.codigo, "RECEPCION_NO_ANULADA");
});
