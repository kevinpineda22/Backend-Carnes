import { Router } from "express";
import * as SiesaController from "../controllers/siesa.controller.js";
import { validators } from "../middleware/validators.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";

const router = Router();

// Todo este router es del panel del admin (autorización: middleware/authCarnes.js).
router.use(requireAdminCarnes);

// Trazabilidad: qué se mandó, cuándo, con qué resultado.
router.get("/estado", SiesaController.estado);
router.get("/envios", SiesaController.listar);
router.get("/envios/:id", SiesaController.obtener);
// Un envío sin confirmar (timeout, corte) bloquea el reintento hasta que una
// persona mire en SIESA y diga si está o no.
router.post("/envios/:id/resolver", SiesaController.resolver);
// El ADMIN borra un envío que falló: nunca llegó a crear nada en SIESA. Ver
// `puedeEliminarEnvio` en shared/eliminacionAdmin.js — cualquier otro estado
// es 409.
router.delete("/envios/:id", SiesaController.eliminarEnvio);

// La inicial sale sola al cerrar la recepción (ver recepciones.controller).
// Esto es el reintento manual cuando aquella falló.
router.post("/recepciones/:id/inicial", SiesaController.reintentarInicial);

// Las vísceras de res salen al cerrar la recepción (CARNES_SIESA_VISCERAS_AL_CIERRE).
// Esto es el reintento manual cuando aquel envío falló.
router.post("/recepciones/:id/visceras", SiesaController.reintentarViscerasRecepcion);

// La oficial la dispara el admin desde la liquidación costeada.
router.get("/liquidaciones/:id/previsualizar", SiesaController.previsualizarOficial);
router.post("/liquidaciones/:id/enviar", SiesaController.enviarOficial);
// Se anularon en SIESA: vuelve a Costeada para corregir y reenviar.
router.post("/liquidaciones/:id/anular", SiesaController.anularOficiales);

// Las vísceras entran al inventario por un ajuste CEI aparte, UN documento por
// liquidación con todas las sedes, que SIESA contabiliza al importar. Solo con la
// oficial ya en SIESA.
router.get(
  "/liquidaciones/:id/ajuste-visceras/previsualizar",
  SiesaController.previsualizarAjusteVisceras,
);
router.post("/liquidaciones/:id/ajuste-visceras/enviar", SiesaController.enviarAjusteVisceras);
// Liquidaciones cuyas vísceras salieron al cerrar la recepción: el admin reenvía las
// recepciones pendientes o modificadas (confirmando que borró el documento viejo en
// SIESA). La vista previa de arriba trae el estado de cada una.
router.post(
  "/liquidaciones/:id/visceras/reenviar",
  validators.reenviarVisceras,
  SiesaController.reenviarViscerasLiquidacion,
);
// Se anuló en SIESA el ajuste: se libera para mandarlo de nuevo. Con `recepcion_id`,
// el de una sede del esquema anterior; sin él, el consolidado.
router.post("/liquidaciones/:id/ajuste-visceras/anular", SiesaController.anularAjusteVisceras);

export default router;
