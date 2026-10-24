import { Router } from "express";
import * as TransformacionesController from "../controllers/transformaciones.controller.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";
import { createError } from "../middleware/errorHandler.js";

const router = Router();

// Todo este router es del panel del admin (autorización: middleware/authCarnes.js).
router.use(requireAdminCarnes);

// Solo lectura: la tabla la escribe otro proceso.
router.get("/", TransformacionesController.listar);
router.get(
  "/:id",
  (req, _res, next) => {
    if (!/^[1-9]\d{0,14}$/.test(req.params.id))
      return next(createError(400, "El id debe ser un entero positivo."));
    next();
  },
  TransformacionesController.obtener,
);

export default router;
