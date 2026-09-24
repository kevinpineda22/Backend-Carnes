import * as DesposteModel from "../models/Desposte.model.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * GET /api/recepciones/:id/desposte
 * El informe adjunto y el cruce contra lo que digitó el recibidor.
 */
export async function obtener(req, res, next) {
  try {
    const data = await DesposteModel.obtener(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/recepciones/:id/desposte — multipart, campo `archivo`.
 *
 * `forzar=true` deja adjuntar un informe cuyo "Sub Cliente" no coincide con la
 * sede. Existe porque la cadena del PDF puede cambiar del lado del frigorífico
 * y no se puede dejar la operación trabada esperando a que alguien actualice un
 * catálogo. Queda registrado: `sede_coincide` guarda false.
 */
export async function adjuntar(req, res, next) {
  try {
    if (!req.file) {
      throw createError(400, "Falta el archivo PDF (campo `archivo`).");
    }
    const data = await DesposteModel.adjuntar(req.params.id, {
      buffer: req.file.buffer,
      nombre: req.file.originalname,
      subidoPor: req.body?.subido_por,
      forzar: req.body?.forzar === "true" || req.body?.forzar === true,
    });
    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/recepciones/:id/desposte/archivo — URL firmada para abrir el PDF. */
export async function archivo(req, res, next) {
  try {
    const data = await DesposteModel.urlArchivo(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/recepciones/:id/desposte */
export async function eliminar(req, res, next) {
  try {
    const data = await DesposteModel.eliminar(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

// ─── Guía anticipada ───────────────────────────────────────────────────────

/** GET /api/desposte/anticipadas?especie= — las que esperan su recepción. */
export async function listarAnticipadas(req, res, next) {
  try {
    const data = await DesposteModel.listarAnticipadas({ especie: req.query.especie });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/desposte/anticipadas — multipart: `archivo`, `sede_id`, `especie`,
 * `fecha` (de entrega), `subido_por`, `forzar`.
 *
 * Si la recepción de esa sede y fecha ya cerró, se adjunta directo y se compara
 * en el acto (`destino: "recepcion"`). Si no, queda esperando (`"anticipada"`).
 */
export async function subirAnticipada(req, res, next) {
  try {
    if (!req.file) throw createError(400, "Falta el archivo PDF (campo `archivo`).");
    const data = await DesposteModel.subirAnticipada({
      sedeId: Number(req.body?.sede_id),
      especie: req.body?.especie,
      fecha: req.body?.fecha,
      buffer: req.file.buffer,
      nombre: req.file.originalname,
      subidoPor: req.body?.subido_por,
      forzar: req.body?.forzar === "true" || req.body?.forzar === true,
    });
    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/desposte/anticipadas/:id/archivo — URL firmada del PDF. */
export async function archivoAnticipada(req, res, next) {
  try {
    const data = await DesposteModel.urlArchivoAnticipada(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/desposte/anticipadas/:id — solo si todavía no se enganchó. */
export async function eliminarAnticipada(req, res, next) {
  try {
    const data = await DesposteModel.eliminarAnticipada(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}
