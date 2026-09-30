/**
 * Máquina de estados de una recepción de PROVEEDOR.
 *
 * Gemela de `estados.js` (misma API) pero independiente: las recepciones de
 * proveedor viven en sus propias tablas y NUNCA tocan Talleres, costeo ni
 * liquidaciones. Mezclar los dos grafos en un solo módulo haría que un estado
 * nuevo de uno cambie lo que se permite en el otro.
 */

export const ESTADOS = {
  BORRADOR: "Borrador",
  FINALIZADA: "Finalizada",
  ENVIADA_SIESA: "Enviada_SIESA",
  ANULADA: "Anulada",
};

/**
 * A dónde puede ir cada estado.
 *
 *   · `Borrador → Finalizada` es la firma. No hay vuelta atrás: con la firma los
 *     renglones quedan congelados (son la prueba de qué llegó). Un borrador no se
 *     anula, se DESCARTA (se borra), porque nunca tuvo efecto fuera de acá.
 *   · `Finalizada → Enviada_SIESA` cuando la entrada CEA queda ok.
 *   · `Finalizada` y `Enviada_SIESA` salen SOLO a `Anulada`. Desde `Enviada_SIESA`
 *     el admin anula después de que una persona anuló el documento en SIESA; sin
 *     eso, dos versiones de la misma factura. `Anulada` libera la clave de
 *     factura (se puede volver a recibir) y es terminal.
 */
const TRANSICIONES = {
  [ESTADOS.BORRADOR]: [ESTADOS.FINALIZADA],
  [ESTADOS.FINALIZADA]: [ESTADOS.ENVIADA_SIESA, ESTADOS.ANULADA],
  [ESTADOS.ENVIADA_SIESA]: [ESTADOS.ANULADA],
  [ESTADOS.ANULADA]: [],
};

/** Mensaje humano para cada estado, para explicar por qué algo no se puede. */
const PORQUE = {
  [ESTADOS.FINALIZADA]: "ya la firmó el recibidor",
  [ESTADOS.ENVIADA_SIESA]: "ya se subió a SIESA",
  [ESTADOS.ANULADA]: "está anulada",
};

export function esEstadoValido(estado) {
  return Object.values(ESTADOS).includes(estado);
}

/** ¿Se puede pasar de `desde` a `hacia`? */
export function puedeTransicionar(desde, hacia) {
  return Object.hasOwn(TRANSICIONES, desde) && TRANSICIONES[desde].includes(hacia);
}

/**
 * Valida una transición y devuelve el motivo si no se puede. `{ ok, motivo }` en
 * vez de lanzar: quien llama decide si es un 409 o una rama interna.
 *
 * @returns {{ok: boolean, motivo: string|null}}
 */
export function validarTransicion(desde, hacia) {
  if (!esEstadoValido(desde)) {
    return { ok: false, motivo: `Estado actual desconocido: "${desde}".` };
  }
  if (!esEstadoValido(hacia)) {
    return { ok: false, motivo: `Estado destino desconocido: "${hacia}".` };
  }
  if (desde === hacia) {
    return { ok: false, motivo: `La recepción ya está en "${desde}".` };
  }
  if (puedeTransicionar(desde, hacia)) return { ok: true, motivo: null };

  const explicacion = PORQUE[desde];
  return {
    ok: false,
    motivo: explicacion
      ? `No se puede pasar a "${hacia}": la recepción ${explicacion}.`
      : `No se puede pasar de "${desde}" a "${hacia}".`,
  };
}

/** ¿Se pueden tocar cantidades, valores y devoluciones? Solo en borrador. */
export function puedeEditarCantidades(estado) {
  return estado === ESTADOS.BORRADOR;
}

/** ¿Se puede descartar (borrar)? Solo un borrador: después de firmar solo se anula. */
export function puedeDescartar(estado) {
  return estado === ESTADOS.BORRADOR;
}

/** ¿Ya la firmó el recibidor? (Finalizada o Enviada_SIESA): un reintento de finalizar no vuelve a firmar. */
export function estaFirmada(estado) {
  return estado === ESTADOS.FINALIZADA || estado === ESTADOS.ENVIADA_SIESA;
}

/** ¿El admin puede anularla? Finalizada o Enviada_SIESA (esta última, tras anular en SIESA). */
export function puedeAnular(estado) {
  return puedeTransicionar(estado, ESTADOS.ANULADA);
}

/**
 * ¿Se puede (re)enviar la entrada a SIESA, o corregir la referencia de factura?
 * Solo Finalizada: en Enviada_SIESA ya hay un documento en el ERP.
 */
export function puedeEnviarASiesa(estado) {
  return estado === ESTADOS.FINALIZADA;
}
