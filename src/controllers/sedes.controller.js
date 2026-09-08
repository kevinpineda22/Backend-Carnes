import * as SedeModel from "../models/Sede.model.js";

/**
 * GET /api/sedes
 * Sedes activas para el selector del recibidor. NO incluye `qr_token`.
 */
export async function listar(req, res, next) {
  try {
    const data = await SedeModel.listar({
      incluirInactivas: req.query.incluirInactivas === "true",
    });
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/sedes/tokens
 * Listado CON el token, para imprimir los stickers. Exige `X-Admin-Key`.
 */
export async function listarConToken(_req, res, next) {
  try {
    const data = await SedeModel.listarConToken();
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/sedes/verificar
 * Body: { sede_id, qr_token }
 *
 * Contesta con `verificada: true|false` y un mensaje listo para mostrar.
 *
 * Devuelve 200 incluso cuando NO coincide, y eso es deliberado. Un 403 lo trata
 * el front como un error —toast rojo genérico, o peor, un `catch` que traga— y
 * acá el "no coincide" no es una falla técnica: es el resultado útil del
 * chequeo, el caso que este endpoint existe para detectar. Tiene que llegar a la
 * pantalla con su explicación intacta.
 */
export async function verificar(req, res, next) {
  try {
    const { sede_id, qr_token } = req.body;
    const { estado, sede } = await SedeModel.verificarQr(sede_id, qr_token);

    const MENSAJES = {
      ok: () => `Verificado: estás en ${sede.nombre}.`,
      desconocido: () =>
        "Ese código QR no está registrado. Verificá que sea el de la zona de " +
        "recibo y no otro adhesivo.",
      sede_inactiva: () =>
        `El QR corresponde a ${sede.nombre}, que está inactiva. Avisale al administrador.`,
      sede_distinta: () =>
        `El QR que escaneaste es de ${sede.nombre}. Cambiá la sede seleccionada ` +
        "o escaneá el código de la sede donde estás.",
    };

    res.json({
      ok: true,
      verificada: estado === "ok",
      estado,
      // La sede escaneada solo se devuelve cuando el token era válido: si no
      // existe, no hay nada que contar.
      sede: sede || null,
      mensaje: MENSAJES[estado](),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/sedes/:id/regenerar-token
 * Invalida el QR anterior de esa sede. Exige `X-Admin-Key`.
 */
export async function regenerarToken(req, res, next) {
  try {
    const data = await SedeModel.regenerarToken(req.params.id);
    console.log(`🔄 QR regenerado para la sede "${data.nombre}" (#${data.id})`);
    res.json({
      ok: true,
      data,
      aviso:
        "El QR anterior de esta sede dejó de funcionar. Hay que reimprimir y " +
        "reemplazar el adhesivo ANTES del próximo recibo.",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/sedes/:id
 * Edita nombre, C.O. o el estado activo. El token no se toca por acá.
 */
export async function actualizar(req, res, next) {
  try {
    const data = await SedeModel.actualizar(req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (error) {
    next(error);
  }
}
