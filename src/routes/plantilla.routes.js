import { Router } from "express";
import * as PlantillaController from "../controllers/plantilla.controller.js";
import {
  validarEspecie,
  validarCatalogo,
  validarCatalogoBody,
  validators,
} from "../middleware/validators.js";

const router = Router();

// `:especie` se valida una sola vez para todo el router. Sin esto, una especie
// inventada llega hasta Supabase y vuelve como un 500 con el mensaje de Postgres
// adentro — que no le dice nada al front y le cuenta el esquema a cualquiera.
router.use("/:especie", validarEspecie);

router.get("/:especie", PlantillaController.obtenerTodo);

// De acá para abajo, todo lleva `:catalogo` (items | viceras | conceptos).
router.use("/:especie/:catalogo", validarCatalogo);

router.get("/:especie/:catalogo", PlantillaController.listar);
router.post("/:especie/:catalogo", validarCatalogoBody("fila"), PlantillaController.crear);
router.put("/:especie/:catalogo", validarCatalogoBody("lote"), PlantillaController.guardarLote);

// "/orden" va ANTES de "/:id": Express matchea por orden de declaración, y con
// esta línea abajo, un PUT a ".../orden" entraría por "/:id" con id = "orden".
router.put("/:especie/:catalogo/orden", validators.reordenar, PlantillaController.reordenar);

router.patch(
  "/:especie/:catalogo/:id",
  validarCatalogoBody("fila"),
  PlantillaController.actualizar,
);
router.delete("/:especie/:catalogo/:id", PlantillaController.eliminar);

export default router;
