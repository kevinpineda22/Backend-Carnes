/**
 * Qué significa un QR de sede, una vez que se buscó su token en la base.
 *
 * Puro, sin Supabase, para poder testear la regla que decide si se abre una
 * recepción: la búsqueda del token vive en `Sede.model.verificarQr`, la
 * decisión vive acá.
 *
 *   · `desconocido`   el token no existe (QR de otra cosa, o uno revocado).
 *   · `sede_inactiva` es de una sede dada de baja.
 *   · `sede_distinta` es válido pero de OTRA sede que la pedida. Solo puede
 *                     pasar si se pidió una: el front viejo la hacía elegir.
 *   · `ok`            es la sede. Sin sede pedida, el QR ES la sede: el token
 *                     es único por sede, así que no hay nada contra qué
 *                     compararlo.
 *
 * @param {{ id, activo } | null} sede   la fila de la sede del token, o null
 * @param {number|string|null|undefined} sedePedida
 * @returns {{ estado: string, sede: object|null }}
 */
export function evaluarQr(sede, sedePedida) {
  if (!sede) return { estado: "desconocido", sede: null };
  if (!sede.activo) return { estado: "sede_inactiva", sede };
  if (sedePedida != null && String(sede.id) !== String(sedePedida)) {
    return { estado: "sede_distinta", sede };
  }
  return { estado: "ok", sede };
}
