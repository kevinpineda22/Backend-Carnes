import { Router } from "express";
import * as ProveedoresController from "../controllers/proveedores.controller.js";
import { validators } from "../middleware/validators.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";

const router = Router();

router.get("/", validators.listarProveedores, ProveedoresController.listar);
// Las plantillas son del admin (PlantillasProveedor). El listado de arriba lo usa
// también el selector del recibidor, por eso queda sin guard de admin.
router.get(
  "/:id/plantilla",
  requireAdminCarnes,
  validators.idParam,
  ProveedoresController.obtenerPlantilla,
);
// Carga de plantilla desde el admin. `:id` primero, después el body (cada validador
// guarda lo suyo: params en `datosValidados`, body en `req.body`).
router.put(
  "/:id/plantilla",
  requireAdminCarnes,
  validators.idParam,
  validators.cargarPlantillaProveedor,
  ProveedoresController.cargarPlantilla,
);

export default router;
