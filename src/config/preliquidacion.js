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
 * Compuerta de autenticación (C3): en producción (`VERCEL_ENV=production`) la
 * preliquidación solo está habilitada con `CARNES_AUTH=exigir`. Sin autenticación
 * exigida cualquiera podría crear preliquidaciones o disparar envíos a SIESA, así que
 * el módulo queda apagado y las escrituras responden 503 `auth_requerida`. Fuera de
 * producción (preview, local) la compuerta no aplica.
 */

const AFIRMATIVOS = new Set(["on", "true", "1"]);

const flagEncendido = (env) => AFIRMATIVOS.has(String(env.CARNES_PRELIQUIDACION ?? "").trim().toLowerCase());
const authExigida = (env) => String(env.CARNES_AUTH ?? "").trim().toLowerCase() === "exigir";
const esProduccion = (env) => String(env.VERCEL_ENV ?? "").trim().toLowerCase() === "production";

/**
 * Compuerta de autenticación, independiente del interruptor: en producción sin
 * `CARNES_AUTH=exigir` es `true` aunque `CARNES_PRELIQUIDACION` esté apagado. Así las rutas
 * de drenaje (que siguen vivas con el interruptor apagado) tampoco operan sin autenticación.
 */
export function authRequeridaEnProduccion(env = process.env) {
  return esProduccion(env) && !authExigida(env);
}

/**
 * Por qué está apagada la preliquidación: `"flag_apagado"`, `"auth_requerida"` o `null`
 * si está habilitada. El interruptor manda: apagado es `flag_apagado` aunque falte auth.
 */
export function motivoApagado(env = process.env) {
  if (!flagEncendido(env)) return "flag_apagado";
  if (esProduccion(env) && !authExigida(env)) return "auth_requerida";
  return null;
}

/** ¿Está habilitada la preliquidación (interruptor encendido y compuerta de auth superada)? */
export function preliquidacionHabilitada(env = process.env) {
  return motivoApagado(env) === null;
}

/** `"on"` u `"off"`: la forma que usa el cron y el panel para informar el estado. */
export function estadoPreliquidacion(env = process.env) {
  return preliquidacionHabilitada(env) ? "on" : "off";
}

/** Texto de la advertencia de arranque, o `null` si no hay nada que advertir. */
export function advertenciaDeArranque(env = process.env) {
  if (motivoApagado(env) !== "auth_requerida") return null;
  return (
    "CARNES_PRELIQUIDACION está encendida en producción pero CARNES_AUTH no es 'exigir': " +
    "la preliquidación queda deshabilitada (503 auth_requerida) hasta exigir autenticación (CARNES_AUTH=exigir)."
  );
}

let avisoEmitido = false;

/** Registra la advertencia de arranque una sola vez por instancia. */
export function avisarAuthRequerida({ env = process.env, log = console } = {}) {
  const mensaje = advertenciaDeArranque(env);
  if (!mensaje || avisoEmitido) return;
  avisoEmitido = true;
  log.warn(`⚠️  ${mensaje}`);
}

/** Solo para pruebas: permite volver a emitir la advertencia. */
export function reiniciarAvisoAuth() {
  avisoEmitido = false;
}
