import { Router } from "express";
import * as RecibidoresController from "../controllers/recibidores.controller.js";

const router = Router();

// Lista para el recibidor (id + nombre). Las rutas de admin ("/admin", que sí
// llevan la cédula) se agregan ANTES de cualquier "/:id", por el mismo motivo
// que en plantilla.routes.js: Express matchea por orden de declaración.
router.get("/", RecibidoresController.listarActivos);

export default router;
