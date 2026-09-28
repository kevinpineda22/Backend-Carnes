/**
 * Reglas puras de borrado para el admin: cuándo una recepción o un envío a
 * SIESA se pueden borrar DE VERDAD, en vez de solo cambiar de estado.
 *
 * Viven separadas de los modelos —igual que `estados.js`— porque la pregunta
 * "¿esto se puede borrar?" tiene que responderse igual en el backend (que
 * manda) y en el front (que solo muestra el botón). Si la regla se escribiera
 * dos veces, un día alguna de las dos se olvida de un caso, y ese caso es
 * plata real: producción manda automáticamente una INICIAL a SIESA al cerrar
 * cada recepción, y hay liquidaciones oficiales de por medio.
 */

import { ESTADOS } from "./estados.js";

/**
 * ¿Se puede borrar esta recepción?
 *
 * NO es `descartar` (eso es solo para Borrador — ver Recepcion.model.js): esto
 * es para una recepción YA CERRADA que el admin identificó como prueba o carga
 * de más. Las condiciones son todas necesarias, y cada una dice por sí sola
 * por qué no se puede:
 *
 *   Borrador                 es de `descartar`, no de acá.
 *   Costeado / Enviado_SIESA ya movió plata o ya está en el ERP.
 *   liquidacion_id           vinculada a una liquidación: hay que sacarla de
 *                            ahí primero, o el consolidado de esa liquidación
 *                            queda corriendo sobre una recepción que ya no
 *                            existe.
 *   envío oficial            una oficial —de CUALQUIER estado, hasta un
 *                            "error"— es la prueba de que esta recepción
 *                            (sola o dentro de una CEA consolidada) SE
 *                            INTENTÓ subir al ERP. Borrarla de acá no la
 *                            borra de SIESA.
 *   envío sin resolver       `enviando` o `sin_confirmar`: SIESA puede
 *                            haberlo creado y todavía no se sabe. Mejor
 *                            trabado que borrado a ciegas.
 *
 * @param {{
 *   estado: string,
 *   liquidacion_id: number|string|null,
 *   envios?: {tipo: string, estado: string}[],
 * }} p  `envios` son los de esta recepción, directos (recepcion_id) y los de
 *       la CEA consolidada que la incluye (recepcion_ids) — ver
 *       `SiesaEnvio.model.js#enviosDeRecepcion`.
 * @returns {{ok: boolean, motivo: string|null}}
 */
export function puedeEliminarRecepcion({ estado, liquidacion_id, envios = [] }) {
  if (estado === ESTADOS.BORRADOR) {
    return {
      ok: false,
      motivo: 'Es un borrador: usá "Descartar" en vez de eliminar.',
    };
  }
  if (estado === ESTADOS.COSTEADO) {
    return {
      ok: false,
      motivo: "Ya está costeada: no se puede eliminar una recepción que movió plata.",
    };
  }
  if (estado === ESTADOS.ENVIADO_SIESA) {
    return {
      ok: false,
      motivo: "Ya se subió a SIESA: no se puede eliminar, ese documento ya existe en el ERP.",
    };
  }
  if (liquidacion_id) {
    return {
      ok: false,
      motivo: "Está vinculada a una liquidación: desvinculala primero.",
    };
  }
  const oficial = envios.find((e) => e.tipo === "oficial");
  if (oficial) {
    return {
      ok: false,
      motivo:
        "Tiene una entrada oficial en SIESA (o se intentó mandar una): anulala allá antes de eliminar acá.",
    };
  }
  const sinResolver = envios.find((e) => ["enviando", "sin_confirmar"].includes(e.estado));
  if (sinResolver) {
    return {
      ok: false,
      motivo: `Tiene un envío a SIESA sin resolver (${sinResolver.estado}). Resolvelo desde el panel de envíos antes de eliminar.`,
    };
  }
  return { ok: true, motivo: null };
}

/**
 * ¿Se puede borrar este envío a SIESA?
 *
 * Solo `error`: un envío que falló no llegó a crear nada en SIESA, así que
 * borrar la fila no deja un documento huérfano allá. Cualquier otro estado
 * significa que SIESA lo tiene (`ok`), puede tenerlo (`enviando`,
 * `sin_confirmar`) o ya se resolvió como tal (`anulado`, `duplicado`) — borrar
 * la fila en esos casos borraría el rastro sin borrar el documento en SIESA.
 *
 * No toca el candado de sql/010: ese índice único solo cubre
 * `enviando`/`ok`/`sin_confirmar`, así que un `error` nunca lo ocupa y
 * borrarlo no destraba ni traba nada.
 *
 * @param {{estado: string}} p
 * @returns {{ok: boolean, motivo: string|null}}
 */
export function puedeEliminarEnvio({ estado }) {
  if (estado === "error") return { ok: true, motivo: null };
  if (["enviando", "sin_confirmar"].includes(estado)) {
    return {
      ok: false,
      motivo: `Este envío está "${estado}": resolvelo desde el panel antes de borrarlo.`,
    };
  }
  return {
    ok: false,
    motivo: `Este envío ya está en SIESA (o lo estuvo): borrar la fila no anula el documento. Estado: "${estado}".`,
  };
}
