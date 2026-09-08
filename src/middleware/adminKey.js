import crypto from "node:crypto";
import { createError } from "./errorHandler.js";

/**
 * Llave para los endpoints que EXPONEN los tokens de QR de las sedes.
 *
 * Este backend, como el de traslados, no tiene auth propia: los endpoints los
 * consume el front de Merkahorro y viven detrás de la sesión de la app. Para casi
 * todo alcanza. Pero dos endpoints son distintos:
 *
 *   GET  /api/sedes/tokens
 *   POST /api/sedes/:id/regenerar-token
 *
 * Esos devuelven el `qr_token`, que es EL secreto del que depende toda la
 * verificación de sede. Servidos sin llave, cualquiera con la URL se copia los
 * nueve tokens y la verificación deja de verificar: el recibidor podría "estar"
 * en Villahermosa desde la casa.
 *
 * Y no se pueden proteger metiendo la llave en el front, porque una variable
 * `VITE_*` termina en el bundle — o sea, publicada. Por eso estos dos endpoints
 * NO los llama el panel: se llaman una vez, desde una terminal o Postman, cuando
 * hay que imprimir o rotar un sticker. Es una operación de instalación, no de
 * todos los días.
 *
 * Configuración:
 *   CARNES_ADMIN_KEY=<clave larga y aleatoria>
 *
 * Generarla:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const HEADER = "x-admin-key";

/**
 * Comparación en tiempo constante.
 *
 * `a === b` corta en el primer carácter distinto, y esa diferencia de tiempo
 * —medible sobre miles de requests— permite adivinar la clave carácter por
 * carácter. Se comparan los SHA-256 porque `timingSafeEqual` exige buffers del
 * mismo largo, y hashear normaliza el largo sin filtrar cuántos caracteres tenía
 * la clave correcta.
 */
function igualSeguro(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Exige el header `X-Admin-Key`.
 *
 * Si `CARNES_ADMIN_KEY` no está configurada responde 503 y NO deja pasar. Fallar
 * cerrado es el punto: la alternativa cómoda —"sin clave configurada, dejá pasar
 * todo"— convierte un deploy con una variable olvidada en una lista pública de
 * tokens, y eso no se nota nunca, porque todo "funciona".
 */
export function requireAdminKey(req, _res, next) {
  const esperada = String(process.env.CARNES_ADMIN_KEY || "").trim();

  if (!esperada) {
    console.error(
      "🔴 CARNES_ADMIN_KEY no está configurada — los endpoints de tokens quedan cerrados.",
    );
    return next(createError(503, "Endpoint no disponible en este entorno."));
  }

  const recibida = String(req.headers[HEADER] || "").trim();
  if (!recibida) return next(createError(401, "Falta el header X-Admin-Key."));
  if (!igualSeguro(recibida, esperada)) return next(createError(401, "Clave inválida."));

  next();
}
