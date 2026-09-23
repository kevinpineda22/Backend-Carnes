import { sendEmail, destinatariosAdmin, destinatariosAnulacion } from "./email.service.js";

/* =============================================
   Avisos por correo del módulo de carnes.

   · Recepción finalizada  → al admin, para que la revise.
   · Diferencia con la guía → al admin, cuando lo recibido se aparta del
                              informe del frigorífico más del umbral.
   · Anular entrada inicial → a quien anula en SIESA, cuando salió la oficial.
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

  // Si el QR no se verificó, el admin tiene que saberlo ANTES de liquidar. Es la
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
          antes de liquidar.
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
        <tr><td style="color:#6b7280;">Productos con cantidad</td>
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
        Ver la recepción
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

const pesos = (n) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })
    .format(Number(n) || 0);

/**
 * Avisa al admin que lo recibido se aparta del informe del frigorífico.
 *
 * Se manda al ADJUNTAR la guía —no al cerrar la recepción—, porque es el
 * momento en que existe la comparación. Y solo por encima del umbral: medio
 * kilo es báscula; dos kilos es carne.
 *
 * @param {object} recepcion  fila + sede
 * @param {object} cruce      salida de `cruzarDesposte`
 * @param {object} informe    fila de `carnes_desposte_informes`
 */
export async function notificarDiferenciaDesposte(recepcion, cruce, informe) {
  const t = cruce?.totales || {};
  const sede = recepcion.sede?.nombre || `Sede ${recepcion.sede_id}`;
  const especie = recepcion.especie === "cerdo" ? "Cerdo" : "Res";
  const faltan = Number(t.diferencia) < 0;
  const dif = Math.abs(Number(t.diferencia) || 0);

  const conDiferencia = (cruce?.lineas || []).filter(
    (l) => l.estado === "faltante" || l.estado === "sobrante" || l.estado === "solo_pdf",
  );

  const filas = conDiferencia
    .slice(0, 15)
    .map((l) => {
      const d = l.diferencia ?? -(l.kgPdf ?? 0);
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">${esc(l.producto || l.descripcion)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${kilos(l.kgPdf)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${kilos(l.kgRecibido ?? 0)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;color:${d < 0 ? "#b91c1c" : "#b45309"};">${d > 0 ? "+" : ""}${kilos(d)}</td>
        </tr>`;
    })
    .join("");

  const panel = process.env.CARNES_PANEL_URL || "https://merkahorro.com/carnes/admin";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
      <h2 style="margin:0 0 4px;color:#b91c1c;">${faltan ? "Faltan" : "Sobran"} ${kilos(dif)} kg en ${esc(sede)}</h2>
      <p style="margin:0 0 16px;color:#6b7280;">${especie} · Recepción #${recepcion.id} · ${hora()}</p>

      <table style="border-collapse:collapse;width:100%;margin:0 0 16px;font-size:14px;">
        <tr><td style="padding:4px 8px;color:#6b7280;">El informe del frigorífico dice</td><td style="padding:4px 8px;text-align:right;"><b>${kilos(t.kgPdf)} kg</b></td></tr>
        <tr><td style="padding:4px 8px;color:#6b7280;">El recibidor digitó</td><td style="padding:4px 8px;text-align:right;"><b>${kilos(t.kgRecibido)} kg</b></td></tr>
        <tr><td style="padding:4px 8px;color:#6b7280;">Diferencia</td><td style="padding:4px 8px;text-align:right;color:#b91c1c;"><b>${t.diferencia > 0 ? "+" : ""}${kilos(t.diferencia)} kg</b></td></tr>
      </table>

      ${
        filas
          ? `<p style="margin:0 0 6px;font-size:13px;color:#6b7280;">Productos con diferencia:</p>
             <table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 16px;">
               <tr style="color:#6b7280;"><th style="text-align:left;padding:6px 8px;">Producto</th><th style="text-align:right;padding:6px 8px;">Informe</th><th style="text-align:right;padding:6px 8px;">Recibido</th><th style="text-align:right;padding:6px 8px;">Dif.</th></tr>
               ${filas}
             </table>`
          : ""
      }

      <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">
        Lote ${esc(informe?.lote || "—")} · desposte del ${esc(informe?.fecha_desposte || "—")}.
        Revisala antes de liquidarla, y reclamale al frigorífico si corresponde.
      </p>

      <a href="${panel}" style="display:inline-block;background:#1f2937;color:#fff;text-decoration:none;padding:12px 24px;font-size:14px;border-radius:4px;">Abrir la recepción</a>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">Este correo es automático, no hace falta responderlo.</p>
    </div>`;

  return sendEmail({
    to: destinatariosAdmin(),
    subject: `${faltan ? "Faltan" : "Sobran"} ${kilos(dif)} kg — ${sede} · ${especie}`,
    html,
  });
}

/**
 * Avisa a quien anula en SIESA: salió la entrada oficial, hay que anular la
 * inicial. Lleva las dos referencias para que no haya que buscar nada.
 *
 * @param {object} recepcion   fila + sede
 * @param {object} inicial     fila de `carnes_siesa_envios` (o null si no hubo)
 * @param {object} oficial     fila de `carnes_siesa_envios`
 */
export async function notificarAnularInicial(recepcion, inicial, oficial) {
  const sede = recepcion.sede?.nombre || `Sede ${recepcion.sede_id}`;
  const especie = recepcion.especie === "cerdo" ? "Cerdo" : "Res";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
      <h2 style="margin:0 0 4px;">Anular la entrada inicial de ${esc(sede)}</h2>
      <p style="margin:0 0 16px;color:#6b7280;">${especie} · Recepción #${recepcion.id} · ${hora()}</p>

      <p style="margin:0 0 12px;">
        Ya está en SIESA la <b>entrada oficial</b> de esta recepción, con los
        costos de la liquidación. La <b>entrada inicial</b> que se subió cuando
        llegó la carne hay que <b>anularla</b> para que el inventario no quede doble.
      </p>

      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 16px;">
        <tr>
          <td style="padding:8px;background:#fef2f2;border:1px solid #fecaca;white-space:nowrap;"><b>Anular</b> → inicial</td>
          <td style="padding:8px;background:#fef2f2;border:1px solid #fecaca;">
            referencia <b>${esc(inicial?.referencia || "—")}</b> · notas "TALLER DE CARNES - ENTRADA INICIAL"
            ${inicial ? `· ${kilos(inicial.total_kilos)} kg · ${pesos(inicial.total_valor)}` : "· (no hay registro del envío inicial: buscá por las notas)"}
          </td>
        </tr>
        <tr>
          <td style="padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;white-space:nowrap;"><b>Dejar</b> → oficial</td>
          <td style="padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;">
            referencia <b>${esc(oficial.referencia)}</b> · notas "TALLER DE CARNES - ENTRADA OFICIAL"
            · ${kilos(oficial.total_kilos)} kg · ${pesos(oficial.total_valor)}
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">
        Las dos están en elaboración. La oficial lleva en "documento referencia" la
        referencia de la inicial (${esc(inicial?.referencia || "—")}), por si hay que cotejar.
      </p>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">Este correo es automático, no hace falta responderlo.</p>
    </div>`;

  return sendEmail({
    to: destinatariosAnulacion(),
    subject: `Anular entrada inicial ${inicial?.referencia || ""} — ${sede} · ${especie}`.replace(/\s+/g, " "),
    html,
  });
}
