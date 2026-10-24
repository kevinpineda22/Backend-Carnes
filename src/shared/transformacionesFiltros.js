/**
 * Filtros del listado de transformaciones (tabla `sps_transformaciones`).
 *
 * Es pura y no toca la base: valida lo que llega en el query string y devuelve
 * un objeto limpio. Si algo no es válido lanza un error 400 (`createError`), que
 * el errorHandler convierte en respuesta.
 */
import { createError } from "../middleware/errorHandler.js";

export const ENTORNOS = ["QA", "PROD"];
export const ESTADOS_TRANSFORMACION = ["OK", "ERROR"];
export const TIPOS_DTO = ["CEI", "CSA"];
export const LIMITE_POR_DEFECTO = 100;
export const LIMITE_MAXIMO = 500;

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Un valor de query puede venir repetido (arreglo): se toma el primero. */
function escalar(valor) {
  return Array.isArray(valor) ? valor[0] : valor;
}

function textoOpcional(valor) {
  const v = escalar(valor);
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  return t === "" ? undefined : t;
}

function fechaValida(texto) {
  if (!FECHA_ISO.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

function fechaOpcional(valor, nombre) {
  const t = textoOpcional(valor);
  if (t === undefined) return undefined;
  if (!fechaValida(t)) throw createError(400, `${nombre} debe tener el formato AAAA-MM-DD.`);
  return t;
}

function opcionDeLista(valor, lista, nombre) {
  const t = textoOpcional(valor);
  if (t === undefined) return undefined;
  const normalizado = t.toUpperCase();
  if (!lista.includes(normalizado))
    throw createError(400, `${nombre} debe ser uno de: ${lista.join(", ")}.`);
  return normalizado;
}

/**
 * @param {object} query  `req.query`
 * @returns {{entorno: string, fecha_desde?: string, fecha_hasta?: string,
 *            status?: string, tipo_dto?: string, co?: string, limite: number}}
 */
export function normalizarFiltrosTransformaciones(query = {}) {
  const q = query || {};
  const entorno = opcionDeLista(q.entorno, ENTORNOS, "entorno") ?? "PROD";
  const fecha_desde = fechaOpcional(q.fecha_desde, "fecha_desde");
  const fecha_hasta = fechaOpcional(q.fecha_hasta, "fecha_hasta");
  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta)
    throw createError(400, "fecha_desde no puede ser posterior a fecha_hasta.");

  const status = opcionDeLista(q.status, ESTADOS_TRANSFORMACION, "status");
  const tipo_dto = opcionDeLista(q.tipo_dto, TIPOS_DTO, "tipo_dto");
  const co = textoOpcional(q.co);

  const bruto = textoOpcional(q.limite);
  let limite = LIMITE_POR_DEFECTO;
  if (bruto !== undefined) {
    const n = Number(bruto);
    if (!Number.isFinite(n)) throw createError(400, "limite debe ser un número.");
    limite = Math.min(Math.max(Math.trunc(n), 1), LIMITE_MAXIMO);
  }

  const filtros = { entorno, limite };
  if (fecha_desde) filtros.fecha_desde = fecha_desde;
  if (fecha_hasta) filtros.fecha_hasta = fecha_hasta;
  if (status) filtros.status = status;
  if (tipo_dto) filtros.tipo_dto = tipo_dto;
  if (co) filtros.co = co;
  return filtros;
}

/**
 * Deja la última corrida por (entorno, fecha). Una fecha puede tener varias corridas
 * (reintentos manuales, ejecuciones repetidas): manda la más reciente por `created_at`,
 * y a igual `created_at`, la de mayor `id`.
 *
 * @param {Array<{entorno: string, fecha: string, created_at?: string, id?: number}>} filas
 * @returns {Array} una fila por (entorno, fecha), ordenadas por fecha descendente.
 */
export function ultimaCorridaPorFecha(filas) {
  const lista = Array.isArray(filas) ? filas : [];
  const mejor = new Map();
  const esMasReciente = (a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    if (ta !== tb) return ta > tb;
    return Number(a.id ?? 0) > Number(b.id ?? 0);
  };
  for (const fila of lista) {
    const clave = `${fila.entorno}|${fila.fecha}`;
    const actual = mejor.get(clave);
    if (!actual || esMasReciente(fila, actual)) mejor.set(clave, fila);
  }
  return [...mejor.values()].sort((a, b) =>
    a.fecha === b.fecha
      ? String(a.entorno).localeCompare(String(b.entorno))
      : a.fecha < b.fecha
        ? 1
        : -1,
  );
}
