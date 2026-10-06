import * as ProveedorModel from "../models/Proveedor.model.js";
import { conQuienHace } from "../middleware/auth.js";

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

/**
 * PUT /api/proveedores/:id/plantilla
 * Body: { por(correo), filas: <hoja como arreglo de arreglos, encabezado incluido>,
 *         aplicar?: boolean (false = solo vista previa) }
 *
 * Vista previa (aplicar false, no escribe): el plan completo, fila por fila.
 * Aplicar (true): lo guardado y desactivado + el resumen; 422 PLANTILLA_NO_APLICABLE
 * si la hoja no tiene ninguna fila válida.
 */
export async function cargarPlantilla(req, res, next) {
  try {
    const { filas, aplicar, por } = conQuienHace(req, req.body, "por");
    const { proveedor, plan, aplicado, guardadas, desactivadas } =
      await ProveedorModel.cargarPlantilla(req.datosValidados.id, { filas, aplicar, por });

    if (!aplicado) {
      res.json({
        ok: true,
        aplicado: false,
        proveedor,
        aplicable: plan.aplicable,
        motivo_no_aplicable: plan.motivo_no_aplicable,
        errores: plan.errores,
        advertencias: plan.advertencias,
        filas: plan.filas,
        rechazadas: plan.rechazadas,
        a_desactivar: plan.a_desactivar,
        desactivacion_omitida: plan.desactivacion_omitida,
        resumen: plan.resumen,
      });
      return;
    }
    res.json({
      ok: true,
      aplicado: true,
      proveedor,
      guardadas,
      desactivadas,
      advertencias: plan.advertencias,
      rechazadas: plan.rechazadas,
      desactivacion_omitida: plan.desactivacion_omitida,
      resumen: plan.resumen,
    });
  } catch (error) {
    next(error);
  }
}
