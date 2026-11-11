import { esc, renglonesRecibidos } from "./confirmacionRecepcion.js";
import { etiquetaSeccion, formatearPesos } from "./proveedorValores.js";

/* =============================================
   Armado PURO del aviso interno "recepción de proveedor" que reciben los
   destinatarios de CARNES_MAIL_PROVEEDORES (contabilidad / compras).

   Sin red ni base de datos: recibe la recepción finalizada, sus renglones, el
   resumen y el resultado de SIESA, y devuelve { subject, html }. El envío vive
   en `services/notificaciones.service.js`.
   ============================================= */

const ZONA = "America/Bogota";

function fechaHora(fecha) {
  const d = fecha ? new Date(fecha) : new Date();
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "full", timeStyle: "short", timeZone: ZONA }).format(
    Number.isNaN(d.getTime()) ? new Date() : d,
  );
}

const cantidadTexto = (n) =>
  new Intl.NumberFormat("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(Number(n) || 0);

const descripcionDe = (item) => item?.descripcion_item || item?.descripcion || "Producto sin descripción";

const fila = (etiqueta, valor) =>
  `<tr><td style="color:#6b7280;">${esc(etiqueta)}</td><td align="right"><strong>${valor}</strong></td></tr>`;

/** "Pierna · Con alas" (la sección solo si el renglón la tiene). */
function nombreConSeccion(item) {
  const seccion = etiquetaSeccion(item?.seccion);
  return seccion ? `${descripcionDe(item)} · ${seccion}` : descripcionDe(item);
}

/**
 * Estado de un envío a SIESA en palabras. `nombre` es el documento ("Entrada",
 * "Nota crédito"). Devuelve { texto, tono } con tono ok | error | aviso.
 */
export function textoEstadoSiesa(envio, { nombre = "Entrada" } = {}) {
  const referencia = envio?.referencia ? ` (${envio.referencia})` : "";
  switch (envio?.estado) {
    case "ok":
    case "duplicado":
      return { texto: "En SIESA", tono: "ok" };
    case "error":
      return {
        texto: `Error al subir a SIESA: ${envio?.error || "sin detalle del error"}`,
        tono: "error",
      };
    case "apagado":
      return { texto: "No se envió: el envío a SIESA está apagado", tono: "aviso" };
    case "sin_confirmar":
      return {
        texto: `Enviada, pero SIESA no confirmó: hay que revisar si quedó`,
        tono: "aviso",
      };
    case "pendiente":
      return {
        texto: envio?.bloqueo ? `Pendiente: ${envio.bloqueo}` : "Pendiente de enviar a SIESA",
        tono: "aviso",
      };
    default:
      if (envio?.bloqueo) return { texto: `Pendiente: ${envio.bloqueo}`, tono: "aviso" };
      return {
        texto: envio?.estado ? `${nombre}: estado ${envio.estado}${referencia}` : "Sin información de SIESA",
        tono: "aviso",
      };
  }
}

const COLOR_TONO = { ok: "#166534", error: "#b91c1c", aviso: "#b45309" };

function filaSiesa(etiqueta, referencia, estado) {
  const ref = referencia ? ` · Ref. ${esc(referencia)}` : "";
  return (
    `<tr><td style="color:#6b7280;">${esc(etiqueta)}</td>` +
    `<td align="right"><strong style="color:${COLOR_TONO[estado.tono]};">${esc(estado.texto)}</strong>${ref}</td></tr>`
  );
}

function tablaProductos(renglones) {
  const celda = "padding:6px 8px;border-bottom:1px solid #e5e7eb;";
  const cabecera =
    `<tr style="background:#f3f4f6;text-align:left;">` +
    `<th style="${celda}">Producto</th><th style="${celda}" align="right">Cantidad</th>` +
    `<th style="${celda}" align="right">Valor</th></tr>`;
  const cuerpo = renglones
    .map(
      (i) =>
        `<tr><td style="${celda}">${esc(nombreConSeccion(i))}</td>` +
        `<td style="${celda}" align="right">${esc(cantidadTexto(i.cantidad))} ${esc(i.unidad || "KL")}</td>` +
        `<td style="${celda}" align="right">${esc(formatearPesos(i.valor_total))}</td></tr>`,
    )
    .join("");
  return `<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:20px;">${cabecera}${cuerpo}</table>`;
}

function bloqueDevoluciones(renglones) {
  const devueltos = renglones.filter((i) => (Number(i.cantidad_devuelta) || 0) > 0);
  if (devueltos.length === 0) return "";
  const detalle = devueltos
    .map(
      (i) =>
        `${esc(nombreConSeccion(i))}: ${esc(cantidadTexto(i.cantidad_devuelta))} ${esc(i.unidad || "KL")}` +
        ` · Motivo: ${esc(i.motivo_devolucion || "sin motivo")}`,
    )
    .join("<br>");
  return `
      <div style="border-left:4px solid #b45309;background:#fef3c7;padding:12px 16px;margin:0 0 20px;font-size:13px;color:#78350f;">
        <p style="margin:0 0 8px;font-weight:bold;">Devoluciones</p>
        ${detalle}
      </div>`;
}

function bloqueTotales(resumen) {
  if (!resumen) return "";
  const hayDescuento = Number(resumen.descuento_pct) > 0 || Number(resumen.descuento) > 0;
  const filas = hayDescuento
    ? [
        fila("Subtotal", esc(formatearPesos(resumen.subtotal))),
        fila("Descuento", `- ${esc(formatearPesos(resumen.descuento))}`),
        fila("Total", esc(formatearPesos(resumen.total))),
      ]
    : [fila("Total", esc(formatearPesos(resumen.total)))];
  if (Number(resumen.iva) > 0) {
    filas.push(fila("IVA", esc(formatearPesos(resumen.iva))));
    filas.push(fila("Total a pagar", esc(formatearPesos(resumen.total_con_iva))));
  }
  if (Number(resumen.total_devuelto) > 0) {
    filas.push(fila("Valor devuelto", esc(formatearPesos(resumen.total_devuelto))));
  }
  return `<table cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">${filas.join("")}</table>`;
}

/** Cuántos archivos de la factura hay (acepta el arreglo o un `factura_total` ya contado). */
function totalFotos(recepcion) {
  if (Array.isArray(recepcion?.factura_archivos)) return recepcion.factura_archivos.length;
  return Number(recepcion?.factura_total) || 0;
}

/**
 * @param {object} recepcion  recepción finalizada (con `sede`, `factura_archivos`)
 * @param {object[]} items    renglones
 * @param {object} resumen    `resumenRecepcion(...)`
 * @param {object} [siesa]    salida de `despuesDeFinalizar`: { referencias, siesa, notaCredito }
 * @returns {{ subject: string, html: string }}
 */
export function armarAvisoProveedores(recepcion, items = [], resumen = null, siesa = null) {
  const razon = recepcion?.proveedor_razon_social || "Proveedor";
  const factura = recepcion?.factura || "—";
  const sede = recepcion?.sede?.nombre || `Sede ${recepcion?.sede_id}`;
  const renglones = renglonesRecibidos(items);

  const entrada = siesa?.siesa || null;
  const nota = siesa?.notaCredito || null;
  const refs = siesa?.referencias || {};

  const filasSiesa = [
    filaSiesa("SIESA · Entrada", entrada?.referencia || refs.entrada, textoEstadoSiesa(entrada, { nombre: "Entrada" })),
  ];
  // `nota` puede ser null si SIESA falló antes de evaluarla; las referencias dicen si hubo devolución.
  if (nota?.requerida || refs.nota_credito) {
    filasSiesa.push(
      filaSiesa(
        "SIESA · Nota crédito",
        nota.referencia || refs.nota_credito,
        textoEstadoSiesa(nota, { nombre: "Nota crédito" }),
      ),
    );
  }

  const fotos = totalFotos(recepcion);
  const textoFotos =
    fotos > 0
      ? `La foto de la factura (${fotos} ${fotos === 1 ? "archivo" : "archivos"}) está en el panel de Proveedores.`
      : "Sin foto de factura.";

  const filas = [
    fila("Proveedor", esc(razon)),
    fila("NIT", esc(recepcion?.proveedor_nit || "—")),
    fila("Factura", esc(factura)),
    fila("Sede", esc(sede)),
    fila("Fecha y hora", esc(fechaHora(recepcion?.finalizado_at || recepcion?.fecha_recepcion))),
    fila("Recibido por", esc(recepcion?.recibidor_nombre || recepcion?.recibido_por || "—")),
  ];

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;color:#1f2937;">
      <h2 style="margin:0 0 4px;font-size:20px;">Recepción de proveedor</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">${esc(razon)} · Factura ${esc(factura)} · ${esc(sede)}</p>

      <table cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        ${filas.join("")}
      </table>

      ${renglones.length ? tablaProductos(renglones) : ""}
      ${bloqueDevoluciones(renglones)}
      ${bloqueTotales(resumen)}

      <table cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        ${filasSiesa.join("")}
      </table>

      <p style="font-size:13px;background:#f3f4f6;padding:12px;margin:0 0 20px;">${esc(textoFotos)}</p>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">
        Recepción #${esc(recepcion?.id)} · Este correo es automático, no hace falta responderlo.
      </p>
    </div>`;

  return {
    subject: `Carnes · Recepción de proveedor · ${razon} · Factura ${factura} · ${sede}`.replace(/\s+/g, " ").trim(),
    html,
  };
}
