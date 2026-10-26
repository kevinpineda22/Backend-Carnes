/**
 * Lectura de consultas registradas en Connekta (GET /ejecutarconsulta). Solo eso.
 *
 * Es de SOLO LECTURA: no crea nada en SIESA. El importador (POST) vive en
 * `siesa.service.js`. Mismo contrato que el cliente de Backend-traslados
 * (`config/connekta.js`): `{ codigo: 0, detalle: { Datos, total_registros,
 * página_actual, total_páginas } }`.
 *
 * Reintenta lo transitorio —sin respuesta (red, timeout), 429 y 5xx—: Connekta corre
 * sobre SQL Server y bajo carga devuelve 500 por deadlock. Un 4xx que no sea 429 es
 * culpa nuestra (consulta mal escrita, credenciales) y no se reintenta.
 *
 * NO pagina por su cuenta, a propósito. Una consulta sin `ORDER BY` estable puede
 * repetir y saltarse filas entre páginas, y un helper genérico lo esconde. Quien
 * pagina (ver `GrupoImpositivo.model.js`) cuenta filas DISTINTAS contra el total
 * declarado antes de escribir.
 */

import { conexionConsultas, faltantesConsultas } from "../config/siesa.js";
import { createError } from "../middleware/errorHandler.js";

const MAX_INTENTOS = 4;
const BACKOFF_BASE_MS = 800;
const TIMEOUT_MS = 60_000;
/** Con menos que esto de presupuesto restante un intento no tiene sentido: se corta. */
const MIN_INTENTO_MS = 1_000;

const dormirReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sin `status` = no hubo respuesta (red, timeout): transitorio. 429 y 5xx también. */
function esReintentable(status) {
  return !status || status === 429 || status >= 500;
}

function esperaAntesDeReintentar(intento) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (intento - 1), 15_000) + Math.random() * 500;
}

/** 504 de presupuesto agotado: el llamador lo trata como "no se escribió nada, reintentá". */
function tiempoAgotado() {
  const e = createError(
    504,
    "Se acabó el tiempo de la sincronización antes de traer todas las páginas. No se escribió nada; volvé a intentar.",
    "SYNC_TIEMPO_AGOTADO",
  );
  e.fatal = true;
  return e;
}

/** Error 502 con el mensaje listo para el admin. `fatal`: no se reintenta. */
function fallar(descripcion, pagina, detalle, status) {
  const e = createError(502, `Connekta falló en la página ${pagina} de "${descripcion}"${status ? ` (HTTP ${status})` : ""}: ${detalle}`);
  e.fatal = true;
  return e;
}

/**
 * Una página de una consulta registrada.
 *
 * @param {string} descripcion nombre de la consulta en Connekta
 * @param {number} [pagina]
 * @param {number} [tamPag]    Connekta acepta hasta 1000
 * @param {{limiteAbsoluto?: number, ahora?: Function, fetchFn?: Function, conexion?: object, dormir?: Function}} [opciones]
 *   `limiteAbsoluto` (ms epoch): tope duro. Cada intento dura min(60 s, lo que quede) y no se
 *   reintenta pasado el límite (lanza 504 SYNC_TIEMPO_AGOTADO). El resto es solo para tests.
 * @returns {Promise<{datos: object[], total: number, pagina: number, totalPaginas: number}>}
 */
export async function ejecutarConsulta(
  descripcion,
  pagina = 1,
  tamPag = 100,
  { fetchFn = fetch, conexion, dormir = dormirReal, limiteAbsoluto, ahora = Date.now } = {},
) {
  const c = conexion ?? conexionConsultas();
  if (!conexion) {
    const faltan = faltantesConsultas();
    if (faltan.length) throw createError(503, `Falta configurar Connekta: ${faltan.join(", ")}.`);
  }

  const url =
    `${c.url}/ejecutarconsulta?idCompania=${encodeURIComponent(c.idCompania)}` +
    `&descripcion=${encodeURIComponent(descripcion)}` +
    `&paginacion=${encodeURIComponent(`numPag=${pagina}|tamPag=${tamPag}`)}`;

  let ultimo = "error desconocido";
  let ultimoStatus = null;
  const tieneLimite = Number.isFinite(limiteAbsoluto);
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    let tiempoIntento = TIMEOUT_MS;
    if (tieneLimite) {
      const restante = limiteAbsoluto - ahora();
      if (restante < MIN_INTENTO_MS) throw tiempoAgotado();
      tiempoIntento = Math.min(TIMEOUT_MS, restante);
    }
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), tiempoIntento);
    try {
      const r = await fetchFn(url, {
        method: "GET",
        headers: { conniKey: c.conniKey, conniToken: c.conniToken },
        signal: controlador.signal,
      });
      const crudo = await r.text();
      let cuerpo = null;
      try {
        cuerpo = crudo ? JSON.parse(crudo) : null;
      } catch {
        cuerpo = null;
      }

      if (!r.ok) {
        ultimoStatus = r.status;
        ultimo = String(cuerpo?.detalle ?? cuerpo?.mensaje ?? crudo ?? "").slice(0, 300) || "sin detalle";
        // "No se encontraron registros" es una página vacía, no un fallo.
        if (r.status === 400 && /no se encontraron registros/i.test(ultimo)) {
          return { datos: [], total: 0, pagina, totalPaginas: 1 };
        }
        if (!esReintentable(r.status)) throw fallar(descripcion, pagina, ultimo, r.status);
      } else if (!cuerpo || cuerpo.codigo !== 0) {
        // 200 con rechazo adentro: no es transitorio.
        const detalle = cuerpo ? `[${cuerpo.codigo}] ${cuerpo.mensaje || ""} ${typeof cuerpo.detalle === "string" ? cuerpo.detalle : ""}` : "respuesta vacía";
        throw fallar(descripcion, pagina, detalle.trim().slice(0, 300), r.status);
      } else {
        const d = cuerpo.detalle || {};
        return {
          datos: Array.isArray(d.Datos) ? d.Datos : [],
          total: Number(d.total_registros) || 0,
          pagina: Number(d["página_actual"]) || pagina,
          totalPaginas: Number(d["total_páginas"]) || 1,
        };
      }
    } catch (e) {
      if (e?.fatal) throw e;
      ultimoStatus = null;
      ultimo = e?.name === "AbortError" ? `sin respuesta en ${Math.round(tiempoIntento / 1000)} s` : e?.message || "error de red";
    } finally {
      clearTimeout(temporizador);
    }
    if (intento < MAX_INTENTOS) {
      const espera = esperaAntesDeReintentar(intento);
      // No dormir más de lo que queda: el próximo intento ya no cabría.
      if (tieneLimite && limiteAbsoluto - ahora() < espera + MIN_INTENTO_MS) throw tiempoAgotado();
      await dormir(espera);
    }
  }
  throw fallar(descripcion, pagina, `${ultimo} (tras ${MAX_INTENTOS} intentos)`, ultimoStatus);
}

/**
 * Trae TODAS las páginas de una consulta, `concurrencia` a la vez, respetando un
 * `limiteAbsoluto` (ms epoch) que se revisa antes de CADA página (la 1 incluida) y se
 * pasa a `ejecutarConsulta` para que ni un intento lo sobrepase. Si UNA página falla
 * (ya reintentada) o se agota el tiempo, lanza: quien llama no escribe un catálogo agujereado.
 *
 * @param {{ejecutar?: Function, ahora?: Function, concurrencia?: number}} [inyectado] solo para tests
 */
export async function traerTodasLasPaginas(
  descripcion,
  tamPag,
  limiteAbsoluto,
  { ejecutar = ejecutarConsulta, ahora = Date.now, concurrencia = 3 } = {},
) {
  const pedir = (p) => {
    if (ahora() > limiteAbsoluto) throw tiempoAgotado();
    return ejecutar(descripcion, p, tamPag, { limiteAbsoluto, ahora });
  };

  const primera = await pedir(1);
  const paginas = [];
  for (let p = 2; p <= primera.totalPaginas; p++) paginas.push(p);

  const bloques = [primera.datos];
  let cursor = 0;
  async function trabajador() {
    while (cursor < paginas.length) {
      const p = paginas[cursor++];
      bloques.push((await pedir(p)).datos);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrencia, paginas.length || 1) }, trabajador));

  return { crudas: bloques.flat(), totalDeclarado: primera.total, totalPaginas: primera.totalPaginas };
}
