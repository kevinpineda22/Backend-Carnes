import * as RecibidorModel from "../models/Recibidor.model.js";

/**
 * GET /api/recibidores?activos=1
 * Quienes pueden firmar "recibí": SOLO `id` y `nombre`, nunca la cédula. Siempre
 * devuelve únicamente a los activos; `activos` se acepta por compatibilidad con
 * el front pero no cambia el resultado (la lista con cédula del admin irá en
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
