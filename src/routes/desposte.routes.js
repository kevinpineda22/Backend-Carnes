import { Router } from "express";
import * as DesposteController from "../controllers/desposte.controller.js";
import { subirPDF } from "../middleware/subirPDF.js";

/**
 * Guías de desposte que no cuelgan (todavía) de una recepción.
 *
 * El admin sube la guía apenas llega del frigorífico, y se engancha sola a la
 * recepción cuando el recibidor cierra. Las guías de una recepción ya existente
 * siguen en /api/recepciones/:id/desposte.
 *
 * Solo el panel del admin usa esto. El recibidor no tiene cómo ver una guía
 * antes de cerrar: si la viera, transcribiría el PDF en vez de contar la carne.
 */
const router = Router();

router.get("/anticipadas", DesposteController.listarAnticipadas);
router.post("/anticipadas", subirPDF, DesposteController.subirAnticipada);
router.get("/anticipadas/:id/archivo", DesposteController.archivoAnticipada);
router.delete("/anticipadas/:id", DesposteController.eliminarAnticipada);

export default router;
