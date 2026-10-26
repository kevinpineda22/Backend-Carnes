import * as ProveedorModel from "../models/Proveedor.model.js";
import * as CatalogoModel from "../models/Catalogo.model.js";
import * as GrupoImpositivoModel from "../models/GrupoImpositivo.model.js";
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

/**
 * GET /api/proveedores/catalogo-cortes?q=
 * Busca cortes del catálogo por código o descripción (mínimo 2 caracteres). Lo usan
 * el "Agregar corte" de la plantilla (admin) y los "Cortes adicionales" del recibidor.
 */
export async function buscarCortes(req, res, next) {
  try {
    const { q, limite } = req.datosValidados;
    const data = await CatalogoModel.buscarCortes(q, { limite });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/proveedores/:id/plantilla/cortes
 * Body: { por(correo), codigo_item, unidad }
 *
 * Agrega UN corte del catálogo a la plantilla del proveedor. 201 con la fila;
 * 404 si el corte no está en el catálogo; 409 si ya está en la plantilla.
 */
export async function agregarCorte(req, res, next) {
  try {
    const { codigo_item, unidad, por } = conQuienHace(req, req.body, "por");
    const { fila, reactivada } = await ProveedorModel.agregarCorte(req.datosValidados.id, {
      codigo_item,
      unidad,
      por,
    });
    res.status(201).json({ ok: true, data: fila, reactivada });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/proveedores/grupos-impositivos/estado
 * Cuántos ítems tiene el catálogo de grupos impositivos y cuándo se sincronizó por
 * última vez (`ultima_sincronizacion` null = nunca).
 */
export async function estadoGruposImpositivos(_req, res, next) {
  try {
    const data = await GrupoImpositivoModel.estado();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/proveedores/grupos-impositivos/sincronizar
 * Trae de Connekta el grupo impositivo de cada ítem y lo guarda (solo lectura en
 * SIESA: no crea nada allá). Tarda decenas de segundos. 409 si ya hay una en curso;
 * 502 si Connekta falla o la lectura quedó incompleta (en ese caso no se escribió nada).
 */
export async function sincronizarGruposImpositivos(_req, res, next) {
  try {
    const data = await GrupoImpositivoModel.sincronizar();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
