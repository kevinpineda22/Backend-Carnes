/**
 * Catálogo de cortes (items de SIESA) que se pueden AGREGAR a mano: a la plantilla
 * de un proveedor (admin) o a una recepción en borrador (recibidor).
 *
 * Puro, sin Supabase: `Catalogo.model.js` lee las tablas y este módulo une, filtra
 * y ordena lo leído. No hay un maestro de items de SIESA en este backend (ver el
 * encabezado de `plantillaProveedor.js`), así que el catálogo es la UNIÓN de lo
 * que el sistema ya conoce, en este orden de prioridad:
 *
 *   1. `carnes_plantilla_items`          — cortes de res y cerdo (unidad KL).
 *   2. `carnes_viceras_items`            — vísceras que tienen código de SIESA.
 *   3. `carnes_proveedor_equivalencias`  — lo que ya está en las plantillas de
 *                                          cualquier proveedor (con su unidad).
 *
 * La llave de un corte es (codigo_item, unidad): el mismo código puede venir en
 * KL y en UND. Si dos fuentes traen la misma llave gana la de mayor prioridad
 * (descripciones más limpias). Solo entran unidades KL / UND: lo demás no puede
 * viajar a SIESA (ver `validarRenglon`).
 */

import { normalizarUnidad, unidadValida } from "./proveedorValores.js";

export const LARGO_MIN_BUSQUEDA = 2;
export const LARGO_MAX_DESCRIPCION = 160;
export const LARGO_MAX_BUSQUEDA = 60;
export const LIMITE_BUSQUEDA = 30;
/** Filas que se piden a CADA tabla antes de unir: las plantillas repiten el mismo item por proveedor. */
export const FILAS_POR_FUENTE = 200;

/**
 * Deja el texto de búsqueda apto para un filtro `ilike` de PostgREST: solo letras,
 * números, espacio, punto, guion y barra. Quita comodines (`%`, `_`, `*`) y los
 * separadores del filtro `or` (coma, paréntesis, dos puntos), que de otro modo
 * cambiarían la consulta.
 */
export function normalizarBusqueda(texto) {
  return String(texto ?? "")
    .replace(/[^\p{L}\p{N} .\-/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LARGO_MAX_BUSQUEDA);
}

export function busquedaValida(texto) {
  return normalizarBusqueda(texto).length >= LARGO_MIN_BUSQUEDA;
}

/** Llave de un corte: código (recortado) + unidad canónica. */
export function claveCorte({ codigo_item, unidad } = {}) {
  return `${String(codigo_item ?? "").trim()}|${normalizarUnidad(unidad)}`;
}

function aCorte(codigo, descripcion, unidad) {
  const codigo_item = String(codigo ?? "").trim();
  const u = normalizarUnidad(unidad);
  if (!codigo_item || !unidadValida(u)) return null;
  // `descripcion_item` es VARCHAR(160): más largo rompería el INSERT.
  const texto = String(descripcion ?? "").trim().slice(0, LARGO_MAX_DESCRIPCION).trimEnd();
  return { codigo_item, descripcion_item: texto || null, unidad: u };
}

/** Qué tan bien calza el corte con la búsqueda (menor = mejor): código exacto, código o descripción que empieza, contiene. */
function puntaje(corte, q) {
  const t = q.toLowerCase();
  const codigo = corte.codigo_item.toLowerCase();
  const desc = (corte.descripcion_item ?? "").toLowerCase();
  if (codigo === t) return 0;
  if (codigo.startsWith(t)) return 1;
  if (desc.startsWith(t)) return 2;
  return 3;
}

/**
 * Une las tres fuentes en una lista sin repetidos. Con `q` ordena por qué tan bien
 * calza y después por descripción; sin `q` solo por descripción.
 *
 * @param {{plantilla?: object[], viceras?: object[], equivalencias?: object[]}} fuentes
 * @param {{q?: string, limite?: number}} [opciones]
 * @returns {{codigo_item: string, descripcion_item: string|null, unidad: string}[]}
 */
export function unirCatalogo(
  { plantilla = [], viceras = [], equivalencias = [] } = {},
  { q = "", limite = LIMITE_BUSQUEDA } = {},
) {
  const candidatos = [
    ...plantilla.map((f) => aCorte(f?.codigo_item, f?.descripcion, "KL")),
    ...viceras.map((f) => aCorte(f?.codigo_item, f?.nombre, f?.unidad || "KL")),
    ...equivalencias.map((f) => aCorte(f?.codigo_item, f?.descripcion_item, f?.unidad)),
  ];
  const vistos = new Map();
  for (const c of candidatos) {
    if (c && !vistos.has(claveCorte(c))) vistos.set(claveCorte(c), c);
  }
  const texto = normalizarBusqueda(q);
  const lista = [...vistos.values()];
  lista.sort(
    (a, b) =>
      (texto ? puntaje(a, texto) - puntaje(b, texto) : 0) ||
      String(a.descripcion_item ?? "").localeCompare(String(b.descripcion_item ?? ""), "es") ||
      a.codigo_item.localeCompare(b.codigo_item),
  );
  return lista.slice(0, limite);
}

/** El corte exacto (código + unidad) dentro de lo que devolvieron las fuentes, o null. */
export function buscarCorteExacto(fuentes, { codigo_item, unidad } = {}) {
  const clave = claveCorte({ codigo_item, unidad });
  return unirCatalogo(fuentes, { limite: Number.MAX_SAFE_INTEGER }).find((c) => claveCorte(c) === clave) ?? null;
}

/**
 * El corte que el usuario ELIGIÓ en la búsqueda. La búsqueda filtra cada fuente por
 * el texto escrito, así que la descripción que se ve puede ser la de una fila que el
 * dedupe de la lista completa descartaría (mismo código y unidad, otra descripción:
 * p. ej. dos filas de la plantilla con el código 15167). Si el cliente manda la
 * descripción que vio y es de ALGUNA fila del catálogo con esa llave, se respeta; si
 * no calza con ninguna (cliente viejo, texto inventado) gana la de mayor prioridad,
 * como en `buscarCorteExacto`. El código y la unidad siempre salen del catálogo.
 */
export function elegirCorte(fuentes, { codigo_item, unidad, descripcion_item } = {}) {
  const exacto = buscarCorteExacto(fuentes, { codigo_item, unidad });
  if (!exacto) return null;
  const pedida = String(descripcion_item ?? "").trim().slice(0, LARGO_MAX_DESCRIPCION).trimEnd();
  if (!pedida || pedida === exacto.descripcion_item) return exacto;
  const { plantilla = [], viceras = [], equivalencias = [] } = fuentes ?? {};
  const clave = claveCorte({ codigo_item, unidad });
  const coincide = [
    ...plantilla.map((f) => aCorte(f?.codigo_item, f?.descripcion, "KL")),
    ...viceras.map((f) => aCorte(f?.codigo_item, f?.nombre, f?.unidad || "KL")),
    ...equivalencias.map((f) => aCorte(f?.codigo_item, f?.descripcion_item, f?.unidad)),
  ].find((c) => c && claveCorte(c) === clave && c.descripcion_item === pedida);
  return coincide ?? exacto;
}
