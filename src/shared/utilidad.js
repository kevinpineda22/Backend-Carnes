/**
 * Utilidad por sede de una preliquidación (forma cerrada, en centavos BigInt).
 *
 *   utilidad = costo teórico - gasto de la sede + (res: vísceras | cerdo: retomas)
 *
 * Las vísceras (res) y las retomas (cerdo) entran en la utilidad (y por ende en
 * el servicio de compra = utilidad / 2) y, además, REDUCEN el costo real que se
 * distribuye en la pasada final de `costearSede`:
 *
 *   costo real = gasto de sede + servicio de compra - aporte
 *
 * Reproduce el flujo legado, donde el encargado cargaba el servicio de compra a
 * mano y la bonificación de vísceras (res) / el gasto derivado "Retomas" (cerdo)
 * se restaban del costo real. `aporteSede` es la única fuente de esa selección.
 * Solo backend: la API devuelve `utilidad` por sede y el frontend la muestra sin
 * recalcularla.
 *
 * Puro: sin Supabase ni Express.
 */

/**
 * Aporte de la sede: vísceras en res, retomas en cerdo (el otro se ignora).
 * @returns {bigint} aporte en centavos
 */
export function aporteSede({ especie, valorVicerasCent = 0n, valorRetomasCent = 0n }) {
  if (especie !== "res" && especie !== "cerdo") {
    throw new Error(`especie inválida para la utilidad: ${String(especie)}`);
  }
  return especie === "res" ? valorVicerasCent : valorRetomasCent;
}

/**
 * @param {object} p
 * @param {"res"|"cerdo"} p.especie
 * @param {bigint} p.costoTeoricoCent
 * @param {bigint} p.gastoSedeCent
 * @param {bigint} [p.valorVicerasCent] solo cuenta en res
 * @param {bigint} [p.valorRetomasCent]  solo cuenta en cerdo
 * @returns {bigint} utilidad en centavos
 */
export function utilidadSede({
  especie,
  costoTeoricoCent,
  gastoSedeCent,
  valorVicerasCent = 0n,
  valorRetomasCent = 0n,
}) {
  const aporte = aporteSede({ especie, valorVicerasCent, valorRetomasCent });
  return costoTeoricoCent - gastoSedeCent + aporte;
}
