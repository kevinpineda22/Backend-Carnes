import * as SiesaEnvio from "../models/SiesaEnvio.model.js";
import {
  siesaConfigurado,
  siesaActivo,
  faltantesSiesa,
  conexionSiesa,
  DOCUMENTO_CARNES,
  DOCUMENTO_AJUSTE_VISCERAS,
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
  });
}

/** POST /api/siesa/recepciones/:id/inicial — reintento manual. */
export async function reintentarInicial(req, res, next) {
  try {
    const data = await SiesaEnvio.reintentarInicial(req.params.id, req.body?.enviado_por);
    res.status(data.estado === "ok" ? 201 : 502).json({ ok: data.estado === "ok", data });
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
      req.body?.enviado_por,
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
 * Manda el ajuste de cada sede pendiente, una a una. 200 si quedó todo; 207 si
 * alguna sede no salió o quedó pendiente (el detalle va en `resultados`).
 */
export async function enviarAjusteVisceras(req, res, next) {
  try {
    const data = await SiesaEnvio.enviarAjusteVisceras(req.params.id, req.body?.enviado_por);
    res.status(data.completo ? 200 : 207).json({ ok: data.completo, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/siesa/liquidaciones/:id/ajuste-visceras/anular
 * { recepcion_id, por, motivo } — el ajuste de esa sede ya se anuló en SIESA.
 */
export async function anularAjusteVisceras(req, res, next) {
  try {
    const data = await SiesaEnvio.anularAjusteVisceras(req.params.id, {
      recepcionId: req.body?.recepcion_id,
      por: req.body?.por,
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
      por: req.body?.por,
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
      por: req.body?.por,
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
