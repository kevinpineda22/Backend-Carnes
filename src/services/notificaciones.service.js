import { sendEmail, destinatariosAdmin } from "./email.service.js";

/* =============================================
   Avisos por correo del módulo de carnes.

   Hoy hay uno solo: cuando un recibidor cierra una recepción, el admin se
   entera sin tener que estar mirando el panel.
   ============================================= */

const ZONA = "America/Bogota";

/** Formatea una fecha en hora de Colombia. El servidor corre en UTC. */
function hora(fecha) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: ZONA,
  }).format(fecha ? new Date(fecha) : new Date());
}

const kilos = (n) =>
  new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 3 })
    .format(Number(n) || 0);

/** Escapa HTML. Las descripciones de los adicionales las escribe un humano. */
function esc(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Avisa al admin que un recibidor terminó de recibir.
 *
 * Best-effort: nunca lanza. Ver el comentario de `sendEmail` — el correo no
 * puede tumbar el cierre de una recepción.
 *
 * El asunto lleva la sede y la especie porque en un día de entrega grande llegan
 * ocho de estos correos seguidos, y el admin necesita distinguirlos en la lista
 * de la bandeja sin abrir ninguno.
 *
 * @param {object} recepcion  fila de `carnes_recepciones` + `sede`
 * @param {object[]} items    renglones de `carnes_recepcion_items`
 */
export async function notificarRecepcionFinalizada(recepcion, items = []) {
  const especie = recepcion.especie === "cerdo" ? "Cerdo" : "Res";
  const sede = recepcion.sede?.nombre || `Sede ${recepcion.sede_id}`;

  const carnes = items.filter((i) => i.tipo === "carne");
  const viceras = items.filter((i) => i.tipo === "vicera");
  const adicionales = items.filter((i) => i.tipo === "adicional");

  const totalKilos = items.reduce((acc, i) => acc + (Number(i.cantidad) || 0), 0);
  const conCantidad = items.filter((i) => (Number(i.cantidad) || 0) > 0).length;

  const panel =
    process.env.CARNES_PANEL_URL ||
    "https://merkahorro.com/carnes/admin";

  // Los adicionales van PRIMERO y destacados: son lo único de este correo que el
  // admin no puede resolver mirando la plantilla. Un renglón que el recibidor
  // escribió a mano todavía no tiene código de SIESA, y hasta que alguien lo
  // homologue ese producto no puede subir. Enterrado al final de una tabla de 38
  // filas, se pasa por alto.
  const bloqueAdicionales = adicionales.length
    ? `
      <div style="border-left:4px solid #b45309;background:#fef3c7;padding:12px 16px;margin:0 0 20px;">
        <p style="margin:0 0 8px;font-weight:bold;color:#92400e;">
          ⚠ ${adicionales.length} ítem(s) fuera de la plantilla
        </p>
        <p style="margin:0 0 8px;color:#78350f;font-size:13px;">
          El recibidor los escribió a mano. Hay que homologarlos a un código de
          SIESA antes de subir el documento.
        </p>
        <table cellpadding="4" cellspacing="0" style="font-size:13px;color:#451a03;">
          ${adicionales
            .map(
              (a) =>
                `<tr><td><strong>${esc(a.descripcion)}</strong></td>` +
                `<td align="right">${kilos(a.cantidad)} kg</td></tr>`,
            )
            .join("")}
        </table>
      </div>`
    : "";

  // Si el QR no se verificó, el admin tiene que saberlo ANTES de aprobar. Es la
  // única señal de que la sede del documento puede no ser la sede real.
  const avisoSede = recepcion.sede_verificada
    ? ""
    : `
      <div style="border-left:4px solid #b91c1c;background:#fee2e2;padding:12px 16px;margin:0 0 20px;">
        <p style="margin:0;font-weight:bold;color:#7f1d1d;">
          ⚠ La sede NO se verificó con el código QR
        </p>
        <p style="margin:6px 0 0;color:#7f1d1d;font-size:13px;">
          La sede de este documento la eligió el recibidor a mano. Confirmala
          antes de aprobar.
        </p>
      </div>`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;color:#1f2937;">
      <h2 style="margin:0 0 4px;font-size:20px;">Recepción de carne terminada</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">
        ${esc(sede)} · ${especie}
      </p>

      ${avisoSede}
      ${bloqueAdicionales}

      <table cellpadding="6" cellspacing="0" width="100%"
             style="border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <tr><td style="color:#6b7280;">Recibido por</td>
            <td align="right"><strong>${esc(recepcion.recibido_por || "—")}</strong></td></tr>
        <tr><td style="color:#6b7280;">Fecha y hora</td>
            <td align="right">${hora(recepcion.recibido_at)}</td></tr>
        <tr><td style="color:#6b7280;">Sede verificada por QR</td>
            <td align="right">${recepcion.sede_verificada ? "Sí" : "NO"}</td></tr>
        <tr><td style="color:#6b7280;">Novillos</td>
            <td align="right">${Number(recepcion.novillos) || 0}</td></tr>
        <tr><td style="color:#6b7280;">Renglones con cantidad</td>
            <td align="right">${conCantidad} de ${items.length}</td></tr>
        <tr><td style="color:#6b7280;">Cortes / vísceras / adicionales</td>
            <td align="right">${carnes.length} / ${viceras.length} / ${adicionales.length}</td></tr>
        <tr style="border-top:2px solid #e5e7eb;">
            <td style="padding-top:10px;"><strong>Total recibido</strong></td>
            <td align="right" style="padding-top:10px;"><strong>${kilos(totalKilos)} kg</strong></td></tr>
      </table>

      ${
        recepcion.observaciones
          ? `<p style="font-size:14px;background:#f3f4f6;padding:12px;margin:0 0 20px;">
               <strong>Observaciones del recibidor:</strong><br>${esc(recepcion.observaciones)}
             </p>`
          : ""
      }

      <a href="${panel}"
         style="display:inline-block;background:#1f2937;color:#ffffff;text-decoration:none;
                padding:12px 24px;font-size:14px;border-radius:4px;">
        Revisar y aprobar
      </a>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">
        Recepción #${recepcion.id} · Este correo es automático, no hace falta responderlo.
      </p>
    </div>`;

  return sendEmail({
    to: destinatariosAdmin(),
    subject: `Carne recibida — ${sede} · ${especie} · ${kilos(totalKilos)} kg`,
    html,
  });
}
