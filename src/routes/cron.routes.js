import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { ejecutarCron, validarCuerpoCron } from "../services/preliquidacionCron.js";
import { createError } from "../middleware/errorHandler.js";

const router = Router();

const sha256 = (texto) => createHash("sha256").update(String(texto)).digest();

/**
 * ¿El header `Authorization: Bearer <secreto>` coincide con CRON_SECRET?
 * Se comparan los digests SHA-256 de ambos valores: tienen siempre la misma longitud, así
 * que `timingSafeEqual` no lanza aunque el token enviado sea más corto o más largo.
 */
export function secretoValido(autorizacion, secreto) {
  if (typeof autorizacion !== "string") return false;
  const partes = autorizacion.match(/^Bearer (.*)$/s);
  if (!partes) return false;
  return timingSafeEqual(sha256(partes[1]), sha256(secreto));
}

/**
 * POST /api/cron/preliquidaciones
 * Lo llama el workflow de GitHub Actions (`.github/workflows/preliquidacion.yml`); se monta
 * ANTES de `autenticar` porque su credencial es CRON_SECRET, no una sesión de usuario.
 * Con el interruptor apagado responde `{ok:true, flag:'off', motivo}` sin escribir nada.
 */
router.post("/preliquidaciones", async (req, res, next) => {
  try {
    const secreto = process.env.CRON_SECRET;
    if (!secreto || !secreto.trim()) {
      throw createError(503, "El cron no está configurado (falta CRON_SECRET).", "cron_no_configurado");
    }
    if (!secretoValido(req.headers.authorization, secreto)) {
      throw createError(401, "No autorizado.", "no_autorizado");
    }
    const cuerpo = validarCuerpoCron(req.body);
    if (!cuerpo.ok) throw createError(400, cuerpo.mensaje, "cuerpo_invalido");

    res.json(await ejecutarCron(cuerpo.valor));
  } catch (error) {
    next(error);
  }
});

export default router;
