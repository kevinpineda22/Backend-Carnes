import { motivoApagado } from "../config/preliquidacion.js";
import { sandboxOn } from "../config/sandbox.js";
import { destinatariosPreliquidacion, emailConfigurado } from "./email.service.js";
import { enviarAlerta } from "./preliquidacionAlertasEnvio.js";

/**
 * Puerto de alertas de la preliquidación.
 *
 * Es una cola en la tabla `carnes_preliquidacion_alertas` con deduplicación por
 * `(evento, preliquidacion_id, sede_id, ocurrencia)`:
 *
 * - `encolarAlerta` solo inserta (`INSERT ... ON CONFLICT DO NOTHING`): no envía nada.
 * - `despacharAlertas` reclama las filas sin enviar, las manda por el transporte inyectado
 *   (`enviar`) y marca `enviado_ok` SOLO después de un envío exitoso. Un envío fallido deja la
 *   fila para la siguiente corrida (tope de `MAX_INTENTOS_ALERTA`).
 *
 * Ninguna de las dos lanza jamás: una alerta que falla no puede tumbar una liquidación ni un envío
 * a SIESA. Con el interruptor de la preliquidación apagado (o la compuerta de auth cerrada) no se produce nada (G4).
 *
 * Los destinatarios salen de `CARNES_MAIL_PRELIQUIDACION` (con respaldo al admin); si no hay,
 * se avisa por log (G-S3) y el flujo sigue.
 */

/** Tipos de alerta del diseño (ver "Emails"). */
export const EVENTOS_ALERTA = Object.freeze([
  "excede_animales",
  "utilidad_negativa",
  "servicio_cero",
  "costeo_invalido",
  "armado_invalido",
  "sin_preliquidacion",
  "oficial_legacy",
  "fuera_ventana",
  "ventana_vencida",
  "envio_error",
  "reintentos_agotados",
  "sin_confirmar",
  "envio_en_vuelo",
  "inicial_pendiente",
  "servicio_tardio",
  "requiere_correccion",
  "corrida_perdida",
  "cerrada",
]);

/**
 * Qué lleva cada evento en la clave de deduplicación (tabla "Alert dedupe" del diseño):
 * - `sede`: sede_id real y `ocurrencia` = versión de la sede tras la transición que entró al estado alertado.
 * - `recepcion`: sede 0 y `ocurrencia` = id de la recepción (el aviso se genera antes de tener sede).
 * - `alterna`: sede 0 y `ocurrencia` = id de la alterna.
 * - `preliquidacion`: sede 0 y ocurrencia 0 (una vez por preliquidación).
 */
export const REGLA_OCURRENCIA = Object.freeze({
  excede_animales: "sede",
  utilidad_negativa: "sede",
  servicio_cero: "sede",
  costeo_invalido: "sede",
  armado_invalido: "sede",
  envio_error: "sede",
  reintentos_agotados: "sede",
  sin_confirmar: "sede",
  envio_en_vuelo: "sede",
  inicial_pendiente: "sede",
  requiere_correccion: "sede",
  sin_preliquidacion: "recepcion",
  fuera_ventana: "recepcion",
  oficial_legacy: "recepcion",
  servicio_tardio: "alterna",
  ventana_vencida: "preliquidacion",
  corrida_perdida: "preliquidacion",
  cerrada: "preliquidacion",
});

/** Intentos de envío por fila antes de dejar de insistir (queda en el log y en la tabla). */
export const MAX_INTENTOS_ALERTA = 5;

/** Un reclamo más viejo que esto se considera abandonado (el proceso que lo tomó murió). */
export const VENCIMIENTO_RECLAMO_MS = 5 * 60 * 1000;

/**
 * Espera mínima desde el último intento (`reclamada_at`) antes de volver a reclamar una fila, según los
 * intentos ya gastados: 5, 10, 20 y 40 min. Evita agotar el tope en minutos cuando el SMTP está caído; con
 * un reclamo en vuelo (sin resultado) la misma espera hace de vencimiento.
 */
export function esperaReintentoMs(intentos) {
  const n = entero(intentos);
  return n <= 0 ? 0 : VENCIMIENTO_RECLAMO_MS * 2 ** (n - 1);
}

/** Filas que se despachan por invocación si el contexto no pide otro límite. */
const LIMITE_POR_DEFECTO = 25;
/** Filas que se leen para elegir las despachables (el filtro del reclamo vencido se hace en JS). */
const LECTURA_MAXIMA = 200;

const TABLA = "carnes_preliquidacion_alertas";
const CLAVE_UNICA = "evento,preliquidacion_id,sede_id,ocurrencia";
const VARIABLE_DESTINATARIOS = "CARNES_MAIL_PRELIQUIDACION";

/** Ejecuta un log sin dejar que un logger roto escape. */
function seguro(fn) {
  try {
    fn();
  } catch {
    // El log nunca debe afectar al flujo de negocio.
  }
}

/** La base real se carga bajo demanda: importar el cliente exige las variables de Supabase. */
async function baseDeDatos() {
  return (await import("../config/supabase.js")).supabase;
}

const entero = (valor) => (Number.isFinite(Number(valor)) ? Math.trunc(Number(valor)) : 0);

/** Normaliza la clave según la regla del evento, para que la deduplicación no dependa del llamador. */
function claveNormalizada(evento, datos) {
  const preliquidacionId = entero(datos.preliquidacionId);
  const sedeId = entero(datos.sedeId);
  const ocurrencia = entero(datos.ocurrencia);
  switch (REGLA_OCURRENCIA[evento]) {
    case "preliquidacion":
      return { preliquidacion_id: preliquidacionId, sede_id: 0, ocurrencia: 0 };
    case "recepcion":
    case "alterna":
      return { preliquidacion_id: preliquidacionId, sede_id: 0, ocurrencia };
    default:
      return { preliquidacion_id: preliquidacionId, sede_id: sedeId, ocurrencia };
  }
}

/**
 * Encola una alerta (solo inserta; el correo sale en `despacharAlertas`).
 *
 * @param {{evento: string, preliquidacionId?: *, sedeId?: *, ocurrencia?: *, detalle?: object}} alerta
 * @param {{log?: Pick<Console, "info"|"warn"|"error">, db?: object, env?: object}} [opciones]
 * @returns {Promise<{ok: boolean, encolada?: boolean, noop?: boolean, error?: string}>}
 *   `encolada:false` = ya existía esa clave; `noop:true` = no se encoló (flag apagado o evento inválido).
 */
export async function encolarAlerta(alerta, { log = console, db, env = process.env } = {}) {
  try {
    const datos = alerta && typeof alerta === "object" ? alerta : {};
    const evento = typeof datos.evento === "string" ? datos.evento : String(datos.evento);

    if (!EVENTOS_ALERTA.includes(evento)) {
      seguro(() => log.warn(`[preliquidacion-alertas] evento desconocido "${evento}"; se ignora`));
      return { ok: true, noop: true };
    }
    if (motivoApagado(env) !== null) return { ok: true, noop: true, motivo: "flag_apagado" };

    if (destinatariosPreliquidacion(env).length === 0) {
      seguro(() =>
        log.warn(
          `[preliquidacion-alertas] ${VARIABLE_DESTINATARIOS} no está definida: la alerta "${evento}" queda en cola hasta que haya a quién enviarla`,
        ),
      );
    }

    const cliente = db ?? (await baseDeDatos());
    const fila = {
      evento,
      ...claveNormalizada(evento, datos),
      detalle: datos.detalle && typeof datos.detalle === "object" ? datos.detalle : {},
      enviado_ok: false,
    };
    const { data, error } = await cliente
      .from(TABLA)
      .upsert(fila, { onConflict: CLAVE_UNICA, ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(error.message);

    const encolada = Array.isArray(data) && data.length > 0;
    seguro(() =>
      log.info(
        `[preliquidacion-alertas] ${evento} preliquidacion=${fila.preliquidacion_id} sede=${fila.sede_id} ` +
          `ocurrencia=${fila.ocurrencia} ${encolada ? "encolada" : "ya existía"}`,
      ),
    );
    return { ok: true, encolada };
  } catch (error) {
    seguro(() => log.error(`[preliquidacion-alertas] no se pudo encolar la alerta: ${error?.message}`));
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Reclamo atómico (CAS): solo gana quien ve la fila exactamente como la leyó. */
async function reclamar(cliente, fila, ahora) {
  let consulta = cliente
    .from(TABLA)
    .update({ reclamada_at: ahora.toISOString(), intentos_envio: fila.intentos_envio + 1 })
    .eq("id", fila.id)
    .eq("enviado_ok", false)
    .eq("intentos_envio", fila.intentos_envio);
  consulta = fila.reclamada_at == null ? consulta.is("reclamada_at", null) : consulta.eq("reclamada_at", fila.reclamada_at);
  const { data, error } = await consulta.select();
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/** El contexto del correo: el detalle de la alerta más las claves que la identifican. */
function contextoDeEnvio(fila) {
  return {
    ...(fila.detalle && typeof fila.detalle === "object" ? fila.detalle : {}),
    preliquidacion_id: fila.preliquidacion_id,
    sede_id: fila.sede_id,
    ocurrencia: fila.ocurrencia,
  };
}

/**
 * Despacha el backlog de alertas sin enviar.
 *
 * @param {{ahora?: Date, preliquidacionId?: number, limite?: number, hasta?: number}} [contexto]
 *   `hasta` (ms epoch) es la fecha límite: pasada, deja de reclamar filas nuevas.
 * @param {{enviar?: (evento: string, contexto: object) => Promise<{success: boolean, sandbox?: boolean, error?: string}>,
 *   notificar?: Function, db?: object, env?: object, log?: object, destinatarios?: () => string[], sandbox?: () => boolean}} [opciones]
 *   `enviar` es el transporte; por defecto completa el contexto desde la base y manda el correo de
 *   `notificarPreliquidacion` (`notificar` permite sustituir solo el correo).
 * @returns {Promise<{ok: boolean, enviadas: number, fallidas?: number, sin_destinatarios?: true, error?: string}>}
 */
export async function despacharAlertas(contexto, opciones = {}) {
  const {
    enviar,
    notificar,
    db,
    env = process.env,
    log = console,
    destinatarios = () => destinatariosPreliquidacion(env),
    sandbox = () => sandboxOn(),
    // Con transporte o notificador inyectado no se exige el SMTP real; por defecto sí.
    // Reloj para la fecha límite (`hasta`, ms epoch); inyectable en pruebas.
    reloj = () => Date.now(),
    emailListo = () => (typeof enviar === "function" || typeof notificar === "function" ? true : emailConfigurado()),
  } = opciones ?? {};
  try {
    const { ahora = new Date(), preliquidacionId, limite = LIMITE_POR_DEFECTO, hasta } = contexto && typeof contexto === "object" ? contexto : {};
    if (motivoApagado(env) !== null) return { ok: true, enviadas: 0 };

    if (!sandbox() && destinatarios().length === 0) {
      seguro(() => log.warn(`[preliquidacion-alertas] ${VARIABLE_DESTINATARIOS} no está definida: no se despachan alertas`));
      return { ok: true, enviadas: 0, sin_destinatarios: true };
    }

    // Sin SMTP configurado cada intento fallaría y agotaría el tope: no se reclama nada y se avisa una vez por corrida.
    if (!sandbox() && !emailListo()) {
      seguro(() => log.warn("[preliquidacion-alertas] EMAIL_USER/EMAIL_PASS no están configurados: no se despachan alertas"));
      return { ok: true, enviadas: 0, sin_correo: true };
    }

    const cliente = db ?? (await baseDeDatos());
    const transporte = typeof enviar === "function" ? enviar : (evento, ctx) => enviarAlerta(evento, ctx, { db: cliente, notificar, log });
    let lectura = cliente
      .from(TABLA)
      .select("*")
      .eq("enviado_ok", false)
      .lt("intentos_envio", MAX_INTENTOS_ALERTA)
      .order("created_at", { ascending: true });
    if (preliquidacionId !== undefined) lectura = lectura.eq("preliquidacion_id", preliquidacionId);
    const { data, error } = await lectura.limit(LECTURA_MAXIMA);
    if (error) throw new Error(error.message);

    // `reclamada_at` es la hora del último intento: la fila vuelve a ser elegible pasada la espera de su backoff.
    const candidatas = (data || [])
      .filter((f) => f.reclamada_at == null || new Date(f.reclamada_at).getTime() <= ahora.getTime() - esperaReintentoMs(f.intentos_envio))
      .slice(0, Math.max(0, entero(limite)));

    let enviadas = 0;
    let fallidas = 0;
    for (const candidata of candidatas) {
      // Presupuesto agotado: no se reclama nada nuevo (lo que falte lo toma la siguiente corrida).
      if (Number.isFinite(hasta) && reloj() >= hasta) break;
      let reclamada = null;
      try {
        reclamada = await reclamar(cliente, candidata, ahora);
      } catch (e) {
        seguro(() => log.error(`[preliquidacion-alertas] no se pudo reclamar la alerta ${candidata.id}: ${e?.message}`));
      }
      if (!reclamada) continue;

      let resultado;
      try {
        resultado = await transporte(reclamada.evento, contextoDeEnvio(reclamada));
      } catch (e) {
        resultado = { success: false, error: e?.message ?? String(e) };
      }

      try {
        if (resultado?.success) {
          const detalle = resultado.sandbox ? { ...(reclamada.detalle ?? {}), sandbox: true } : reclamada.detalle ?? {};
          const { error: errorMarca } = await cliente
            .from(TABLA)
            .update({ enviado_ok: true, enviado_at: ahora.toISOString(), detalle })
            .eq("id", reclamada.id);
          if (errorMarca) throw new Error(errorMarca.message);
          enviadas += 1;
          continue;
        }
        fallidas += 1;
        seguro(() =>
          log.warn(
            `[preliquidacion-alertas] el envío de la alerta ${reclamada.id} (${reclamada.evento}) falló ` +
              `(intento ${reclamada.intentos_envio}/${MAX_INTENTOS_ALERTA}): ${resultado?.error ?? "sin detalle"}`,
          ),
        );
        if (reclamada.intentos_envio >= MAX_INTENTOS_ALERTA) {
          seguro(() =>
            log.error(
              `[preliquidacion-alertas] la alerta ${reclamada.id} (${reclamada.evento}) agotó los ${MAX_INTENTOS_ALERTA} intentos y ya no se reintentará`,
            ),
          );
        }
        // El reclamo NO se libera: `reclamada_at` queda como hora del último intento y marca el backoff. Así un
        // proceso tardío no puede borrar el reclamo de otro (compare-and-set sobre el valor que puso cada quien).
      } catch (e) {
        seguro(() => log.error(`[preliquidacion-alertas] no se pudo actualizar la alerta ${reclamada.id}: ${e?.message}`));
      }
    }
    return { ok: true, enviadas, fallidas };
  } catch (error) {
    seguro(() => log.error(`[preliquidacion-alertas] el despacho falló: ${error?.message}`));
    return { ok: false, enviadas: 0, error: error?.message ?? String(error) };
  }
}
