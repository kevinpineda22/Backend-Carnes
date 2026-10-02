import { Router } from "express";
import * as ProveedoresController from "../controllers/proveedores.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", validators.listarProveedores, ProveedoresController.listar);
router.get("/:id/plantilla", validators.idParam, ProveedoresController.obtenerPlantilla);
// Carga de plantilla desde el admin. `:id` primero, después el body (cada validador
// guarda lo suyo: params en `datosValidados`, body en `req.body`).
router.put(
  "/:id/plantilla",
  validators.idParam,
  validators.cargarPlantillaProveedor,
  ProveedoresController.cargarPlantilla,
);

export default router;
