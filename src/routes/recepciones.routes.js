import { Router } from "express";
import * as RecepcionesController from "../controllers/recepciones.controller.js";
import { validators } from "../middleware/validators.js";

const router = Router();

router.get("/", RecepcionesController.listar);

// "/abrir" va ANTES de "/:id": Express matchea por orden de declaración, y con
// esta línea abajo el POST entraría por otra ruta con id = "abrir".
router.post("/abrir", validators.abrirRecepcion, RecepcionesController.abrir);

router.get("/:id", RecepcionesController.obtener);
router.patch("/:id", validators.guardarBorrador, RecepcionesController.guardar);

// Renglones fuera de plantilla — el "Otro / Agregar".
router.post("/:id/items", validators.agregarAdicional, RecepcionesController.agregarAdicional);
router.delete("/:id/items/:itemId", RecepcionesController.eliminarItem);

// Homologar: el ADMIN le pone código de SIESA y costo a un renglón que el
// recibidor agregó a mano. Ocurre DESPUÉS del cierre, por eso no vive con el
// resto de la edición del borrador.
router.patch(
  "/:id/items/:itemId/homologar",
  validators.homologarAdicional,
  RecepcionesController.homologarAdicional,
);

// ─── Transiciones ─────────────────────────────────────────────────────────
//
// Cada una es su propio POST y no un `PATCH { estado }` genérico. Un endpoint
// con nombre dice qué pasó —y puede exigir lo que ese paso necesita: `rechazar`
// pide el motivo, `aprobar` pide quién aprobó—. Con un campo `estado` suelto,
// esas reglas quedarían en un `switch` que hay que acordarse de completar cada
// vez que se agrega un estado.
router.post("/:id/finalizar", validators.finalizar, RecepcionesController.finalizar);
router.post("/:id/aprobar", validators.aprobar, RecepcionesController.aprobar);
router.post("/:id/rechazar", validators.rechazar, RecepcionesController.rechazar);
router.post("/:id/reabrir", RecepcionesController.reabrir);
router.post("/:id/desaprobar", RecepcionesController.desaprobar);

export default router;
