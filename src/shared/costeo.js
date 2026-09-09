/**
 * Motor de costeo de recepción de carnes.
 *
 * Módulo PURO: no toca Supabase, no toca Express, no lee `process.env`. Entra un
 * objeto, sale un objeto. Esa es la única razón por la que se puede testear
 * contra los números reales de los Excel del admin (ver test/costeo.test.js), y
 * por la que el día que el cálculo cambie se va a saber en un segundo si cambió
 * de más.
 *
 * ─── El cálculo ───────────────────────────────────────────────────────────
 *
 * Los dos archivos del admin —res y cerdo— corren EXACTAMENTE el mismo
 * algoritmo, aunque las hojas no se parezcan en nada:
 *
 *   costo_teorico   = Σ (costo_base_i × cantidad_i)
 *   costo_real      = Σ (gasto_j × signo_j) − bonificación de vísceras
 *   factor          = (costo_teorico − costo_real) / costo_teorico
 *   costo_ajustado_i = costo_base_i × (1 − factor)
 *   costo_total_i    = costo_ajustado_i × cantidad_i
 *
 * Es un PRORRATEO: reparte lo que de verdad se pagó entre los cortes, en
 * proporción a lo que cada corte vale en la lista de precios. Un corte caro
 * absorbe más del sobrecosto que uno barato, que es lo correcto: si el lote
 * salió 5% más caro, cada corte salió 5% más caro.
 *
 * Equivalencias con las celdas, por si hay que auditar contra el Excel:
 *
 *   RES   (hoja de sede)  costo_teorico = F48 · costo_real = F7 · factor = H8
 *                         costo_ajustado = columna G · costo_total = columna H
 *   CERDO (`Plantilla`)   costo_teorico = G26 · costo_real = G11 · factor = I11
 *                         costo_ajustado = columna H · costo_total = columna I
 *
 * ─── Lo que este módulo hace y el Excel no ────────────────────────────────
 *
 * Devuelve `advertencias`. El Excel calcula callado y entrega un número, sea el
 * que sea; acá el resultado viene con las señales de que ese número no se puede
 * mandar a SIESA. La más importante es `factor_anula_costos`: si los gastos
 * están vacíos, el factor da exactamente 1, y TODOS los costos ajustados dan
 * cero. El archivo de res está en ese estado ahora mismo —columna G llena de
 * ceros— y nada en la hoja lo dice. Un documento de inventario con costo cero
 * entra igual y deja el margen del corte en 100%.
 */

/** Redondeo a `n` decimales, evitando la basura de punto flotante. */
function redondear(valor, n) {
  if (!Number.isFinite(valor)) return 0;
  return Number(valor.toFixed(n));
}

/** Convierte a número tolerando `null`, `undefined`, strings y NaN. */
function num(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/** Decimales de guardado: 4 para el costo unitario, 2 para totales de plata. */
const DECIMALES_UNITARIO = 4;
const DECIMALES_TOTAL = 2;

/**
 * @typedef {object} ItemCosteo
 * @property {string|number} [id]
 * @property {string} [codigo_item]
 * @property {string} [descripcion]
 * @property {number} cantidad    kilos recibidos (acepta decimales)
 * @property {number} costo_base  precio de lista congelado al recibir
 */

/**
 * @typedef {object} GastoCosteo
 * @property {string} [concepto]
 * @property {number} valor
 * @property {1|-1} [signo]  -1 en las retomas, que RESTAN del costo real
 */

/**
 * @typedef {object} ViceraCosteo
 * @property {string} [nombre]
 * @property {number} cantidad
 * @property {number} precio
 */

/**
 * Corre el costeo completo de una recepción.
 *
 * @param {object} entrada
 * @param {ItemCosteo[]}   entrada.items                 renglones de carne
 * @param {GastoCosteo[]}  [entrada.gastos]              conceptos de gasto de la liquidación
 * @param {ViceraCosteo[]} [entrada.viceras]             SOLO las del bloque 'bonificacion'
 * @param {boolean}        [entrada.bonificacionViceras] el toggle `Sumar Viceras (SI/NO)`
 * @returns {{
 *   costoTeorico: number, totalGastos: number, valorViceras: number,
 *   costoReal: number, factor: number, cantidadTotal: number,
 *   costoPromedioKilo: number, items: object[], totalCosteado: number,
 *   residuo: number, advertencias: {codigo: string, mensaje: string}[]
 * }}
 */
/**
 * Umbrales del factor de ajuste.
 *
 * El factor es cuánto MÁS BARATO resultó lo pagado respecto del valor de lista.
 * Uno sano es chico: la hoja de cerdo del Excel da 8,61%.
 *
 *   ≥ 0.9  → los costos quedan por debajo del 10% de la lista. Bloquea.
 *   ≥ 0.5  → el costo real es menos de la mitad. Avisa.
 */
const FACTOR_INVEROSIMIL = 0.9;
const FACTOR_SOSPECHOSO = 0.5;

export function calcularCosteo({
  items = [],
  gastos = [],
  viceras = [],
  bonificacionViceras = false,
} = {}) {
  const advertencias = [];

  const cantidadTotal = items.reduce((acc, it) => acc + num(it.cantidad), 0);
  const costoTeorico = items.reduce(
    (acc, it) => acc + num(it.cantidad) * num(it.costo_base),
    0,
  );

  // `signo` por defecto 1: un gasto sin signo suma. Las retomas lo traen en -1.
  const totalGastos = gastos.reduce(
    (acc, g) => acc + num(g.valor) * (num(g.signo) === -1 ? -1 : 1),
    0,
  );

  // La bonificación solo cuenta si el toggle está encendido — `Datos `!D50.
  // Con el toggle apagado las cantidades igual se guardan; simplemente no
  // descuentan. Por eso el cálculo se hace siempre y el `if` va sobre el uso.
  const valorViceras = bonificacionViceras
    ? viceras.reduce((acc, v) => acc + num(v.cantidad) * num(v.precio), 0)
    : 0;

  const costoReal = totalGastos - valorViceras;

  // ─── El factor, con sus tres formas de salir mal ───────────────────────
  let factor = 0;
  if (costoTeorico === 0) {
    // Sin kilos o sin precios no hay nada que prorratear. El Excel devuelve
    // #DIV/0! y arrastra el error a toda la columna; acá el factor queda en 0
    // (o sea: costo ajustado = costo de lista) y se avisa.
    advertencias.push({
      codigo: "costo_teorico_cero",
      mensaje:
        "El costo teórico es 0: no hay cantidades o no hay precios base. " +
        "Los costos ajustados quedan iguales al precio de lista.",
    });
  } else {
    factor = (costoTeorico - costoReal) / costoTeorico;
  }

  if (factor >= FACTOR_INVEROSIMIL) {
    // El caso peligroso, y NO es solo el factor exactamente 1.
    //
    // Con factor 0.9986 —gastos mil veces más chicos de lo que corresponde— cada
    // corte queda en el 0,14% de su precio de lista: un lomo de $61.000 costaría
    // $85. Eso sube a SIESA sin protestar y deja el margen de todo el lote en
    // 99,86%. Es tan destructivo como el cero exacto, así que se bloquea igual.
    //
    // El umbral es 0.9 y no 1 porque no existe una compra de carne donde lo
    // pagado sea menos del 10% del valor de lista. Si un caso legítimo cayera
    // acá, se sube la constante — pero que sea una decisión, no un descuido.
    const porcentaje = redondear(factor * 100, 2);
    advertencias.push({
      codigo: "factor_anula_costos",
      mensaje:
        `El factor de ajuste es ${porcentaje}%, así que cada corte queda en el ` +
        `${redondear((1 - factor) * 100, 2)}% de su precio de lista. Casi siempre ` +
        "significa que faltan gastos o que se cargaron con menos ceros. " +
        "NO subir a SIESA en este estado.",
    });
  } else if (factor >= FACTOR_SOSPECHOSO) {
    // Zona gris: matemáticamente posible, comercialmente raro. Se avisa pero no
    // se bloquea — no me corresponde decidir hasta dónde llega su negocio.
    advertencias.push({
      codigo: "factor_alto",
      mensaje:
        `El factor de ajuste es ${redondear(factor * 100, 2)}%: el costo real es ` +
        "menos de la mitad del valor de lista. Revisá que estén todos los gastos " +
        "y que las cifras tengan los ceros que corresponden.",
    });
  } else if (factor < 0) {
    // Legítimo —se pagó más de lo que decía la lista— pero encarece cada corte
    // por encima de su precio base, y eso el admin lo tiene que ver.
    advertencias.push({
      codigo: "costo_real_supera_teorico",
      mensaje:
        "El costo real supera al teórico: cada corte queda MÁS caro que su " +
        "precio de lista. Verificar los gastos cargados.",
    });
  }

  // ─── Prorrateo por ítem ────────────────────────────────────────────────
  //
  // `costo_total` se calcula desde el ajustado SIN redondear y recién ahí se
  // redondea. Redondear primero y multiplicar después mete un error que crece
  // con los kilos: en un renglón de 500 kg, cuatro decimales perdidos son
  // decenas de pesos, y el Excel no redondea en el medio.
  const itemsCosteados = items.map((it) => {
    const cantidad = num(it.cantidad);
    const costoBase = num(it.costo_base);
    const ajustadoExacto = costoBase * (1 - factor);

    return {
      ...it,
      cantidad,
      costo_base: costoBase,
      costo_ajustado: redondear(ajustadoExacto, DECIMALES_UNITARIO),
      costo_total: redondear(ajustadoExacto * cantidad, DECIMALES_TOTAL),
    };
  });

  const totalCosteado = redondear(
    itemsCosteados.reduce((acc, it) => acc + it.costo_total, 0),
    DECIMALES_TOTAL,
  );

  // Diferencia entre lo que se pagó y la suma de los renglones redondeados.
  // Debería ser centavos. Si no lo es, algo no cierra y el admin tiene que
  // saberlo ANTES de aprobar, no cuando contabilidad reclame.
  const residuo = redondear(costoReal - totalCosteado, DECIMALES_TOTAL);
  if (costoTeorico > 0 && Math.abs(residuo) > 1) {
    advertencias.push({
      codigo: "residuo_alto",
      mensaje:
        `La suma de los renglones difiere del costo real en $${residuo}. ` +
        "Revisar antes de aprobar.",
    });
  }

  return {
    costoTeorico: redondear(costoTeorico, DECIMALES_TOTAL),
    totalGastos: redondear(totalGastos, DECIMALES_TOTAL),
    valorViceras: redondear(valorViceras, DECIMALES_TOTAL),
    costoReal: redondear(costoReal, DECIMALES_TOTAL),
    factor,
    cantidadTotal: redondear(cantidadTotal, 3),
    costoPromedioKilo:
      cantidadTotal > 0 ? redondear(costoReal / cantidadTotal, DECIMALES_UNITARIO) : 0,
    items: itemsCosteados,
    totalCosteado,
    residuo,
    advertencias,
  };
}

/**
 * Reparte el costo total de una liquidación entre sus sedes, en proporción a los
 * kilos que recibió cada una.
 *
 * Espejo de `Datos `!fila 42 (% de participación) y `Datos `!P25:P33 (valor de
 * factura por sede). El Excel lo expresa de dos maneras que dan lo mismo:
 * `total_gastos × %participación`, y `costo_promedio_kilo × kilos_sede`. Acá va
 * la primera, que no arrastra el redondeo del promedio.
 *
 * @param {{sede_id: number|string, cantidad: number}[]} recepciones
 * @param {number} totalGastos
 * @returns {{sede_id: any, cantidad: number, participacion: number, valorFactura: number}[]}
 */
export function repartirPorSede(recepciones = [], totalGastos = 0) {
  const total = recepciones.reduce((acc, r) => acc + num(r.cantidad), 0);

  return recepciones.map((r) => {
    const cantidad = num(r.cantidad);
    // Sin kilos totales la participación es 0, no NaN: una sede sin recibir
    // nada no puede quedarse con una porción indefinida de la factura.
    const participacion = total > 0 ? cantidad / total : 0;
    return {
      sede_id: r.sede_id,
      cantidad: redondear(cantidad, 3),
      participacion,
      valorFactura: redondear(num(totalGastos) * participacion, DECIMALES_TOTAL),
    };
  });
}
