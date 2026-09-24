import { Router } from "express";
import * as SiesaController from "../controllers/siesa.controller.js";

const router = Router();

// Trazabilidad: qué se mandó, cuándo, con qué resultado.
router.get("/estado", SiesaController.estado);
router.get("/envios", SiesaController.listar);
router.get("/envios/:id", SiesaController.obtener);
// Un envío sin confirmar (timeout, corte) bloquea el reintento hasta que una
// persona mire en SIESA y diga si está o no.
router.post("/envios/:id/resolver", SiesaController.resolver);

// La inicial sale sola al cerrar la recepción (ver recepciones.controller).
// Esto es el reintento manual cuando aquella falló.
router.post("/recepciones/:id/inicial", SiesaController.reintentarInicial);

// La oficial la dispara el admin desde la liquidación costeada.
router.get("/liquidaciones/:id/previsualizar", SiesaController.previsualizarOficial);
router.post("/liquidaciones/:id/enviar", SiesaController.enviarOficial);
// Se anularon en SIESA: vuelve a Costeada para corregir y reenviar.
router.post("/liquidaciones/:id/anular", SiesaController.anularOficiales);

export default router;
