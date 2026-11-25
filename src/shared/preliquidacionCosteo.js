/**
 * Núcleo monetario de la preliquidación de talleres (res / cerdo).
 *
 * Todo el dinero se maneja en CENTAVOS ENTEROS como BigInt. Postgres entrega los
 * NUMERIC como texto: se parsean con un lector de texto (`aCentavos`), nunca con
 * multiplicaciones en float. El reparto entre sedes usa división entera BigInt
 * redondeando la mitad hacia afuera del cero. Los valores vuelven a la base como
 * NUMERIC(14,2) con `centavosATexto`.
 *
 * Puro: sin Supabase ni Express. Las RPC solo persisten los planes que salen de
 * aquí; la fórmula vive en un único lugar.
 */

import { calcularCosteo } from "./costeo.js";
import { utilidadSede, aporteSede } from "./utilidad.js";

const MENSAJE_VALOR = "valor monetario inválido";

/**
 * Convierte un valor monetario a centavos enteros.
 * Texto/NUMERIC: lee los dígitos sin float; con más de dos decimales redondea la
 * mitad hacia afuera del cero mirando el tercer decimal. Número: se normaliza a
 * 6 decimales antes de leerlo (absorbe el ruido binario de 0.1 + 0.2).
 * @param {string|number|bigint} valor monto en unidades (pesos), no en centavos
 * @returns {bigint}
 */
export function aCentavos(valor) {
  if (typeof valor === "bigint") return valor * 100n;

  let texto;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || Math.abs(valor) >= 1e21) {
      throw new Error(`${MENSAJE_VALOR}: ${String(valor)}`);
    }
    texto = valor.toFixed(6);
  } else if (typeof valor === "string") {
    texto = valor.trim();
  } else {
    throw new Error(`${MENSAJE_VALOR}: ${String(valor)}`);
  }

  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(texto);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) {
    throw new Error(`${MENSAJE_VALOR}: ${JSON.stringify(valor)}`);
  }

  const entero = m[2] === "" ? "0" : m[2];
  const fraccion = m[3] ?? "";
  const dosDecimales = (fraccion + "00").slice(0, 2);
  let centavos = BigInt(entero) * 100n + BigInt(dosDecimales);
  if (fraccion.length > 2 && fraccion[2] >= "5") centavos += 1n; // magnitud: la mitad se aleja de cero
  return m[1] === "-" ? -centavos : centavos;
}

/** Centavos -> texto NUMERIC(14,2) con siempre dos decimales (`"-1234.56"`). */
export function centavosATexto(centavos) {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = abs / 100n;
  const resto = (abs % 100n).toString().padStart(2, "0");
  return `${negativo ? "-" : ""}${entero}.${resto}`;
}

/**
 * División entera `numerador / divisor` redondeando la mitad hacia afuera del cero.
 * @param {bigint} numerador
 * @param {bigint} divisor distinto de cero
 * @returns {bigint}
 */
export function roundHalfAwayFromZero(numerador, divisor) {
  if (divisor === 0n) throw new Error("divisor cero en el redondeo");
  const negativo = numerador < 0n !== divisor < 0n;
  const a = numerador < 0n ? -numerador : numerador;
  const b = divisor < 0n ? -divisor : divisor;
  const q = (2n * a + b) / (2n * b);
  return negativo ? -q : q;
}

function aBigIntEntero(valor, nombre) {
  if (typeof valor === "bigint") return valor;
  if (Number.isInteger(valor)) return BigInt(valor);
  throw new Error(`${nombre} debe ser un entero de centavos (bigint)`);
}

/**
 * Reparte el gasto total entre las sedes con redondeo acumulado, en el orden de
 * vinculación recibido: `acumCent_i = round(acumAnimales_i x gasto / animales)` y
 * `gastoSede_i = acumCent_i - (lo ya asignado)`. No hay una sede que absorba el
 * residuo: cada sede tiene su monto determinista y, con la vinculación completa,
 * la suma es exactamente el gasto total.
 *
 * - Las sedes `bloqueada` no consumen animales ni reciben monto (no salen en el
 *   resultado).
 * - Una sede ya enviada llega con `gastoSedeCentFijo` y conserva su monto aunque
 *   el gasto total haya cambiado; las no enviadas absorben la diferencia porque
 *   el objetivo acumulado se descuenta de lo realmente asignado.
 *
 * @param {Array<{sedeId: *, animales: number, bloqueada?: boolean, gastoSedeCentFijo?: bigint|null}>} sedesOrdenadas
 * @param {{gastoTotalCent: bigint, animales: number}} opciones
 * @returns {Array<{sedeId: *, acumulado: number, gastoSedeCent: bigint}>}
 */
export function montoSedes(sedesOrdenadas, { gastoTotalCent, animales }) {
  const total = aBigIntEntero(gastoTotalCent, "gastoTotalCent");
  if (!Number.isInteger(animales) || animales <= 0) {
    throw new Error(`animales de la preliquidación debe ser un entero > 0: ${animales}`);
  }

  const resultado = [];
  let acumulado = 0;
  let asignado = 0n;

  for (const s of sedesOrdenadas) {
    if (s.bloqueada) continue;
    if (!Number.isInteger(s.animales) || s.animales <= 0) {
      throw new Error(`animales de la sede ${s.sedeId} debe ser un entero > 0: ${s.animales}`);
    }
    acumulado += s.animales;
    if (acumulado > animales) {
      throw new Error(`las sedes vinculadas (${acumulado}) excede los animales de la preliquidación (${animales})`);
    }

    let gastoSedeCent;
    if (s.gastoSedeCentFijo != null) {
      gastoSedeCent = aBigIntEntero(s.gastoSedeCentFijo, "gastoSedeCentFijo");
    } else {
      const objetivo = roundHalfAwayFromZero(BigInt(acumulado) * total, BigInt(animales));
      gastoSedeCent = objetivo - asignado;
    }
    asignado += gastoSedeCent;
    resultado.push({ sedeId: s.sedeId, acumulado, gastoSedeCent });
  }
  return resultado;
}

// ─── Gasto total de la preliquidación ──────────────────────────────────────

/**
 * Servicio precorte efectivo en centavos, o `null` si no cuenta como cargado.
 * M3: un precorte <= 0 se trata como no cargado; si no, un 0 (o negativo) bloquearía
 * la preliquidación por `servicio_cero` aun con predeterminado > 0, y
 * `desbloqueaServicioCero` no podría destrabarla. Se usa en `gastoTotal` y en
 * `desbloqueaServicioCero` para que ambos decidan igual en toda combinación.
 * El SQL de `carnes_preliq_actualizar_servicio` debe revalidar con el mismo
 * criterio (`COALESCE(servicio_precorte, 0) <= 0`).
 */
function precorteEfectivoCent(servicioPrecorte) {
  if (servicioPrecorte == null) return null;
  const cent = aCentavos(servicioPrecorte);
  return cent > 0n ? cent : null;
}

/** Servicio predeterminado por animal en centavos; un valor negativo no es un servicio válido (0). */
function porAnimalEfectivoCent(servicioPorAnimal) {
  const cent = aCentavos(servicioPorAnimal);
  return cent > 0n ? cent : 0n;
}

/**
 * Única implementación de la fórmula del gasto total (el plan de
 * `carnes_preliq_liquidar` sale de aquí; plpgsql no repite la fórmula):
 *
 *   servicioAplicado = servicioPrecorte (si > 0) ?? servicioPorAnimal x animales
 *   gastoTotal       = animalEnPie + servicioAplicado + Σ gastos (signo) + Σ saldos pendientes
 *
 * Entradas NUMERIC como texto/número en pesos; salidas en centavos BigInt.
 * `saldos` debe traer solo los dirigidos a esta preliquidación; se ignoran los
 * que declaran un estado distinto de `pendiente`.
 *
 * @returns {{servicioAplicadoCent: bigint, gastoTotalCent: bigint, costoPorAnimalCent: bigint,
 *   saldoIds: Array<*>, bloqueo?: "servicio_cero", plan: object}}
 */
export function gastoTotal({ animalEnPie, servicioPrecorte, servicioPorAnimal, animales, gastos = [], saldos = [] }) {
  if (!Number.isInteger(animales) || animales <= 0) {
    throw new Error(`animales de la preliquidación debe ser un entero > 0: ${animales}`);
  }

  const precorte = precorteEfectivoCent(servicioPrecorte);
  const servicioAplicadoCent =
    precorte !== null ? precorte : porAnimalEfectivoCent(servicioPorAnimal) * BigInt(animales);

  let total = aCentavos(animalEnPie) + servicioAplicadoCent;
  for (const g of gastos) total += aCentavos(g.valor) * BigInt(g.signo);

  const saldoIds = [];
  for (const s of saldos) {
    if (s.estado !== undefined && s.estado !== "pendiente") continue;
    total += aCentavos(s.valor);
    saldoIds.push(s.id);
  }

  const costoPorAnimalCent = roundHalfAwayFromZero(total, BigInt(animales));
  const resultado = {
    servicioAplicadoCent,
    gastoTotalCent: total,
    costoPorAnimalCent,
    saldoIds,
    plan: {
      servicio_aplicado: centavosATexto(servicioAplicadoCent),
      gasto_total: centavosATexto(total),
      costo_por_animal: centavosATexto(costoPorAnimalCent),
      saldo_ids: saldoIds,
    },
  };
  if (servicioAplicadoCent === 0n) resultado.bloqueo = "servicio_cero";
  return resultado;
}

/**
 * ¿Cargar un servicio real desbloquea una preliquidación bloqueada por
 * `servicio_cero`? Solo si aún no se liquidó, no hay servicio precorte y el
 * predeterminado por animal es 0. Va como `p_desbloqueo` al PATCH de servicio.
 */
export function desbloqueaServicioCero({ liquidadaAt, servicioPrecorte, servicioPorAnimal }) {
  if (liquidadaAt) return false;
  return precorteEfectivoCent(servicioPrecorte) === null && porAnimalEfectivoCent(servicioPorAnimal) === 0n;
}

// ─── Costeo de una sede ────────────────────────────────────────────────────

const centavosAPesos = (centavos) => Number(centavosATexto(centavos));

/**
 * Costeo de una sede de la preliquidación. Envuelve `calcularCosteo` sin tocarlo:
 *
 *   1. costo teórico = `calcularCosteo` con `bonificacionViceras = false` (solo se
 *      lee `costoTeorico`), llevado a centavos.
 *   2. utilidad = `utilidadSede` (forma cerrada; suma el aporte: vísceras en res,
 *      retomas en cerdo).
 *   3. servicio de compra = utilidad / 2, una sola vez, mitad hacia afuera del cero.
 *   4. UNA pasada final de `calcularCosteo` con
 *        costo real = gasto de sede + servicio de compra - aporte
 *      y `bonificacionViceras = false`; esos renglones son los que se congelan y
 *      se envían. El aporte vuelve a bajar el costo de los cortes, como en el flujo
 *      legado (servicio de compra cargado a mano y vísceras/"Retomas" restadas del
 *      costo real). Algebraicamente el costo final total es
 *      (gasto + teórico - aporte) / 2.
 *
 * Bloqueos: utilidad < 0 -> `utilidad_negativa`; la advertencia
 * `factor_anula_costos` de la pasada final -> `costeo_invalido` (cubre también un
 * costo real <= 0 por un aporte desproporcionado, que da factor >= 1).
 *
 * @param {object} p
 * @param {Array} p.items renglones de carne `{cantidad, costo_base, ...}`
 * @param {bigint} p.gastoSedeCent gasto asignado a la sede (de `montoSedes`)
 * @param {"res"|"cerdo"} p.especie
 * @param {bigint} [p.valorVicerasCent]
 * @param {bigint} [p.valorRetomasCent]
 */
export function costearSede({ items, gastoSedeCent, especie, valorVicerasCent = 0n, valorRetomasCent = 0n }) {
  const gastoSede = aBigIntEntero(gastoSedeCent, "gastoSedeCent");

  const teorico = calcularCosteo({ items, gastos: [], bonificacionViceras: false });
  const costoTeoricoCent = aCentavos(teorico.costoTeorico);

  const utilidadCent = utilidadSede({
    especie,
    costoTeoricoCent,
    gastoSedeCent: gastoSede,
    valorVicerasCent,
    valorRetomasCent,
  });
  const servicioCompraCent = roundHalfAwayFromZero(utilidadCent, 2n);

  const aporteCent = aporteSede({ especie, valorVicerasCent, valorRetomasCent });
  const costoRealCent = gastoSede + servicioCompraCent - aporteCent;

  const costeoFinal = calcularCosteo({
    items,
    gastos: [
      {
        concepto: "Gasto de sede y servicio de compra, menos vísceras/retomas",
        valor: centavosAPesos(costoRealCent),
      },
    ],
    bonificacionViceras: false,
  });

  const bloqueos = [];
  if (utilidadCent < 0n) {
    bloqueos.push({
      motivo: "utilidad_negativa",
      detalle: `La utilidad de la sede es negativa (${centavosATexto(utilidadCent)}).`,
    });
  }
  const anula = costeoFinal.advertencias.find((a) => a.codigo === "factor_anula_costos");
  if (anula) bloqueos.push({ motivo: "costeo_invalido", detalle: anula.mensaje });

  return {
    costoTeoricoCent,
    utilidadCent,
    servicioCompraCent,
    costeoFinal,
    bloqueos,
    plan: {
      gasto_sede: centavosATexto(gastoSede),
      utilidad: centavosATexto(utilidadCent),
      servicio_compra: centavosATexto(servicioCompraCent),
      valor_viceras: centavosATexto(especie === "res" ? valorVicerasCent : 0n),
      valor_retomas: centavosATexto(especie === "cerdo" ? valorRetomasCent : 0n),
    },
  };
}
