import { Router } from "express";
import * as PreliquidacionesController from "../controllers/preliquidaciones.controller.js";
import { validators, validarEspecie } from "../middleware/validators.js";
import { requireAdminCarnes } from "../middleware/authCarnes.js";
import { createError } from "../middleware/errorHandler.js";

const router = Router();

// Todo este router es del panel del admin (autorización: middleware/authCarnes.js).
router.use(requireAdminCarnes);

// Con el interruptor del módulo apagado toda escritura es 409 `preliquidacion_apagada`, antes de
// validar y de tocar la base. No depende de CARNES_AUTH (hoy `off`: el guard de arriba no protege).
router.use(PreliquidacionesController.exigirEscrituraHabilitada);

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
router.param("saldoId", idEntero("id del saldo", "idSaldo"));

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

// Saldos pendientes: se declaran ANTES de `/:id` para que "saldos" no se lea como un id.
router.get("/saldos", validators.listarSaldosPreliquidacion, PreliquidacionesController.listarSaldos);
router.patch("/saldos/:saldoId", validators.actualizarSaldoPreliquidacion, PreliquidacionesController.actualizarSaldo);

router.get("/:id", PreliquidacionesController.obtener);
router.patch("/:id", validators.actualizarPreliquidacion, PreliquidacionesController.actualizar);

// Cierre (corte) manual: fija o restablece (corte = null) mientras esté abierta y sin liquidar.
router.put("/:id/corte", validators.fijarCortePreliquidacion, PreliquidacionesController.fijarCorte);

router.put("/:id/gastos", validators.guardarGastosPreliquidacion, PreliquidacionesController.guardarGastos);

// Retomas de la entrega (solo cerdo, solo antes de congelar). No son un gasto: entran
// a la utilidad de cada sede, repartidas por animales.
router.get("/:id/retomas", PreliquidacionesController.obtenerRetomas);
router.put("/:id/retomas", validators.guardarRetomas, PreliquidacionesController.guardarRetomas);

router.post("/:id/recepciones", validators.vincularRecepciones, PreliquidacionesController.vincular);
router.delete("/:id/sedes/:sedeId", PreliquidacionesController.desvincular);

// Recalcular no enviadas: escritura normal (NO es drenaje), con interruptor y compuerta de auth.
router.post("/:id/recalcular", validators.recalcularPreliquidacion, PreliquidacionesController.recalcular);

// Procesar y cerrar: acciones del admin. Siguen disponibles con el interruptor apagado (drenaje).
router.post("/sedes/:sedeId/procesar", PreliquidacionesController.procesarSede);
router.post("/:id/procesar", PreliquidacionesController.procesar);
router.post("/:id/cerrar", PreliquidacionesController.cerrar);
// Anular la preliquidación completa: rollback mientras nada haya salido a SIESA (drenaje).
router.post("/:id/anular", validators.anularPreliquidacion, PreliquidacionesController.anular);

// Correcciones de una sede ya enviada. Anular confirma lo hecho a mano en SIESA (drenaje: sigue con el
// interruptor apagado); descartar la corrección es una escritura normal.
router.post("/sedes/:sedeId/anular", validators.anularSedePreliquidacion, PreliquidacionesController.anularSede);
router.post(
  "/sedes/:sedeId/descartar-correccion",
  validators.descartarCorreccionPreliquidacion,
  PreliquidacionesController.descartarCorreccion,
);

// Oficial sin inicial (sql/044): el admin decide que la recepción no manda la CEA inicial, solo la oficial.
// Escritura normal (con interruptor): no es drenaje. Una sede o todas las de la preliquidación.
router.post(
  "/sedes/:sedeId/omitir-inicial",
  validators.omitirInicialPreliquidacion,
  PreliquidacionesController.omitirInicialSede,
);
router.post(
  "/:id/omitir-inicial",
  validators.omitirInicialPreliquidacion,
  PreliquidacionesController.omitirInicialPreliquidacion,
);

// Previsualizar es GET porque no escribe nada.
router.get("/:id/previsualizar", PreliquidacionesController.previsualizar);

// Hoja de costeo de una sede (corte por corte): en vivo antes de liquidar, congelada después. Es lectura.
router.get("/:id/sedes/:sedeId/hoja", PreliquidacionesController.hojaSede);

export default router;
