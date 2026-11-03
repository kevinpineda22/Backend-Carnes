import * as AdminModel from "../models/RecepcionProveedorAdmin.model.js";
import { conQuienHace } from "../middleware/auth.js";
import { createError } from "../middleware/errorHandler.js";
import { ESTADOS } from "../shared/estadosProveedor.js";

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
 * DELETE /api/recepciones-proveedor/:id/admin
 * Body: { por }
 *
 * Elimina una recepción Anulada junto con sus envíos a SIESA. Ver `AdminModel.eliminar`.
 */
export async function eliminar(req, res, next) {
  try {
    const { por } = conQuienHace(req, req.body || {}, "por");
    const data = await AdminModel.eliminar(req.datosValidados.id, { por: por || "sin usuario" });
    res.json({ ok: true, ...data });
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

/**
 * GET /api/recepciones-proveedor/contabilidad?aprobacion&proveedor_id&sede_id&desde&hasta&factura&limite
 *
 * Lista de contabilidad: SOLO las que ya están en SIESA (`Enviada_SIESA`), sin
 * firma ni cédula. El estado lo fija el servidor: lo que mande el cliente no cuenta.
 * `aprobacion`: "pendiente" | "aprobada" | "todas".
 */
export async function listarContabilidad(req, res, next) {
  try {
    const { recepciones, limite, truncado } = await AdminModel.listar({
      ...req.datosValidados,
      estado: ESTADOS.ENVIADA_SIESA,
    });
    res.json({ ok: true, data: recepciones, limite, truncado });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/:id/contabilidad
 *
 * Detalle de solo lectura para contabilidad: sin firma, cédula ni `acciones`; con
 * `data.aprobacion` ({ puede_aprobar, codigo, motivo }).
 */
export async function detalleContabilidad(req, res, next) {
  try {
    const { recepcion, envios, siesa, notaCredito } = await AdminModel.detalleContabilidad(req.datosValidados.id);
    res.json({ ok: true, data: recepcion, envios, siesa, notaCredito });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recepciones-proveedor/:id/aprobar-contabilidad
 * Body: { por }
 *
 * Marca la factura como aprobada por contabilidad (quién y cuándo). NO envía nada a
 * SIESA. 404 si no existe; 409 `YA_APROBADA` / `ESTADO_NO_APROBABLE`. Con
 * `CARNES_AUTH=exigir` el autor sale del token; en `off` / `reportar`, del `por`
 * del body (obligatorio: sin él no quedaría registrado quién aprobó).
 */
export async function aprobarContabilidad(req, res, next) {
  try {
    const { por } = conQuienHace(req, req.body || {}, "por");
    if (!por) throw createError(400, "Falta quién aprueba: no hay un correo de sesión para registrar.");
    const data = await AdminModel.aprobarContabilidad(req.datosValidados.id, { por });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
