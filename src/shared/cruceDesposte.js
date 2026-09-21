/**
 * Cruce: lo que dice el informe del frigorífico contra lo que contó el recibidor.
 *
 * Módulo PURO, igual que `costeo.js` y `consolidado.js`. Entran dos listas de
 * números, sale la diferencia. No sabe de Supabase ni de Express.
 *
 * ─── Qué se cruza y qué no ────────────────────────────────────────────────
 *
 * El informe parte en dos bloques:
 *
 *   FINAS         los cortes aprovechables. Entran SIEMPRE al cruce.
 *   SUBPRODUCTOS  hueso blanco, sebo, despojos, chocozuela, rompe.
 *
 * Un subproducto entra al cruce SOLO si está mapeado en la plantilla
 * (`nombre_desposte`). La operación definió que chocozuela y rompe kilo se
 * reciben como carne; hueso, sebo y despojos no. Esa lista no vive acá: vive en
 * el diccionario, que edita el admin. Un subproducto sin mapear se muestra
 * aparte y no suma ni resta de nada.
 *
 * ─── Dos comparaciones, no una ────────────────────────────────────────────
 *
 * 1. POR TOTALES — kilos del PDF contra kilos del recibidor.
 *    No necesita mapear ni un solo nombre. Funciona desde el primer informe y
 *    es la que contesta la pregunta que importa: ¿llegó todo?
 *
 * 2. LÍNEA POR LÍNEA — producto contra producto.
 *    Necesita el diccionario `carnes_plantilla_items.nombre_desposte`, que se
 *    llena a mano. Mientras esté vacío, esta comparación devuelve todo como
 *    `sin_mapear` y no finge que cuadró.
 *
 * Por qué NO se adivina el mapeo por parecido de texto: "PUNTA DE ANCA" y
 * "PUNTA DE FALDA" están a una palabra de distancia y son dos cortes distintos.
 * Un falso positivo acá no se ve —los kilos cuadran— y esconde justamente el
 * faltante que este cruce existe para encontrar.
 */

import { normalizarNombre, BLOQUE_FINAS } from "./desposteParser.js";

/**
 * Renglones de la recepción que son carne.
 *
 * Misma definición que en `consolidado.js`: 'carne' y 'adicional' sí, 'vicera'
 * no. Un adicional es un corte que llegó sin estar en la plantilla — sigue
 * siendo carne y el frigorífico lo facturó, así que tiene que entrar al cruce.
 * Las vísceras quedan afuera porque su contraparte son los subproductos, que es
 * exactamente lo que todavía no está definido.
 */
const ES_CARNE = (i) => i.tipo === "carne" || i.tipo === "adicional";

/**
 * Tolerancia del cruce por totales.
 *
 * La planta pesa en canal y la sede pesa en canasta, con otra báscula y unas
 * horas de diferencia. Un desvío de centésimos es normal; medio kilo ya no.
 *
 * Se usa el MAYOR de los dos: en un lote de 130 kg manda el piso absoluto
 * (0.5 kg), y en uno de 2.000 kg manda el porcentual, porque exigir medio kilo
 * sobre dos toneladas sería marcar en rojo todas las entregas grandes.
 */
export const TOLERANCIA_KG = 0.5;
export const TOLERANCIA_PCT = 0.005; // 0.5 %

/**
 * A partir de cuánto se le manda un correo al admin.
 *
 * Es otro umbral, y más alto, que el de "no cuadra": la pastilla en pantalla
 * puede ponerse roja por 600 gramos, pero un correo por 600 gramos en cada
 * entrega es un correo que nadie abre. Dos kilos es la cifra que definió la
 * operación como "esto hay que mirarlo hoy".
 */
export const UMBRAL_ALERTA_KG = 2;

/** Redondeo a kilos con tres decimales, como la columna `cantidad` de la base. */
const kg = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Clasifica una diferencia contra la tolerancia. */
function clasificar(diferencia, referencia) {
  const margen = Math.max(TOLERANCIA_KG, Math.abs(referencia) * TOLERANCIA_PCT);
  if (Math.abs(diferencia) <= margen) return "ok";
  return diferencia < 0 ? "faltante" : "sobrante";
}

/**
 * Arma el diccionario nombre-del-PDF → ítem de la plantilla.
 *
 * @param {Array<{id, descripcion, codigo_item, nombre_desposte}>} plantilla
 * @returns {Map<string, object>} clave normalizada → ítem
 */
export function construirDiccionario(plantilla = []) {
  const mapa = new Map();
  for (const item of plantilla) {
    if (!item?.nombre_desposte) continue;
    mapa.set(normalizarNombre(item.nombre_desposte), item);
  }
  return mapa;
}

/**
 * Compara un informe contra los renglones de la recepción.
 *
 * @param {object} p
 * @param {object} p.informe        Salida de `parsearInformeDesposte`, o la fila
 *                                  guardada con sus `items`.
 * @param {Array}  p.items          Renglones de `carnes_recepcion_items`.
 * @param {Array}  p.plantilla      Ítems de la plantilla, para el diccionario.
 * @returns {object} totales, líneas, subproductos y advertencias.
 */
export function cruzarDesposte({ informe, items = [], plantilla = [] }) {
  const advertencias = [];

  const diccionario = construirDiccionario(plantilla);
  const todas = informe?.items || [];

  // ─── Qué líneas del PDF entran al cruce ─────────────────────────────────
  //
  // FINAS entra siempre. Un SUBPRODUCTO entra solo si está mapeado en la
  // plantilla: la operación decidió que chocozuela y rompe kilo se reciben como
  // carne, y el resto —hueso, sebo, despojos— no. Esa decisión vive en el
  // diccionario y no en una lista de nombres acá adentro: si mañana el sebo
  // también se recibe, es un dato que carga el admin, no un cambio de código.
  const finas = todas.filter((i) => i.bloque === BLOQUE_FINAS);
  const subproductosMapeados = todas.filter(
    (i) => i.bloque !== BLOQUE_FINAS && diccionario.has(normalizarNombre(i.producto)),
  );
  const subproductosFuera = todas.filter(
    (i) => i.bloque !== BLOQUE_FINAS && !diccionario.has(normalizarNombre(i.producto)),
  );
  const lineasPdf = [...finas, ...subproductosMapeados];

  // ─── 1. Totales ─────────────────────────────────────────────────────────
  //
  // Para FINAS se prefiere el total IMPRESO en el informe: es el número que el
  // frigorífico firma. Si no coincide con la suma de líneas, el parser ya avisó
  // (`total_no_cuadra`) y el problema es de lectura, no de kilos. Los
  // subproductos que entran se suman línea por línea, porque el total impreso
  // de esa sección incluye a los que NO entran.
  const kgFinasPdf =
    informe?.totales?.kgFinas ?? finas.reduce((a, i) => a + (Number(i.cantidadKg) || 0), 0);
  const kgSubMapeados = subproductosMapeados.reduce((a, i) => a + (Number(i.cantidadKg) || 0), 0);
  const kgPdf = kg(kgFinasPdf + kgSubMapeados);
  const recibidos = items.filter(ES_CARNE);
  const kgRecibido = kg(recibidos.reduce((a, i) => a + (Number(i.cantidad) || 0), 0));

  const diferencia = kg(kgRecibido - kgPdf);
  const estadoTotales = clasificar(diferencia, kgPdf);

  const totales = {
    kgPdf,
    kgRecibido,
    diferencia,
    diferenciaPct: kgPdf > 0 ? Math.round((diferencia / kgPdf) * 10000) / 100 : null,
    estado: estadoTotales,
    alerta: Math.abs(diferencia) >= UMBRAL_ALERTA_KG,
    renglonesRecibidos: recibidos.length,
    renglonesPdf: lineasPdf.length,
  };

  if (estadoTotales === "faltante") {
    advertencias.push({
      codigo: "faltan_kilos",
      mensaje:
        `El informe dice ${kgPdf} kg de cortes y se recibieron ${kgRecibido} kg: ` +
        `faltan ${Math.abs(diferencia)} kg. Revisá antes de aprobar.`,
    });
  } else if (estadoTotales === "sobrante") {
    advertencias.push({
      codigo: "sobran_kilos",
      mensaje:
        `Se recibieron ${kgRecibido} kg pero el informe dice ${kgPdf} kg: ` +
        `hay ${Math.abs(diferencia)} kg de más. Puede ser un renglón digitado dos ` +
        "veces o carne de otro lote mezclada.",
    });
  }

  // ─── 2. Línea por línea ─────────────────────────────────────────────────

  // Los renglones del recibidor, indexados por el ítem de plantilla que usaron.
  // Se agrupa porque un mismo corte puede venir en dos renglones (la plantilla
  // lo tiene una vez, pero un adicional homologado puede apuntar al mismo).
  const porPlantilla = new Map();
  for (const item of recibidos) {
    const clave = item.plantilla_item_id ?? `desc:${normalizarNombre(item.descripcion)}`;
    const previo = porPlantilla.get(clave);
    if (previo) {
      previo.cantidad += Number(item.cantidad) || 0;
    } else {
      porPlantilla.set(clave, {
        descripcion: item.descripcion,
        codigo_item: item.codigo_item,
        cantidad: Number(item.cantidad) || 0,
      });
    }
  }

  const usados = new Set();
  const lineas = lineasPdf.map((linea) => {
    const plantillaItem = diccionario.get(normalizarNombre(linea.producto));

    if (!plantillaItem) {
      return {
        producto: linea.producto,
        bloque: linea.bloque,
        plantilla_item_id: null,
        descripcion: null,
        codigo_item: null,
        kgPdf: kg(linea.cantidadKg),
        kgRecibido: null,
        diferencia: null,
        // No es "faltante": es "no sé". Mostrarlo como faltante mandaría a
        // alguien a buscar carne que probablemente está bien contada, solo que
        // bajo otro nombre.
        estado: "sin_mapear",
      };
    }

    usados.add(plantillaItem.id);
    const recibido = porPlantilla.get(plantillaItem.id);
    const kgLineaPdf = kg(linea.cantidadKg);
    const kgLineaRec = recibido ? kg(recibido.cantidad) : 0;
    const dif = kg(kgLineaRec - kgLineaPdf);

    return {
      producto: linea.producto,
      bloque: linea.bloque,
      plantilla_item_id: plantillaItem.id,
      descripcion: plantillaItem.descripcion,
      codigo_item: plantillaItem.codigo_item,
      kgPdf: kgLineaPdf,
      kgRecibido: kgLineaRec,
      diferencia: dif,
      estado: recibido ? clasificar(dif, kgLineaPdf) : "solo_pdf",
    };
  });

  // Lo que el recibidor cargó y el informe no menciona. Es el caso simétrico y
  // el que más se olvida: carne que llegó de más, o de otro lote.
  //
  // Un renglón sin mapear NO entra acá. Si su ítem de plantilla no tiene
  // `nombre_desposte`, la ausencia no significa "no vino en el informe" sino
  // "no sé cómo se llama en el informe" — y eso ya lo dice
  // `diccionario_incompleto`. Reportarlo como sobrante mandaría al admin a
  // investigar un agujero del diccionario creyendo que es un problema de carne.
  const mapeados = new Set([...diccionario.values()].map((i) => i.id));
  const soloRecepcion = [];
  for (const [clave, r] of porPlantilla) {
    if (kg(r.cantidad) === 0) continue;

    const esAdicionalSuelto = typeof clave === "string";
    if (!esAdicionalSuelto) {
      if (usados.has(clave)) continue; // el PDF sí lo nombró
      if (!mapeados.has(clave)) continue; // sin mapear: no se puede concluir nada
    }

    soloRecepcion.push({
      producto: null,
      bloque: null,
      plantilla_item_id: esAdicionalSuelto ? null : clave,
      descripcion: r.descripcion,
      codigo_item: r.codigo_item,
      kgPdf: null,
      kgRecibido: kg(r.cantidad),
      diferencia: null,
      estado: "solo_recepcion",
    });
  }

  const sinMapear = lineas.filter((l) => l.estado === "sin_mapear").length;
  if (sinMapear > 0) {
    advertencias.push({
      codigo: "diccionario_incompleto",
      mensaje:
        `${sinMapear} de ${lineas.length} productos del informe no están mapeados ` +
        "a la plantilla, así que el detalle línea por línea está incompleto. El " +
        "cruce por totales de arriba sí es confiable.",
    });
  }

  // ─── 3. Subproductos que NO entran ──────────────────────────────────────
  //
  // Solo los que no están mapeados. Los mapeados ya viajaron en `lineas` y en el
  // total, así que listarlos acá también los contaría dos veces a la vista.
  const subproductos = {
    kgPdf: kg(subproductosFuera.reduce((a, i) => a + (Number(i.cantidadKg) || 0), 0)),
    items: subproductosFuera.map((i) => ({ producto: i.producto, kgPdf: kg(i.cantidadKg) })),
    nota:
      "Hueso, sebo y despojos: no se reciben como carne y no entran en la " +
      "diferencia. Si alguno sí se recibe, mapealo en la plantilla y pasa a contar.",
  };

  return { totales, lineas: [...lineas, ...soloRecepcion], subproductos, advertencias };
}

/**
 * ¿El informe es de esta sede y de esta entrega?
 *
 * Es el equivalente del QR, pero para el admin. El recibidor no puede recibir en
 * la sede equivocada porque escanea; el admin no puede adjuntar el informe de
 * López a Villa Hermosa porque el archivo dice de quién es.
 *
 * La fecha se compara aparte y NO invalida nada: el desposte es del día anterior
 * al ingreso más veces de las que no. Se informa, se guarda, y el admin decide.
 *
 * @param {object} informe  Salida de `parsearInformeDesposte`.
 * @param {object} sede     Fila de `carnes_sedes`.
 * @param {string} fechaIngreso  `fecha_ingreso` de la recepción (ISO).
 */
export function verificarIdentidad(informe, sede, fechaIngreso) {
  const esperado = sede?.subcliente_desposte;
  const problemas = [];

  let sedeCoincide = false;
  if (!esperado) {
    // Sin configurar NO bloquea: frenar una recepción real porque falta un dato
    // de catálogo es peor que aceptarla marcada como no verificada.
    problemas.push({
      codigo: "sede_sin_configurar",
      mensaje:
        `La sede "${sede?.nombre ?? "?"}" no tiene cargado su "Sub Cliente" del ` +
        `informe. El PDF dice "${informe?.subcliente ?? "—"}": si es el correcto, ` +
        "guardalo en la sede y a partir de ahí se verifica solo.",
    });
  } else if (!informe?.subcliente) {
    problemas.push({
      codigo: "informe_sin_subcliente",
      mensaje: 'El PDF no trae la línea "Sub Cliente", así que no se puede verificar.',
    });
  } else {
    sedeCoincide = normalizarNombre(informe.subcliente) === normalizarNombre(esperado);
    if (!sedeCoincide) {
      problemas.push({
        codigo: "sede_no_coincide",
        mensaje:
          `Este informe es de "${informe.subcliente}" y la recepción es de ` +
          `"${sede.nombre}" ("${esperado}"). Es el PDF de otra sede.`,
      });
    }
  }

  const fechaCoincide = Boolean(
    informe?.fechaDesposte && fechaIngreso && informe.fechaDesposte === String(fechaIngreso).slice(0, 10),
  );
  if (informe?.fechaDesposte && !fechaCoincide) {
    problemas.push({
      codigo: "fecha_distinta",
      mensaje:
        `El desposte es del ${informe.fechaDesposte} y la recepción es del ` +
        `${String(fechaIngreso ?? "—").slice(0, 10)}. Suele ser normal —se desposta un ` +
        "día y se entrega al siguiente—, pero verificá que sea la entrega correcta.",
    });
  }

  return { sedeCoincide, fechaCoincide, problemas };
}
