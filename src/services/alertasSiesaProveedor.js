import { supabase } from "../config/supabase.js";
import { siesaActivo, parsearPisoVisceras } from "../config/siesa.js";
import { esMigracionFaltante } from "../shared/migraciones.js";
import { ESTADOS } from "../shared/estadosProveedor.js";
import { TIPO_ENVIO_PROVEEDOR } from "../shared/siesaProveedor.js";
import { sendEmail, destinatariosSiesaProveedores } from "./email.service.js";


/* =============================================
   Alerta por correo: recepciones de proveedor que NO llegaron a SIESA.

   Dos caminos que comparten el mismo correo y el mismo dedupe:

     · Inmediata  → `alertarEnvioProveedorFallido`, desde `registrarYEnviar`, cuando
                    un envío de proveedor termina en `error` o `sin_confirmar`.
     · Barrido    → `barrerProveedoresSinSiesa`, desde POST /api/cron/proveedores-siesa.
                    Recoge lo que NO dejó fila ni correo (SIESA apagado, función caída
                    antes de reservar) y lo que quedó trabado (`enviando` abandonado).

   Dedupe (sql/045): `alerta_siesa_at` (reclamado) y `alerta_siesa_enviada_at` (enviado) en
   la recepción. Se RECLAMA con un UPDATE condicional (`alerta_siesa_at is null`) ANTES de
   mandar el correo, así dos corridas simultáneas no mandan el mismo aviso; al salir el correo
   se anota `alerta_siesa_enviada_at`. Si el correo no sale (SMTP caído, sandbox) se libera el
   reclamo y el siguiente barrido lo reintenta. Un reclamo sin `enviada_at` de más de
   `RECLAMO_HUERFANO_MS` es de una función que murió a medias: el barrido lo reclama de nuevo.

   El barrido solo mira lo finalizado desde `CARNES_ALERTA_SIESA_DESDE` (sin ella no hace nada)
   y deja de empezar correos pasado `PRESUPUESTO_BARRIDO_MS`.

   Todo es best-effort: ningún camino lanza hacia quien lo llama.
   ============================================= */

const TABLA = "carnes_proveedor_recepciones";
const TABLA_ENVIOS = "carnes_siesa_envios";

/** Igual que `ENVIANDO_ABANDONADO_MS` del modelo de envíos: un `enviando` más viejo está trabado. */
export const ENVIANDO_ABANDONADO_MS = 6 * 60 * 1000;

export const MINUTOS_POR_DEFECTO = 30;
export const VENTANA_DIAS = 14;
/** Tope de correos por corrida: el resto sale en la siguiente (cada 15 min), sin saturar la función. */
export const MAX_ALERTAS_POR_CORRIDA = 25;
/** Tras este tiempo el barrido no empieza más correos (el resto queda pendiente). El curl del workflow espera bastante más. */
export const PRESUPUESTO_BARRIDO_MS = 90_000;
/** Un reclamo sin correo enviado de más de este tiempo se considera huérfano y se puede reclamar otra vez. */
export const RECLAMO_HUERFANO_MS = 15 * 60 * 1000;
/** PostgREST corta en silencio a 1000 filas: todo se lee por páginas de este tamaño o menos. */
const PAGINA_MAX = 1000;
const PAGINA_RECEPCIONES = 500;
const LOTE_IDS = 100;

export const MOTIVOS = {
  SIN_ENVIO: "sin_envio",
  SIESA_APAGADO: "siesa_apagado",
  ERROR: "error",
  SIN_CONFIRMAR: "sin_confirmar",
  ENVIANDO_ABANDONADO: "enviando_abandonado",
};

const COLUMNAS_RECEPCION =
  "id, estado, proveedor_razon_social, proveedor_nit, proveedor_sucursal, factura, factura_siesa, " +
  "bodega_siesa, codigo_co, fecha_recepcion, finalizado_at, recibido_por, recibidor_nombre, " +
  "sede:carnes_sedes ( nombre, codigo_co )";

let avisoPisoEmitido = false;
/** Solo para los tests. */
export function reiniciarAvisoPiso() {
  avisoPisoEmitido = false;
}

/**
 * Piso de activación del barrido: `CARNES_ALERTA_SIESA_DESDE` (estricto: `YYYY-MM-DD` = 00:00
 * Bogotá, o `YYYY-MM-DDTHH:mm(:ss)` con `Z` o `±HH:MM`). Sin ella, vacía o inválida el barrido NO
 * hace nada (falla seguro: evita avisar de todo el historial al desplegar); se avisa una vez.
 *
 * @returns {{desde: Date|null, motivo: null|"sin_definir"|"invalida"}}
 */
export function pisoDeAlerta(env = process.env) {
  const crudo = String(env.CARNES_ALERTA_SIESA_DESDE ?? "").trim();
  const desde = crudo ? parsearPisoVisceras(crudo) : null;
  if (desde) return { desde, motivo: null };
  const motivo = crudo ? "invalida" : "sin_definir";
  if (!avisoPisoEmitido) {
    avisoPisoEmitido = true;
    console.warn(
      motivo === "invalida"
        ? `[alerta-siesa-proveedor] CARNES_ALERTA_SIESA_DESDE tiene un formato inválido ("${crudo}"): use YYYY-MM-DD o ` +
            "YYYY-MM-DDTHH:mm:ss con Z o ±HH:MM. El barrido no avisa de nada hasta corregirla."
        : "[alerta-siesa-proveedor] CARNES_ALERTA_SIESA_DESDE no está definida: el barrido no avisa de nada " +
            "hasta definirla (fecha ISO de activación). La alerta inmediata sigue funcionando.",
    );
  }
  return { desde: null, motivo };
}

/** Minutos que una recepción Finalizada puede estar sin entrada ok antes de alertar. */
export function minutosDeAlerta(env = process.env) {
  const n = Number(env.CARNES_ALERTA_SIESA_MIN);
  return Number.isFinite(n) && n > 0 ? n : MINUTOS_POR_DEFECTO;
}

// ─── Clasificación (pura) ──────────────────────────────────────────────────

const aMs = (v) => {
  const t = new Date(v ?? 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * ¿Por qué una recepción Finalizada no está en SIESA? `null` = no hay nada que avisar
 * (la entrada ya está ok, o hay un envío en curso que todavía no es sospechoso).
 *
 * Mira solo los envíos de ENTRADA y descarta los `anulado`: una entrada anulada no cuenta
 * ni como ok ni como intento. Con un `ok` no avisa nunca.
 *
 * @param {{envios: object[], ahora?: Date, activo?: boolean}} p
 * @returns {?{motivo: string, detalle: string, envio: ?object}}
 */
export function clasificarRecepcion({ envios = [], ahora = new Date(), activo = true }) {
  const entradas = envios.filter(
    (e) => e.tipo === TIPO_ENVIO_PROVEEDOR.ENTRADA && e.estado !== "anulado",
  );
  if (entradas.some((e) => e.estado === "ok")) return null;

  const ultimo = [...entradas].sort(
    (a, b) => aMs(b.enviado_at) - aMs(a.enviado_at) || Number(b.id ?? 0) - Number(a.id ?? 0),
  )[0];

  if (!ultimo) {
    return activo
      ? {
          motivo: MOTIVOS.SIN_ENVIO,
          detalle: "La recepción se finalizó pero no hay ningún intento de envío a SIESA registrado.",
          envio: null,
        }
      : {
          motivo: MOTIVOS.SIESA_APAGADO,
          detalle:
            "La recepción se finalizó pero no hay ningún intento de envío a SIESA registrado: " +
            "el envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).",
          envio: null,
        };
  }

  if (ultimo.estado === "enviando") {
    const edad = aMs(ahora) - aMs(ultimo.enviado_at);
    if (edad <= ENVIANDO_ABANDONADO_MS) return null;
    return {
      motivo: MOTIVOS.ENVIANDO_ABANDONADO,
      detalle:
        `El envío ${ultimo.referencia || `#${ultimo.id}`} quedó en "enviando" hace más de ` +
        `${Math.round(edad / 60000)} minutos y no se resolvió.`,
      envio: ultimo,
    };
  }

  if (ultimo.estado === "sin_confirmar") {
    return {
      motivo: MOTIVOS.SIN_CONFIRMAR,
      detalle:
        `SIESA no confirmó el envío ${ultimo.referencia || `#${ultimo.id}`}` +
        (ultimo.error ? `: ${ultimo.error}` : ".") +
        " Verifique en SIESA si el documento existe y resuelva el envío (no lo reintente).",
      envio: ultimo,
    };
  }

  return {
    motivo: MOTIVOS.ERROR,
    detalle: ultimo.error || "SIESA rechazó el envío sin dar detalle.",
    envio: ultimo,
  };
}

// ─── Correo ────────────────────────────────────────────────────────────────

const esc = (texto) =>
  String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const hora = (fecha) =>
  fecha
    ? new Intl.DateTimeFormat("es-CO", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: "America/Bogota",
      }).format(new Date(fecha))
    : "—";

/** `fecha_recepcion` es un DATE: se formatea sin pasar por la zona horaria. */
const dia = (fecha) => {
  const m = String(fecha ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};

const TITULO_MOTIVO = {
  [MOTIVOS.SIN_ENVIO]: "No se intentó subir a SIESA",
  [MOTIVOS.SIESA_APAGADO]: "El envío a SIESA está apagado",
  [MOTIVOS.ERROR]: "SIESA no recibió el documento",
  [MOTIVOS.SIN_CONFIRMAR]: "SIESA no confirmó el documento",
  [MOTIVOS.ENVIANDO_ABANDONADO]: "El envío a SIESA quedó trabado",
};

/**
 * Arma el correo de una recepción de proveedor sin subir a SIESA. Puro.
 *
 * @param {{recepcion: object, motivo: string, detalle: string, documento?: string, panel?: string}} p
 */
export function armarCorreoAlerta({ recepcion, motivo, detalle, documento, esNota = false, panel }) {
  documento ??= esNota ? "Nota crédito" : "Entrada CEA";
  const titulo = esNota ? "Nota crédito de proveedor sin subir a SIESA" : "Recepción de proveedor sin subir a SIESA";
  const proveedor = recepcion.proveedor_razon_social || "Proveedor";
  const sede = recepcion.sede?.nombre || `Sede ${recepcion.sede_id ?? "—"}`;
  const co = recepcion.codigo_co || recepcion.sede?.codigo_co || "—";
  const url = panel || process.env.CARNES_PANEL_URL || "https://merkahorro.com/carnes/admin";
  const referencia = recepcion.factura_siesa
    ? `${recepcion.factura} (referencia SIESA: ${recepcion.factura_siesa})`
    : recepcion.factura || "—";
  const recibidor = [recepcion.recibidor_nombre, recepcion.recibido_por].filter(Boolean).join(" · ") || "—";

  const filas = [
    ["Proveedor", proveedor],
    ["NIT / sucursal", `${recepcion.proveedor_nit || "—"} / ${recepcion.proveedor_sucursal || "—"}`],
    ["Factura", referencia],
    ["Sede", sede],
    ["C.O. / bodega", `${co} / ${recepcion.bodega_siesa || "—"}`],
    ["Recibidor", recibidor],
    ["Fecha de recepción", dia(recepcion.fecha_recepcion)],
    ["Finalizada", hora(recepcion.finalizado_at)],
    ["Documento", documento],
  ];

  let accion;
  if (motivo === MOTIVOS.SIESA_APAGADO) {
    accion =
      "El envío a SIESA está apagado (<b>CARNES_SIESA_ACTIVO</b>): actívelo y luego reintente desde " +
      "<b>Carnes → Proveedores → Actualizar estado con SIESA / reintentar</b>:";
  } else if (motivo === MOTIVOS.SIN_CONFIRMAR) {
    accion =
      "Verifique en SIESA si el documento existe y <b>resuelva</b> el envío desde el panel de envíos a SIESA " +
      "(no lo reintente, para no duplicarlo):";
  } else if (esNota) {
    accion = "Reintente la nota crédito desde <b>Carnes → Proveedores</b> (detalle de la recepción):";
  } else {
    accion = "Reintente desde <b>Carnes → Proveedores → Actualizar estado con SIESA / reintentar</b>:";
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111827;">
      <h2 style="margin:0 0 4px;">${esc(titulo)}</h2>
      <p style="margin:0 0 16px;color:#6b7280;">Recepción #${esc(recepcion.id)} · ${esc(proveedor)}</p>

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
        <p style="margin:0 0 6px;font-weight:bold;color:#7f1d1d;">${esc(TITULO_MOTIVO[motivo] || "Sin subir a SIESA")}</p>
        <p style="margin:0;color:#7f1d1d;font-size:13px;">${esc(detalle)}</p>
      </div>

      <p style="margin:0 0 16px;font-size:13px;color:#374151;">
        ${accion}
        <a href="${esc(url)}">${esc(url)}</a>
      </p>

      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">Este correo es automático, no hace falta responderlo.</p>
    </div>`;

  return {
    subject: `${titulo} — #${recepcion.id} ${proveedor}`.replace(/\s+/g, " ").trim(),
    html,
  };
}

// ─── Reclamo, envío y liberación ───────────────────────────────────────────

let avisoSinDestinatarios = false;
/** Una sola línea por proceso: si no, cada barrido de 15 minutos llenaría el log. */
function avisarSinDestinatarios() {
  if (avisoSinDestinatarios) return;
  avisoSinDestinatarios = true;
  console.warn(
    "[alerta-siesa-proveedor] CARNES_MAIL_SIESA_PROVEEDORES está vacía: no se avisa de las " +
      "recepciones de proveedor que no llegan a SIESA.",
  );
}
/** Solo para los tests. */
export function reiniciarAvisoSinDestinatarios() {
  avisoSinDestinatarios = false;
}

const dependencias = (deps = {}) => ({
  db: deps.db ?? supabase,
  enviar: deps.enviar ?? sendEmail,
  destinatarios: deps.destinatarios ?? destinatariosSiesaProveedores,
});

/**
 * Filtro de "reclamable": sin reclamo, o con un reclamo huérfano (sin correo enviado y más viejo
 * que `RECLAMO_HUERFANO_MS`). Sirve igual para el UPDATE del reclamo y para leer candidatas.
 */
const filtroReclamable = (ahoraMs) =>
  `alerta_siesa_at.is.null,and(alerta_siesa_enviada_at.is.null,alerta_siesa_at.lt.${new Date(
    ahoraMs - RECLAMO_HUERFANO_MS,
  ).toISOString()})`;

/**
 * UPDATE condicional: solo gana quien encuentra la alerta sin reclamar (o con un reclamo
 * huérfano). `soloFinalizada` (el barrido) exige además que la recepción siga Finalizada.
 */
async function reclamar(db, recepcionId, motivo, marca, { soloFinalizada = false } = {}) {
  let consulta = db
    .from(TABLA)
    .update({ alerta_siesa_at: marca, alerta_siesa_enviada_at: null, alerta_siesa_motivo: motivo })
    .eq("id", recepcionId)
    .or(filtroReclamable(new Date(marca).getTime()));
  if (soloFinalizada) consulta = consulta.eq("estado", ESTADOS.FINALIZADA);
  const { data, error } = await consulta.select("id");
  if (error) return { estado: esMigracionFaltante(error) ? "sin_columnas" : "error", error };
  return { estado: data?.length ? "reclamada" : "ya_alertada" };
}

/** Devuelve el reclamo (solo si sigue siendo el nuestro) para que el siguiente barrido reintente. */
async function liberar(db, recepcionId, marca) {
  try {
    await db
      .from(TABLA)
      .update({ alerta_siesa_at: null, alerta_siesa_enviada_at: null, alerta_siesa_motivo: null })
      .eq("id", recepcionId)
      .eq("alerta_siesa_at", marca);
  } catch (e) {
    console.error(`[alerta-siesa-proveedor] no se pudo liberar el reclamo de #${recepcionId}: ${e?.message}`);
  }
}

/** Anota que el correo salió (solo si el reclamo sigue siendo el nuestro). Best-effort. */
async function marcarEnviada(db, recepcionId, marca, ahora) {
  try {
    const { error } = await db
      .from(TABLA)
      .update({ alerta_siesa_enviada_at: new Date(ahora).toISOString() })
      .eq("id", recepcionId)
      .eq("alerta_siesa_at", marca);
    if (error) {
      console.error(`[alerta-siesa-proveedor] no se pudo anotar el envío de #${recepcionId}: ${error.message}`);
    }
  } catch (e) {
    console.error(`[alerta-siesa-proveedor] no se pudo anotar el envío de #${recepcionId}: ${e?.message}`);
  }
}

/**
 * Reclama, manda y, si el correo no salió de verdad, libera. NUNCA lanza.
 *
 * `sinDedupe`: con las columnas de sql/045 sin crear, la alerta inmediata igual sale (un
 * fallo de envío es raro y vale más avisar); el barrido NO, porque repetiría el aviso
 * cada 15 minutos.
 *
 * @returns {Promise<{estado: 'enviada'|'sandbox'|'fallida'|'ya_alertada'|'sin_destinatarios'|'sin_columnas'|'error'}>}
 */
export async function alertarRecepcion(
  { recepcion, motivo, detalle, esNota = false },
  { sinDedupe = false, soloFinalizada = false, ahora = new Date(), ...deps } = {},
) {
  const { db, enviar, destinatarios } = dependencias(deps);
  try {
    const to = destinatarios();
    if (!to.length) {
      avisarSinDestinatarios();
      return { estado: "sin_destinatarios" };
    }

    const marca = new Date(ahora).toISOString();
    let reclamada = false;
    const reclamo = await reclamar(db, recepcion.id, motivo, marca, { soloFinalizada });
    if (reclamo.estado === "ya_alertada") return { estado: "ya_alertada" };
    if (reclamo.estado === "reclamada") reclamada = true;
    else if (reclamo.estado === "sin_columnas" && sinDedupe) {
      console.warn("[alerta-siesa-proveedor] falta sql/045: se avisa sin poder deduplicar.");
    } else {
      console.error(
        `[alerta-siesa-proveedor] no se pudo reclamar #${recepcion.id}: ${reclamo.error?.message || reclamo.estado}`,
      );
      return { estado: reclamo.estado };
    }

    let resultado;
    try {
      const { subject, html } = armarCorreoAlerta({ recepcion, motivo, detalle, esNota });
      resultado = await enviar({ to, subject, html });
    } catch (e) {
      resultado = { success: false, error: e?.message };
    }

    const salio = Boolean(resultado?.success) && !resultado?.sandbox;
    if (!salio && reclamada) await liberar(db, recepcion.id, marca);
    if (salio) {
      if (reclamada) await marcarEnviada(db, recepcion.id, marca, new Date());
      return { estado: "enviada" };
    }
    return { estado: resultado?.sandbox ? "sandbox" : "fallida" };
  } catch (e) {
    console.error(`[alerta-siesa-proveedor] #${recepcion?.id}: ${e?.message}`);
    return { estado: "error" };
  }
}

/**
 * Alerta INMEDIATA de un envío de proveedor que terminó en `error` o `sin_confirmar`.
 * Se llama desde `registrarYEnviar`; nunca lanza y nunca cambia el resultado del envío.
 *
 * @param {object} envio  fila de `carnes_siesa_envios` (recepcion_proveedor_id, tipo, estado, error, referencia)
 */
export async function alertarEnvioProveedorFallido(envio, opciones = {}) {
  const { db } = dependencias(opciones);
  try {
    const id = envio?.recepcion_proveedor_id;
    if (!id) return { estado: "sin_recepcion" };
    if (envio.estado !== "error" && envio.estado !== "sin_confirmar") return { estado: "no_aplica" };

    const { data: recepcion, error } = await db
      .from(TABLA)
      .select(COLUMNAS_RECEPCION)
      .eq("id", id)
      .maybeSingle();
    if (error || !recepcion) {
      console.error(`[alerta-siesa-proveedor] no se pudo leer la recepción #${id}: ${error?.message || "no existe"}`);
      return { estado: "error" };
    }
    if (![ESTADOS.FINALIZADA, ESTADOS.ENVIADA_SIESA].includes(recepcion.estado)) return { estado: "no_aplica" };

    const esNota = envio.tipo === TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO;
    const referencia = envio.referencia ? ` ${envio.referencia}` : "";
    const detalle =
      envio.estado === "sin_confirmar"
        ? `SIESA no confirmó el envío${referencia}${envio.error ? `: ${envio.error}` : "."} ` +
          "Verifique en SIESA si el documento existe y resuelva el envío (no lo reintente)."
        : envio.error || "SIESA rechazó el envío sin dar detalle.";

    return await alertarRecepcion(
      { recepcion, motivo: envio.estado === "sin_confirmar" ? MOTIVOS.SIN_CONFIRMAR : MOTIVOS.ERROR, detalle, esNota },
      { ...opciones, sinDedupe: true },
    );
  } catch (e) {
    console.error(`[alerta-siesa-proveedor] alerta inmediata: ${e?.message}`);
    return { estado: "error" };
  }
}

const pendientes = new Set();

/**
 * `waitUntil` del proyecto (`waitUntilPorDefecto`, de @vercel/functions). Carga perezosa: el módulo
 * arrastra la preliquidación entera y esta alerta no tiene por qué cargarla si no la usa.
 */
async function waitUntilDelProyecto(crearTarea) {
  const { waitUntilPorDefecto } = await import("./preliquidacionInmediato.js");
  return waitUntilPorDefecto(crearTarea);
}

/**
 * Alerta inmediata en segundo plano: NO se espera. Así el correo (SMTP lento) no retrasa el cierre
 * de la recepción ni la respuesta al celular, y nunca cambia el resultado del envío. En Vercel se
 * registra con `waitUntil` para que la función no se congele antes de que salga; sin él corre como
 * promesa suelta con su catch.
 *
 * @param {object} envio
 * @param {object} [opciones] `waitUntil` (inyectable en tests) + las de `alertarEnvioProveedorFallido`
 */
export async function despacharAlertaEnvioProveedor(envio, { waitUntil = waitUntilDelProyecto, ...opciones } = {}) {
  let tarea = null;
  const crear = () => {
    tarea ??= alertarEnvioProveedorFallido(envio, opciones)
      .catch((e) => console.error(`[alerta-siesa-proveedor] alerta en segundo plano: ${e?.message}`))
      .finally(() => pendientes.delete(tarea));
    pendientes.add(tarea);
    return tarea;
  };
  try {
    if (!(await waitUntil(crear))) crear();
  } catch (e) {
    console.error(`[alerta-siesa-proveedor] waitUntil: ${e?.message}`);
    crear();
  }
}

/** Solo para los tests: espera a que terminen las alertas en segundo plano. */
export async function esperarAlertasPendientes() {
  while (pendientes.size) await Promise.allSettled([...pendientes]);
}

/**
 * Borra la marca de alerta (reclamo y envío): se llama justo antes de que el admin reintente o
 * resuelva un envío, para que un nuevo fallo avise otra vez. Best-effort: nunca lanza ni frena el
 * reintento.
 */
export async function limpiarAlertaSiesa(recepcionId, opciones = {}) {
  const { db } = dependencias(opciones);
  try {
    const { error } = await db
      .from(TABLA)
      .update({ alerta_siesa_at: null, alerta_siesa_enviada_at: null, alerta_siesa_motivo: null })
      .eq("id", recepcionId)
      .not("alerta_siesa_at", "is", null);
    if (error && !esMigracionFaltante(error)) {
      console.error(`[alerta-siesa-proveedor] no se pudo limpiar la alerta de #${recepcionId}: ${error.message}`);
    }
  } catch (e) {
    console.error(`[alerta-siesa-proveedor] limpiar alerta de #${recepcionId}: ${e?.message}`);
  }
}

// ─── Barrido ───────────────────────────────────────────────────────────────

/** Lee TODAS las páginas de una consulta con `range` (nunca confía en el tope de 1000 de PostgREST). */
async function leerPaginado(construir, pagina) {
  const filas = [];
  for (let desde = 0; ; desde += pagina) {
    const { data, error } = await construir().range(desde, desde + pagina - 1);
    if (error) return { error };
    filas.push(...(data || []));
    if ((data?.length ?? 0) < pagina) return { data: filas };
  }
}

/**
 * Recepciones Finalizadas, finalizadas entre `piso` y `corte`, sin alerta. Paginación por
 * llave (`id > último`), no por offset: el reclamo de alertas cambia el conjunto mientras se lee.
 */
async function leerCandidatas(db, { piso, corte, pagina, ahoraMs }) {
  const filas = [];
  let ultimo = 0;
  for (;;) {
    const { data, error } = await db
      .from(TABLA)
      .select(COLUMNAS_RECEPCION)
      .eq("estado", ESTADOS.FINALIZADA)
      .or(filtroReclamable(ahoraMs))
      .gte("finalizado_at", piso)
      .lte("finalizado_at", corte)
      .gt("id", ultimo)
      .order("id", { ascending: true })
      .limit(pagina);
    if (error) return { error };
    filas.push(...(data || []));
    if ((data?.length ?? 0) < pagina) return { data: filas };
    ultimo = data[data.length - 1].id;
  }
}

async function leerEnvios(db, ids, { lote, pagina }) {
  const porRecepcion = new Map();
  for (let i = 0; i < ids.length; i += lote) {
    const trozo = ids.slice(i, i + lote);
    const { data, error } = await leerPaginado(
      () =>
        db
          .from(TABLA_ENVIOS)
          .select("id, recepcion_proveedor_id, tipo, estado, referencia, error, enviado_at")
          .eq("tipo", TIPO_ENVIO_PROVEEDOR.ENTRADA)
          .in("recepcion_proveedor_id", trozo)
          .order("id", { ascending: true }),
      pagina,
    );
    if (error) return { error };
    for (const e of data) {
      const lista = porRecepcion.get(e.recepcion_proveedor_id) || [];
      lista.push(e);
      porRecepcion.set(e.recepcion_proveedor_id, lista);
    }
  }
  return { data: porRecepcion };
}

/**
 * Barrido: avisa de cada recepción de proveedor Finalizada hace más de `minutos` que no
 * tiene una entrada ok en SIESA. Una alerta por recepción (ver el dedupe arriba).
 *
 * Solo mira las finalizadas en los últimos 14 días (el historial viejo no interesa). Lanza
 * solo si falla una lectura de la base (el cron responde 500 y el workflow lo ve); las
 * columnas de sql/045 sin crear NO lanzan: se informa en el resultado.
 *
 * @param {{minutos?: number, ahora?: Date, activo?: boolean, maxAlertas?: number,
 *          pagina?: number, lote?: number}} [opciones]
 */
export async function barrerProveedoresSinSiesa(opciones = {}, deps = {}) {
  const {
    minutos = minutosDeAlerta(),
    ahora = new Date(),
    activo = siesaActivo(),
    maxAlertas = MAX_ALERTAS_POR_CORRIDA,
    presupuestoMs = PRESUPUESTO_BARRIDO_MS,
    reloj = () => Date.now(),
    env = process.env,
  } = opciones;
  const inicio = reloj();
  const pagina = Math.min(opciones.pagina ?? PAGINA_RECEPCIONES, PAGINA_MAX);
  const lote = opciones.lote ?? LOTE_IDS;
  const { db, destinatarios } = dependencias(deps);

  const base = {
    ok: true, minutos, revisadas: 0, candidatas: 0, enviadas: 0, sandbox: 0, fallidas: 0,
    ya_alertadas: 0, descartadas: 0, pendientes: 0,
  };

  if (!destinatarios().length) {
    avisarSinDestinatarios();
    return { ...base, omitido: "sin_destinatarios" };
  }

  const { desde } = pisoDeAlerta(env);
  if (!desde) return { ...base, omitido: "sin_piso" };

  const ahoraMs = new Date(ahora).getTime();
  const corte = new Date(ahoraMs - minutos * 60_000).toISOString();
  // Ventana de 14 días, pero nunca antes del piso de activación.
  const piso = new Date(Math.max(ahoraMs - VENTANA_DIAS * 86_400_000, desde.getTime())).toISOString();

  const recepciones = await leerCandidatas(db, { piso, corte, pagina, ahoraMs });
  if (recepciones.error) {
    if (esMigracionFaltante(recepciones.error)) {
      console.error("[alerta-siesa-proveedor] falta sql/045_alerta_siesa_proveedor.sql: el barrido no corre.");
      return { ...base, omitido: "migracion_faltante" };
    }
    throw new Error(`Error al leer las recepciones de proveedor: ${recepciones.error.message}`);
  }
  if (!recepciones.data.length) return base;

  const envios = await leerEnvios(db, recepciones.data.map((r) => r.id), { lote, pagina });
  if (envios.error) throw new Error(`Error al leer los envíos de proveedor: ${envios.error.message}`);

  const resultado = { ...base, revisadas: recepciones.data.length };
  const alertas = [];
  for (const recepcion of recepciones.data) {
    const clasificada = clasificarRecepcion({ envios: envios.data.get(recepcion.id) || [], ahora, activo });
    if (clasificada) alertas.push({ recepcion, ...clasificada });
  }
  resultado.candidatas = alertas.length;

  for (const alerta of alertas) {
    if (
      resultado.enviadas + resultado.sandbox + resultado.fallidas >= maxAlertas ||
      reloj() - inicio >= presupuestoMs
    ) {
      resultado.pendientes += 1;
      continue;
    }

    // Releída justo antes de reclamar: lo clasificado arriba pudo cambiar (la entrada quedó ok, un
    // envío en curso terminó, otro barrido ya la avisó) mientras se mandaban los correos anteriores.
    const fresco = await leerEnvios(db, [alerta.recepcion.id], { lote, pagina });
    if (fresco.error) throw new Error(`Error al leer los envíos de proveedor: ${fresco.error.message}`);
    const vigente = clasificarRecepcion({ envios: fresco.data.get(alerta.recepcion.id) || [], ahora, activo });
    if (!vigente) {
      resultado.descartadas += 1;
      continue;
    }

    const { estado } = await alertarRecepcion(
      { recepcion: alerta.recepcion, motivo: vigente.motivo, detalle: vigente.detalle },
      { ahora, soloFinalizada: true, ...deps },
    );
    if (estado === "enviada") resultado.enviadas += 1;
    else if (estado === "sandbox") resultado.sandbox += 1;
    else if (estado === "ya_alertada") resultado.ya_alertadas += 1;
    else if (estado === "sin_destinatarios") return { ...resultado, omitido: "sin_destinatarios" };
    else if (estado === "sin_columnas") return { ...resultado, omitido: "migracion_faltante" };
    else resultado.fallidas += 1;
  }
  if (resultado.pendientes && reloj() - inicio >= presupuestoMs) resultado.presupuesto_agotado = true;
  return resultado;
}
