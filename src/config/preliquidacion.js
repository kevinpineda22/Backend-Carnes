/**
 * Interruptor de la preliquidación de talleres: `CARNES_PRELIQUIDACION`.
 *
 * Se lee en CADA llamada y no al arrancar: en Vercel las variables se cambian sin
 * redesplegar, y un valor cacheado seguiría con el estado anterior. Apagado por
 * defecto: sin la variable (o con cualquier valor que no sea afirmativo) el
 * comportamiento de todo el módulo de carnes es el de antes de esta función.
 *
 * Valores que lo encienden: `on`, `true`, `1` (sin distinguir mayúsculas).
 *
 * La compuerta de autenticación en producción (`CARNES_AUTH=exigir`) se agrega
 * sobre esta misma función en la fase de envío (S2); aquí solo está el interruptor.
 */

const AFIRMATIVOS = new Set(["on", "true", "1"]);

/** ¿Está encendida la preliquidación? */
export function preliquidacionHabilitada() {
  return AFIRMATIVOS.has(String(process.env.CARNES_PRELIQUIDACION ?? "").trim().toLowerCase());
}

/** `"on"` u `"off"`: la forma que usa el cron y el panel para informar el estado. */
export function estadoPreliquidacion() {
  return preliquidacionHabilitada() ? "on" : "off";
}
