import * as RecepcionProveedorModel from "../models/RecepcionProveedor.model.js";
import * as PostFinalizarProveedor from "../models/PostFinalizarProveedor.model.js";
import * as SiesaEnvioModel from "../models/SiesaEnvio.model.js";
import { conQuienHace, quienHace } from "../middleware/auth.js";
import { notificarConfirmacionProveedor } from "../services/notificaciones.service.js";
import { hoyBogota } from "../shared/proveedorValores.js";
import { normalizarCorreo, ventanaHistorial } from "../shared/historialRecibidor.js";

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
 * GET /api/recepciones-proveedor/mias?recibido_por=&desde=&hasta=&limite=&offset=
 *
 * "Mi historial": las facturas que firmó la cuenta de la sesión. Con
 * `CARNES_AUTH` activo el correo sale del token y el de la query se ignora
 * (`quienHace`). Sin firma ni cédula.
 */
export async function listarMias(req, res, next) {
  try {
    const { recibido_por, desde, hasta, limite, offset } = req.datosValidados;
    const correo = normalizarCorreo(quienHace(req, recibido_por, "recibido_por"));
    const ventana = ventanaHistorial({ desde, hasta }, hoyBogota());
    const { recepciones, hay_mas } = await RecepcionProveedorModel.listarMias({ correo, ...ventana, limite, offset });
    res.json({ ok: true, data: recepciones, limite, offset, hay_mas, ...ventana });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/en-curso?recibido_por=
 *
 * Los borradores que abrió la cuenta de la sesión (todas las sedes), con cuántos
 * renglones ya tienen cantidad. Con `CARNES_AUTH` activo el correo sale del token
 * (`quienHace`). Sin firma ni cédula.
 */
export async function listarEnCurso(req, res, next) {
  try {
    const { recibido_por } = req.datosValidados;
    const correo = normalizarCorreo(quienHace(req, recibido_por, "recibido_por"));
    const data = await RecepcionProveedorModel.listarEnCurso({ correo });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/recepciones-proveedor/:id/acta?recibido_por=
 *
 * Lo que necesita el acta de devolución de una recepción firmada por la cuenta de
 * la sesión (con `CARNES_AUTH` activo el correo sale del token: `quienHace`). Trae
 * firma y cédula, por eso solo la entrega a su dueña. 404 si no existe, no es suya
 * o no está firmada (no se filtra cuál de las tres).
 */
export async function obtenerActa(req, res, next) {
  try {
    const { id, recibido_por } = req.datosValidados;
    const correo = normalizarCorreo(quienHace(req, recibido_por, "recibido_por"));
    const data = await RecepcionProveedorModel.obtenerActa({ id, correo });
    res.json({ ok: true, data });
  } catch (error) {
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
 * Body: { editado_por, observaciones?, descuento_pct?, items: [{ id, cantidad?, valor?,
 *   valor_fuente?, cantidad_devuelta?, motivo_devolucion?, confirmar_exceso?, confirmar_valor?,
 *   descuento_pct? }] }  (`descuento_pct`: el global en la cabecera; en un renglón su propio
 *   porcentaje, que lo reemplaza, y `null` lo quita)
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

/**
 * POST /api/recepciones-proveedor/:id/cortes-adicionales
 * Body: { editado_por, codigo_item, unidad }
 *
 * Agrega a un borrador un corte del catálogo que no está en la plantilla. 201 con
 * el renglón creado (`item`); 404 si el corte no está en el catálogo; 409 si ya
 * está en la recepción o si ya no es un borrador.
 */
export async function agregarCorteAdicional(req, res, next) {
  try {
    const { editado_por, codigo_item, unidad } = conQuienHace(req, req.body, "editado_por");
    const item = await RecepcionProveedorModel.agregarCorteAdicional(req.datosValidados.id, {
      codigo_item,
      unidad,
      por: editado_por,
    });
    res.status(201).json({ ok: true, item });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/recepciones-proveedor/:id/cortes-adicionales/:item_id
 * Quita un corte adicional de un borrador. 409 si el renglón es de la plantilla o la
 * recepción ya no es un borrador; 404 si no existe.
 */
export async function quitarCorteAdicional(req, res, next) {
  try {
    const { id, item_id } = req.datosValidados;
    const data = await RecepcionProveedorModel.quitarCorteAdicional(id, item_id);
    res.json({ ok: true, ...data });
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
    //
    // La confirmación a quien recibió sale en paralelo con SIESA (que puede tardar
    // hasta 45 s) y se ESPERA: en Vercel la función se congela al responder. Solo
    // en la firma real; un reintento (`yaFinalizada`) no vuelve a mandarla.
    const [{ cambios, ...despues }, confirmacion] = await Promise.all([
      PostFinalizarProveedor.despuesDeFinalizar({ recepcion, resumen, yaFinalizada }),
      yaFinalizada
        ? Promise.resolve(null)
        : notificarConfirmacionProveedor(recepcion, recepcion.items, resumen),
    ]);
    res.json({
      ok: true,
      // Si la entrada quedó ok, la recepción ya pasó a Enviada_SIESA: que `data` lo diga.
      data: cambios ? { ...recepcion, ...cambios } : recepcion,
      resumen,
      ya_finalizada: yaFinalizada,
      confirmacion,
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
