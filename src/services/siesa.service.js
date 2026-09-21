/**
 * La llamada HTTP al conector de SIESA. Solo eso.
 *
 * Armar el documento es de `shared/siesaEntrada.js` (puro). Decidir cuándo se
 * manda y guardar el rastro es de `models/SiesaEnvio.model.js`. Acá vive lo
 * único que no se puede testear sin red: el POST.
 *
 * Nunca lanza por un error de SIESA: devuelve `{ ok, status, respuesta, error }`
 * y el modelo lo guarda tal cual. Un 400 del conector es información —qué
 * campo rechazó— y tiene que quedar en la tabla, no perderse en un throw.
 */

import { conexionSiesa, DOCUMENTO_CARNES } from "../config/siesa.js";

/** El conector puede tardar: valida cada movimiento contra maestros. */
const TIMEOUT_MS = 45_000;

/**
 * POST al conector.
 *
 * @param {object} payload  { Documentos, Descuentos, Movimientos }
 * @returns {Promise<{ok: boolean, status: number|null, respuesta: any, error: string|null}>}
 */
export async function enviarASiesa(payload) {
  const c = conexionSiesa();

  const url =
    `${c.url}?idCompania=${encodeURIComponent(c.idCompania)}` +
    `&idSistema=${encodeURIComponent(c.idSistema)}` +
    `&idDocumento=${encodeURIComponent(DOCUMENTO_CARNES.idDocumento)}` +
    `&nombreDocumento=${encodeURIComponent(DOCUMENTO_CARNES.nombreDocumento)}`;

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Mismo casing que Backend-Dotacion/Backend-traslados. HTTP no distingue
        // mayúsculas en los nombres de header, pero verlos iguales evita dudas.
        conniKey: c.conniKey,
        conniToken: c.conniToken,
      },
      body: JSON.stringify(payload),
      signal: controlador.signal,
    });

    // SIESA a veces responde texto plano en los errores. Se guarda lo que sea.
    const texto = await r.text();
    let respuesta;
    try {
      respuesta = texto ? JSON.parse(texto) : null;
    } catch {
      respuesta = { texto };
    }

    if (!r.ok) {
      return {
        ok: false,
        status: r.status,
        respuesta,
        error: `SIESA respondió ${r.status}: ${resumirError(respuesta)}`,
      };
    }

    // Un 200 con mensaje de rechazo adentro también es un fallo. El conector
    // devuelve estructuras variadas; se busca lo obvio.
    const rechazo = detectarRechazo(respuesta);
    if (rechazo) {
      return { ok: false, status: r.status, respuesta, error: rechazo };
    }

    return { ok: true, status: r.status, respuesta, error: null };
  } catch (e) {
    const motivo =
      e.name === "AbortError"
        ? `SIESA no respondió en ${TIMEOUT_MS / 1000} s.`
        : `No se pudo conectar con SIESA: ${e.message}`;
    return { ok: false, status: null, respuesta: null, error: motivo };
  } finally {
    clearTimeout(temporizador);
  }
}

/** Texto corto de un cuerpo de error, para el mensaje. */
function resumirError(respuesta) {
  if (!respuesta) return "sin cuerpo";
  if (typeof respuesta === "string") return respuesta.slice(0, 300);
  const candidatos = [respuesta.mensaje, respuesta.message, respuesta.error, respuesta.detalle, respuesta.texto];
  const primero = candidatos.find((x) => typeof x === "string" && x.trim());
  return primero ? primero.slice(0, 300) : JSON.stringify(respuesta).slice(0, 300);
}

/**
 * ¿La respuesta "exitosa" trae un rechazo adentro?
 *
 * No se conoce el contrato exacto de este conector hasta el primer envío real.
 * Se cubren las formas habituales de los conectores de SIESA Cloud; lo que no
 * encaje pasa como ok y queda el cuerpo guardado para revisarlo.
 */
function detectarRechazo(respuesta) {
  if (!respuesta || typeof respuesta !== "object") return null;
  const flags = [respuesta.exito, respuesta.success, respuesta.ok, respuesta.estado];
  if (flags.some((f) => f === false || String(f).toLowerCase() === "error")) {
    return `SIESA rechazó el documento: ${resumirError(respuesta)}`;
  }
  const errores = respuesta.errores ?? respuesta.errors;
  if (Array.isArray(errores) && errores.length) {
    return `SIESA rechazó el documento: ${JSON.stringify(errores).slice(0, 300)}`;
  }
  return null;
}
