import { Router } from "express";
import * as ProveedoresController from "../controllers/proveedores.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", validators.listarProveedores, ProveedoresController.listar);
router.get("/:id/plantilla", validators.idParam, ProveedoresController.obtenerPlantilla);

export default router;
