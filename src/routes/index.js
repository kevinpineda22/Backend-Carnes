import { Router } from "express";
import sedesRoutes from "./sedes.routes.js";
import plantillaRoutes from "./plantilla.routes.js";
import recepcionesRoutes from "./recepciones.routes.js";
import liquidacionesRoutes from "./liquidaciones.routes.js";
import siesaRoutes from "./siesa.routes.js";
import { verificarEmail } from "../services/email.service.js";
import { sandboxOn } from "../config/sandbox.js";

const router = Router();

router.use("/sedes", sedesRoutes);
router.use("/plantilla", plantillaRoutes);
router.use("/recepciones", recepcionesRoutes);
router.use("/liquidaciones", liquidacionesRoutes);
router.use("/siesa", siesaRoutes);

// Health check.
//
// `sandbox` va acá y no en un endpoint aparte porque es la primera pregunta de
// quien va a probar —"¿esto le manda correos al admin de verdad?"— y tiene que
// contestarse con el mismo GET que ya se usa para ver si el backend está vivo.
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    nombre: "Backend Carnes — Merkahorro",
    version: "1.0.0",
    entorno: process.env.NODE_ENV || "development",
    sandbox: sandboxOn(),
  });
});

/**
 * GET /api/health/email
 * Se conecta al SMTP y autentica, SIN enviar nada. Responde 503 si no puede.
 *
 * Existe porque "las variables están cargadas" no es lo mismo que "el correo
 * funciona". Sin este endpoint, la única forma de comprobarlo es cerrar una
 * recepción de verdad y esperar a que el admin avise que no le llegó nada.
 */
router.get("/health/email", async (_req, res) => {
  const estado = await verificarEmail();
  res.status(estado.ok ? 200 : 503).json(estado);
});

export default router;
