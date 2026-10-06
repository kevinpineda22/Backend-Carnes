import * as AdminModel from "../models/RecepcionProveedorAdmin.model.js";
import { conQuienHace } from "../middleware/auth.js";

/**
 * GET /api/recepciones-proveedor?estado&proveedor_id&sede_id&desde&hasta&factura&limite
 *
 * Listado para el admin. Sin firma ni cédula. `truncado: true` = hay más
 * resultados que el `limite` (se muestran los más recientes).
 */
export async function listar(req, res, next) {
  try {
    const { recepciones, limite, truncado } = await AdminModel.listar(req.datosValidados);
    res.json({ ok: true, data: recepciones, limite, truncado });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/:id/admin
 *
 * Detalle del admin: cabecera CON firma y cédula del recibidor (único endpoint que
 * las devuelve), renglones con `valor_devuelto`, envíos a SIESA con `resolvible`,
 * nota crédito y `acciones` (qué botones aplican hoy y por qué no, si no aplican).
 */
export async function detalle(req, res, next) {
  try {
    const { recepcion, envios, siesa, notaCredito, acciones } = await AdminModel.detalle(req.datosValidados.id);
    res.json({ ok: true, data: recepcion, envios, siesa, notaCredito, acciones });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/recepciones-proveedor/:id/factura-siesa
 * Body: { por, factura_siesa }
 *
 * Corrige la referencia que se manda a SIESA (máx. 12 caracteres). Solo en
 * Finalizada y sin entrada vigente u ok. 400 formato; 409 estado / duplicada.
 * Después el admin usa `siesa/reintentar`.
 */
export async function corregirFacturaSiesa(req, res, next) {
  try {
    const { aviso, ...data } = await AdminModel.corregirFacturaSiesa(
      req.datosValidados.id,
      conQuienHace(req, req.body, "por"),
    );
    res.json({ ok: true, data, ...(aviso && { aviso }) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recepciones-proveedor/:id/anular
 * Body: { por, motivo, anulado_en_siesa? }
 *
 * Anula una recepción Finalizada o Enviada_SIESA. Con envíos `ok` hace falta
 * `anulado_en_siesa: true`. Si los envíos quedaron anulados pero la recepción no
 * cambió de estado, 500 `ANULACION_PARCIAL` con los envíos anulados: se repite.
 */
export async function anular(req, res, next) {
  try {
    const { envios_anulados, ...data } = await AdminModel.anular(
      req.datosValidados.id,
      conQuienHace(req, req.body, "por"),
    );
    res.json({ ok: true, data, envios_anulados });
  } catch (error) {
    // Igual que `finalizar`: el 500 parcial lleva el detalle de los envíos ya
    // anulados, que el errorHandler genérico no sabe serializar.
    if (error.detalle) {
      return res.status(error.statusCode).json({
        ok: false,
        error: error.message,
        codigo: error.codigo,
        ...error.detalle,
      });
    }
    next(error);
  }
}
