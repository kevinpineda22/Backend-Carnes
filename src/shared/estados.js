/**
 * Máquina de estados de una recepción.
 *
 * Vive en UN solo lugar y es un módulo puro por la misma razón que `costeo.js`:
 * si las transiciones se validaran adentro de cada controlador, en seis meses
 * habría cinco copias diciendo cosas distintas, y la que se olvide de revisar
 * `Enviado_SIESA` va a dejar editar un documento que ya se subió al ERP.
 */

export const ESTADOS = {
  BORRADOR: "Borrador",
  RECIBIDO: "Recibido",
  APROBADO: "Aprobado",
  COSTEADO: "Costeado",
  ENVIADO_SIESA: "Enviado_SIESA",
  RECHAZADO: "Rechazado",
};

/**
 * A dónde puede ir cada estado.
 *
 * Las vueltas atrás están permitidas a propósito, PERO nunca después de SIESA:
 *
 *   · `Recibido → Borrador` no existe. Si el admin ve algo mal, RECHAZA — y el
 *     rechazo deja `motivo_rechazo` escrito. Una vuelta silenciosa a borrador
 *     borraría la razón, y el recibidor volvería a la pantalla sin saber qué
 *     corregir.
 *   · `Aprobado → Recibido` sí, porque aprobar es un clic y equivocarse también.
 *     Todavía no se calculó nada, así que no hay plata que deshacer.
 *   · `Costeado → Aprobado` sí: el admin corrige un gasto de la liquidación y se
 *     vuelve a costear. Es lo normal, no una excepción.
 *   · `Enviado_SIESA` NO SALE A NINGÚN LADO. Es terminal. El documento ya existe
 *     en el ERP; cambiarlo acá crearía dos versiones de la misma entrega, y la
 *     de SIESA —la que vale— seguiría diciendo lo de antes.
 */
const TRANSICIONES = {
  [ESTADOS.BORRADOR]: [ESTADOS.RECIBIDO],
  [ESTADOS.RECIBIDO]: [ESTADOS.APROBADO, ESTADOS.RECHAZADO],
  [ESTADOS.RECHAZADO]: [ESTADOS.BORRADOR],
  [ESTADOS.APROBADO]: [ESTADOS.COSTEADO, ESTADOS.RECIBIDO],
  [ESTADOS.COSTEADO]: [ESTADOS.ENVIADO_SIESA, ESTADOS.APROBADO],
  [ESTADOS.ENVIADO_SIESA]: [],
};

/** Mensaje humano para cada estado, para explicar por qué algo no se puede. */
const PORQUE = {
  [ESTADOS.RECIBIDO]: "ya la cerró el recibidor",
  [ESTADOS.APROBADO]: "ya la aprobó el administrador",
  [ESTADOS.COSTEADO]: "ya tiene el costeo cerrado",
  [ESTADOS.ENVIADO_SIESA]: "ya se subió a SIESA",
  [ESTADOS.RECHAZADO]: "está rechazada",
};

export function esEstadoValido(estado) {
  return Object.values(ESTADOS).includes(estado);
}

/** ¿Se puede pasar de `desde` a `hacia`? */
export function puedeTransicionar(desde, hacia) {
  return (TRANSICIONES[desde] || []).includes(hacia);
}

/**
 * Valida una transición y devuelve el motivo si no se puede.
 *
 * Devuelve `{ ok, motivo }` en vez de lanzar: quien llama decide si es un 409
 * para el cliente o una rama interna. Y el `motivo` es texto que se le puede
 * mostrar a una persona — "no se puede aprobar la recepción porque ya se subió a
 * SIESA" en vez de "transición inválida Enviado_SIESA→Aprobado".
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

/**
 * ¿El recibidor puede tocar cantidades?
 *
 * Solo en borrador. En cuanto cierra, los números quedan congelados: son la
 * prueba de qué llegó, y el admin aprueba sobre eso. Si se pudieran editar
 * después, "aprobado" dejaría de significar nada.
 */
export function puedeEditarCantidades(estado) {
  return estado === ESTADOS.BORRADOR;
}

/** ¿El costeo puede escribir sobre esta recepción? */
export function puedeCostear(estado) {
  return estado === ESTADOS.APROBADO || estado === ESTADOS.COSTEADO;
}
