/**
 * Reglas puras del Recibidor de Proveedores (factura de un proveedor recibida en
 * una sede): plata, unidades, confirmaciones y validación de renglones.
 *
 * El BACKEND es la autoridad: recalcula la plata en cada guardado y al
 * finalizar, e ignora cualquier cálculo del cliente. El gemelo del frontend
 * (`Pagina-web_React/src/pages/Carnes/utils/valoresProveedor.js`) es solo vista
 * previa. Los dos tests comparten el MISMO arreglo `CASOS`: si se cambia una
 * regla acá, se cambia allá, o el test del gemelo deja de coincidir.
 *
 * Módulo PURO, como `costeo.js` y `visceras.js`: sin Supabase, sin Express.
 *
 * ─── Plata ─────────────────────────────────────────────────────────────────
 *
 * Valores brutos: sin IVA ni descuentos (decisión del negocio). El recibidor
 * digita cantidad + (valor unitario O valor total); el otro se deriva.
 *
 *   · fuente = unitario → total = round(cantidad × unitario) (pesos enteros)
 *   · fuente = total    → unitario = total ÷ cantidad a 4 decimales; el total
 *                         que viaja a SIESA sigue siendo el digitado
 *
 * El texto de plata se interpreta con `parsearPesos`: el punto SOLO separa miles
 * y la coma SOLO separa decimales. Sin esa regla "20.000" sería 20 (veinte) y se
 * mandaría a SIESA una entrada 1000 veces más chica, sin revisión humana.
 */

import { ajustarCantidadAUnidad } from "./visceras.js";

/** Por encima de esto, un renglón en KL pide confirmación (por renglón, no suma del documento). */
export const UMBRAL_KL = 800;

/** PENDIENTE de SIESA admite 12 caracteres: más largo se bloquea el envío, nunca se recorta. */
export const LARGO_FACTURA_SIESA = 12;

export const UNIDADES_VALIDAS = ["KL", "UND"];

/**
 * Rango de valor unitario "esperado" por KL/UND. Fuera de él (estrictamente
 * menor o mayor) el renglón pide confirmación guardada, igual que los 800 KL:
 * la entrada a SIESA sale sola al finalizar y digitar "20" por "20.000" sería
 * un documento contable 1000 veces equivocado. Constantes aparte para poder
 * afinarlas sin tocar la lógica.
 */
export const VALOR_UNITARIO_MIN = 1000;
export const VALOR_UNITARIO_MAX = 150000;

/**
 * Topes que imponen las columnas (sql/022), exclusivos: un valor igual o mayor
 * ya no cabe. NUMERIC(12,3) cantidad, NUMERIC(16,4) unitario, NUMERIC(16,2)
 * total. Sin este chequeo, un valor digitado bien pero MULTIPLICADO por una
 * cantidad grande rompe el guardado con un error de base de datos ilegible.
 */
export const LIMITE_CANTIDAD = 1e9;
export const LIMITE_UNITARIO = 1e12;
export const LIMITE_TOTAL = 1e14;

export const MENSAJE_PESOS = "Usá punto para miles y coma para decimales";

/** Redondeo a `n` decimales, evitando la basura de punto flotante. */
function redondear(valor, n) {
  return Number(valor.toFixed(n));
}

/** null, undefined, "" o solo espacios. `Number(" ")` da 0, y eso no es "vacío". */
function esVacio(valor) {
  return valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "");
}

/** Vacío es 0; lo no numérico da NaN para que el llamador lo marque. */
function aNumero(valor) {
  return esVacio(valor) ? 0 : Number(valor);
}

/** Como `aNumero`, pero vacío es `null`: "no hay valor" no es lo mismo que "valor 0". */
function aNumeroONull(valor) {
  return esVacio(valor) ? null : Number(valor);
}

function esNumeroValido(n) {
  return Number.isFinite(n) && n >= 0;
}

// ─── Unidades ──────────────────────────────────────────────────────────────

/**
 * Deja la unidad en su forma canónica. `KG/KGS/KILO` → `KL` y `UN/UNIDAD` →
 * `UND`, porque así las escriben los Excel de los proveedores. Cualquier otra
 * cosa vuelve tal cual (recortada, en mayúsculas) y `unidadValida` la marca:
 * una unidad que no se sabe mapear NO se adivina, se bloquea hasta homologarla.
 */
export function normalizarUnidad(unidad) {
  const u = String(unidad ?? "").trim().toUpperCase();
  if (u === "KG" || u === "KGS" || u === "KILO") return "KL";
  if (u === "UN" || u === "UNIDAD") return "UND";
  return u;
}

export function unidadValida(unidad) {
  return UNIDADES_VALIDAS.includes(normalizarUnidad(unidad));
}

/**
 * La cantidad tal como se GUARDA y se manda a SIESA: los mismos decimales que
 * el builder (`ajustarCantidadAUnidad`), para que lo guardado y lo enviado sean
 * idénticos. UND 2,667 → 2,66 (se trunca, no se redondea).
 */
export function cantidadAlmacenada(cantidad, unidad) {
  return ajustarCantidadAUnidad(cantidad, normalizarUnidad(unidad));
}

// ─── Fecha y factura ───────────────────────────────────────────────────────

const FORMATO_FECHA_BOGOTA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Fecha calendario de Bogotá (YYYY-MM-DD). NO `toISOString().slice(0, 10)`: eso
 * es UTC y entre las 7 p. m. y medianoche de Bogotá ya marca el día siguiente
 * (el bug de `Recepcion.model.js` en Talleres).
 */
export function hoyBogota(fecha = new Date()) {
  return FORMATO_FECHA_BOGOTA.format(fecha);
}

/**
 * `factura` es lo que se muestra (recortada, mayúsculas, espacios colapsados);
 * `clave` es lo que se compara para detectar duplicados (solo letras y
 * números). Así "fe-00123", " FE 00123 " y "FE00123" son la MISMA factura.
 * Se conservan los ceros a la izquierda: "FE-0012" y "FE12" son distintas.
 */
export function normalizarFactura(texto) {
  const factura = String(texto ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const clave = factura.replace(/[^A-Z0-9]/g, "");
  return { factura, clave };
}

/** ¿La referencia cabe en el PENDIENTE de SIESA (1 a 12 caracteres)? */
export function facturaCabeEnSiesa(factura) {
  const largo = String(factura ?? "").trim().length;
  return largo > 0 && largo <= LARGO_FACTURA_SIESA;
}

// ─── Texto de plata ────────────────────────────────────────────────────────

/**
 * Formato colombiano: `.` SOLO miles, `,` SOLO decimales. Un entero sin
 * puntos, o un primer grupo de 1 a 3 dígitos sin cero a la izquierda seguido de
 * grupos de EXACTAMENTE 3.
 */
const RE_PESOS = /^(0|[1-9]\d*|[1-9]\d{0,2}(?:\.\d{3})+)(?:,(\d+))?$/;

/**
 * Interpreta texto de plata. Devuelve el número, o `null` si es ambiguo o
 * inválido (quien muestra el error usa `MENSAJE_PESOS`).
 *
 * Rechaza a propósito: "1.5" y "20.00" (¿miles o decimales?), "1234.567"
 * (grupo mal formado), "0.500" y "007" (cero a la izquierda), "1,500.00"
 * (formato gringo), más de una coma, espacios, signos, letras.
 *
 * `decimales` = cuántos decimales se aceptan escritos (2 por defecto: total;
 * el unitario usa 4). Solo mira el FORMATO: si el valor cabe en la columna lo
 * decide `calcularValores`, con su propio mensaje.
 *
 * Solo acepta texto: la plata que llega del navegador nunca se toma como número.
 */
export function parsearPesos(texto, { decimales = 2 } = {}) {
  if (typeof texto !== "string") return null;
  const m = RE_PESOS.exec(texto.trim());
  if (!m) return null;
  const [, parteEntera, parteDecimal = ""] = m;
  if (parteDecimal.length > decimales) return null;
  const numero = Number(parteEntera.replaceAll(".", "") + (parteDecimal ? `.${parteDecimal}` : ""));
  return Number.isFinite(numero) ? numero : null;
}

/** 20000 → "$ 20.000"; 20000.5 → "$ 20.000,5". Vacío o inválido → "". */
export function formatearPesos(valor) {
  if (valor === null || valor === undefined || valor === "") return "";
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0 || n >= 1e15) return "";
  // A mano y no con Intl: el locale "es" no agrupa los números de 4 cifras.
  const [entero, decimal] = redondear(n, 4).toString().split(".");
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$ ${conMiles}${decimal ? `,${decimal}` : ""}`;
}

/**
 * Filtro de teclado del campo de plata: deja pasar también las formas PARCIALES
 * mientras se escribe ("20.", "20.0", "20.000,"). No valida el valor final —
 * eso es `parsearPesos`—, solo evita que se escriban caracteres imposibles.
 */
export function esEntradaPesos(texto) {
  return /^(\d+(\.\d{3})*(\.\d{0,3})?(,\d*)?)?$/.test(String(texto ?? ""));
}

// ─── Cálculo de valores ────────────────────────────────────────────────────

/**
 * Calcula unitario y total a partir de UNA fuente.
 *
 * `cantidad` es la ya guardada (ver `cantidadAlmacenada`); `valor` es el número
 * ya interpretado con `parsearPesos` (el unitario si `fuente` = "unitario", el
 * total si = "total"). `valor` vacío → todo null, sin error.
 *
 * Con cantidad 0 y fuente total NO se deriva unitario (nunca divide por 0).
 * Devuelve `error` (texto) si el valor es inválido o si el resultado no cabe en
 * las columnas: multiplicar un unitario válido por una cantidad grande puede
 * pasarse del total, y eso tiene que ser un error del renglón, no un 500.
 *
 * @returns {{valor_unitario: number|null, valor_total: number|null, valor_fuente: string|null, error: string|null}}
 */
export function calcularValores({ cantidad, valor, fuente } = {}) {
  const vacio = { valor_unitario: null, valor_total: null, valor_fuente: null, error: null };
  const v = aNumeroONull(valor);
  if (v === null) return vacio;

  const falla = (error) => ({ ...vacio, error });
  const c = aNumero(cantidad);
  if (!esNumeroValido(v)) return falla("El valor no es válido");
  if (!esNumeroValido(c)) return falla("La cantidad no es válida");
  if (fuente !== "unitario" && fuente !== "total") return falla("Falta indicar si el valor es unitario o total");

  let unitario;
  let total;
  if (fuente === "unitario") {
    unitario = redondear(v, 4);
    total = Math.round(c * unitario);
  } else {
    total = Math.round(v);
    unitario = c > 0 ? redondear(total / c, 4) : null;
  }

  if (!Number.isFinite(total) || total >= LIMITE_TOTAL || (unitario !== null && unitario >= LIMITE_UNITARIO)) {
    return falla("El valor es demasiado grande");
  }
  return { valor_unitario: unitario, valor_total: total, valor_fuente: fuente, error: null };
}

/**
 * ¿El valor unitario está dentro del rango esperado? Sin unitario no hay nada
 * que juzgar. `aviso` es el texto que se le muestra a quien digita.
 *
 * @returns {{plausible: boolean, aviso: string|null}}
 */
export function valorPlausible({ unitario, unidad } = {}) {
  const u = aNumeroONull(unitario);
  if (u === null || !Number.isFinite(u)) return { plausible: true, aviso: null };
  if (u >= VALOR_UNITARIO_MIN && u <= VALOR_UNITARIO_MAX) return { plausible: true, aviso: null };
  const por = normalizarUnidad(unidad) || "unidad";
  return {
    plausible: false,
    aviso:
      `El valor unitario (${formatearPesos(u)}) está fuera del rango esperado ` +
      `(${formatearPesos(VALOR_UNITARIO_MIN)} a ${formatearPesos(VALOR_UNITARIO_MAX)} por ${por}); hay que confirmarlo`,
  };
}

/**
 * ¿La confirmación de valor guardada corresponde al unitario ACTUAL? Solo vale
 * si son iguales: confirmar $20 y luego editar la cantidad (que, con fuente
 * total, cambia el unitario) vuelve a pedir confirmación.
 */
export function valorConfirmado(item) {
  const confirmado = aNumeroONull(item?.valor_confirmado_unitario);
  const actual = aNumeroONull(item?.valor_unitario);
  if (confirmado === null || actual === null) return false;
  if (!Number.isFinite(confirmado) || !Number.isFinite(actual)) return false;
  return redondear(confirmado, 4) === redondear(actual, 4);
}

/** Solo KL, y estrictamente más de 800: con 800 justos no hace falta confirmar. UND queda exento. */
export function excedeUmbral({ cantidad, unidad } = {}) {
  const c = aNumero(cantidad);
  return normalizarUnidad(unidad) === "KL" && Number.isFinite(c) && c > UMBRAL_KL;
}

/**
 * ¿La confirmación de exceso guardada corresponde a la cantidad ACTUAL?
 * Confirmar 850 y después dejar 851 (o 8500) vuelve a pedirla.
 */
export function excesoConfirmado(item) {
  const confirmada = aNumeroONull(item?.exceso_confirmado_cantidad);
  const actual = aNumeroONull(item?.cantidad);
  if (confirmada === null || actual === null) return false;
  if (!Number.isFinite(confirmada) || !Number.isFinite(actual)) return false;
  return redondear(confirmada, 3) === redondear(actual, 3);
}

/**
 * Confirmaciones que le faltan a un renglón, una por regla. Solo aplica a
 * renglones con cantidad > 0. El autosave las ACEPTA y las devuelve como
 * `pendientes` (no se pierde lo digitado); `validarRenglon` las convierte en
 * error al finalizar.
 *
 * @returns {{tipo: "exceso"|"valor", mensaje: string}[]}
 */
export function confirmacionesPendientes(item) {
  const cantidad = aNumero(item?.cantidad);
  if (!(cantidad > 0)) return [];

  const pendientes = [];
  if (excedeUmbral({ cantidad, unidad: item?.unidad }) && !excesoConfirmado(item)) {
    pendientes.push({ tipo: "exceso", mensaje: `Más de ${UMBRAL_KL} KL: falta la confirmación` });
  }
  // Un valor en 0 no es "implausible", es "falta el valor": eso ya lo dice
  // `validarRenglon`, y pedir además una confirmación de $0 sería ruido.
  const { plausible, aviso } = valorPlausible({ unitario: item?.valor_unitario, unidad: item?.unidad });
  if (aNumero(item?.valor_total) > 0 && !plausible && !valorConfirmado(item)) {
    pendientes.push({ tipo: "valor", mensaje: aviso });
  }
  return pendientes;
}

/**
 * Valor de lo devuelto, proporcional al total del renglón, en pesos enteros.
 * SE CALCULA, no se guarda: una columna guardada quedaría vieja al corregir la
 * cantidad. Con cantidad 0 da 0 (nunca divide por 0).
 */
export function valorDevuelto({ cantidad, valor_total, cantidad_devuelta } = {}) {
  const c = aNumero(cantidad);
  const total = aNumero(valor_total);
  const devuelta = aNumero(cantidad_devuelta);
  if (!(c > 0) || !Number.isFinite(total) || !Number.isFinite(devuelta)) return 0;
  // Acotada a [0, cantidad]: una devolución mayor a lo recibido la rechaza
  // `validarRenglon`, pero esta función también alimenta el resumen previo y no
  // puede mostrar una nota crédito más grande que la factura.
  const acotada = Math.min(Math.max(devuelta, 0), c);
  return Math.round((total * acotada) / c);
}

// ─── Validación ────────────────────────────────────────────────────────────

/**
 * Errores de UN renglón, como textos para mostrar. Vacío = válido.
 *
 * Los chequeos de unidad, item, valor y confirmaciones aplican SOLO a los
 * renglones con cantidad > 0: los demás no viajan a SIESA, y bloquear por una
 * unidad rara o un item faltante en algo que no se recibió frenaría la
 * finalización por nada. Lo que SÍ se revisa siempre: números sanos, que no
 * haya valor con cantidad 0, y la devolución.
 */
export function validarRenglon(entrada) {
  const item = entrada ?? {};
  const errores = [];
  const cantidad = aNumero(item.cantidad);
  const cantidadOk = esNumeroValido(cantidad);
  const total = aNumeroONull(item.valor_total);
  const unitario = aNumeroONull(item.valor_unitario);
  const devuelta = aNumero(item.cantidad_devuelta);

  if (!cantidadOk) errores.push("La cantidad no es válida");
  else if (cantidad >= LIMITE_CANTIDAD) errores.push("La cantidad es demasiado grande");

  const totalOk = total === null || esNumeroValido(total);
  const unitarioOk = unitario === null || esNumeroValido(unitario);
  if (!totalOk || !unitarioOk) errores.push("El valor no es válido");

  if (cantidadOk && cantidad > 0) {
    if (!unidadValida(item.unidad)) {
      const mostrada = normalizarUnidad(item.unidad) || "(vacía)";
      errores.push(`La unidad "${mostrada}" no es válida (solo KL o UND)`);
    } else if (redondear(cantidad, 3) !== cantidadAlmacenada(cantidad, item.unidad)) {
      // SIESA recibe la cantidad ajustada a la unidad (UND 2,667 → 2,66). Si lo
      // guardado tiene más decimales, el total se calculó sobre otra cantidad y
      // no cuadraría con lo que llega a SIESA.
      errores.push("La cantidad tiene más decimales de los que admite la unidad; guardá el renglón de nuevo");
    }
    if (!String(item.codigo_item ?? "").trim()) errores.push("Falta el código de item de SIESA");

    if (totalOk && unitarioOk) {
      if (!(total > 0)) {
        errores.push("Falta el valor del renglón");
      } else if (total >= LIMITE_TOTAL || (unitario !== null && unitario >= LIMITE_UNITARIO)) {
        errores.push("El valor es demasiado grande");
      } else if (item.valor_fuente === "unitario" || item.valor_fuente === "total") {
        // Recalcula desde la fuente: un renglón cuya cantidad cambió sin
        // recalcular la plata no puede llegar a SIESA con números viejos.
        const base = item.valor_fuente === "unitario" ? unitario : total;
        const r = calcularValores({ cantidad, valor: base, fuente: item.valor_fuente });
        const coincide =
          r.error === null &&
          r.valor_total === total &&
          r.valor_unitario !== null &&
          unitario !== null &&
          r.valor_unitario === redondear(unitario, 4);
        if (!coincide) errores.push("Los valores no coinciden con la cantidad; guardá el renglón de nuevo");
      } else {
        // Sin fuente no hay contra qué recalcular: un total suelto de $1 con un
        // unitario de $20.000 pasaría derecho a SIESA.
        errores.push("Falta indicar si el valor es unitario o total");
      }
    }

    for (const pendiente of confirmacionesPendientes(item)) errores.push(pendiente.mensaje);
  } else if (cantidadOk && total > 0) {
    errores.push("Tiene valor pero la cantidad es 0");
  }

  if (!esNumeroValido(devuelta)) {
    errores.push("La cantidad devuelta no es válida");
  } else if (devuelta > 0) {
    if (cantidadOk && devuelta > cantidad) errores.push("La cantidad devuelta no puede superar lo recibido");
    if (!String(item.motivo_devolucion ?? "").trim()) errores.push("Falta el motivo de la devolución");
  }

  return errores;
}

/**
 * Valida todos los renglones de una recepción y exige al menos uno recibido.
 *
 * @returns {{ok: boolean, errores: {item_id: *, mensajes: string[]}[], generales: string[], renglones_con_cantidad: number}}
 */
export function validarRecepcion(items = []) {
  const errores = [];
  let conCantidad = 0;
  for (const item of items) {
    if (aNumero(item?.cantidad) > 0) conCantidad += 1;
    const mensajes = validarRenglon(item);
    if (mensajes.length) errores.push({ item_id: item?.id ?? null, mensajes });
  }
  const generales = conCantidad === 0 ? ["Tiene que haber al menos un renglón con cantidad mayor a 0"] : [];
  return {
    ok: errores.length === 0 && generales.length === 0,
    errores,
    generales,
    renglones_con_cantidad: conCantidad,
  };
}

/**
 * Resumen para mostrar antes de firmar. Solo cuenta renglones con cantidad > 0;
 * el total es lo facturado (la devolución NO se resta: la entrada a SIESA lleva
 * el monto completo y lo devuelto sale en nota crédito aparte).
 */
export function resumenRecepcion(items = []) {
  let renglones = 0;
  let total = 0;
  let totalDevuelto = 0;
  let conDevolucion = 0;
  for (const item of items) {
    if (!(aNumero(item?.cantidad) > 0)) continue;
    renglones += 1;
    const t = aNumero(item.valor_total);
    if (Number.isFinite(t)) total += t;
    if (aNumero(item.cantidad_devuelta) > 0) {
      conDevolucion += 1;
      totalDevuelto += valorDevuelto(item);
    }
  }
  return { renglones, total, total_devuelto: totalDevuelto, renglones_con_devolucion: conDevolucion };
}
