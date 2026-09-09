/**
 * Parser del "Informe Rendimiento por Documento y Mermas Desposte".
 *
 * Módulo PURO: entra el TEXTO ya extraído del PDF, sale un objeto. No abre
 * archivos, no toca Supabase, no sabe qué es un PDF. Esa separación es lo único
 * que permite testearlo contra el informe real del frigorífico (ver
 * test/fixtures/) sin montar nada.
 *
 * ─── De dónde sale el texto ───────────────────────────────────────────────
 *
 * El informe lo emite VisualERP y se imprime a PDF desde el navegador: es texto
 * de verdad, no un escaneo. `services/pdf.service.js` lo extrae con `unpdf` y se
 * lo pasa acá. Si algún día llegara escaneado, este parser devolvería vacío y la
 * advertencia `sin_lineas` lo diría en vez de guardar ceros en silencio.
 *
 * ─── La forma del informe ─────────────────────────────────────────────────
 *
 *   Fecha Desposte: 28/08/2026
 *   Cliente: 380 - JULIO ARBOLEDA SIERRA
 *   Sub Cliente: MK - 380 - BARRIO LOPEZ      <- la SEDE
 *   Documento Cliente : 13526305              <- el LOTE
 *   FINAS
 *     CARNE PARA MOLER 4.49 2 2.48 % 4.49     <- producto kg pesajes rto% promedio
 *     ...
 *     TOTAL 133.50 46 73.68
 *   SUBPRODUCTOS
 *     HUESO BLANCO 35.60 1 19.65 % 35.60
 *     ...
 *     TOTAL 47.33 5 26.12
 *   Total Peso En Pie 352.0
 *   ...
 *
 * ─── Los números ──────────────────────────────────────────────────────────
 *
 * El reporte usa formato inglés: PUNTO decimal ("133.50", "0.20 %"). Una coma,
 * si aparece, es separador de miles. Al revés de lo que hace el resto de este
 * sistema —donde el admin escribe "1.234,50"— así que la conversión NO se
 * comparte con `utils/formato.js` del frontend a propósito: son dos idiomas
 * numéricos distintos y mezclarlos convertiría 133.50 kg en 13350.
 */

/** El bloque de cortes aprovechables. Es el que se cruza contra la recepción. */
export const BLOQUE_FINAS = "finas";

/**
 * Hueso, sebo, despojos. Se parsea y se guarda, pero NO se concilia todavía:
 * falta definir con la operación si el recibidor los pesa como vísceras o como
 * carne. Hasta que eso esté claro, mostrarlos sumados sería inventar una regla.
 */
export const BLOQUE_SUBPRODUCTOS = "subproductos";

/** Encabezados de sección, tal cual salen en el PDF. */
const SECCIONES = {
  FINAS: BLOQUE_FINAS,
  SUBPRODUCTOS: BLOQUE_SUBPRODUCTOS,
};

/**
 * Pie de página del reporte. Se cuela EN MEDIO de la tabla —el bloque de
 * subproductos del informe de López está partido por el salto de página— así que
 * no alcanza con recortar el final: hay que descartarlo línea por línea.
 */
const ES_PIE_DE_PAGINA = [
  /^Page\s+\d+\s+of\s+\d+/i,
  /VisualERP\/FrigoGanaderia/i,
  /^\d{1,2}\/\d{1,2}\/\d{4}https?:/i,
];

/**
 * `PRODUCTO  cantidad  pesajes  rendimiento %  promedio`
 *
 * El nombre es no-codicioso y los cinco grupos están anclados al final de la
 * línea. Eso es lo que permite que "ROMPE MALAYA - RILA 0.72 1 0.40 % 0.72"
 * parsee bien: el guión del nombre no puede confundirse con una columna porque
 * detrás de él no hay cuatro números.
 */
const LINEA_ITEM = /^(.+?)\s+(-?[\d.,]+)\s+(\d+)\s+(-?[\d.,]+)\s*%\s+(-?[\d.,]+)$/;

/** `TOTAL 133.50 46 73.68` — cierra una sección. Sin `%`, por eso no es un item. */
const LINEA_TOTAL_SECCION = /^TOTAL\s+(-?[\d.,]+)\s+(\d+)\s+(-?[\d.,]+)\s*$/i;

/**
 * Tolerancia al comparar el TOTAL impreso contra la suma de las líneas.
 * 10 gramos: el informe redondea a dos decimales, así que sumar 40 renglones
 * puede desviarse unos centésimos sin que falte nada.
 */
const TOLERANCIA_SUMA_KG = 0.01;

/**
 * Convierte un número del informe (formato inglés) a `Number`.
 * Devuelve `null` —no 0— cuando no hay dato: un total ausente y un total de cero
 * son cosas distintas, y confundirlas haría que el cruce diga "faltan 133 kg".
 */
export function aNumero(texto) {
  if (texto === null || texto === undefined) return null;
  const limpio = String(texto).replace(/,/g, "").trim();
  if (!limpio) return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normaliza un nombre de producto para poder compararlo.
 *
 * Sin acentos, sin dobles espacios, en mayúsculas. Se usa SOLO para casar el
 * nombre del PDF con `carnes_plantilla_items.nombre_desposte`; lo que se guarda
 * y se le muestra al admin es siempre el texto original, porque "ENTRAÑITAS" es
 * lo que dice el papel que tiene en la mano.
 */
export function normalizarNombre(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** `28/08/2026` → `2026-08-28`. Devuelve null si no es una fecha del reporte. */
export function aFechaISO(texto) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(texto ?? "").trim());
  if (!m) return null;
  const [, d, mes, a] = m;
  return `${a}-${mes.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Primer grupo capturado de `re` sobre `texto`, o null. */
const capturar = (texto, re) => {
  const m = re.exec(texto);
  return m ? m[1].trim() : null;
};

/**
 * Lee el informe.
 *
 * @param {string} texto Texto plano extraído del PDF.
 * @returns {{
 *   lote: string|null, fechaDesposte: string|null, cliente: string|null,
 *   subcliente: string|null, animales: number|null,
 *   items: Array<{bloque: string, producto: string, cantidadKg: number,
 *                 pesajes: number|null, rendimientoPct: number|null,
 *                 promedioKg: number|null, orden: number}>,
 *   totales: object, advertencias: Array<{codigo: string, mensaje: string}>
 * }}
 */
export function parsearInformeDesposte(texto) {
  const advertencias = [];

  const lineas = String(texto ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .filter((l) => !ES_PIE_DE_PAGINA.some((re) => re.test(l)));

  // ─── Cabecera ───────────────────────────────────────────────────────────
  //
  // Se busca por línea y no sobre el texto entero por una razón concreta:
  // `/Cliente\s*:/` también matchea dentro de "Sub Cliente:" y de "Documento
  // Cliente :". Anclando al principio de la línea, cada uno cae donde debe.
  let cliente = null;
  let subcliente = null;
  let lote = null;
  let fechaCruda = null;

  for (const linea of lineas) {
    cliente ??= capturar(linea, /^Cliente\s*:\s*(.+)$/i);
    subcliente ??= capturar(linea, /^Sub\s*Cliente\s*:\s*(.+)$/i);
    lote ??= capturar(linea, /^Documento\s*Cliente\s*:\s*(.+)$/i);
    fechaCruda ??= capturar(linea, /^Fecha\s*Desposte\s*:\s*(.+)$/i);
  }

  // "Cantidad Animales" viene partido en dos líneas por el ancho de la columna,
  // así que este sí se busca sobre el texto unido.
  const unido = lineas.join(" ");
  const animales = aNumero(
    capturar(unido, /Cantidad Animales\s*\(Ingreso Desposte\)\s*:\s*([\d.,]+)/i),
  );

  // ─── Renglones ──────────────────────────────────────────────────────────
  const items = [];
  const totalesSeccion = {};
  let bloque = null;
  let orden = 0;

  for (const linea of lineas) {
    const seccion = SECCIONES[linea.toUpperCase()];
    if (seccion) {
      bloque = seccion;
      orden = 0;
      continue;
    }
    if (!bloque) continue;

    const total = LINEA_TOTAL_SECCION.exec(linea);
    if (total) {
      totalesSeccion[bloque] = {
        kg: aNumero(total[1]),
        pesajes: aNumero(total[2]),
        rendimientoPct: aNumero(total[3]),
      };
      bloque = null; // el TOTAL cierra la sección
      continue;
    }

    const item = LINEA_ITEM.exec(linea);
    if (!item) continue;

    items.push({
      bloque,
      producto: item[1].trim(),
      cantidadKg: aNumero(item[2]) ?? 0,
      pesajes: aNumero(item[3]),
      rendimientoPct: aNumero(item[4]),
      promedioKg: aNumero(item[5]),
      orden: orden++,
    });
  }

  // ─── Totales del pie ────────────────────────────────────────────────────
  //
  // Las etiquetas vienen partidas en dos líneas ("Total Peso Canal Fria" /
  // "(Ingreso Desposte) 181.2"), por eso se busca sobre el texto unido.
  //
  // Ojo con "Total Peso Desposte": hay dos renglones que empiezan igual y el de
  // abajo es "Aprovechable (TCA)". La primera regex no lo pisa porque exige un
  // número inmediatamente después, y ahí lo que sigue es una palabra.
  const totales = {
    animales: aNumero(capturar(unido, /Total Animales\s+([\d.,]+)/i)),
    kgPesoPie: aNumero(capturar(unido, /Total Peso En Pie\s+([\d.,]+)/i)),
    kgCanalCaliente: aNumero(capturar(unido, /Total Peso Canal Caliente\s+([\d.,]+)/i)),
    kgCanalFria: aNumero(
      capturar(unido, /Total Peso Canal Fria\s*\(Ingreso Desposte\)\s+([\d.,]+)/i),
    ),
    kgDesposte: aNumero(capturar(unido, /Total Peso Desposte\s+([\d.,]+)/i)),
    kgAprovechable: aNumero(
      capturar(unido, /Total Peso Desposte\s*Aprovechable\s*\(TCA\)\s+([\d.,]+)/i),
    ),
    rendimientoPct: aNumero(capturar(unido, /Rendimiento Canal a\s*Carne\s+([\d.,]+)/i)),
    mermaKg: aNumero(capturar(unido, /Merma en Kilogramos\s+([\d.,]+)/i)),
    mermaPct: aNumero(capturar(unido, /Merma en Porcentaje\s+([\d.,]+)/i)),
    kgFinas: totalesSeccion[BLOQUE_FINAS]?.kg ?? null,
    kgSubproductos: totalesSeccion[BLOQUE_SUBPRODUCTOS]?.kg ?? null,
  };

  // ─── Autocontrol ────────────────────────────────────────────────────────
  //
  // El informe trae su propio total impreso por sección. Si la suma de las
  // líneas que este parser leyó no da eso, es que se perdió un renglón — y un
  // renglón perdido es carne que el cruce daría por faltante sin que falte.
  //
  // Este chequeo es el que va a avisar el día que el frigorífico cambie el
  // formato del reporte. Sin él, un cambio de formato se manifestaría como un
  // faltante de kilos y alguien saldría a buscar carne que está en la cava.
  for (const [nombreBloque, total] of Object.entries(totalesSeccion)) {
    if (total.kg === null) continue;
    const suma = items
      .filter((i) => i.bloque === nombreBloque)
      .reduce((acc, i) => acc + i.cantidadKg, 0);
    const diferencia = Math.abs(suma - total.kg);
    if (diferencia > TOLERANCIA_SUMA_KG) {
      advertencias.push({
        codigo: "total_no_cuadra",
        mensaje:
          `En "${nombreBloque.toUpperCase()}" el informe dice ${total.kg} kg pero ` +
          `las líneas leídas suman ${Math.round(suma * 1000) / 1000} kg. ` +
          "Probablemente el formato del reporte cambió y hay renglones sin leer.",
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
  if (!subcliente) {
    advertencias.push({
      codigo: "sin_subcliente",
      mensaje:
        'El informe no trae la línea "Sub Cliente", así que no se puede verificar ' +
        "a qué sede corresponde.",
    });
  }
  if (!lote) {
    advertencias.push({
      codigo: "sin_lote",
      mensaje:
        'El informe no trae "Documento Cliente", así que no se puede detectar si ' +
        "este mismo lote ya se adjuntó en otra recepción.",
    });
  }

  return {
    lote,
    fechaDesposte: aFechaISO(fechaCruda),
    cliente,
    subcliente,
    animales: animales ?? totales.animales,
    items,
    totales,
    advertencias,
  };
}
