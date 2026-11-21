import { Router } from "express";
import * as PreliquidacionesController from "../controllers/preliquidaciones.controller.js";
import { validators, validarEspecie } from "../middleware/validators.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";
import { createError } from "../middleware/errorHandler.js";

const router = Router();

// Todo este router es del panel del admin (autorización: middleware/authCarnes.js).
router.use(requireAdminCarnes);

/** Un id que no es un entero positivo es 400, no un 500 de Postgres. */
function idEntero(nombre, destino) {
  return (req, _res, next, valor) => {
    if (!/^[1-9]\d*$/.test(valor)) return next(createError(400, `El ${nombre} no es válido.`));
    req[destino] = Number(valor);
    next();
  };
}
router.param("id", idEntero("id de la preliquidación", "idPreliquidacion"));
router.param("sedeId", idEntero("id de la sede", "idSede"));

router.get("/", PreliquidacionesController.listar);
router.post("/", validators.crearPreliquidacion, PreliquidacionesController.crear);

// Config por especie: se declara ANTES de `/:id` para que "config" no se lea como un id.
router.get("/config/:especie", validarEspecie, PreliquidacionesController.obtenerConfig);
router.put(
  "/config/:especie",
  validarEspecie,
  validators.guardarConfigPreliquidacion,
  PreliquidacionesController.guardarConfig,
);

router.get("/:id", PreliquidacionesController.obtener);
router.patch("/:id", validators.actualizarPreliquidacion, PreliquidacionesController.actualizar);

router.put("/:id/gastos", validators.guardarGastosPreliquidacion, PreliquidacionesController.guardarGastos);

router.post("/:id/recepciones", validators.vincularRecepciones, PreliquidacionesController.vincular);
router.delete("/:id/sedes/:sedeId", PreliquidacionesController.desvincular);

// Previsualizar es GET porque no escribe nada.
router.get("/:id/previsualizar", PreliquidacionesController.previsualizar);

export default router;
