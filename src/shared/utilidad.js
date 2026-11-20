/**
 * Utilidad por sede de una preliquidación (forma cerrada, en centavos BigInt).
 *
 *   utilidad = costo teórico - gasto de la sede + (res: vísceras | cerdo: retomas)
 *
 * Las vísceras (res) y las retomas (cerdo) entran SOLO aquí: ni se prorratean ni
 * viajan como gasto del costeo. Solo backend: la API devuelve `utilidad` por sede
 * y el frontend la muestra sin recalcularla.
 *
 * Puro: sin Supabase ni Express.
 */

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
  if (especie !== "res" && especie !== "cerdo") {
    throw new Error(`especie inválida para la utilidad: ${String(especie)}`);
  }
  const aporte = especie === "res" ? valorVicerasCent : valorRetomasCent;
  return costoTeoricoCent - gastoSedeCent + aporte;
}
