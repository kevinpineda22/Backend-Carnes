import { Router } from "express";
import * as RecibidoresController from "../controllers/recibidores.controller.js";
import { validators } from "../middleware/validators.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";

const router = Router();

// Lista para el recibidor (id + nombre).
router.get("/", RecibidoresController.listarActivos);

// Gestión del admin (con cédula). Rutas bajo "/admin": no hay un "/:id" suelto,
// así que no compiten, pero cualquier ruta con parámetro que se agregue a este
// router va DESPUÉS de estas (Express matchea por orden de declaración).
router.get("/admin", requireAdminCarnes, RecibidoresController.listarAdmin);
router.post("/admin", requireAdminCarnes, validators.crearRecibidor, RecibidoresController.crear);
router.patch(
  "/admin/:id",
  requireAdminCarnes,
  validators.idParam,
  validators.actualizarRecibidor,
  RecibidoresController.actualizar,
);

export default router;
