import * as PlantillaModel from "../models/Plantilla.model.js";

/**
 * GET /api/plantilla/:especie
 * Los tres catálogos de una especie en una sola llamada.
 *
 * Va junto y no en tres endpoints porque es exactamente lo que necesita cada
 * pantalla de una: el recibidor abre "Recibir Res" y tiene que ver su lista ya
 * ordenada, sin tres esperas encadenadas parado en la cava.
 *
 * `?incluirInactivos=true` para el panel del admin.
 */
export async function obtenerTodo(req, res, next) {
  try {
    const data = await PlantillaModel.listarTodo(req.params.especie, {
      incluirInactivos: req.query.incluirInactivos === "true",
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/plantilla/:especie/:catalogo
 * Un catálogo suelto: `items`, `viceras` o `conceptos`.
 */
export async function listar(req, res, next) {
  try {
    const data = await PlantillaModel.listar(
      req.params.catalogo,
      req.params.especie,
      { incluirInactivos: req.query.incluirInactivos === "true" },
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/plantilla/:especie/:catalogo — crea una fila. */
export async function crear(req, res, next) {
  try {
    const data = await PlantillaModel.crear(
      req.params.catalogo,
      req.params.especie,
      req.body,
    );
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/plantilla/:especie/:catalogo
 * Guardado masivo de la grilla. Body: { filas: [...] }
 *
 * Lo que NO viene en `filas` se desactiva — ver `guardarLote` en el modelo.
 */
export async function guardarLote(req, res, next) {
  try {
    const data = await PlantillaModel.guardarLote(
      req.params.catalogo,
      req.params.especie,
      req.body.filas,
    );
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/plantilla/:especie/:catalogo/orden
 * Reordena. Body: { orden: [{ id, orden }] }
 */
export async function reordenar(req, res, next) {
  try {
    const data = await PlantillaModel.reordenar(req.params.catalogo, req.body.orden);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/plantilla/:especie/:catalogo/:id — edita una fila. */
export async function actualizar(req, res, next) {
  try {
    const data = await PlantillaModel.actualizar(
      req.params.catalogo,
      req.params.id,
      req.body,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/plantilla/:especie/:catalogo/:id
 * Baja lógica (`activo = false`), nunca borrado físico. Ver el modelo.
 */
export async function eliminar(req, res, next) {
  try {
    const data = await PlantillaModel.desactivar(req.params.catalogo, req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
