import * as RecepcionProveedorModel from "../models/RecepcionProveedor.model.js";
import * as PostFinalizarProveedor from "../models/PostFinalizarProveedor.model.js";
import * as SiesaEnvioModel from "../models/SiesaEnvio.model.js";
import { conQuienHace, quienHace } from "../middleware/auth.js";

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
      conQuienHace(req, req.body, "recibido_por"),
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
      conQuienHace(req, req.body, "editado_por"),
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

/**
 * POST /api/recepciones-proveedor/:id/finalizar
 * Body: { recibido_por, recibidor: { id } | { otro: true, nombre, cedula }, firma_data,
 *   proveedor_firmante?: { nombre, documento, firma_data } }  (obligatorio si hay devoluciones)
 *
 * Firma la recepción (Borrador -> Finalizada) y manda la entrada a SIESA (ver
 * `PostFinalizarProveedor.model.js`). 200 con la recepción (sin firma ni cédula), el
 * `resumen`, `siesa` {estado, referencia, error, envio_id} y `notaCredito` {requerida,
 * estado, bloqueo, referencia, error} con el estado REAL. Que SIESA falle no es un
 * error de finalizar: la recepción ya está firmada y el admin reintenta.
 *
 * Sobre una recepción que YA estaba firmada devuelve 200 con el estado actual y
 * `ya_finalizada: true`: no vuelve a firmar. 422 con el detalle por renglón si
 * algo no pasa la validación; 409 si cambió mientras se firmaba.
 */
export async function finalizar(req, res, next) {
  try {
    const { recepcion, resumen, yaFinalizada } = await RecepcionProveedorModel.finalizar(
      req.datosValidados.id,
      conQuienHace(req, req.body, "recibido_por"),
    );
    // Nunca lanza: la recepción ya está firmada y lo que falle acá viaja en la respuesta.
    const { cambios, ...despues } = await PostFinalizarProveedor.despuesDeFinalizar({
      recepcion,
      resumen,
      yaFinalizada,
    });
    res.json({
      ok: true,
      // Si la entrada quedó ok, la recepción ya pasó a Enviada_SIESA: que `data` lo diga.
      data: cambios ? { ...recepcion, ...cambios } : recepcion,
      resumen,
      ya_finalizada: yaFinalizada,
      ...despues,
    });
  } catch (error) {
    // Igual que `abrir` con la verificación del QR: el 422 lleva el detalle por
    // renglón, que el errorHandler genérico no sabe serializar.
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
 * POST /api/recepciones-proveedor/:id/siesa/reintentar
 * Body: { por }  (correo del admin)
 *
 * Reintenta la entrada a SIESA. Si la entrada YA está ok no manda otra: reconcilia
 * el estado de la recepción (`reconciliada: true`) y dispara la nota crédito que
 * falte. 200 si la entrada está en SIESA; 502 con el motivo si SIESA la rechazó o
 * quedó sin confirmar (el detalle va en `siesa`). 409 si no se puede (borrador,
 * anulada, envío en curso o sin confirmar, SIESA apagado).
 */
export async function reintentarSiesa(req, res, next) {
  try {
    const id = req.datosValidados.id;
    const { cambios, ...resultado } = await SiesaEnvioModel.reintentarEntradaProveedor(
      id,
      quienHace(req, req.body.por, "por"),
    );
    const recepcion = await RecepcionProveedorModel.obtener(id);
    const ok = resultado.siesa.estado === "ok";
    res.status(ok ? 200 : 502).json({
      ok,
      data: cambios ? { ...recepcion, ...cambios } : recepcion,
      ...resultado,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recepciones-proveedor/:id/nota-credito/reintentar
 * Body: { por }  (correo del admin)
 *
 * Manda (o reintenta) la nota crédito de lo devuelto. 409 con el motivo si no se
 * puede: la entrada no está en SIESA, no hay devoluciones, ya hay una vigente u
 * ok, SIESA apagado, o el conector de la nota crédito todavía no está configurado
 * (en ese caso NO se anota ningún envío). 200 si quedó en SIESA; 502 si SIESA la
 * rechazó o quedó sin confirmar.
 */
export async function reintentarNotaCredito(req, res, next) {
  try {
    const id = req.datosValidados.id;
    const { notaCredito } = await SiesaEnvioModel.reintentarNotaCreditoProveedor(
      id,
      quienHace(req, req.body.por, "por"),
    );
    const recepcion = await RecepcionProveedorModel.obtener(id);
    const ok = notaCredito.estado === "ok";
    res.status(ok ? 200 : 502).json({ ok, data: recepcion, notaCredito });
  } catch (error) {
    next(error);
  }
}
