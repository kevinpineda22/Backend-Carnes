/**
 * Qué alerta (si alguna) merece el resultado del CEI de vísceras de una sede de la preliquidación.
 * Puro: quien llama la encola con `encolarAlerta`.
 *
 * ─── Por qué casi no hay alertas ────────────────────────────────────────────
 *
 * Un CEI rechazado por SIESA deja su fila `error` en `carnes_siesa_envios` (visible en el panel de SIESA
 * Talleres) y `registrarYEnviar` YA avisa por correo ese error. Encolar además `visceras_error` mandaría un
 * segundo correo por el mismo fallo, así que solo se encola cuando NO hubo fila que avisara:
 *
 *   · `visceras_error`    el fallo no dejó fila de envío (una excepción, una lectura que falló): nadie más avisó.
 *   · `visceras_agotadas` el CEI llegó al tope de intentos automáticos: el barrido ya no lo reintenta y una
 *                         persona debe reenviarlo a mano. Es el único aviso por correo propio de esta ruta; tiene
 *                         su evento aparte para que no lo apague el dedupe de un `visceras_error` anterior de la
 *                         misma versión de la sede.
 *
 * Ni `repetido` (otra corrida ya lo mandó), ni `sin_tiempo` (lo retoma el barrido), ni un resultado sin error
 * (ok, sin_visceras, bloqueado, anterior_a_activacion...) generan alerta.
 */

export const MENSAJE_VISCERAS_AGOTADAS =
  "Se agotaron los reintentos automáticos del CEI de vísceras: el barrido horario ya no lo reenvía. " +
  "Una persona debe reintentarlo manualmente desde el panel de SIESA Talleres (reenviar las vísceras de la recepción).";

/**
 * @param {{estado?: string, error?: string|null, referencia?: string|null, repetido?: boolean}|null|undefined} r
 * @param {{preliquidacionId: number|string, sedeId: number|string, ocurrencia: number|string, recepcionId: number|string}} clave
 * @returns {object|null} la alerta para `encolarAlerta`, o null si no corresponde ninguna
 */
export function alertaDeViscerasSede(r, { preliquidacionId, sedeId, ocurrencia, recepcionId }) {
  if (!r || r.repetido) return null;
  const clave = { preliquidacionId, sedeId, ocurrencia };
  if (r.estado === "agotado") {
    return {
      evento: "visceras_agotadas",
      ...clave,
      detalle: { error: MENSAJE_VISCERAS_AGOTADAS, recepcion_id: recepcionId },
    };
  }
  if (r.estado === "error" && !r.referencia) {
    return {
      evento: "visceras_error",
      ...clave,
      detalle: { error: r.error ?? null, recepcion_id: recepcionId },
    };
  }
  return null;
}
