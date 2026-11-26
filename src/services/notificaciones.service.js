import {
  sendEmail,
  destinatariosAdmin,
  destinatariosAnulacion,
  destinatariosPreliquidacion,
  destinatariosProveedores,
} from "./email.service.js";
import { sandboxOn } from "../config/sandbox.js";
import { armarConfirmacion } from "../shared/confirmacionRecepcion.js";
import { armarAvisoProveedores } from "../shared/avisoRecepcionProveedor.js";

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

/**
 * La oficial CONSOLIDADA entró: un solo correo con todas las iniciales que hay
 * que anular, una fila por sede.
 *
 * Con una CEA por liquidación ya no hay una oficial por sede que apunte a su
 * inicial. Nueve correos de "anulá R2I", "anulá R3I"… para un solo documento
 * serían ruido; uno con la lista completa es lo que quien anula necesita.
 *
 * @param {{ id: number, especie: string }} liquidacion
 * @param {Array<{ sede: string, referencia: string, total_kilos: number, total_valor: number }>} iniciales
 * @param {{ referencia: string, total_kilos: number, total_valor: number, renglones: number }} oficial
 */
export async function notificarAnularIniciales(liquidacion, iniciales, oficial) {
  const especie = liquidacion?.especie === "cerdo" ? "Cerdo" : "Res";
  // Desde sql/033 la oficial sale una por fecha de ingreso: `oficial` resume varias
  // (la referencia lista todas, separadas por coma) y `documentos` dice cuántas.
  const varias = oficial?.documentos > 1;
  const textoOficial = varias
    ? `Ya están en SIESA las <b>${oficial.documentos} entradas oficiales</b> de esta liquidación ` +
      "(una por fecha de ingreso), con los costos liquidados de todas las sedes."
    : "Ya está en SIESA la <b>entrada oficial consolidada</b> de esta liquidación, " +
      "con los costos liquidados de todas las sedes en un solo documento.";
  const filas = iniciales
    .map(
      (i) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #fecaca;">${esc(i.sede || "—")}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #fecaca;"><b>${esc(i.referencia)}</b></td>
          <td style="padding:6px 8px;border-bottom:1px solid #fecaca;text-align:right;">${kilos(i.total_kilos)} kg</td>
          <td style="padding:6px 8px;border-bottom:1px solid #fecaca;text-align:right;">${pesos(i.total_valor)}</td>
        </tr>`,
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
      <h2 style="margin:0 0 4px;">Anular las entradas iniciales de la liquidación #${esc(liquidacion?.id)}</h2>
      <p style="margin:0 0 16px;color:#6b7280;">${especie} · ${hora()}</p>

      <p style="margin:0 0 12px;">
        ${textoOficial} Las
        <b>entradas iniciales</b> de abajo hay que <b>anularlas</b> para que el
        inventario no quede doble.
      </p>

      <p style="margin:0 0 6px;font-weight:bold;color:#7f1d1d;">Anular (notas "TALLER DE CARNES - ENTRADA INICIAL"):</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 16px;background:#fef2f2;">
        ${filas}
      </table>

      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 16px;">
        <tr>
          <td style="padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;white-space:nowrap;"><b>Dejar</b> → oficial${varias ? "es" : ""}</td>
          <td style="padding:8px;background:#f0fdf4;border:1px solid #bbf7d0;">
            referencia${varias ? "s" : ""} <b>${esc(oficial.referencia)}</b> · notas "TALLER DE CARNES - ENTRADA OFICIAL"
            · ${oficial.renglones} renglones · ${kilos(oficial.total_kilos)} kg · ${pesos(oficial.total_valor)}
          </td>
        </tr>
      </table>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">Este correo es automático, no hace falta responderlo.</p>
    </div>`;

  return sendEmail({
    to: destinatariosAnulacion(),
    subject: `Anular ${iniciales.length} entrada(s) inicial(es) — liquidación #${liquidacion?.id} · ${especie}`,
    html,
  });
}

/**
 * Envía el correo armado por `armarConfirmacion` a quien hizo la recepción.
 * Nunca lanza y sin destinatario válido no manda nada: solo deja un log. No lleva
 * copia al admin; ese ya recibe su propio aviso.
 */
async function enviarConfirmacion(tipo, recepcion, items, resumen) {
  try {
    const correo = armarConfirmacion(tipo, recepcion, items, resumen);
    if (!correo) {
      console.log(
        `[email] Confirmación de la recepción #${recepcion?.id} omitida: ` +
          `"recibido_por" vacío o sin forma de correo.`,
      );
      return { success: false, omitido: true };
    }
    return await sendEmail(correo);
  } catch (e) {
    console.error(`[email] Confirmación de la recepción #${recepcion?.id} falló: ${e?.message}`);
    return { success: false, error: e?.message || "Error al armar la confirmación" };
  }
}

/**
 * Confirma a quien recibió (talleres) que su recepción quedó registrada.
 * Best-effort: nunca lanza. Se espera igual que el aviso al admin (Vercel congela
 * la función al responder).
 *
 * @param {object} recepcion  fila de `carnes_recepciones` + `sede`
 * @param {object[]} items    renglones de `carnes_recepcion_items`
 */
export function notificarConfirmacionRecibidor(recepcion, items = []) {
  return enviarConfirmacion("talleres", recepcion, items, null);
}

/**
 * Confirma a quien recibió (proveedores) que la recepción quedó registrada, con
 * subtotal, descuento y total neto si el proveedor tiene descuento.
 *
 * @param {object} recepcion  recepción finalizada de `carnes_proveedor_recepciones`
 * @param {object[]} items    renglones
 * @param {object} resumen    `resumenRecepcion(items, { descuentoPct })`
 */
export function notificarConfirmacionProveedor(recepcion, items = [], resumen = null) {
  return enviarConfirmacion("proveedor", recepcion, items, resumen);
}

/**
 * Avisa a los destinatarios de CARNES_MAIL_PROVEEDORES que una recepción de
 * proveedor quedó finalizada, con el resultado de SIESA. Sin destinatarios no
 * manda nada (no hay respaldo al admin): solo deja un log. Nunca lanza; quien
 * llama lo espera (Vercel congela la función al responder).
 *
 * @param {object} recepcion  recepción finalizada de `carnes_proveedor_recepciones`
 * @param {object[]} items    renglones
 * @param {object} resumen    `resumenRecepcion(items, { descuentoPct })`
 * @param {object} [siesa]    resultado de `despuesDeFinalizar` ({ referencias, siesa, notaCredito })
 */
export async function notificarRecepcionProveedor(recepcion, items = [], resumen = null, siesa = null) {
  try {
    const to = destinatariosProveedores();
    if (to.length === 0) {
      console.log(
        `[email] Aviso de la recepción de proveedor #${recepcion?.id} omitido: ` +
          "CARNES_MAIL_PROVEEDORES vacía.",
      );
      return { success: false, omitido: true };
    }
    const { subject, html } = armarAvisoProveedores(recepcion, items, resumen, siesa);
    return await sendEmail({ to, subject, html });
  } catch (e) {
    console.error(`[email] Aviso de proveedores de la recepción #${recepcion?.id} falló: ${e?.message}`);
    return { success: false, error: e?.message || "Error al armar el aviso" };
  }
}

/** Nombre legible del tipo de envío a SIESA, para asunto y cuerpo del correo. */
const TIPO_ENVIO_LEGIBLE = {
  inicial: "Entrada inicial",
  oficial: "Entrada oficial",
  ajuste_visceras: "Ajuste de vísceras",
  ajuste_faltante: "Ajuste por faltante",
  visceras_recepcion: "Vísceras de la recepción",
};

/**
 * Avisa al admin que un envío de Talleres a SIESA terminó en error (sea porque
 * no salió —bloqueos, configuración— o porque SIESA lo rechazó).
 *
 * Mismos destinatarios que el aviso de recepción finalizada. Best-effort: nunca
 * lanza, y quien llama lo espera (Vercel congela la función al responder).
 *
 * @param {object} envio  fila de `carnes_siesa_envios` (tipo, referencia, recepcion_id,
 *                        liquidacion_id, error, novedad)
 * @param {{ sede?: string|null }} [extra]
 */
export async function notificarErrorEnvioSiesa(envio, { sede = null } = {}) {
  try {
    const tipo = TIPO_ENVIO_LEGIBLE[envio?.tipo] || String(envio?.tipo ?? "Envío");
    const referencia = envio?.referencia || "—";
    const panel = process.env.CARNES_PANEL_URL || "https://merkahorro.com/carnes/admin";

    const filas = [
      ["Tipo", tipo],
      ["Referencia", referencia],
      envio?.recepcion_id ? ["Recepción", `#${envio.recepcion_id}`] : null,
      envio?.liquidacion_id ? ["Liquidación", `#${envio.liquidacion_id}`] : null,
      sede ? ["Sede", sede] : null,
    ].filter(Boolean);

    const novedad = envio?.novedad
      ? `
      <div style="border-left:4px solid #b45309;background:#fef3c7;padding:12px 16px;margin:0 0 16px;">
        <p style="margin:0 0 6px;font-weight:bold;color:#92400e;">Novedad</p>
        <p style="margin:0;color:#78350f;font-size:13px;">${esc(envio.novedad)}</p>
      </div>`
      : "";

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111827;">
      <h2 style="margin:0 0 4px;">Error al subir a SIESA</h2>
      <p style="margin:0 0 16px;color:#6b7280;">${esc(tipo)} · ${esc(referencia)} · ${hora()}</p>

      <table cellpadding="6" cellspacing="0" width="100%"
             style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
        ${filas
          .map(
            ([k, v]) =>
              `<tr><td style="color:#6b7280;">${esc(k)}</td><td align="right"><strong>${esc(v)}</strong></td></tr>`,
          )
          .join("")}
      </table>

      <div style="border-left:4px solid #b91c1c;background:#fee2e2;padding:12px 16px;margin:0 0 16px;">
        <p style="margin:0 0 6px;font-weight:bold;color:#7f1d1d;">SIESA no recibió el documento</p>
        <p style="margin:0;color:#7f1d1d;font-size:13px;">${esc(envio?.error || "Sin detalle del error.")}</p>
      </div>
      ${novedad}
      <p style="margin:0 0 16px;font-size:13px;color:#374151;">
        Se puede reintentar desde el panel <b>SIESA Talleres</b>:
        <a href="${esc(panel)}">${esc(panel)}</a>
      </p>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">Este correo es automático, no hace falta responderlo.</p>
    </div>`;

    return await sendEmail({
      to: destinatariosAdmin(),
      subject: `Carnes · Error al subir a SIESA · ${tipo} ${referencia}`.replace(/\s+/g, " ").trim(),
      html,
    });
  } catch (e) {
    console.error(`[email] Aviso de error SIESA falló: ${e?.message}`);
    return { success: false, error: e?.message || "Error al armar el aviso" };
  }
}

/* =============================================
   Preliquidación de talleres (res / cerdo)

   Un solo correo parametrizado por tipo: cada tipo define el título, el texto que explica
   qué pasó y los datos que se muestran. Los destinatarios salen de
   `CARNES_MAIL_PRELIQUIDACION` (con respaldo al admin) y se leen por llamada; ninguna
   dirección va en el código.
   ============================================= */

export { destinatariosPreliquidacion };

const COP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const ENTERO = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });

/** Cómo se muestra cada dato del contexto: etiqueta y formato. */
const CAMPOS_PRELIQUIDACION = {
  animales: ["Animales de la sede", "entero"],
  solicitados: ["Animales solicitados por la sede", "entero"],
  restantes: ["Animales restantes en la preliquidación", "entero"],
  utilidad: ["Utilidad de la sede", "dinero"],
  gasto_sede: ["Gasto de la sede", "dinero"],
  motivo: ["Motivo", "texto"],
  error: ["Detalle del error", "texto"],
  intentos: ["Intentos de envío", "entero"],
  ventana_fin: ["Fin de la ventana", "fecha"],
  fecha_ingreso: ["Fecha de ingreso", "texto"],
  recepcion_id: ["Recepción", "id"],
  servicio_real: ["Servicio real", "dinero"],
  servicio_aplicado: ["Servicio aplicado", "dinero"],
  diferencia: ["Diferencia", "dinero"],
  no_asignada: ["Diferencia no asignada a sedes", "dinero"],
  monto_no_asignado: ["Monto no asignado (animales que no llegaron)", "dinero"],
  por: ["Registrado por", "texto"],
};

/** Título, explicación y datos de cada tipo. `grave` pinta el recuadro en rojo; si no, en ámbar. */
const AVISOS_PRELIQUIDACION = {
  excede_animales: {
    titulo: "Sede bloqueada: excede los animales de la preliquidación",
    grave: true,
    texto:
      "La sede tiene más animales de los que quedan por asignar. No consume animales ni se envía a SIESA " +
      "hasta que se corrija (editar cantidades, desvincular otras sedes o vincularla a mano).",
    campos: ["solicitados", "restantes"],
  },
  utilidad_negativa: {
    titulo: "Sede bloqueada: utilidad negativa",
    grave: true,
    texto: "La utilidad calculada de la sede es negativa. No se envía a SIESA hasta que se revise el costeo.",
    campos: ["utilidad", "gasto_sede", "animales"],
  },
  servicio_cero: {
    titulo: "Preliquidación bloqueada: servicio en cero",
    grave: true,
    texto: "No hay servicio cargado ni servicio por animal predeterminado: la preliquidación no se puede liquidar. Cargue el servicio.",
    campos: ["motivo"],
  },
  costeo_invalido: {
    titulo: "Sede bloqueada: el costeo no es válido",
    grave: true,
    texto: "No se pudo costear la sede con los datos actuales. No se envía a SIESA hasta corregirlo.",
    campos: ["motivo", "error"],
  },
  armado_invalido: {
    titulo: "Sede bloqueada: el armado del documento no es válido",
    grave: true,
    texto: "El documento de la sede no se puede armar con los datos actuales. No se envía a SIESA hasta corregirlo.",
    campos: ["motivo", "error"],
  },
  sin_preliquidacion: {
    titulo: "Recepción sin preliquidación abierta",
    grave: false,
    texto:
      "Se finalizó una recepción de taller y no hay una preliquidación abierta de su especie. " +
      "La sede queda sin vincular y sin enviar hasta que se cree o se vincule a mano.",
    campos: ["recepcion_id", "fecha_ingreso"],
  },
  oficial_legacy: {
    titulo: "Recepción con oficial del flujo anterior",
    grave: false,
    texto: "La recepción ya tiene un documento oficial del flujo anterior, por eso no se vinculó a la preliquidación.",
    campos: ["recepcion_id", "fecha_ingreso", "motivo"],
  },
  fuera_ventana: {
    titulo: "Recepción fuera de la ventana de la preliquidación",
    grave: false,
    texto: "La recepción llegó después de que venciera la ventana de la preliquidación abierta, por eso no se vinculó.",
    campos: ["recepcion_id", "fecha_ingreso", "ventana_fin"],
  },
  ventana_vencida: {
    titulo: "Ventana vencida con animales por asignar",
    grave: false,
    texto:
      "La ventana de la preliquidación terminó y todavía quedan animales sin asignar. " +
      "La preliquidación sigue abierta: cierre manualmente cuando corresponda.",
    campos: ["restantes", "ventana_fin"],
  },
  envio_error: {
    titulo: "Error al enviar la sede a SIESA",
    grave: true,
    texto: "El envío de la sede a SIESA falló. Se puede reintentar desde el panel.",
    campos: ["error", "intentos"],
  },
  visceras_error: {
    titulo: "Error al enviar las vísceras de la sede a SIESA",
    grave: true,
    texto:
      "La entrada oficial de la sede ya está en SIESA, pero el CEI de vísceras de su recepción falló. " +
      "El barrido horario lo reintenta unas veces; después se puede reenviar desde el panel de SIESA Talleres.",
    campos: ["error"],
  },
  reintentos_agotados: {
    titulo: "Reintentos agotados al enviar la sede a SIESA",
    grave: true,
    texto: "Se agotaron los reintentos automáticos. La sede solo se enviará de nuevo si el administrador lo pide desde el panel.",
    campos: ["error", "intentos"],
  },
  sin_confirmar: {
    titulo: "Envío a SIESA sin confirmar",
    grave: true,
    texto:
      "SIESA no confirmó si recibió el documento. No se reenvía a ciegas: revise en SIESA y resuelva el envío desde el panel.",
    campos: ["error"],
  },
  envio_en_vuelo: {
    titulo: "Envío a SIESA en curso sin respuesta",
    grave: false,
    texto: "Hay un envío de la sede a SIESA que sigue en curso. Se revisará en la siguiente corrida.",
    campos: ["error"],
  },
  inicial_pendiente: {
    titulo: "Sede en espera de la entrada inicial",
    grave: false,
    texto: "La entrada inicial de la sede todavía no está confirmada en SIESA, por eso no se envía la oficial.",
    campos: ["motivo"],
  },
  servicio_tardio: {
    titulo: "Servicio cargado después de la liquidación",
    grave: false,
    texto:
      "Se cargó un servicio distinto del aplicado cuando la preliquidación ya estaba liquidada. No se envió nada a SIESA: " +
      "se generó la liquidación alterna informativa y el saldo pendiente para la siguiente preliquidación.",
    campos: ["servicio_real", "servicio_aplicado", "diferencia", "no_asignada"],
    porSede: true,
  },
  requiere_correccion: {
    titulo: "Sede enviada que requiere corrección",
    grave: true,
    texto:
      "Cambió algún dato de la preliquidación después de enviar esta sede a SIESA. Los montos enviados no cambian: " +
      "revise si hay que anular y reenviar, o descarte la corrección desde el panel.",
    campos: ["motivo", "por"],
  },
  corrida_perdida: {
    titulo: "No hubo corrida programada",
    grave: true,
    texto:
      "Pasó la hora de la liquidación y no hay una corrida exitosa de esta preliquidación. " +
      "Ejecute el proceso manualmente desde el panel o desde el workflow.",
    campos: [],
  },
  cerrada: {
    titulo: "Preliquidación cerrada",
    grave: false,
    texto: "La preliquidación se cerró. El monto no asignado corresponde a los animales que nunca llegaron.",
    campos: ["monto_no_asignado"],
  },
};

/** Los tipos de aviso disponibles (los mismos de la cola de alertas). */
export const TIPOS_AVISO_PRELIQUIDACION = Object.freeze(Object.keys(AVISOS_PRELIQUIDACION));

function formatearCampo(valor, formato) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (formato === "dinero") return Number.isFinite(Number(valor)) ? COP.format(Number(valor)) : String(valor);
  if (formato === "entero") return Number.isFinite(Number(valor)) ? ENTERO.format(Number(valor)) : String(valor);
  if (formato === "id") return `#${valor}`;
  if (formato === "fecha") return hora(valor);
  return String(valor);
}

/**
 * Avisa por correo un evento de la preliquidación de talleres.
 *
 * Best-effort: NUNCA lanza. Sin destinatarios (G-S3) o con un fallo del transporte devuelve
 * `{ success: false }` y lo deja en el log: el correo no puede tumbar un cálculo ni un envío.
 * Con el sandbox encendido no sale nada y se informa como exitoso (la cola no acumula backlog).
 *
 * @param {string} tipo uno de `TIPOS_AVISO_PRELIQUIDACION`
 * @param {object} ctx  `especie`, `preliquidacion_id`, `sede_id`, `sede_nombre` y los datos del tipo
 * @param {{enviar?: Function, destinatarios?: () => string[], sandbox?: () => boolean, log?: object}} [opciones]
 *   dependencias inyectables para pruebas
 */
export async function notificarPreliquidacion(
  tipo,
  ctx = {},
  { enviar = sendEmail, destinatarios = () => destinatariosPreliquidacion(), sandbox = () => sandboxOn(), log = console } = {},
) {
  try {
    const aviso = AVISOS_PRELIQUIDACION[tipo];
    if (!aviso) {
      log.error?.(`[email] Aviso de preliquidación desconocido: "${tipo}"`);
      return { success: false, error: "Tipo de aviso desconocido" };
    }
    const datos = ctx && typeof ctx === "object" ? ctx : {};

    const especie = datos.especie ? String(datos.especie) : null;
    const idPreliq = Number(datos.preliquidacion_id) > 0 ? `#${datos.preliquidacion_id}` : null;
    const sede = datos.sede_nombre
      ? `${datos.sede_nombre}${Number(datos.sede_id) > 0 ? ` (#${datos.sede_id})` : ""}`
      : Number(datos.sede_id) > 0
        ? `#${datos.sede_id}`
        : null;

    const asunto = ["Carnes", ["Preliquidación", especie, idPreliq].filter(Boolean).join(" "), aviso.titulo, sede]
      .filter(Boolean)
      .join(" · ");

    if (sandbox()) {
      log.warn?.(`[email] SANDBOX - "${asunto}" NO se envió.`);
      return { success: true, sandbox: true };
    }

    const para = destinatarios();
    if (!para || para.length === 0) {
      log.error?.(
        `[email] CARNES_MAIL_PRELIQUIDACION no está definida (ni hay admin de respaldo): NO se envió "${asunto}".`,
      );
      return { success: false, error: "Sin destinatarios", sinDestinatarios: true };
    }

    const filas = [
      especie ? ["Especie", especie] : null,
      idPreliq ? ["Preliquidación", idPreliq] : null,
      sede ? ["Sede", sede] : null,
      ...aviso.campos.map((campo) => {
        const [etiqueta, formato] = CAMPOS_PRELIQUIDACION[campo];
        const valor = formatearCampo(datos[campo], formato);
        return valor === null ? null : [etiqueta, valor];
      }),
    ].filter(Boolean);

    const porSede =
      aviso.porSede && Array.isArray(datos.por_sede) && datos.por_sede.length
        ? `
      <p style="margin:16px 0 6px;font-weight:bold;">Cambio por sede</p>
      <table cellpadding="6" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
        ${datos.por_sede
          .map(
            (s) =>
              `<tr><td style="color:#6b7280;">Sede #${esc(s?.sede_id)}</td><td align="right"><strong>${esc(
                formatearCampo(s?.diferencia, "dinero") ?? "-",
              )}</strong></td></tr>`,
          )
          .join("")}
      </table>`
        : "";

    const [fondo, borde, texto] = aviso.grave ? ["#fee2e2", "#b91c1c", "#7f1d1d"] : ["#fef3c7", "#b45309", "#78350f"];
    const panel = process.env.CARNES_PANEL_URL || "https://merkahorro.com/carnes/admin";

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111827;">
      <h2 style="margin:0 0 4px;">${esc(aviso.titulo)}</h2>
      <p style="margin:0 0 16px;color:#6b7280;">${esc(["Preliquidación", especie, idPreliq].filter(Boolean).join(" "))} · ${hora()}</p>

      <div style="border-left:4px solid ${borde};background:${fondo};padding:12px 16px;margin:0 0 16px;">
        <p style="margin:0;color:${texto};font-size:13px;">${esc(aviso.texto)}</p>
      </div>

      <table cellpadding="6" cellspacing="0" width="100%"
             style="border-collapse:collapse;font-size:14px;margin-bottom:16px;">
        ${filas
          .map(
            ([k, v]) =>
              `<tr><td style="color:#6b7280;">${esc(k)}</td><td align="right"><strong>${esc(v)}</strong></td></tr>`,
          )
          .join("")}
      </table>
      ${porSede}
      <p style="margin:0 0 16px;font-size:13px;color:#374151;">
        Revise la preliquidación en el panel de administración:
        <a href="${esc(panel)}">${esc(panel)}</a>
      </p>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">Este correo es automático, no hace falta responderlo.</p>
    </div>`;

    return await enviar({ to: para, subject: asunto, html });
  } catch (e) {
    console.error(`[email] Aviso de preliquidación "${tipo}" falló: ${e?.message}`);
    return { success: false, error: e?.message || "Error al armar el aviso" };
  }
}
