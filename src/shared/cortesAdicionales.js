/**
 * Cortes ADICIONALES de una recepción de proveedor: items que el recibidor agrega
 * a mano porque llegaron en la factura pero no están en la plantilla del proveedor.
 *
 * Puro, sin Supabase: `RecepcionProveedor.model.js` lee y escribe, y este módulo
 * decide. Un corte adicional es un renglón más de la recepción (cantidad, valor,
 * devolución, descuento, SIESA, nota crédito…); solo se distingue por `origen`.
 *
 * ─── Decisiones ────────────────────────────────────────────────────────────
 *
 *   · `origen` = 'adicional' marca el renglón; los de la plantilla son 'plantilla'.
 *   · SIN sección (`seccion` = ''), aunque el proveedor trabaje con "Despresado /
 *     Sin despresar" (Bucanero). La sección es una separación visual de la lista de
 *     la plantilla; un corte adicional se muestra aparte, bajo "Cortes adicionales",
 *     y es UN renglón (no se duplica por sección). La llave única de la base
 *     (recepcion_id, equivalencia_id, seccion) no lo toca: `equivalencia_id` es NULL.
 *   · No se puede agregar un corte que YA está en la recepción en cualquier sección
 *     (mismo código + unidad), sea de la plantilla o adicional. Si ya está en la
 *     plantilla, el recibidor lo digita ahí.
 *   · `equivalencia_id` NULL: no viene de la plantilla, así que tampoco hay nombre
 *     de proveedor (`equivalencia` = '').
 */

import { claveCorte } from "./catalogoCortes.js";

export const ORIGEN = Object.freeze({ PLANTILLA: "plantilla", ADICIONAL: "adicional" });

/** Los adicionales quedan después de toda la plantilla (el `orden` de la plantilla es pequeño). */
export const ORDEN_BASE_ADICIONALES = 100000;

export function esAdicional(item) {
  return item?.origen === ORIGEN.ADICIONAL;
}

/**
 * Qué renglón se inserta al agregar `corte` (ya resuelto en el catálogo) a una
 * recepción, o por qué no se puede.
 *
 * @param {{recepcionId: *, items?: object[], corte: {codigo_item: string, descripcion_item: string|null, unidad: string}}} p
 * @returns {{ok: true, fila: object} | {ok: false, status: number, codigo: string, mensaje: string}}
 */
export function planearCorteAdicional({ recepcionId, items = [], corte }) {
  const clave = claveCorte(corte);
  const existente = items.find((i) => claveCorte(i) === clave);
  if (existente) {
    const donde = esAdicional(existente) ? "en los cortes adicionales" : "en la lista de la recepción";
    return {
      ok: false,
      status: 409,
      codigo: "CORTE_YA_EXISTE",
      mensaje: `Ese corte ya está ${donde}.`,
    };
  }
  const adicionales = items.filter(esAdicional).length;
  return {
    ok: true,
    fila: {
      recepcion_id: recepcionId,
      equivalencia_id: null,
      codigo_item: corte.codigo_item,
      descripcion_item: corte.descripcion_item ?? null,
      unidad: corte.unidad,
      equivalencia: "",
      orden: ORDEN_BASE_ADICIONALES + adicionales,
      seccion: "",
      origen: ORIGEN.ADICIONAL,
    },
  };
}

/**
 * Traduce el código que devuelve la función SQL `carnes_quitar_corte_adicional`
 * (sql/029) al resultado que el modelo convierte en error HTTP.
 *
 * @returns {{ok: true} | {ok: false, status: number, codigo: string, mensaje: string}}
 */
export function resultadoQuitarAdicional(codigo) {
  switch (codigo) {
    case "ok":
      return { ok: true };
    case "no_borrador":
      return { ok: false, status: 409, codigo: "RECEPCION_NO_BORRADOR", mensaje: "La recepción ya no está en borrador" };
    case "no_adicional":
      return decidirQuitarAdicional({ origen: ORIGEN.PLANTILLA });
    case "no_recepcion":
      return { ok: false, status: 404, codigo: "RECEPCION_NO_ENCONTRADA", mensaje: "Recepción no encontrada." };
    case "no_item":
      return decidirQuitarAdicional(null);
    default:
      return { ok: false, status: 500, codigo: "RESPUESTA_INESPERADA", mensaje: "No se pudo quitar el corte." };
  }
}

/**
 * ¿Se puede quitar este renglón? Solo un corte adicional de la recepción: los de
 * la plantilla no se quitan (se dejan en 0).
 *
 * @returns {{ok: true} | {ok: false, status: number, codigo: string, mensaje: string}}
 */
export function decidirQuitarAdicional(item) {
  if (!item) {
    return { ok: false, status: 404, codigo: "CORTE_NO_ENCONTRADO", mensaje: "Ese corte no está en esta recepción." };
  }
  if (!esAdicional(item)) {
    return {
      ok: false,
      status: 409,
      codigo: "CORTE_DE_PLANTILLA",
      mensaje: "Solo se pueden quitar los cortes adicionales. Los de la lista se dejan en 0.",
    };
  }
  return { ok: true };
}
