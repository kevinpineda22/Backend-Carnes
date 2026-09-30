import * as ProveedorModel from "../models/Proveedor.model.js";

/**
 * GET /api/proveedores?con_plantilla=1
 * Proveedores activos para el selector del recibidor. Con `con_plantilla=1` solo
 * los que tienen al menos una equivalencia activa (un proveedor sin plantilla no
 * tiene qué recibir). Cada uno trae `equivalencias_activas`.
 */
export async function listar(req, res, next) {
  try {
    const { con_plantilla } = req.datosValidados;
    const data = await ProveedorModel.listar({
      conPlantilla: con_plantilla === "1" || con_plantilla === "true",
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/proveedores/:id/plantilla
 * Las equivalencias activas del proveedor, en el orden de su hoja. 404 si el
 * proveedor no existe o está dado de baja.
 */
export async function obtenerPlantilla(req, res, next) {
  try {
    const { proveedor, equivalencias } = await ProveedorModel.obtenerPlantilla(
      req.datosValidados.id,
    );
    res.json({ ok: true, proveedor, data: equivalencias });
  } catch (error) {
    next(error);
  }
}
