import { Router } from "express";
import * as RecepcionesController from "../controllers/recepciones.controller.js";
import * as DesposteController from "../controllers/desposte.controller.js";
import { validators } from "../middleware/validators.js";
import { subirPDF } from "../middleware/subirPDF.js";

const router = Router();

router.get("/", RecepcionesController.listar);

// "/abrir" va ANTES de "/:id": Express matchea por orden de declaración, y con
// esta línea abajo el POST entraría por otra ruta con id = "abrir".
router.post("/abrir", validators.abrirRecepcion, RecepcionesController.abrir);

router.get("/:id", RecepcionesController.obtener);

// Descartar un borrador abierto por error. Va como DELETE del recurso y no como
// una transición más porque no cambia de estado: deja de existir.
router.delete("/:id", RecepcionesController.descartar);
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

// ─── Informe de desposte ──────────────────────────────────────────────────
//
// El PDF que emite el frigorífico por sede y por lote. Cuelga de la recepción
// porque es uno a uno con ella: misma sede, misma entrega.
//
// Lo sube el ADMIN, nunca el recibidor, y el modelo lo rechaza mientras la
// recepción esté en Borrador. Si el recibidor pudiera verlo antes de digitar,
// transcribiría el informe en vez de contar la carne y el cruce compararía el
// PDF contra sí mismo.
router.get("/:id/desposte", DesposteController.obtener);
router.post("/:id/desposte", subirPDF, DesposteController.adjuntar);
router.get("/:id/desposte/archivo", DesposteController.archivo);
router.delete("/:id/desposte", DesposteController.eliminar);

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
