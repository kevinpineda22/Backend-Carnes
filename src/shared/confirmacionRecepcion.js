import { formatearPesos } from "./proveedorValores.js";

/* =============================================
   Armado PURO del correo de confirmación que recibe quien hizo una recepción.

   Sin red ni base de datos: recibe la recepción, sus renglones y (proveedores) el
   resumen, y devuelve { to, subject, html } o null si no hay a quién escribirle.
   El envío vive en `services/notificaciones.service.js`; acá solo se arma, para
   poder probarlo sin SMTP.
   ============================================= */

const ZONA = "America/Bogota";

/** Forma mínima de un correo. No valida que exista, solo que no sea basura. */
const CORREO = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Escapa HTML. Descripciones, nombres y facturas los escribe un humano. */
export function esc(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Destinatario válido o null. `recibido_por` lo llena el front, así que puede venir
 * vacío, con espacios o con cualquier texto; también se descarta si trae varios
 * correos (coma o punto y coma) para no escribirle a más personas de las debidas.
 */
export function correoDestinatario(valor) {
  const correo = String(valor ?? "").trim();
  return CORREO.test(correo) ? correo : null;
}

/** Fecha y hora en Colombia. El servidor corre en UTC. */
function fechaHora(fecha) {
  const d = fecha ? new Date(fecha) : new Date();
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: ZONA,
  }).format(Number.isNaN(d.getTime()) ? new Date() : d);
}

const cantidadTexto = (n) =>
  new Intl.NumberFormat("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 3 })
    .format(Number(n) || 0);

const descripcionDe = (item) => item?.descripcion_item || item?.descripcion || "Producto sin descripción";

/** Solo los renglones que se recibieron: los que quedaron en 0 no aportan. */
export function renglonesRecibidos(items = []) {
  return (items || []).filter((i) => (Number(i?.cantidad) || 0) > 0);
}

const fila = (etiqueta, valor) =>
  `<tr><td style="color:#6b7280;">${etiqueta}</td><td align="right"><strong>${valor}</strong></td></tr>`;

function tablaRenglones(renglones, { conValor }) {
  const celda = "padding:6px 8px;border-bottom:1px solid #e5e7eb;";
  const cabecera =
    `<tr style="background:#f3f4f6;text-align:left;">` +
    `<th style="${celda}">Producto</th>` +
    `<th style="${celda}" align="right">Cantidad</th>` +
    `<th style="${celda}">Unidad</th>` +
    (conValor ? `<th style="${celda}" align="right">Valor</th>` : "") +
    `</tr>`;
  const cuerpo = renglones
    .map(
      (i) =>
        `<tr><td style="${celda}">${esc(descripcionDe(i))}</td>` +
        `<td style="${celda}" align="right">${cantidadTexto(i.cantidad)}</td>` +
        `<td style="${celda}">${esc(i.unidad || "KL")}</td>` +
        (conValor ? `<td style="${celda}" align="right">${esc(formatearPesos(i.valor_total))}</td>` : "") +
        `</tr>`,
    )
    .join("");
  return `<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;margin-bottom:20px;">${cabecera}${cuerpo}</table>`;
}

/** Subtotal / descuento / total neto (con descuento) o solo el total. */
function bloqueTotales(resumen) {
  if (!resumen) return "";
  const filas = [];
  if (Number(resumen.descuento_pct) > 0) {
    filas.push(fila("Subtotal", esc(formatearPesos(resumen.subtotal))));
    filas.push(
      fila(`Descuento (${esc(cantidadTexto(resumen.descuento_pct))}%)`, `- ${esc(formatearPesos(resumen.descuento))}`),
    );
    filas.push(fila("Total neto", esc(formatearPesos(resumen.total))));
  } else {
    filas.push(fila("Total", esc(formatearPesos(resumen.total))));
  }
  return `<table cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">${filas.join("")}</table>`;
}

function bloqueDevoluciones(items, resumen) {
  const devueltos = renglonesRecibidos(items).filter((i) => (Number(i.cantidad_devuelta) || 0) > 0);
  if (devueltos.length === 0) return "";
  const detalle = devueltos
    .map((i) => `${esc(descripcionDe(i))}: ${cantidadTexto(i.cantidad_devuelta)} ${esc(i.unidad || "KL")}`)
    .join("<br>");
  const valor = resumen && Number(resumen.total_devuelto) > 0
    ? `<p style="margin:8px 0 0;font-size:13px;">Valor devuelto: <strong>${esc(formatearPesos(resumen.total_devuelto))}</strong></p>`
    : "";
  return `
      <div style="border-left:4px solid #b45309;background:#fef3c7;padding:12px 16px;margin:0 0 20px;font-size:13px;color:#78350f;">
        <p style="margin:0 0 8px;font-weight:bold;">Esta recepción incluye devoluciones</p>
        ${detalle}
        ${valor}
      </div>`;
}

function envolver({ titulo, subtitulo, filas, cuerpo, id }) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;color:#1f2937;">
      <h2 style="margin:0 0 4px;font-size:20px;">${titulo}</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">${subtitulo}</p>

      <table cellpadding="6" cellspacing="0" width="100%"
             style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        ${filas.join("")}
      </table>

      ${cuerpo}

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">
        Recepción #${esc(id)} · Este correo es automático, no hace falta responderlo.
      </p>
    </div>`;
}

/**
 * Correo de confirmación para quien hizo una recepción.
 *
 * @param {"talleres"|"proveedor"} tipo
 * @param {object} recepcion  fila + sede (`recibido_por` es el destinatario)
 * @param {object[]} items    renglones de la recepción
 * @param {object} [resumen]  proveedores: `resumenRecepcion(items, { descuentoPct })`
 * @returns {{to: string, subject: string, html: string}|null} null si no hay destinatario válido
 */
export function armarConfirmacion(tipo, recepcion, items = [], resumen = null) {
  const to = correoDestinatario(recepcion?.recibido_por);
  if (!to) return null;

  const renglones = renglonesRecibidos(items);
  const sede = recepcion.sede?.nombre || `Sede ${recepcion.sede_id}`;
  const recibidor = recepcion.recibidor_nombre
    ? esc(recepcion.recibidor_nombre)
    : "—";

  if (tipo === "proveedor") {
    const razon = recepcion.proveedor_razon_social || "Proveedor";
    const factura = recepcion.factura || "—";
    const filas = [
      fila("Número de recepción", `#${esc(recepcion.id)}`),
      fila("Proveedor", esc(razon)),
      fila("Factura", esc(factura)),
      fila("Sede / bodega", esc(recepcion.bodega_siesa ? `${sede} · ${recepcion.bodega_siesa}` : sede)),
      fila("Fecha y hora", esc(fechaHora(recepcion.finalizado_at || recepcion.fecha_recepcion))),
      fila("Firmó como recibidor", recibidor),
    ];
    return {
      to,
      subject: `Recepción de proveedor registrada · ${razon} · Factura ${factura}`,
      html: envolver({
        titulo: "Recepción de proveedor registrada",
        subtitulo: "La recepción quedó registrada correctamente.",
        filas,
        cuerpo: `${tablaRenglones(renglones, { conValor: true })}${bloqueTotales(resumen)}${bloqueDevoluciones(items, resumen)}`,
        id: recepcion.id,
      }),
    };
  }

  const especie = recepcion.especie === "cerdo" ? "Cerdo" : "Res";
  const filas = [
    fila("Número de recepción", `#${esc(recepcion.id)}`),
    fila("Sede", esc(sede)),
    fila("Especie", especie),
    fila("Fecha y hora", esc(fechaHora(recepcion.recibido_at))),
    fila("Firmó como recibidor", recibidor),
  ];
  return {
    to,
    subject: `Recepción registrada · ${sede} · #${recepcion.id}`,
    html: envolver({
      titulo: "Recepción registrada",
      subtitulo: "Tu recepción quedó registrada correctamente.",
      filas,
      cuerpo: tablaRenglones(renglones, { conValor: false }),
      id: recepcion.id,
    }),
  };
}
