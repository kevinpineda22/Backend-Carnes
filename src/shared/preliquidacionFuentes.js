/**
 * Fuentes de vísceras (res) y retomas (cerdo) por sede para la preliquidación.
 *
 * Todo en centavos BigInt. El producto cantidad x precio se hace exacto (escala
 * 1e6 por factor, 1e12 el producto), se SUMA sin redondear y se redondea una sola
 * vez a centavos (mitad hacia afuera del cero): así coincide con la suma en
 * flotante de `calcularCosteo`/`consolidarLiquidacion`, redondeada a 2 decimales,
 * sin la deriva de miles de renglones.
 *
 * Puro: sin Supabase ni Express.
 */

import { descuentaEnLiquidacion } from "./visceras.js";
import { montoSedes, roundHalfAwayFromZero } from "./preliquidacionCosteo.js";

const ESCALA_FACTOR = 6; // decimales con que se lee cada factor
const ESCALA_PRODUCTO_A_CENTAVOS = 10n ** 10n; // 1e12 (producto) -> 1e2 (centavos)

/** Lee un número/texto como entero escalado a 1e6, sin float en el producto. */
function aEscalado(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0n;
  const texto = typeof valor === "string" ? valor.trim() : n.toFixed(ESCALA_FACTOR);
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(texto);
  if (!m) return 0n;
  const entero = m[2] === "" ? "0" : m[2];
  const fraccion = ((m[3] ?? "") + "0".repeat(ESCALA_FACTOR)).slice(0, ESCALA_FACTOR);
  const v = BigInt(entero) * 10n ** BigInt(ESCALA_FACTOR) + BigInt(fraccion);
  return m[1] === "-" ? -v : v;
}

/** Σ a x b exacta y redondeada UNA vez a centavos. */
function sumaProductosCent(pares) {
  let total = 0n;
  for (const [a, b] of pares) total += aEscalado(a) * aEscalado(b);
  return roundHalfAwayFromZero(total, ESCALA_PRODUCTO_A_CENTAVOS);
}

/**
 * Valor de las vísceras de una recepción de res que descuentan en la liquidación:
 * la misma lista de `consolidarLiquidacion` (`tipo === "vicera"` y
 * `descuentaEnLiquidacion`), valoradas cantidad x costo_base. Cerdo: 0.
 *
 * @param {{items?: Array}} recepcion
 * @param {"res"|"cerdo"} [especie="res"]
 * @returns {bigint} centavos
 */
export function valorVicerasSede(recepcion, especie = "res") {
  if (especie === "cerdo") return 0n;
  const items = recepcion?.items ?? [];
  const pares = items
    .filter((i) => i.tipo === "vicera" && descuentaEnLiquidacion(i))
    .map((i) => [i.cantidad, i.costo_base]);
  return sumaProductosCent(pares);
}

/**
 * Reparte el valor de las retomas de la preliquidación (cerdo) entre sus sedes en
 * proporción a `sede.animales / animales`, con el mismo redondeo acumulado que
 * `montoSedes`. Res: 0 en todas las sedes.
 *
 * @param {Array<{kilos: *, precio: *}>} retomas
 * @param {Array<{sedeId: *, animales: number, bloqueada?: boolean}>} sedes en orden de vinculación
 * @param {number} animales animales de la preliquidación
 * @param {{especie?: "res"|"cerdo"}} [opciones]
 * @returns {Array<{sedeId: *, valorRetomasCent: bigint}>}
 */
export function valorRetomasSedes(retomas, sedes, animales, { especie = "cerdo" } = {}) {
  const total = especie === "res" ? 0n : sumaProductosCent((retomas ?? []).map((r) => [r.kilos, r.precio]));
  return montoSedes(sedes, { gastoTotalCent: total, animales }).map((s) => ({
    sedeId: s.sedeId,
    valorRetomasCent: s.gastoSedeCent,
  }));
}
