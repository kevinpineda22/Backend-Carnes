import { Router } from "express";
import * as SedesController from "../controllers/sedes.controller.js";
import { validators } from "../middleware/validators.js";
import { requireAdminKey } from "../middleware/adminKey.js";

const router = Router();

router.get("/", SedesController.listar);
router.post("/verificar", validators.verificarSede, SedesController.verificar);

// Los dos que exponen o rotan el `qr_token`. Van detrás de `X-Admin-Key` — ver
// el porqué en middleware/adminKey.js.
//
// "/tokens" se declara ANTES que cualquier "/:id" para que Express no lo tome
// como un id. Hoy no compiten (no hay GET "/:id"), pero el día que se agregue,
// el orden ya está bien y nadie tiene que acordarse.
router.get("/tokens", requireAdminKey, SedesController.listarConToken);
router.post("/:id/regenerar-token", requireAdminKey, SedesController.regenerarToken);

router.patch("/:id", validators.actualizarSede, SedesController.actualizar);

export default router;
