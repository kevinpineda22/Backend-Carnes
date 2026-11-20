/**
 * Puerto de alertas de la preliquidación.
 *
 * S1-S3 dependen solo de este puerto. Hoy es un no-op que deja rastro en el log y
 * NUNCA lanza: una alerta que falla no puede tumbar una liquidación ni un envío.
 * S4 reemplaza el cuerpo por la cola real (tabla `carnes_preliquidacion_alertas`
 * con deduplicación por `(evento, preliquidacion_id, sede_id, ocurrencia)`) y el
 * despacho por correo, sin cambiar las firmas.
 *
 * Los destinatarios salen de `CARNES_MAIL_PRELIQUIDACION`; si falta se avisa por
 * log (G-S3) y el flujo sigue.
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

const VARIABLE_DESTINATARIOS = "CARNES_MAIL_PRELIQUIDACION";

/** Ejecuta un log sin dejar que un logger roto escape. */
function seguro(fn) {
  try {
    fn();
  } catch {
    // El log nunca debe afectar al flujo de negocio.
  }
}

function sinDestinatarios() {
  return !String(process.env[VARIABLE_DESTINATARIOS] ?? "").trim();
}

/**
 * Encola una alerta (hoy: solo la registra en el log).
 * @param {{evento: string, preliquidacionId?: *, sedeId?: *, ocurrencia?: *, detalle?: object}} alerta
 * @param {{log?: Pick<Console, "info"|"warn"|"error">}} [opciones]
 * @returns {Promise<{ok: true, noop: true}>}
 */
export async function encolarAlerta(alerta, { log = console } = {}) {
  seguro(() => {
    const datos = alerta && typeof alerta === "object" ? alerta : {};
    const evento = typeof datos.evento === "string" ? datos.evento : String(datos.evento);

    if (!EVENTOS_ALERTA.includes(evento)) {
      log.warn(`[preliquidacion-alertas] evento desconocido "${evento}"; se ignora`);
      return;
    }
    if (sinDestinatarios()) {
      log.warn(`[preliquidacion-alertas] ${VARIABLE_DESTINATARIOS} no está definida: la alerta "${evento}" no tiene a quién enviarse`);
    }
    log.info(
      `[preliquidacion-alertas] (no-op) ${evento} preliquidacion=${datos.preliquidacionId ?? 0} ` +
        `sede=${datos.sedeId ?? 0} ocurrencia=${datos.ocurrencia ?? 0}`,
    );
  });
  return { ok: true, noop: true };
}

/**
 * Despacha el backlog de alertas (hoy: no hace nada).
 * @returns {Promise<{ok: true, noop: true, enviadas: 0}>}
 */
export async function despacharAlertas(_contexto, _opciones = {}) {
  return { ok: true, noop: true, enviadas: 0 };
}
