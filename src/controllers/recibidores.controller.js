import * as RecibidorModel from "../models/Recibidor.model.js";

/**
 * GET /api/recibidores?activos=1
 * Quienes pueden firmar "recibí": SOLO `id` y `nombre`, nunca la cédula. Siempre
 * devuelve únicamente a los activos; `activos` se acepta por compatibilidad con
 * el front pero no cambia el resultado (la lista con cédula del admin va en
 * `/recibidores/admin`).
 */
export async function listarActivos(_req, res, next) {
  try {
    const data = await RecibidorModel.listarActivos();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recibidores/admin
 * Todos (activos e inactivos) con cédula, para el editor del admin.
 */
export async function listarAdmin(_req, res, next) {
  try {
    const data = await RecibidorModel.listarAdmin();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recibidores/admin
 * Body: { cedula, nombre, orden? } -> 201 con la fila creada. 409 `CEDULA_DUPLICADA`.
 */
export async function crear(req, res, next) {
  try {
    const data = await RecibidorModel.crear(req.body);
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/recibidores/admin/:id
 * Body: { cedula?, nombre?, activo?, orden? } (al menos uno). Desactivar = `activo: false`.
 */
export async function actualizar(req, res, next) {
  try {
    const data = await RecibidorModel.actualizar(req.datosValidados.id, req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
