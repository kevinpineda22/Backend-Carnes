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
 *
 * `incierto: true` cuando no se sabe si SIESA lo creó: el POST salió pero la
 * respuesta no llegó (timeout, corte de red, 502/503/504 del gateway). Tratarlo como
 * error invita a reintentar, y el reintento duplica si SIESA sí lo había
 * creado. El modelo lo guarda como `sin_confirmar`.
 */

/** Errores de red que garantizan que el pedido NO salió. */
const NO_SALIO = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Respuestas del gateway que no dicen si el conector llegó a crear el documento. */
const ESTADOS_DE_GATEWAY = new Set([502, 503, 504]);

import { conexionSiesa, DOCUMENTO_CARNES } from "../config/siesa.js";

/**
 * Cuánto se espera la respuesta del conector, según el envío.
 *
 * El conector valida cada movimiento contra maestros, y el tiempo crece con los
 * renglones. La inicial (~35, una sede) vuelve en segundos; la oficial
 * consolidada de una liquidación son cientos: TC OFI L10 (403 renglones, 9
 * sedes) pasó dos veces los 45 s de antes el 29/09/2026, y cada corte deja un
 * `sin_confirmar` que puede ser un documento creado.
 *
 * Esta espera tiene que quedar DEBAJO de dos límites, o el remedio es peor:
 *   · el límite de la función en Vercel (300 s, el default de Fluid compute:
 *     vercel.json NO lleva bloque `functions` a propósito, agregarlo rompió el
 *     enrutado): si Vercel mata la función antes, el envío queda colgado en
 *     'enviando'.
 *   · `ENVIANDO_ABANDONADO_MS` (6 min, backend y front): si un envío vivo se
 *     viera "abandonado", alguien lo resolvería y reenviaría mientras corre.
 *
 * La inicial se queda en 45 s a propósito: sale cuando el recibidor cierra, y
 * no puede tenerlo minutos mirando la pantalla por algo que es best-effort.
 */
export const TIMEOUT_INICIAL_MS = 45_000;
export const TIMEOUT_OFICIAL_MS = 240_000;

/**
 * POST al conector.
 *
 * @param {object} payload  { Documentos, Descuentos, Movimientos }
 * @param {{timeoutMs?: number, documento?: {idDocumento: string, nombreDocumento: string}}} [opciones]
 *        `timeoutMs`: ver TIMEOUT_INICIAL_MS / TIMEOUT_OFICIAL_MS.
 *        `documento`: qué conector recibe el POST. Sin él, la CEA de carnes
 *        (`DOCUMENTO_CARNES`); el ajuste de vísceras pasa el suyo.
 * @returns {Promise<{ok: boolean, status: number|null, respuesta: any, error: string|null}>}
 */
export async function enviarASiesa(
  payload,
  { timeoutMs = TIMEOUT_INICIAL_MS, documento = DOCUMENTO_CARNES } = {},
) {
  const c = conexionSiesa();

  const url =
    `${c.url}?idCompania=${encodeURIComponent(c.idCompania)}` +
    `&idSistema=${encodeURIComponent(c.idSistema)}` +
    `&idDocumento=${encodeURIComponent(documento.idDocumento)}` +
    `&nombreDocumento=${encodeURIComponent(documento.nombreDocumento)}`;

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);

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
      // 502/503/504: lo dice el gateway, no el conector. El pedido pudo llegar y
      // el conector terminar detrás (un 504 es el clásico, pero un 502 o un 503
      // cuando el upstream se reinicia a mitad de camino también). Es un "no
      // sé", no un rechazo: tratarlo como error invita a reintentar y duplicar.
      // Un 400/401/404 sí es del conector y sí es un rechazo.
      const incierto = ESTADOS_DE_GATEWAY.has(r.status);
      return {
        ok: false,
        incierto,
        status: r.status,
        respuesta,
        error: incierto
          ? `SIESA no respondió a tiempo (HTTP ${r.status}). Puede haberlo creado: verificalo antes de reintentar.`
          : `SIESA respondió ${r.status}: ${resumirError(respuesta)}`,
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
    if (e.name === "AbortError") {
      return {
        ok: false,
        incierto: true,
        status: null,
        respuesta: null,
        error:
          `SIESA no respondió en ${timeoutMs / 1000} s. Puede haberlo creado: ` +
          "verificalo en SIESA antes de reintentar.",
      };
    }
    // `fetch` envuelve el error de red en `cause`. Si la conexión ni siquiera
    // se abrió, es seguro que no salió; cualquier otro corte puede haber sido
    // después de mandar.
    const codigo = e.cause?.code;
    const incierto = !NO_SALIO.has(codigo);
    return {
      ok: false,
      incierto,
      status: null,
      respuesta: null,
      error: incierto
        ? `Se cortó la conexión con SIESA (${e.message}). Puede haberlo creado: verificalo antes de reintentar.`
        : `No se pudo conectar con SIESA: ${e.message}`,
    };
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
