import * as SiesaEnvio from "../models/SiesaEnvio.model.js";
import { siesaConfigurado, siesaActivo, faltantesSiesa, conexionSiesa, DOCUMENTO_CARNES } from "../config/siesa.js";

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
