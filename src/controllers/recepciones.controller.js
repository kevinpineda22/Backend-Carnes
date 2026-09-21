import * as RecepcionModel from "../models/Recepcion.model.js";
import { notificarRecepcionFinalizada } from "../services/notificaciones.service.js";
import * as SiesaEnvio from "../models/SiesaEnvio.model.js";

/**
 * POST /api/recepciones/abrir
 * Body: { especie, sede_id, qr_token, recibido_por, fecha_ingreso?, novillos? }
 *
 * Verifica el QR, y devuelve el borrador con la plantilla ya cargada. Si ya
 * había uno abierto para esa sede, especie y fecha, devuelve ESE (`reanudada`).
 */
export async function abrir(req, res, next) {
  try {
    const { recepcion, reanudada, rechazada, motivoRechazo } =
      await RecepcionModel.abrir(req.body);
    res.status(reanudada ? 200 : 201).json({
      ok: true,
      data: recepcion,
      reanudada,
      // El front lo necesita para mostrarle al recibidor QUÉ le reclamaron
      // antes de que empiece a corregir.
      ...(rechazada ? { rechazada, motivoRechazo } : {}),
    });
  } catch (error) {
    // La verificación de sede fallida viaja con su detalle: el front lo necesita
    // para decir CUÁL era la sede del QR, no solo que no coincidió.
    if (error.verificacion) {
      return res.status(409).json({
        ok: false,
        error: error.message,
        verificacion: error.verificacion,
      });
    }
    next(error);
  }
}

/** GET /api/recepciones — listado para el panel del admin. */
export async function listar(req, res, next) {
  try {
    const data = await RecepcionModel.listar(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/recepciones/:id — cabecera + renglones. */
export async function obtener(req, res, next) {
  try {
    const data = await RecepcionModel.obtener(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/recepciones/:id
 * Guarda el borrador. Body: { novillos?, observaciones?, items: [{ id, cantidad }] }
 */
export async function guardar(req, res, next) {
  try {
    const data = await RecepcionModel.guardarBorrador(req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recepciones/:id/items — el "Otro / Agregar". */
export async function agregarAdicional(req, res, next) {
  try {
    const data = await RecepcionModel.agregarAdicional(req.params.id, req.body);
    res.status(201).json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/recepciones/:id/items/:itemId — solo adicionales. */
export async function eliminarItem(req, res, next) {
  try {
    const data = await RecepcionModel.eliminarItem(req.params.id, req.params.itemId);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/recepciones/:id/items/:itemId
 * El admin corrige un renglón de una recepción cerrada. Deja rastro.
 */
export async function editarItem(req, res, next) {
  try {
    const { editado_por, ...cambios } = req.body;
    const data = await RecepcionModel.editarItem(
      req.params.id,
      req.params.itemId,
      cambios,
      editado_por,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/recepciones/:id/items/:itemId/homologar
 * Body: { codigo_item, costo_base, codigo_tabla?, descripcion? }
 *
 * Sin esto, un renglón agregado por el recibidor bloquea el costeo de toda la
 * liquidación — a propósito: sin código de SIESA no puede subir al ERP.
 */
export async function homologarAdicional(req, res, next) {
  try {
    const data = await RecepcionModel.homologarAdicional(
      req.params.id,
      req.params.itemId,
      req.body,
    );
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recepciones/:id/finalizar
 * Borrador → Recibido, y le avisa al admin por correo.
 *
 * El correo se ESPERA antes de responder, aunque sea un efecto secundario. En
 * Vercel la función se congela apenas se manda la respuesta, así que un
 * `sendEmail` sin `await` se corta a la mitad y el aviso no sale nunca — sin
 * error, sin log, sin nada. `sendEmail` no lanza y tarda menos de un segundo.
 *
 * El resultado viaja en `notificacion` para que el front pueda decir "guardado,
 * pero el aviso al admin no salió" en vez de dar todo por bueno.
 */
export async function finalizar(req, res, next) {
  try {
    const data = await RecepcionModel.finalizar(req.params.id, req.body || {});

    // Los dos efectos del cierre —el correo al admin y la entrada inicial a
    // SIESA— van en paralelo y ninguno lanza. La recepción YA está cerrada;
    // lo que falle acá se reporta en la respuesta, no como error.
    const [notificacion, siesa] = await Promise.all([
      notificarRecepcionFinalizada(data, data.items),
      SiesaEnvio.enviarInicial(data.id, data.recibido_por),
    ]);

    res.json({
      ok: true,
      data,
      notificacion,
      siesa: { estado: siesa.estado, referencia: siesa.referencia ?? null, error: siesa.error ?? null },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/recepciones/:id
 * Tira un borrador que se abrió por error. Solo en Borrador.
 */
export async function descartar(req, res, next) {
  try {
    const data = await RecepcionModel.descartar(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recepciones/:id/aprobar — Recibido → Aprobado. */
export async function aprobar(req, res, next) {
  try {
    const data = await RecepcionModel.aprobar(req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recepciones/:id/rechazar — Recibido → Rechazado. */
export async function rechazar(req, res, next) {
  try {
    const data = await RecepcionModel.rechazar(req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recepciones/:id/reabrir — Rechazado → Borrador. */
export async function reabrir(req, res, next) {
  try {
    const data = await RecepcionModel.reabrir(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/recepciones/:id/desaprobar — Aprobado → Recibido. */
export async function desaprobar(req, res, next) {
  try {
    const data = await RecepcionModel.desaprobar(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
