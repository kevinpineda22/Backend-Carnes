/**
 * "¿Esto falló porque falta correr una migración?"
 *
 * Vivía copiado en tres modelos. Se unifica acá porque la respuesta correcta
 * fue cambiando —cada tabla nueva enseñó una forma distinta de fallar— y tres
 * copias significaban arreglar una y dejar dos mintiendo.
 *
 * ─── Las dos formas en que Supabase avisa ─────────────────────────────────
 *
 * 1. Con un código: 42P01 (relación inexistente), 42703 (columna inexistente),
 *    o los PGRST20x de PostgREST. Ahí es inequívoco.
 *
 * 2. Con un objeto VACÍO. Literalmente `{}`: sin `code`, sin `message`, sin
 *    `details`. Pasa cuando la tabla no está en el caché de esquema de
 *    PostgREST — que es exactamente lo que ocurre con una tabla recién
 *    agregada en un archivo SQL que nadie corrió.
 *
 * El caso 2 es una CONJETURA y el mensaje lo dice. Un error sin información no
 * se puede diagnosticar; lo que sí se puede es nombrar la causa que explica el
 * 99% de las veces que aparece, en vez de propagar "undefined".
 */

import { createError } from "../middleware/errorHandler.js";

const CODIGOS = ["42P01", "42703", "PGRST204", "PGRST205"];

/** ¿El error viene sin una sola pista? */
function esOpaco(error) {
  if (!error || typeof error !== "object") return false;
  const tiene = (k) => {
    const v = error[k];
    return typeof v === "string"
      ? v.trim().length > 0
      : v !== undefined && v !== null;
  };
  return !["code", "message", "details", "hint", "status"].some(tiene);
}

export function esMigracionFaltante(error) {
  if (!error) return false;
  const codigo = error.code || "";
  const mensaje = String(error.message || "");
  return (
    CODIGOS.includes(codigo) ||
    /(relation|column|table).*(does not exist|not found)/i.test(mensaje) ||
    /schema cache/i.test(mensaje) ||
    esOpaco(error)
  );
}

/**
 * Lanza el error de migración cuando corresponde; si no, propaga el original.
 *
 * @param {object} error      el error de Supabase
 * @param {string} contexto   qué se estaba haciendo, para el log
 * @param {string[]} archivos qué migraciones necesita esta parte del módulo
 */
export function fallarSiFaltaMigracion(error, contexto, archivos = []) {
  if (esMigracionFaltante(error)) {
    const lista = archivos.length
      ? archivos.join(" y ")
      : "las migraciones de sql/";
    const conjetura = esOpaco(error)
      ? " (el error no trae detalle, pero esa es la causa habitual)"
      : "";
    throw createError(
      503,
      `A la base le falta ${lista}. Corrélo${archivos.length > 1 ? "s" : ""} en Supabase y volvé a intentar${conjetura}.`,
    );
  }
  throw new Error(
    `${contexto}: ${error?.message || "error sin detalle de Supabase"}`,
  );
}
