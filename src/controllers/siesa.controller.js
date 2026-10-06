import * as SiesaEnvio from "../models/SiesaEnvio.model.js";
import { quienHace } from "../middleware/auth.js";
import {
  siesaConfigurado,
  siesaActivo,
  faltantesSiesa,
  conexionSiesa,
  DOCUMENTO_CARNES,
  DOCUMENTO_AJUSTE_VISCERAS,
  DOCUMENTO_AJUSTE_FALTANTE,
} from "../config/siesa.js";

/** GET /api/siesa/envios */
export async function listar(req, res, next) {
  try {
    const data = await SiesaEnvio.listar(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/siesa/envios/:id — con payload y respuesta completos. */
export async function obtener(req, res, next) {
  try {
    const data = await SiesaEnvio.obtener(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/siesa/estado — ¿está configurado? Sin exponer secretos: solo dice
 * QUÉ falta, nunca qué valor tiene lo que está.
 */
export async function estado(_req, res) {
  const c = conexionSiesa();
  res.json({
    ok: true,
    activo: siesaActivo(),
    configurado: siesaConfigurado(),
    faltantes: faltantesSiesa(),
    url: c.url || null,
    idCompania: c.idCompania || null,
    idSistema: c.idSistema,
    documento: DOCUMENTO_CARNES,
    documentoAjusteVisceras: DOCUMENTO_AJUSTE_VISCERAS,
    documentoAjusteFaltante: DOCUMENTO_AJUSTE_FALTANTE,
  });
}

/** POST /api/siesa/recepciones/:id/inicial — reintento manual. */
export async function reintentarInicial(req, res, next) {
  try {
    const data = await SiesaEnvio.reintentarInicial(
      req.params.id,
      quienHace(req, req.body?.enviado_por, "enviado_por"),
    );
    res.status(data.estado === "ok" ? 201 : 502).json({ ok: data.estado === "ok", data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/recepciones/:id/visceras — reintento manual del CEI de las
 * vísceras de una recepción de res (el que sale al cerrarla).
 */
export async function reintentarViscerasRecepcion(req, res, next) {
  try {
    const data = await SiesaEnvio.reintentarViscerasRecepcion(
      req.params.id,
      quienHace(req, req.body?.enviado_por, "enviado_por"),
    );
    res.status(data.estado === "ok" ? 201 : 502).json({ ok: data.estado === "ok", data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/liquidaciones/:id/visceras/reenviar
 * { recepcion_ids, eliminado_en_siesa, por, motivo? } — manda las vísceras de
 * esas recepciones. Las modificadas exigen `eliminado_en_siesa: true` (el
 * documento viejo se borró a mano en SIESA). 200 si todas quedaron en SIESA; 207
 * si alguna no (el detalle va en `resultados`). 409 si algo lo bloquea, sin
 * mandar nada.
 */
export async function reenviarViscerasLiquidacion(req, res, next) {
  try {
    const { recepcion_ids, eliminado_en_siesa, motivo } = req.body;
    const por = quienHace(req, req.body.por, "por");
    const data = await SiesaEnvio.reenviarViscerasLiquidacion(req.params.id, {
      recepcionIds: recepcion_ids,
      eliminadoEnSiesa: eliminado_en_siesa,
      por,
      motivo,
    });
    res.status(data.completo ? 200 : 207).json({ ok: data.completo, ...data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/siesa/liquidaciones/:id/previsualizar */
export async function previsualizarOficial(req, res, next) {
  try {
    const data = await SiesaEnvio.previsualizarOficial(req.params.id, req.query.tercero);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/siesa/liquidaciones/:id/enviar — la entrada oficial de cada sede. */
export async function enviarOficial(req, res, next) {
  try {
    const data = await SiesaEnvio.enviarOficial(
      req.params.id,
      quienHace(req, req.body?.enviado_por, "enviado_por"),
      req.body?.tercero,
    );
    // 207: algunas sedes salieron y otras no. El front muestra el detalle.
    res.status(data.cerrada ? 200 : 207).json({ ok: data.cerrada, ...data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/siesa/liquidaciones/:id/ajuste-visceras/previsualizar */
export async function previsualizarAjusteVisceras(req, res, next) {
  try {
    const data = await SiesaEnvio.previsualizarAjusteVisceras(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/liquidaciones/:id/ajuste-visceras/enviar
 *
 * Manda UN ajuste con las vísceras de todas las sedes (un solo POST, todo o
 * nada). 200 si quedó en SIESA; 207 si no (error o sin confirmar: el detalle va
 * en `envio`). 409 si algo lo bloquea, sin mandar nada.
 */
export async function enviarAjusteVisceras(req, res, next) {
  try {
    const data = await SiesaEnvio.enviarAjusteVisceras(
      req.params.id,
      quienHace(req, req.body?.enviado_por, "enviado_por"),
    );
    res.status(data.completo ? 200 : 207).json({ ok: data.completo, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/liquidaciones/:id/ajuste-visceras/anular
 * { recepcion_id?, por, motivo } — el ajuste ya se anuló en SIESA. Con
 * `recepcion_id`, el ajuste por sede del esquema anterior de esa recepción; sin
 * él, el consolidado de la liquidación.
 */
export async function anularAjusteVisceras(req, res, next) {
  try {
    const data = await SiesaEnvio.anularAjusteVisceras(req.params.id, {
      recepcionId: req.body?.recepcion_id,
      por: quienHace(req, req.body?.por, "por"),
      motivo: req.body?.motivo,
    });
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/envios/:id/resolver — { resultado: "ok" | "no_llego", por }
 *
 * Para un envío sin confirmar: alguien miró en SIESA y dice si está o no.
 */
export async function resolver(req, res, next) {
  try {
    const data = await SiesaEnvio.resolver(req.params.id, {
      resultado: req.body?.resultado,
      por: quienHace(req, req.body?.por, "por"),
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/liquidaciones/:id/anular
 * { por, motivo, iniciales_anuladas } — las oficiales ya se anularon en SIESA.
 */
export async function anularOficiales(req, res, next) {
  try {
    const data = await SiesaEnvio.anularOficiales(req.params.id, {
      por: quienHace(req, req.body?.por, "por"),
      motivo: req.body?.motivo,
      inicialesAnuladas: Boolean(req.body?.iniciales_anuladas),
    });
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/siesa/envios/:id
 * El ADMIN borra un envío que quedó en `error`. Nunca llegó a crear un
 * documento en SIESA, así que borrar la fila acá no deja nada huérfano allá.
 * Cualquier otro estado devuelve 409 — ver `puedeEliminarEnvio`.
 */
export async function eliminarEnvio(req, res, next) {
  try {
    const data = await SiesaEnvio.eliminarEnvioAdmin(req.params.id);
    res.json({ ok: true, ...data });
  } catch (error) {
    next(error);
  }
}
