import * as FacturaModel from "../models/FacturaProveedor.model.js";
import { conQuienHace } from "../middleware/auth.js";

/**
 * POST /api/recepciones-proveedor/:id/factura/subidas
 * Body: { editado_por?, archivos: [{ nombre, tipo, tamano }] }
 *
 * Paso 1 de la foto de la factura: valida cantidad (máx. 5 en total), tipo (imagen o
 * PDF) y tamaño (máx. 10 MB) y devuelve una URL firmada de subida por archivo
 * (`subidas[]`: path, token, url, nombre, tipo). El navegador sube directo a Storage.
 * 409 si la recepción ya no es un borrador.
 */
export async function solicitarSubidas(req, res, next) {
  try {
    const data = await FacturaModel.solicitarSubidas(req.datosValidados.id, req.body);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recepciones-proveedor/:id/factura/confirmar
 * Body: { editado_por?, archivos: [{ path, nombre }] }
 *
 * Paso 3: vincula a la recepción los archivos ya subidos. Tipo y tamaño se leen de
 * Storage, no del cuerpo. 422 `FACTURA_NO_SUBIDA` si alguno no llegó.
 */
export async function confirmar(req, res, next) {
  try {
    const { editado_por, archivos } = conQuienHace(req, req.body, "editado_por");
    const data = await FacturaModel.confirmar(req.datosValidados.id, { archivos, por: editado_por ?? null });
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recepciones-proveedor/:id/factura/quitar — Body: { path }. Quita un archivo del borrador. */
export async function quitar(req, res, next) {
  try {
    const data = await FacturaModel.quitar(req.datosValidados.id, { path: req.body.path });
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/:id/admin/factura
 *
 * Archivos de la factura con URL firmada de 10 minutos, para el admin (cualquier estado).
 */
export async function urlsAdmin(req, res, next) {
  try {
    const data = await FacturaModel.urlsDeFactura(req.datosValidados.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/:id/contabilidad/factura
 *
 * Lo mismo para contabilidad, consulta de recepciones y admin (el guard va en la
 * ruta). Solo `Enviada_SIESA`, como el acta: en otro estado, 404.
 */
export async function urlsContabilidad(req, res, next) {
  try {
    const data = await FacturaModel.urlsDeFactura(req.datosValidados.id, { soloEnviada: true });
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}
