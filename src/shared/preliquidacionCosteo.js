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
