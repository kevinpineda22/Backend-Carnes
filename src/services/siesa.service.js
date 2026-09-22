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

/**
 * Texto corto de un cuerpo de error, para el mensaje que ve el admin.
 *
 * Cuando el conector rechaza una estructura, `mensaje` dice apenas "Error en la
 * Estructura" y el QUÉ está en `detalle`: un arreglo de objetos con la sección,
 * el campo y la explicación. Sin sacarlo de ahí, el panel muestra tres palabras
 * inútiles y hay que abrir el JSON crudo para entender qué pasó.
 */
function resumirError(respuesta) {
  if (!respuesta) return "sin cuerpo";
  if (typeof respuesta === "string") return respuesta.slice(0, 300);

  const partes = [];
  const cabecera = [respuesta.mensaje, respuesta.message, respuesta.error].find(
    (x) => typeof x === "string" && x.trim(),
  );
  if (cabecera) partes.push(cabecera.trim());

  // `detalle` puede ser texto o el arreglo de validaciones del conector.
  const d = respuesta.detalle;
  if (Array.isArray(d)) {
    // Las advertencias no explican el rechazo; los errores sí. Si solo hay
    // advertencias se muestran igual, porque algo tiene que decir.
    const errores = d.filter((x) => !/^Advertencia/i.test(String(x?.f_detalle ?? "")));
    const mostrar = (errores.length ? errores : d).slice(0, 6);
    for (const x of mostrar) {
      const donde = [x?.f_nivel, x?.f_valor].filter(Boolean).join(" · ");
      partes.push(donde ? `[${donde}] ${x?.f_detalle ?? ""}` : String(x?.f_detalle ?? ""));
    }
    const restantes = (errores.length ? errores : d).length - mostrar.length;
    if (restantes > 0) partes.push(`(+${restantes} más)`);
  } else if (typeof d === "string" && d.trim()) {
    partes.push(d.trim());
  } else if (!cabecera) {
    partes.push(JSON.stringify(respuesta).slice(0, 300));
  }

  return partes.join(" ").slice(0, 700);
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
  // El conector usa `codigo`: 0 es éxito, cualquier otra cosa es rechazo.
  if (respuesta.codigo !== undefined && Number(respuesta.codigo) !== 0) {
    return `SIESA rechazó el documento: ${resumirError(respuesta)}`;
  }
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
