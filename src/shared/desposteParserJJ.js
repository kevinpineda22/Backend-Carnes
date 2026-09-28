/**
 * Parser del segundo formato de guía: "Comercial de Carnes J&J SAS", emitido por
 * el software Ribisoft. Por ahora solo llega en cerdo, pero el parser no asume
 * eso: lee la especie del propio documento.
 *
 * Mismo trato que `desposteParser.js`: módulo PURO, entra el texto ya extraído
 * del PDF (`services/pdf.service.js`), sale un objeto con la MISMA forma que
 * devuelve `parsearInformeDesposte`. Vive en su propio archivo a propósito —
 * así el parser de VisualERP (el que está en producción ahora mismo) no se toca
 * ni un carácter para agregar este.
 *
 * ─── La forma del documento (dos páginas, mergeadas por `pdf.service.js`) ────
 *
 * Página 1 — la tabla de salida de bodega, la fuente de verdad de kilos:
 *
 *   Referencia Descripción Lote Cantidad # pesajes
 *   202 CAÑON DE CERDO 1230953340 26,80 1
 *   ...
 *   Total 505,94 27
 *   Salidas de Inventario
 *   Fecha 23/09/2026 15:42:27
 *   No. MQ00003186
 *   Observaciones LOPEZ 6 CANALES
 *
 * Página 2 — la guía de transporte que exige la resolución INVIMA, repite los
 * mismos productos con la ESPECIE y el peso a 3 decimales:
 *
 *   NUMERO DE GUIA 203DM-003186-26
 *   Razón social: COMERCIAL DE CARNES J&J SAS ...
 *   ESPECIE DESCRIPCION LOTE PESO(kg) EMPAQUE FECHA...
 *   PORCINO BARRIGUERO 1230953340 45,000 A GRANEL 7/10/2026 22/9/2026
 *
 * No hay FINAS/SUBPRODUCTOS como en el informe de VisualERP: acá todo lo que
 * sale de bodega es un corte aprovechable. Por eso cada línea se guarda con el
 * mismo valor que usa el otro parser para "carne que sí entra al cruce" — la
 * cadena "finas" está repetida a mano y no importada, para no crear un import
 * circular entre los dos módulos por una sola constante.
 *
 * ─── Los números ──────────────────────────────────────────────────────────
 *
 * Este documento SÍ usa el formato que se espera en el resto del sistema:
 * PUNTO de miles, COMA decimal ("2.022,35" = dos mil veintidós con treinta y
 * cinco). Es el formato contrario al de `desposteParser.js` (inglés), así que
 * la conversión tampoco se comparte con ese archivo: mezclar los dos convertiría
 * "2.022,35" en 2.02235 o en 2022035 según cuál de los dos se use por error.
 *
 * ─── Qué se guarda como `lote` (y por qué NO es el de la columna "Lote") ────
 *
 * La tabla de la página 1 trae una columna "Lote" (p.ej. "1230953340"), pero
 * ESE número es el LOTE DE PRODUCCIÓN del frigorífico: se repite en todas las
 * líneas del documento, y —a diferencia de "Documento Cliente" en el informe
 * de VisualERP— también se repite entre SEDES distintas despachadas el mismo
 * día (López y Villa Hermosa pueden compartir lote de producción). La columna
 * `lote` de `carnes_desposte_informes` tiene un índice ÚNICO en toda la tabla
 * (sql/004), pensado para "Documento Cliente": un documento por entrega. Si
 * acá se guardara el lote de producción, la segunda sede del día chocaría
 * contra esa restricción — un error de base de datos, no una advertencia, y ni
 * siquiera `forzar` lo salva porque el índice no distingue sedes.
 *
 * Por eso `lote` se llena con el número de "No. MQ0000xxxx" —el documento de
 * salida de bodega de J&J, uno por guía— que es el verdadero equivalente de
 * "Documento Cliente". El lote de producción no se pierde: queda en
 * `documento.loteProduccion`, para quien lo necesite mirar.
 */

/** Mismo significado que `BLOQUE_FINAS` de `desposteParser.js`. */
const BLOQUE_CORTES = "finas";

/** `Salidas de Inventario` + el encabezado de la tabla: las dos anclas del formato. */
const ES_SALIDA_INVENTARIO = /Salidas de Inventario/i;
const ENCABEZADO_TABLA = /Referencia\s+Descripci[oó]n\s+Lote\s+Cantidad/i;

/**
 * ¿El texto es de este formato?
 *
 * Dos anclas y no una: "Salidas de Inventario" sola podría, en teoría, aparecer
 * en un informe distinto que hable de bodega; el encabezado de la tabla sirve
 * de segunda confirmación. El informe de VisualERP no trae ninguna de las dos.
 */
export function esFormatoJJ(texto) {
  const t = String(texto ?? "");
  return ES_SALIDA_INVENTARIO.test(t) && ENCABEZADO_TABLA.test(t);
}

/**
 * `202 CAÑON DE CERDO 1230953340 26,80 1`
 *   → referencia, descripción, lote, cantidad, # pesajes
 *
 * El nombre es no-codicioso, igual que en el otro parser: lo que ancla la línea
 * son los tres números del final (lote, cantidad, pesajes), no el nombre.
 */
const LINEA_ITEM = /^(\d+)\s+(.+?)\s+(\d+)\s+(-?[\d.,]+)\s+(\d+)$/;

/** `Total 505,94 27` — cierra la tabla de la página 1. */
const LINEA_TOTAL = /^Total\s+(-?[\d.,]+)\s+(\d+)\s*$/i;

/** `Observaciones LOPEZ 6 CANALES` — el nombre de la sede, tal como lo escribe J&J. */
const LINEA_OBSERVACIONES = /^Observaciones\s+(.+)$/i;

/** El número de canales dentro de "Observaciones" (`LOPEZ 6 CANALES` → 6). Informativo. */
const CANALES_EN_OBSERVACIONES = /(\d+)\s+CANALES\b/i;

/** `No. MQ00003186` — el documento de salida de bodega de J&J. */
const LINEA_DOCUMENTO = /^No\.\s*(\S+)/i;

/** `NUMERO DE GUIA 203DM-003186-26` — la guía de transporte ante el INVIMA. */
const LINEA_GUIA_TRANSPORTE = /^NUMERO DE GUIA\s+(\S+)/i;

/** `Razón social: COMERCIAL DE CARNES J&J SAS Departamento: Antioquia` — el proveedor. */
const LINEA_RAZON_SOCIAL = /^Raz[oó]n social:\s*(.+?)\s+Departamento:/i;

/** `Fecha 23/09/2026 15:42:27` — se descarta la hora, solo importa el día. */
const LINEA_FECHA = /^Fecha\s+(\d{1,2}\/\d{1,2}\/\d{4})/i;

/**
 * `PORCINO BARRIGUERO 1230953340 45,000 A GRANEL 7/10/2026 22/9/2026`
 *   → especie, descripción, lote, peso (3 decimales)
 *
 * De la página 2 (guía de transporte). Sirve para dos cosas: saber la especie
 * —el documento la declara, no hay que adivinarla del nombre del producto como
 * pasa con `unidad_medida` en el picking— y, opcionalmente, contrastar el peso
 * contra la página 1.
 */
const LINEA_GUIA_PRODUCTO =
  /^(PORCINO|BOVINO|RES)\s+(.+?)\s+(\d+)\s+(-?[\d.,]+)\s+(?:A GRANEL|AL VAC[IÍ]O)\b/i;

/** Especie tal como la declara el documento → especie tal como la usa el resto del sistema. */
const ESPECIE_DESDE_GUIA = {
  PORCINO: "cerdo",
  BOVINO: "res",
  RES: "res",
};

/** Tolerancia al comparar el total impreso contra la suma de líneas. Ver desposteParser.js. */
const TOLERANCIA_SUMA_KG = 0.01;

/** Tolerancia al contrastar el kilaje de la página 1 contra la página 2 del mismo producto. */
const TOLERANCIA_CRUCE_PAGINAS_KG = 0.01;

/**
 * Convierte un número de ESTE documento (formato colombiano) a `Number`.
 *
 * PUNTO = separador de miles, COMA = decimal. Al revés que `aNumero()` de
 * `desposteParser.js`. Devuelve `null` —no 0— cuando no hay dato, por la misma
 * razón que el otro parser: "sin dato" y "cero kilos" no son lo mismo para el
 * cruce.
 */
export function aNumeroLatino(texto) {
  if (texto === null || texto === undefined) return null;
  const limpio = String(texto).replace(/\./g, "").replace(",", ".").trim();
  if (!limpio) return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/** `23/09/2026` → `2026-09-23`. Mismo formato de fecha que el otro parser. */
function aFechaISO(texto) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(texto ?? "").trim());
  if (!m) return null;
  const [, d, mes, a] = m;
  return `${a}-${mes.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * Lee la guía de J&J.
 *
 * @param {string} texto Texto plano extraído del PDF (las dos páginas mergeadas).
 * @returns {{
 *   lote: string|null, fechaDesposte: string|null, cliente: string|null,
 *   subcliente: string|null, animales: number|null,
 *   items: Array<{bloque: string, producto: string, cantidadKg: number,
 *                 pesajes: number|null, rendimientoPct: null, promedioKg: null,
 *                 orden: number}>,
 *   totales: object, especie: string|null, formato: "jj",
 *   documento: {salidaBodega: string|null, guiaTransporte: string|null,
 *               loteProduccion: string|null, canales: number|null},
 *   advertencias: Array<{codigo: string, mensaje: string}>
 * }}
 */
export function parsearInformeDesposteJJ(texto) {
  const advertencias = [];

  const lineas = String(texto ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  // ─── Página 1: la tabla de salida de bodega ─────────────────────────────
  const items = [];
  let totalImpreso = null;
  let observaciones = null;
  let documentoSalida = null;
  let fechaCruda = null;
  let orden = 0;

  for (const linea of lineas) {
    const item = LINEA_ITEM.exec(linea);
    if (item && totalImpreso === null) {
      items.push({
        bloque: BLOQUE_CORTES,
        producto: item[2].trim(),
        cantidadKg: aNumeroLatino(item[4]) ?? 0,
        pesajes: aNumeroLatino(item[5]),
        // El documento no trae rendimiento ni promedio por línea, a diferencia
        // del informe de VisualERP: no se inventan.
        rendimientoPct: null,
        promedioKg: null,
        orden: orden++,
      });
      continue;
    }

    const total = LINEA_TOTAL.exec(linea);
    if (total && totalImpreso === null && items.length > 0) {
      totalImpreso = { kg: aNumeroLatino(total[1]), pesajes: aNumeroLatino(total[2]) };
      continue;
    }

    observaciones ??= capturar(linea, LINEA_OBSERVACIONES);
    documentoSalida ??= capturar(linea, LINEA_DOCUMENTO);
    fechaCruda ??= capturar(linea, LINEA_FECHA);
  }

  // ─── Página 2: la guía de transporte (especie + contraste opcional) ─────
  let guiaTransporte = null;
  let razonSocial = null;
  let especie = null;
  const kgPorProductoGuia = new Map();

  for (const linea of lineas) {
    guiaTransporte ??= capturar(linea, LINEA_GUIA_TRANSPORTE);
    razonSocial ??= capturar(linea, LINEA_RAZON_SOCIAL);

    const producto = LINEA_GUIA_PRODUCTO.exec(linea);
    if (producto) {
      especie ??= ESPECIE_DESDE_GUIA[producto[1].toUpperCase()] ?? null;
      kgPorProductoGuia.set(normalizarNombreLocal(producto[2]), aNumeroLatino(producto[4]));
    }
  }

  // ─── Autocontrol: la suma de líneas contra el "Total" impreso ───────────
  //
  // Igual razón que en desposteParser.js: si un renglón no matchea el día que
  // J&J cambie una columna, esto avisa antes de que alguien salga a buscar
  // carne que en realidad está mal leída, no faltante.
  const loteProduccion = items.length > 0 ? loteProduccionDe(lineas) : null;
  const canales = aNumeroLatino(capturar(observaciones || "", CANALES_EN_OBSERVACIONES));
  const sumaItems = items.reduce((acc, i) => acc + i.cantidadKg, 0);
  if (totalImpreso?.kg !== null && totalImpreso?.kg !== undefined) {
    const diferencia = Math.abs(sumaItems - totalImpreso.kg);
    if (diferencia > TOLERANCIA_SUMA_KG) {
      advertencias.push({
        codigo: "total_no_cuadra",
        mensaje:
          `La guía dice ${totalImpreso.kg} kg en total pero las líneas leídas suman ` +
          `${Math.round(sumaItems * 1000) / 1000} kg. Probablemente el formato de la ` +
          "guía cambió y hay renglones sin leer.",
      });
    }
  }

  // ─── Contraste opcional contra la página 2 ──────────────────────────────
  //
  // Es un chequeo de más, no la fuente de verdad: la página 1 manda (ver
  // encabezado del archivo). Si algún producto no cuadra, se avisa y se sigue —
  // un PDF mal extraído no puede frenar una recepción real.
  for (const i of items) {
    const kgGuia = kgPorProductoGuia.get(normalizarNombreLocal(i.producto));
    if (kgGuia === undefined || kgGuia === null) continue;
    if (Math.abs(kgGuia - i.cantidadKg) > TOLERANCIA_CRUCE_PAGINAS_KG) {
      advertencias.push({
        codigo: "guia_transporte_no_cuadra",
        mensaje:
          `"${i.producto}" pesa ${i.cantidadKg} kg en la tabla de salida y ${kgGuia} kg ` +
          "en la guía de transporte (página 2). Puede ser un error de digitación de J&J.",
      });
    }
  }

  if (items.length === 0) {
    advertencias.push({
      codigo: "sin_lineas",
      mensaje:
        "No se pudo leer ningún producto del PDF. Si el archivo es un escaneo o " +
        "una foto, no tiene texto que extraer: hay que adjuntar el PDF original " +
        "del frigorífico.",
    });
  }
  if (!observaciones) {
    advertencias.push({
      codigo: "sin_subcliente",
      mensaje:
        'La guía no trae la línea "Observaciones", así que no se puede verificar a ' +
        "qué sede corresponde.",
    });
  }
  if (!documentoSalida) {
    advertencias.push({
      codigo: "sin_lote",
      mensaje:
        'La guía no trae la línea "No." con el documento de salida de bodega, así ' +
        "que no se puede detectar si ya se adjuntó en otra recepción.",
    });
  }

  return {
    // El documento de salida de bodega ("No. MQ0000xxxx"), NO el lote de
    // producción de la columna "Lote". Ver la nota de cabecera de este
    // archivo: es el que cumple el mismo rol que "Documento Cliente" en el
    // informe de VisualERP —un documento por entrega— y el único de los dos
    // que no choca contra el índice único de `carnes_desposte_informes.lote`
    // cuando varias sedes comparten lote de producción el mismo día.
    lote: documentoSalida,
    fechaDesposte: aFechaISO(fechaCruda),
    // No hay un "Cliente" de frigorífico como en VisualERP (ahí es un código
    // interno del frigorífico); lo más parecido que trae este documento es
    // quién lo emite.
    cliente: razonSocial,
    // El nombre de la sede tal como lo escribe J&J en "Observaciones"
    // ("LOPEZ 6 CANALES"), completo. `verificarIdentidad()` NO lo compara
    // contra `carnes_sedes.subcliente_desposte` para este formato —esa
    // comparación es la nomenclatura de VisualERP y daría falsos positivos—
    // así que acá no importa si se recorta o no; se deja completo porque es
    // justamente el dato que el admin necesita leer para verificar a ojo.
    subcliente: observaciones,
    animales: null, // el documento no lo declara
    items,
    totales: {
      kgFinas: totalImpreso?.kg ?? (items.length > 0 ? Math.round(sumaItems * 1000) / 1000 : null),
      kgSubproductos: null, // no existen subproductos en este formato
      kgPesoPie: null,
      kgCanalCaliente: null,
      kgCanalFria: null,
      kgDesposte: null,
      kgAprovechable: null,
      rendimientoPct: null,
      mermaKg: null,
      mermaPct: null,
    },
    especie,
    formato: "jj",
    documento: { salidaBodega: documentoSalida, guiaTransporte, loteProduccion, canales },
    advertencias,
  };
}

/** Primer grupo capturado de `re` sobre `texto`, o null. */
function capturar(texto, re) {
  const m = re.exec(texto);
  return m ? m[1].trim() : null;
}

/** El lote de producción es el mismo en todas las líneas; se toma de la primera. */
function loteProduccionDe(lineas) {
  for (const linea of lineas) {
    const item = LINEA_ITEM.exec(linea);
    if (item) return item[3];
  }
  return null;
}

/**
 * Normaliza un nombre de producto SOLO para casar la página 1 contra la
 * página 2 dentro de este archivo. No es `normalizarNombre()` de
 * `desposteParser.js` a propósito —evita el import circular por una función
 * de una línea— pero hace exactamente lo mismo.
 */
function normalizarNombreLocal(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}
