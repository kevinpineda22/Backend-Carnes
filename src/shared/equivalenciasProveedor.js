/* =============================================
   Normalizador del Excel "Equivalencias" de proveedores.

   Puro: recibe las filas de una hoja como ARREGLO DE ARREGLOS (lo que entrega
   `XLSX.utils.sheet_to_json(hoja, { header: 1 })`) y devuelve filas listas para
   `carnes_proveedor_equivalencias`, más el reporte de lo que se descartó y por
   qué. No lee archivos ni toca la base: lo usan el script de siembra
   (`scripts/seed-proveedores.js`) y, más adelante, el endpoint de carga de
   plantilla, y por eso se prueba una sola vez acá.

   ─── Lo que ya mordió del Excel real ───────────────────────────────────────

   · Las columnas NO están siempre en el mismo lugar. La hoja de Bucanero trae
     `U.M.` al final y no trae `Equivalencia`. Por eso las columnas se buscan por
     el NOMBRE del encabezado, nunca por posición.

   · Todo viene con relleno: el NIT con espacios al final ("901261672      "), la
     descripción y la U.M. rellenas a ancho fijo ("KL  "). Se recorta todo.

   · El `Item` llega como NÚMERO (15134) y en la base es texto (el f120_id).

   · La hoja de Nutresa reporta ~1M de filas "con formato" y solo 37 con datos.
     Quien lee el archivo debe acotar la lectura (`TOPE_FILAS_EXCEL`) y este módulo
     se detiene en la ÚLTIMA fila con algo, no en el final de la hoja.

   · "Sin equivalencia" es un dato válido (`equivalencia = ''`): el renglón se
     recibe y se envía a SIESA igual; solo cambia cómo se muestra.

   · La unidad que no es KL ni UND NO se adivina: la fila se rechaza y se reporta.
     (KG se homologa a KL con `normalizarUnidad`, igual que en el resto del módulo.)
   ============================================= */

import { normalizarUnidad, unidadValida, UNIDADES_VALIDAS } from "./proveedorValores.js";

/**
 * Cuántas filas se le piden a SheetJS (`sheetRows`). Sin tope, la hoja de Nutresa
 * obliga a materializar un millón de filas vacías.
 */
export const TOPE_FILAS_EXCEL = 2000;

/** Anchos de las columnas de sql/022. Un valor más largo rompe el INSERT entero. */
export const LIMITES = {
  codigo_item: 20,
  descripcion_item: 160,
  unidad: 4,
  equivalencia: 160,
  nit: 15,
  sucursal: 3,
  razon_social: 160,
  desc_sucursal: 120,
};

/** Cuántas filas desde arriba se miran buscando el encabezado. */
const FILAS_PARA_ENCABEZADO = 10;

/** Piso para que un nombre de hoja cuente como PREFIJO de una razón social. */
const LARGO_MINIMO_PREFIJO = 5;

// ─── Celdas ────────────────────────────────────────────────────────────────

/** Texto recortado de una celda. Espacios duros (Excel los mete) cuentan como espacio. */
function texto(celda) {
  if (celda === null || celda === undefined) return "";
  return String(celda).replace(/ /g, " ").trim();
}

/**
 * Identificador numérico que Excel entrega como número (Item, NIT): 15134 →
 * "15134". Un número con decimales NO se trunca en silencio: devuelve `null`, y
 * quien llama lo reporta (truncar 15134.5 a 15134 sería apuntar a OTRO producto).
 */
function identificador(celda) {
  if (typeof celda === "number") {
    return Number.isInteger(celda) && celda >= 0 ? String(celda) : null;
  }
  return texto(celda);
}

function filaVacia(fila) {
  return !Array.isArray(fila) || fila.every((c) => texto(c) === "");
}

/** Índice de la última fila con algún dato, o -1. */
function ultimaFilaConDatos(filas) {
  for (let i = filas.length - 1; i >= 0; i--) {
    if (!filaVacia(filas[i])) return i;
  }
  return -1;
}

/**
 * "Razón social proveedor" → "RAZONSOCIALPROVEEDOR". Sin acentos, sin puntos ni
 * espacios: el encabezado del Excel lo escribe una persona ("Desc. item",
 * "U.M.") y no hay que depender de cómo puso la puntuación.
 */
function claveColumna(celda) {
  return texto(celda)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Busca la fila de encabezado y devuelve `{ indiceFila, columnas }` con
 * `columnas[CLAVE] = índice`. La primera columna con un nombre gana (la hoja de
 * Bucanero trae una columna sin nombre que no debe pisar nada).
 *
 * Es encabezado la primera fila que contenga TODAS las claves `requeridas`.
 */
function buscarEncabezado(filas, requeridas, ultima) {
  const tope = Math.min(ultima, FILAS_PARA_ENCABEZADO - 1);
  for (let i = 0; i <= tope; i++) {
    const columnas = {};
    (filas[i] || []).forEach((celda, j) => {
      const clave = claveColumna(celda);
      if (clave && columnas[clave] === undefined) columnas[clave] = j;
    });
    if (requeridas.every((r) => columnas[r] !== undefined)) {
      return { indiceFila: i, columnas };
    }
  }
  return null;
}

/** Sucursal a 3 dígitos ("1" → "001"); vacía → "001", el valor de la base. */
function normalizarSucursal(celda) {
  const s = identificador(celda);
  if (s === null) return null;
  return (s === "" ? "001" : s).padStart(LIMITES.sucursal, "0");
}

// ─── Hoja de equivalencias (plantilla de un proveedor) ─────────────────────

/**
 * @typedef {object} FilaEquivalencia
 * @property {string} codigo_item       f120_id de SIESA, como texto
 * @property {string|null} descripcion_item
 * @property {string} unidad            'KL' | 'UND'
 * @property {string} equivalencia      '' = "Sin equivalencia"
 * @property {number} orden             1.. en el orden de la hoja (tras deduplicar)
 */

/**
 * Normaliza la hoja de UN proveedor.
 *
 * @param {Array<Array<unknown>>} filas  hoja completa, encabezado incluido
 * @param {{ topeFilas?: number }} [opciones]
 *        `topeFilas`: el `sheetRows` con el que se leyó. Si hay datos pegados a
 *        ese tope se avisa que la hoja pudo quedar cortada.
 * @returns {{
 *   ok: boolean,
 *   filas: FilaEquivalencia[],
 *   rechazadas: Array<{ fila: number, codigo_item: string, motivo: string }>,
 *   advertencias: string[],
 *   errores: string[],
 *   terceros: Array<{ nit: string, sucursal: string|null }>,
 *   resumen: {
 *     leidas: number, validas: number, sin_equivalencia: number,
 *     duplicadas: number, rechazadas: number, unidades_invalidas: number,
 *     sin_item: number,
 *   },
 * }}
 *   `ok` es false solo cuando la hoja no se pudo interpretar (vacía, sin
 *   columnas obligatorias). Filas sueltas rechazadas NO lo vuelven false: van en
 *   `rechazadas` para que quien carga decida.
 */
export function normalizarHojaEquivalencias(filas, { topeFilas } = {}) {
  const salida = {
    ok: false,
    filas: [],
    rechazadas: [],
    advertencias: [],
    errores: [],
    terceros: [],
    resumen: {
      leidas: 0,
      validas: 0,
      sin_equivalencia: 0,
      duplicadas: 0,
      rechazadas: 0,
      unidades_invalidas: 0,
      sin_item: 0,
    },
  };

  const lista = Array.isArray(filas) ? filas : [];
  const ultima = ultimaFilaConDatos(lista);
  if (ultima < 0) {
    salida.errores.push("La hoja está vacía.");
    return salida;
  }

  const enc = buscarEncabezado(lista, ["ITEM", "UM"], ultima);
  if (!enc) {
    salida.errores.push(
      'No se encontró el encabezado: la hoja necesita las columnas "Item" y "U.M.".',
    );
    return salida;
  }
  const { indiceFila, columnas } = enc;
  if (columnas.DESCITEM === undefined) {
    salida.advertencias.push(
      'La hoja no trae la columna "Desc. item": los renglones sin equivalencia se mostrarán sin nombre.',
    );
  }
  if (topeFilas && ultima + 1 >= topeFilas) {
    salida.advertencias.push(
      `Hay datos hasta la fila ${ultima + 1}, pegados al tope de lectura (${topeFilas}): la hoja pudo quedar cortada.`,
    );
  }

  const celdaDe = (fila, clave) =>
    columnas[clave] === undefined ? undefined : fila[columnas[clave]];
  const vistas = new Set();
  const terceros = new Map();

  for (let i = indiceFila + 1; i <= ultima; i++) {
    const fila = lista[i];
    if (filaVacia(fila)) continue;
    const numeroFila = i + 1; // como lo ve quien abre el Excel

    const item = identificador(celdaDe(fila, "ITEM"));
    if (item === "") {
      // Hay datos en otras columnas pero no el Item: no hay a qué producto de
      // SIESA apuntar. Se cuenta aparte y no se rechaza como error de dato.
      salida.resumen.sin_item++;
      continue;
    }
    salida.resumen.leidas++;

    const rechazar = (motivo) => {
      salida.rechazadas.push({ fila: numeroFila, codigo_item: String(item ?? ""), motivo });
      salida.resumen.rechazadas++;
    };

    if (item === null) {
      rechazar("El Item no es un código entero.");
      continue;
    }
    if (/\s/.test(item)) {
      rechazar("El Item trae espacios.");
      continue;
    }
    if (item.length > LIMITES.codigo_item) {
      rechazar(`El Item supera los ${LIMITES.codigo_item} caracteres.`);
      continue;
    }

    const unidadCruda = texto(celdaDe(fila, "UM"));
    if (unidadCruda === "") {
      salida.resumen.unidades_invalidas++;
      rechazar("Falta la unidad de medida.");
      continue;
    }
    const unidad = normalizarUnidad(unidadCruda);
    if (unidad.length > LIMITES.unidad) {
      salida.resumen.unidades_invalidas++;
      rechazar(`La unidad "${unidadCruda}" es demasiado larga.`);
      continue;
    }
    if (!unidadValida(unidad)) {
      salida.resumen.unidades_invalidas++;
      rechazar(
        `La unidad "${unidadCruda}" no está soportada (solo ${UNIDADES_VALIDAS.join(" o ")}).`,
      );
      continue;
    }

    const descripcion = texto(celdaDe(fila, "DESCITEM"));
    if (descripcion.length > LIMITES.descripcion_item) {
      rechazar(`La descripción supera los ${LIMITES.descripcion_item} caracteres.`);
      continue;
    }
    const equivalencia = texto(celdaDe(fila, "EQUIVALENCIA"));
    if (equivalencia.length > LIMITES.equivalencia) {
      rechazar(`La equivalencia supera los ${LIMITES.equivalencia} caracteres.`);
      continue;
    }

    // Los terceros se anotan incluso si la fila se descarta por repetida: es
    // para detectar que la hoja trae un NIT distinto al del maestro.
    const nit = identificador(celdaDe(fila, "PROVEEDOR"));
    if (nit) {
      const sucursal = normalizarSucursal(celdaDe(fila, "SUCURSAL"));
      terceros.set(`${nit}|${sucursal}`, { nit, sucursal });
    }

    // La llave es la MISMA del UNIQUE de la base. Repetirla en un solo upsert
    // haría que Postgres falle ("cannot affect row a second time") y se pierda la
    // hoja entera por una fila duplicada. Se conserva la primera.
    const llave = claveFila({ codigo_item: item, unidad, equivalencia });
    if (vistas.has(llave)) {
      salida.resumen.duplicadas++;
      continue;
    }
    vistas.add(llave);

    salida.filas.push({
      codigo_item: item,
      descripcion_item: descripcion || null,
      unidad,
      equivalencia,
      orden: salida.filas.length + 1,
    });
    if (equivalencia === "") salida.resumen.sin_equivalencia++;
  }

  salida.resumen.validas = salida.filas.length;
  salida.terceros = [...terceros.values()];
  salida.ok = true;
  return salida;
}

// ─── Hoja maestra de proveedores ───────────────────────────────────────────

/**
 * Normaliza la hoja del maestro ("proveedores mientras"): Proveedor (NIT),
 * Razón social proveedor, Sucursal, Desc. sucursal.
 *
 * @returns {{
 *   ok: boolean,
 *   proveedores: Array<{ nit: string, sucursal: string, razon_social: string, desc_sucursal: string|null }>,
 *   rechazadas: Array<{ fila: number, motivo: string }>,
 *   advertencias: string[],
 *   errores: string[],
 * }}
 */
export function normalizarHojaProveedores(filas, { topeFilas } = {}) {
  const salida = { ok: false, proveedores: [], rechazadas: [], advertencias: [], errores: [] };

  const lista = Array.isArray(filas) ? filas : [];
  const ultima = ultimaFilaConDatos(lista);
  if (ultima < 0) {
    salida.errores.push("La hoja de proveedores está vacía.");
    return salida;
  }
  const enc = buscarEncabezado(lista, ["PROVEEDOR", "RAZONSOCIALPROVEEDOR"], ultima);
  if (!enc) {
    salida.errores.push(
      'No se encontró el encabezado: la hoja necesita "Proveedor" y "Razón social proveedor".',
    );
    return salida;
  }
  const { indiceFila, columnas } = enc;
  if (topeFilas && ultima + 1 >= topeFilas) {
    salida.advertencias.push(
      `Hay datos hasta la fila ${ultima + 1}, pegados al tope de lectura (${topeFilas}): la hoja pudo quedar cortada.`,
    );
  }
  const celdaDe = (fila, clave) =>
    columnas[clave] === undefined ? undefined : fila[columnas[clave]];
  const vistos = new Set();

  for (let i = indiceFila + 1; i <= ultima; i++) {
    const fila = lista[i];
    if (filaVacia(fila)) continue;
    const numeroFila = i + 1;
    const rechazar = (motivo) => salida.rechazadas.push({ fila: numeroFila, motivo });

    const nit = identificador(celdaDe(fila, "PROVEEDOR"));
    const razon = texto(celdaDe(fila, "RAZONSOCIALPROVEEDOR"));
    if (nit === null) {
      rechazar("El NIT no es un número entero.");
      continue;
    }
    if (nit === "") {
      rechazar("Falta el NIT.");
      continue;
    }
    if (nit.length > LIMITES.nit) {
      rechazar(`El NIT supera los ${LIMITES.nit} caracteres.`);
      continue;
    }
    if (razon === "") {
      rechazar("Falta la razón social.");
      continue;
    }
    if (razon.length > LIMITES.razon_social) {
      rechazar(`La razón social supera los ${LIMITES.razon_social} caracteres.`);
      continue;
    }
    const sucursal = normalizarSucursal(celdaDe(fila, "SUCURSAL"));
    if (sucursal === null || sucursal.length > LIMITES.sucursal) {
      rechazar("La sucursal no es válida.");
      continue;
    }
    const descSucursal = texto(celdaDe(fila, "DESCSUCURSAL"));
    if (descSucursal.length > LIMITES.desc_sucursal) {
      rechazar(`La descripción de sucursal supera los ${LIMITES.desc_sucursal} caracteres.`);
      continue;
    }
    if (!/^\d+$/.test(nit)) {
      salida.advertencias.push(`Fila ${numeroFila}: el NIT "${nit}" no es solo dígitos.`);
    }

    const llave = `${nit}|${sucursal}`;
    if (vistos.has(llave)) {
      salida.advertencias.push(`Fila ${numeroFila}: NIT ${nit} sucursal ${sucursal} repetido; se conserva el primero.`);
      continue;
    }
    vistos.add(llave);
    salida.proveedores.push({
      nit,
      sucursal,
      razon_social: razon,
      desc_sucursal: descSucursal || null,
    });
  }

  salida.ok = true;
  return salida;
}

// ─── Hoja ↔ proveedor ──────────────────────────────────────────────────────

/**
 * Forma comparable de un nombre: mayúsculas, sin acentos, puntuación como espacio
 * y espacios colapsados. "S.A.S." y "S A S" quedan iguales.
 */
export function normalizarNombre(nombre) {
  return texto(nombre)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Busca a qué proveedor del maestro pertenece una hoja, por su NOMBRE.
 *
 * Excel corta los nombres de hoja a 31 caracteres ("COMERCIALIZADORA DE
 * REFRIGERADO" es "COMERCIALIZADORA DE REFRIGERADOS NUTRESA SAS" cortada), así que
 * si no hay coincidencia exacta se acepta que el nombre de hoja sea PREFIJO de la
 * razón social. Dos candidatos no son una coincidencia: son una ambigüedad y se
 * reporta, nunca se elige uno.
 *
 * @returns {{ estado: 'ok', proveedor: object }
 *          | { estado: 'ambigua', candidatos: object[] }
 *          | { estado: 'sin_proveedor' }}
 */
export function buscarProveedorDeHoja(nombreHoja, proveedores) {
  const hoja = normalizarNombre(nombreHoja);
  if (!hoja) return { estado: "sin_proveedor" };

  const conNombre = proveedores.map((p) => ({ p, n: normalizarNombre(p.razon_social) }));
  const resolver = (candidatos) =>
    candidatos.length === 1
      ? { estado: "ok", proveedor: candidatos[0].p }
      : { estado: "ambigua", candidatos: candidatos.map((c) => c.p) };

  const exactos = conNombre.filter((c) => c.n === hoja);
  if (exactos.length > 0) return resolver(exactos);

  if (hoja.length >= LARGO_MINIMO_PREFIJO) {
    const prefijo = conNombre.filter((c) => c.n.startsWith(hoja));
    if (prefijo.length > 0) return resolver(prefijo);
  }
  return { estado: "sin_proveedor" };
}

// ─── Respuesta del catálogo ────────────────────────────────────────────────

/**
 * Aplana la respuesta de PostgREST de `GET /proveedores`. El conteo de una
 * relación embebida llega como `carnes_proveedor_equivalencias: [{ count: N }]`
 * (o vacío si no hay filas); se convierte en un número plano para que el front no
 * conozca el nombre de la tabla. Vive acá y no en el modelo para poder probarla
 * sin Supabase.
 */
export function formatearProveedores(filas = []) {
  return filas.map((f) => ({
    id: f.id,
    nit: f.nit,
    sucursal: f.sucursal,
    razon_social: f.razon_social,
    equivalencias_activas: Number(f.carnes_proveedor_equivalencias?.[0]?.count ?? 0),
  }));
}

// ─── Plan de siembra ───────────────────────────────────────────────────────

/** La llave de una fila de plantilla: la misma del UNIQUE de sql/022 sin el proveedor. */
export function claveFila({ codigo_item, unidad, equivalencia }) {
  return JSON.stringify([String(codigo_item), String(unidad), String(equivalencia ?? "")]);
}

/**
 * Ids de equivalencias ACTIVAS que ya no están en la hoja y hay que desactivar.
 * Nunca se borran: las recepciones ya hechas apuntan a su fila.
 *
 * @param {Array<{id:number, codigo_item:string, unidad:string, equivalencia:string, activo:boolean}>} existentes
 * @param {FilaEquivalencia[]} filas
 */
export function idsADesactivar(existentes, filas) {
  const enHoja = new Set(filas.map(claveFila));
  return existentes.filter((e) => e.activo && !enHoja.has(claveFila(e))).map((e) => e.id);
}

/**
 * Arma el plan completo de la siembra a partir de las hojas del libro. Puro:
 * el script solo lee el Excel, imprime esto y, con `--aplicar`, lo escribe.
 *
 * @param {{ hojas: Array<{ nombre: string, filas: Array<Array<unknown>> }>,
 *           nombreMaestro?: string, topeFilas?: number }} entrada
 * @returns {{
 *   ok: boolean,
 *   errores: string[],
 *   advertencias: string[],
 *   proveedores: object[],
 *   rechazadasMaestro: object[],
 *   hojas: Array<{
 *     hoja: string,
 *     estado: 'ok'|'vacia'|'invalida'|'sin_proveedor'|'ambigua'|'repetida',
 *     proveedor: object|null, candidatos?: object[],
 *     normalizada: object|null, advertencias: string[],
 *   }>,
 * }}
 */
export function armarPlanSeed({ hojas, nombreMaestro = "proveedores mientras", topeFilas } = {}) {
  const plan = {
    ok: false,
    errores: [],
    advertencias: [],
    proveedores: [],
    rechazadasMaestro: [],
    hojas: [],
  };

  const clave = normalizarNombre(nombreMaestro);
  const maestra = (hojas || []).find((h) => normalizarNombre(h.nombre) === clave);
  if (!maestra) {
    plan.errores.push(`No se encontró la hoja del maestro de proveedores ("${nombreMaestro}").`);
    return plan;
  }
  const maestro = normalizarHojaProveedores(maestra.filas, { topeFilas });
  if (!maestro.ok) {
    plan.errores.push(...maestro.errores);
    return plan;
  }
  plan.proveedores = maestro.proveedores;
  plan.rechazadasMaestro = maestro.rechazadas;
  plan.advertencias.push(...maestro.advertencias);

  const yaAsignados = new Map(); // "nit|sucursal" → nombre de la hoja
  for (const hoja of hojas) {
    if (hoja === maestra) continue;

    const normalizada = normalizarHojaEquivalencias(hoja.filas, { topeFilas });
    const entrada = {
      hoja: hoja.nombre,
      estado: "ok",
      proveedor: null,
      normalizada,
      advertencias: [...normalizada.advertencias],
    };
    plan.hojas.push(entrada);

    if (!normalizada.ok) {
      // Una hoja sin datos ("Hoja5") no es un problema; una con datos que no se
      // pudo leer sí, y se distingue para que el reporte no grite por la vacía.
      entrada.estado = ultimaFilaConDatos(Array.isArray(hoja.filas) ? hoja.filas : []) < 0
        ? "vacia"
        : "invalida";
      continue;
    }

    const match = buscarProveedorDeHoja(hoja.nombre, plan.proveedores);
    if (match.estado !== "ok") {
      entrada.estado = match.estado;
      if (match.candidatos) entrada.candidatos = match.candidatos;
      continue;
    }
    entrada.proveedor = match.proveedor;

    const llave = `${match.proveedor.nit}|${match.proveedor.sucursal}`;
    if (yaAsignados.has(llave)) {
      entrada.estado = "repetida";
      entrada.advertencias.push(
        `El proveedor ya se cargó desde la hoja "${yaAsignados.get(llave)}"; esta se omite.`,
      );
      continue;
    }
    yaAsignados.set(llave, hoja.nombre);

    // El maestro manda. Un NIT distinto en las filas de la hoja (Sánchez trae
    // 1035425099 y 1035425100) es un dato sucio del Excel: se reporta y se ignora.
    const distintos = normalizada.terceros.filter(
      (t) => t.nit !== match.proveedor.nit || t.sucursal !== match.proveedor.sucursal,
    );
    if (distintos.length > 0) {
      entrada.advertencias.push(
        `Las filas de la hoja traen NIT/sucursal distintos al maestro (se ignoran): ${distintos
          .map((t) => `${t.nit}/${t.sucursal}`)
          .join(", ")}.`,
      );
    }
  }

  plan.ok = true;
  return plan;
}
