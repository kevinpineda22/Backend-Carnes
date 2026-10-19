import test from "node:test";
import assert from "node:assert/strict";

import {
  LIMITE_HISTORIAL_DEFECTO,
  VENTANA_DIAS_DEFECTO,
  armarFilaProveedor,
  armarFilaTalleres,
  escaparParaIlike,
  esEstadoDeHistorial,
  filtrarHistorial,
  mismoCorreo,
  normalizarCorreo,
  paginar,
  resumenTalleres,
  restarDias,
  ventanaHistorial,
} from "../src/shared/historialRecibidor.js";

test("normalizarCorreo: recorta y pasa a minúsculas; lo que no es texto es vacío", () => {
  assert.equal(normalizarCorreo("  Ana.Perez@Merkahorro.COM "), "ana.perez@merkahorro.com");
  assert.equal(normalizarCorreo(null), "");
  assert.equal(normalizarCorreo(42), "");
});

test("mismoCorreo: ignora mayúsculas y espacios, y el vacío nunca coincide", () => {
  assert.equal(mismoCorreo(" A@b.co", "a@B.CO "), true);
  assert.equal(mismoCorreo("a@b.co", "c@b.co"), false);
  assert.equal(mismoCorreo("", ""), false);
  assert.equal(mismoCorreo(null, undefined), false);
});

test("escaparParaIlike: el guion bajo y el porcentaje dejan de ser comodines", () => {
  assert.equal(escaparParaIlike("ana_perez@x.co"), "ana\\_perez@x.co");
  assert.equal(escaparParaIlike("100%\\"), "100\\%\\\\");
});

test("restarDias: cruza meses y años sin depender de la zona horaria", () => {
  assert.equal(restarDias("2026-03-01", 1), "2026-02-28");
  assert.equal(restarDias("2026-01-10", 15), "2025-12-26");
  assert.equal(restarDias("2024-03-01", 1), "2024-02-29");
});

test("ventanaHistorial: por defecto son 60 días hasta hoy", () => {
  assert.equal(VENTANA_DIAS_DEFECTO, 60);
  assert.deepEqual(ventanaHistorial({}, "2026-10-19"), { desde: "2026-08-20", hasta: "2026-10-19" });
  assert.deepEqual(ventanaHistorial(undefined, "2026-10-19"), { desde: "2026-08-20", hasta: "2026-10-19" });
});

test("ventanaHistorial: respeta lo que se pide y completa lo que falta", () => {
  assert.deepEqual(ventanaHistorial({ desde: "2026-10-01", hasta: "2026-10-05" }, "2026-10-19"), {
    desde: "2026-10-01",
    hasta: "2026-10-05",
  });
  assert.deepEqual(ventanaHistorial({ desde: "2026-10-01" }, "2026-10-19"), {
    desde: "2026-10-01",
    hasta: "2026-10-19",
  });
  // Sin `desde`, los 60 días se cuentan desde `hasta`, no desde hoy.
  assert.deepEqual(ventanaHistorial({ hasta: "2026-06-30" }, "2026-10-19"), {
    desde: "2026-05-01",
    hasta: "2026-06-30",
  });
});

test("esEstadoDeHistorial: el borrador no entra en ninguno de los dos módulos", () => {
  assert.equal(esEstadoDeHistorial("Borrador"), false);
  for (const e of ["Recibido", "Aprobado", "Costeado", "Enviado_SIESA", "Rechazado", "Finalizada", "Enviada_SIESA", "Anulada"]) {
    assert.equal(esEstadoDeHistorial(e), true, e);
  }
});

test("filtrarHistorial: saca borradores y recepciones de otra cuenta", () => {
  const filas = [
    { id: 1, estado: "Recibido", recibido_por: "Ana@x.co" },
    { id: 2, estado: "Borrador", recibido_por: "ana@x.co" },
    { id: 3, estado: "Recibido", recibido_por: "otra@x.co" },
    { id: 4, estado: "Finalizada", recibido_por: " ana@X.CO " },
    { id: 5, estado: "Finalizada", recibido_por: null },
  ];
  assert.deepEqual(
    filtrarHistorial(filas, "ANA@x.co").map((f) => f.id),
    [1, 4],
  );
  assert.deepEqual(filtrarHistorial(undefined, "ana@x.co"), []);
  assert.deepEqual(filtrarHistorial(filas, ""), []);
});

test("resumenTalleres: suma solo kilos con cantidad > 0, sin vísceras, y cuenta los renglones con cantidad", () => {
  const items = [
    { cantidad: "10.5", unidad: "KL" },
    { cantidad: 4, unidad: "KL" },
    { cantidad: 0, unidad: "KL" },
    { cantidad: -3, unidad: "KL" },
    { cantidad: 6, unidad: "UND" },
    { cantidad: 2.25 },
    { tipo: "vicera", cantidad: 9, unidad: "KL" },
  ];
  assert.deepEqual(resumenTalleres(items), { total_kilos: 16.75, renglones: 4 });
  assert.deepEqual(resumenTalleres(), { total_kilos: 0, renglones: 0 });
});

test("armarFilaTalleres: forma de la fila y sin firma ni cédula", () => {
  const fila = armarFilaTalleres({
    cabecera: {
      id: 7,
      fecha_ingreso: "2026-10-18",
      especie: "res",
      estado: "Recibido",
      recibidor_nombre: "Ana Pérez",
      recibido_por: "ana@x.co",
      sede: { id: 3, nombre: "Sede Norte" },
      firma_data: "data:image/png;base64,AAAA",
      recibidor_cedula: "123",
    },
    items: [{ cantidad: 12.5, unidad: "KL" }],
  });
  assert.deepEqual(fila, {
    id: 7,
    fecha_ingreso: "2026-10-18",
    especie: "res",
    sede: "Sede Norte",
    estado: "Recibido",
    recibidor_nombre: "Ana Pérez",
    total_kilos: 12.5,
    renglones: 1,
  });
  assert.equal("firma_data" in fila, false);
  assert.equal("recibidor_cedula" in fila, false);
});

test("armarFilaProveedor: el total es neto del descuento", () => {
  const cabecera = {
    id: 9,
    proveedor_razon_social: "Bucanero SAS",
    factura: "FE-12",
    fecha_recepcion: "2026-10-17",
    estado: "Finalizada",
    recibidor_nombre: null,
    descuento_pct: "10",
    sede: { id: 1, nombre: "Centro" },
    firma_data: "x",
    recibidor_cedula: "1",
  };
  const items = [
    { cantidad: 5, valor_total: 1000, cantidad_devuelta: 0 },
    { cantidad: 2, valor_total: 500, cantidad_devuelta: 0 },
    { cantidad: 0, valor_total: 999, cantidad_devuelta: 0 },
  ];
  const fila = armarFilaProveedor({ cabecera, items });
  assert.equal(fila.total, 1350);
  assert.equal(fila.renglones, 2);
  assert.equal(fila.descuento_pct, 10);
  assert.equal(fila.proveedor, "Bucanero SAS");
  assert.equal(fila.factura, "FE-12");
  assert.equal(fila.fecha, "2026-10-17");
  assert.equal(fila.sede, "Centro");
  assert.equal(fila.recibidor_nombre, null);
  assert.equal("firma_data" in fila, false);
  assert.equal("recibidor_cedula" in fila, false);

  const sinDescuento = armarFilaProveedor({ cabecera: { ...cabecera, descuento_pct: 0 }, items });
  assert.equal(sinDescuento.total, 1500);
});

test("paginar: recorta a `limite` y avisa si había más", () => {
  assert.equal(LIMITE_HISTORIAL_DEFECTO, 30);
  assert.deepEqual(paginar([1, 2, 3], 2), { filas: [1, 2], hay_mas: true });
  assert.deepEqual(paginar([1, 2], 2), { filas: [1, 2], hay_mas: false });
  assert.deepEqual(paginar(undefined, 2), { filas: [], hay_mas: false });
});
