import * as RecepcionProveedorModel from "../models/RecepcionProveedor.model.js";

/**
 * POST /api/recepciones-proveedor/abrir
 * Body: { proveedor_id, factura, qr_token, recibido_por }
 *
 * Abre el borrador de una factura de proveedor con la plantilla ya cargada, o
 * devuelve el que ya estaba abierto en esta sede (`reanudada`). 201 al crear, 200
 * al reanudar. 409 si el QR no sirve, si el proveedor no tiene plantilla o si la
 * factura ya se recibió / está abierta en otra sede (cada uno con su `codigo`).
 */
export async function abrir(req, res, next) {
  try {
    const { recepcion, reanudada, verificacion, avisos } = await RecepcionProveedorModel.abrir(
      req.body,
    );
    res.status(reanudada ? 200 : 201).json({
      ok: true,
      data: recepcion,
      reanudada,
      verificacion,
      avisos,
    });
  } catch (error) {
    // Igual que en Talleres: el QR fallido viaja con su detalle, porque el front
    // necesita decir CUÁL era la sede del QR y no solo que no coincidió.
    if (error.verificacion) {
      return res.status(409).json({
        ok: false,
        error: error.message,
        codigo: error.codigo,
        verificacion: error.verificacion,
      });
    }
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/:id
 * Cabecera + renglones para reanudar. Sin firma ni cédula del recibidor: el
 * detalle completo del admin llega en un corte posterior.
 */
export async function obtener(req, res, next) {
  try {
    const data = await RecepcionProveedorModel.obtener(req.datosValidados.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/recepciones-proveedor/:id
 * Body: { editado_por, observaciones?, items: [{ id, cantidad?, valor?, valor_fuente?,
 *   cantidad_devuelta?, motivo_devolucion?, confirmar_exceso?, confirmar_valor? }] }
 *
 * Autoguardado. SIEMPRE 200 si el borrador se pudo escribir: lo que no se pudo
 * aplicar (valor que no se entiende) o falta confirmar vuelve en `pendientes`, y
 * `data` trae lo que quedó guardado. 409 si la recepción ya no es un borrador.
 */
export async function guardar(req, res, next) {
  try {
    const { recepcion, pendientes, ignorados, avisos } = await RecepcionProveedorModel.guardar(
      req.datosValidados.id,
      req.body,
    );
    res.json({ ok: true, data: recepcion, pendientes, ignorados, avisos });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/recepciones-proveedor/:id — descarta un borrador. 409 si ya está firmada. */
export async function descartar(req, res, next) {
  try {
    const data = await RecepcionProveedorModel.descartar(req.datosValidados.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}
