import { Router } from "express";
import * as RecepcionesProveedorController from "../controllers/recepcionesProveedor.controller.js";
import * as AdminController from "../controllers/recepcionesProveedorAdmin.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

// Admin: listado (sin firma ni cédula). "/" no choca con "/:id": son rutas distintas.
router.get("/", validators.listarRecepcionesProveedor, AdminController.listar);

// "/abrir" va ANTES de "/:id": Express matchea por orden de declaración, y con
// esta línea abajo el POST entraría por otra ruta con id = "abrir".
router.post(
  "/abrir",
  validators.abrirRecepcionProveedor,
  RecepcionesProveedorController.abrir,
);

// Para reanudar el borrador tras recargar (sin firma ni cédula).
router.get("/:id", validators.idParam, RecepcionesProveedorController.obtener);

// Autoguardado. Solo mientras la recepción es un borrador.
router.patch(
  "/:id",
  validators.idParam,
  validators.guardarRecepcionProveedor,
  RecepcionesProveedorController.guardar,
);

// Firmar. Borrador -> Finalizada; sobre una ya firmada es un reintento que no vuelve a firmar.
router.post(
  "/:id/finalizar",
  validators.idParam,
  validators.finalizarRecepcionProveedor,
  RecepcionesProveedorController.finalizar,
);

// SIESA: reintento manual de la entrada (si ya está ok, reconcilia el estado) y de la
// nota crédito de lo devuelto. Los dos piden el correo del admin en `por`.
router.post(
  "/:id/siesa/reintentar",
  validators.idParam,
  validators.reintentarSiesaProveedor,
  RecepcionesProveedorController.reintentarSiesa,
);
router.post(
  "/:id/nota-credito/reintentar",
  validators.idParam,
  validators.reintentarSiesaProveedor,
  RecepcionesProveedorController.reintentarNotaCredito,
);

// Admin: detalle completo (ÚNICO lugar que devuelve firma y cédula del recibidor),
// corregir la referencia de factura para SIESA y anular. "/:id" de arriba sigue
// siendo el del recibidor, sin firma ni cédula.
router.get("/:id/admin", validators.idParam, AdminController.detalle);
router.patch(
  "/:id/factura-siesa",
  validators.idParam,
  validators.corregirFacturaSiesaProveedor,
  AdminController.corregirFacturaSiesa,
);
router.post(
  "/:id/anular",
  validators.idParam,
  validators.anularRecepcionProveedor,
  AdminController.anular,
);

// Descartar un borrador: deja de existir (no cambia de estado). Es el mismo
// endpoint para el recibidor que abrió por error y para el admin que descarta un
// borrador viejo — ver `mensajeFacturaEnRecepcion` en shared/aperturaProveedor.js.
router.delete("/:id", validators.idParam, RecepcionesProveedorController.descartar);

export default router;
