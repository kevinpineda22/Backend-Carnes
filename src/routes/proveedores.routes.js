import { Router } from "express";
import * as ProveedoresController from "../controllers/proveedores.controller.js";
import { validators } from "../middleware/validators.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";

const router = Router();

router.get("/", validators.listarProveedores, ProveedoresController.listar);
// Búsqueda en el catálogo de cortes para "Agregar corte" de la plantilla. ANTES de
// "/:id/...": "catalogo-cortes" no es un id. El recibidor tiene su propia ruta
// (recepcionesProveedor.routes.js) con el mismo controlador.
router.get(
  "/catalogo-cortes",
  requireAdminCarnes,
  validators.buscarCortes,
  ProveedoresController.buscarCortes,
);
// Grupos impositivos de SIESA (IVA por ítem). Del admin; ANTES de "/:id/...".
router.get(
  "/grupos-impositivos/estado",
  requireAdminCarnes,
  ProveedoresController.estadoGruposImpositivos,
);
router.post(
  "/grupos-impositivos/sincronizar",
  requireAdminCarnes,
  ProveedoresController.sincronizarGruposImpositivos,
);
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

// Agregar UN corte del catálogo a la plantilla, sin pasar por el Excel.
router.post(
  "/:id/plantilla/cortes",
  requireAdminCarnes,
  validators.idParam,
  validators.agregarCorteProveedor,
  ProveedoresController.agregarCorte,
);

export default router;
