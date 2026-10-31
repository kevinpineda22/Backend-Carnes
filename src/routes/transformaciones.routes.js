import { Router } from "express";
import * as TransformacionesController from "../controllers/transformaciones.controller.js";
import * as TrazaController from "../controllers/transformacionesTraza.controller.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";
import { createError } from "../middleware/errorHandler.js";

const router = Router();

// Todo este router es del panel del admin (autorización: middleware/authCarnes.js).
router.use(requireAdminCarnes);

// Solo lectura: la tabla la escribe otro proceso.
router.get("/", TransformacionesController.listar);
// Debe ir ANTES de "/:id": si no, "corridas" cae en la validación del id y responde 400.
router.get("/corridas", TransformacionesController.listarCorridas);

function validarId(req, _res, next) {
  if (!/^[1-9]\d{0,14}$/.test(req.params.id))
    return next(createError(400, "El id debe ser un entero positivo."));
  next();
}

// Trazabilidad (historial de ejecuciones y documentos de negativos). También ANTES de "/:id".
router.get("/ejecuciones", TrazaController.listarEjecuciones);
router.get("/ejecuciones/:job/:id", validarId, TrazaController.obtenerEjecucion);
router.get("/negativos", TrazaController.listarNegativos);
router.get("/negativos/:id", validarId, TrazaController.obtenerNegativo);

router.get("/:id", validarId, TransformacionesController.obtener);

export default router;
