import { Router } from "express";
import * as LiquidacionesController from "../controllers/liquidaciones.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", LiquidacionesController.listar);
router.post("/", validators.crearLiquidacion, LiquidacionesController.crear);

router.get("/:id", LiquidacionesController.obtener);
router.patch("/:id", validators.actualizarLiquidacion, LiquidacionesController.actualizar);

// Borrar una creada por error. Solo en Abierta — ver el modelo.
router.delete("/:id", LiquidacionesController.eliminar);

router.put("/:id/gastos", validators.guardarGastos, LiquidacionesController.guardarGastos);

router.post(
  "/:id/recepciones",
  validators.vincularRecepciones,
  LiquidacionesController.vincular,
);
router.delete("/:id/recepciones/:recepcionId", LiquidacionesController.desvincular);

// Previsualizar es GET porque no escribe nada: se puede recargar, compartir el
// link y pegarle mil veces mientras el admin ajusta los gastos en otra pestaña.
router.get("/:id/previsualizar", LiquidacionesController.previsualizar);

router.post("/:id/costear", LiquidacionesController.costear);
router.post("/:id/reabrir", LiquidacionesController.reabrir);

export default router;
