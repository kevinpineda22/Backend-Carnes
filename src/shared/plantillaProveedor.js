/* =============================================
   Carga de la plantilla de un proveedor desde el admin.

   Puro: no toca la base ni SheetJS. El admin abre el .xlsx en el navegador,
   manda las filas de UNA hoja como arreglo de arreglos (`sheet_to_json` con
   `header: 1`) y este módulo decide qué pasaría con ellas contra lo que ya hay
   en `carnes_proveedor_equivalencias`. La lectura del Excel y sus reglas (columnas
   por nombre de encabezado, KG → KL, unidades fuera de KL/UND rechazadas, duplicadas,
   anchos) viven en `equivalenciasProveedor.js` y NO se repiten acá: es el mismo
   normalizador que usa la siembra (`scripts/seed-proveedores.js`).

   ─── Qué se hace con las filas ────────────────────────────────────────────

   · Cada fila válida se compara con lo existente por la llave del UNIQUE de
     sql/022 (codigo_item, unidad, equivalencia): nueva / actualizada / sin cambios.
     "Actualizada" es una fila que ya existía pero cambia su descripción, su orden
     o estaba desactivada (se reactiva).
   · Lo que está ACTIVO y ya no viene en la hoja se desactiva, nunca se borra: las
     recepciones ya hechas apuntan a esa fila.
   · Con filas rechazadas NO se desactiva nada (misma regla de la siembra): una fila
     mal escrita en el Excel no puede dar de baja el producto que quería ser.
   · Una hoja sin ninguna fila válida no se aplica: dejaría la plantilla igual de
     vieja pero con la sensación de que se cargó.

   ─── Lo que NO se puede validar acá ────────────────────────────────────────

   Que el Item exista en SIESA. Backend-Carnes no tiene consulta al catálogo de
   ítems de SIESA (solo el conector que ESCRIBE movimientos), así que la carga no
   puede marcar "Item inexistente en SIESA". Un Item equivocado se descubre al
   enviar la entrada.
   ============================================= */

import {
  TOPE_FILAS_EXCEL,
  claveFila,
  idsADesactivar,
  normalizarHojaEquivalencias,
} from "./equivalenciasProveedor.js";

/** Filas que acepta el endpoint: las mismas que se le piden a SheetJS (`sheetRows`). */
export const TOPE_FILAS_CARGA = TOPE_FILAS_EXCEL;

/** Columnas por fila. Las plantillas reales usan 5-8; más que esto es otro archivo. */
export const TOPE_COLUMNAS_CARGA = 60;

export const ESTADOS_FILA = Object.freeze({
  NUEVA: "nueva",
  ACTUALIZADA: "actualizada",
  SIN_CAMBIOS: "sin_cambios",
});

/** Lo que cambia de una fila existente (valores de `cambios`). */
export const CAMBIOS_FILA = Object.freeze({
  DESCRIPCION: "descripcion",
  ORDEN: "orden",
  REACTIVADA: "reactivada",
});

const MENSAJE_SIN_FILAS_VALIDAS =
  "La hoja no tiene ninguna fila válida: no hay nada para guardar.";
const MENSAJE_DESACTIVACION_POR_RECHAZOS =
  "La hoja tiene filas rechazadas: se guardan las válidas pero no se desactiva ninguna fila existente. " +
  "Corregí el Excel y volvé a cargarlo para dar de baja lo que ya no está.";

// ─── Forma de lo recibido ──────────────────────────────────────────────────

/**
 * Valida la FORMA de las filas (no su contenido): arreglo de arreglos de valores
 * simples, con tope de filas y de columnas. El contenido lo juzga el normalizador.
 * Existe además del zod del endpoint para que el modelo no dependa de que alguien
 * lo haya llamado por la ruta.
 *
 * @returns {{ ok: true } | { ok: false, mensaje: string }}
 */
export function validarFormaFilas(filas) {
  if (!Array.isArray(filas)) return { ok: false, mensaje: "Las filas de la hoja no son válidas." };
  if (filas.length === 0) return { ok: false, mensaje: "La hoja está vacía." };
  if (filas.length > TOPE_FILAS_CARGA) {
    return {
      ok: false,
      mensaje: `La hoja trae más de ${TOPE_FILAS_CARGA} filas. Dejá solo la plantilla del proveedor.`,
    };
  }
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    if (!Array.isArray(fila)) {
      return { ok: false, mensaje: `La fila ${i + 1} no es válida.` };
    }
    if (fila.length > TOPE_COLUMNAS_CARGA) {
      return {
        ok: false,
        mensaje: `La fila ${i + 1} trae más de ${TOPE_COLUMNAS_CARGA} columnas.`,
      };
    }
    for (const celda of fila) {
      const tipo = typeof celda;
      if (celda !== null && tipo !== "string" && tipo !== "number" && tipo !== "boolean") {
        return { ok: false, mensaje: `La fila ${i + 1} trae una celda que no es válida.` };
      }
    }
  }
  return { ok: true };
}

// ─── Comparación con lo que ya hay ─────────────────────────────────────────

/** La descripción como se guarda: sin relleno y `null` si quedó vacía. */
function descripcionGuardada(valor) {
  const t = valor === null || valor === undefined ? "" : String(valor).trim();
  return t === "" ? null : t;
}

/**
 * Qué le pasaría a una fila de la hoja frente a la fila existente (o ninguna).
 *
 * @returns {{ estado: string, cambios: string[] }}
 */
function clasificarFila(fila, existente) {
  if (!existente) return { estado: ESTADOS_FILA.NUEVA, cambios: [] };
  const cambios = [];
  if (!existente.activo) cambios.push(CAMBIOS_FILA.REACTIVADA);
  if (descripcionGuardada(existente.descripcion_item) !== descripcionGuardada(fila.descripcion_item)) {
    cambios.push(CAMBIOS_FILA.DESCRIPCION);
  }
  if (Number(existente.orden) !== fila.orden) cambios.push(CAMBIOS_FILA.ORDEN);
  return cambios.length === 0
    ? { estado: ESTADOS_FILA.SIN_CAMBIOS, cambios }
    : { estado: ESTADOS_FILA.ACTUALIZADA, cambios };
}

function describirExistente(e) {
  return {
    id: e.id,
    codigo_item: e.codigo_item,
    descripcion_item: descripcionGuardada(e.descripcion_item),
    unidad: e.unidad,
    equivalencia: e.equivalencia ?? "",
  };
}

/**
 * Plan de la carga: qué pasaría con la hoja frente a lo que hay en la base.
 *
 * @param {{
 *   filas: Array<Array<unknown>>,
 *   existentes?: Array<{ id: number, codigo_item: string, descripcion_item: string|null,
 *                        unidad: string, equivalencia: string, orden: number, activo: boolean }>,
 *   proveedor?: { nit: string, sucursal: string } | null,
 * }} entrada
 *        `existentes`: TODAS las filas del proveedor, activas e inactivas (una
 *        desactivada que vuelve a venir se reactiva en vez de chocar con el UNIQUE).
 *        `proveedor`: solo para avisar si la hoja parece de otro proveedor.
 * @returns {{
 *   ok: boolean, aplicable: boolean, motivo_no_aplicable: string|null,
 *   errores: string[], advertencias: string[],
 *   filas: Array<{ codigo_item: string, descripcion_item: string|null, unidad: string,
 *                  equivalencia: string, orden: number, estado: string, cambios: string[] }>,
 *   rechazadas: Array<{ fila: number, codigo_item: string, motivo: string }>,
 *   a_desactivar: Array<{ id: number, codigo_item: string, descripcion_item: string|null,
 *                         unidad: string, equivalencia: string }>,
 *   desactivacion_omitida: string|null,
 *   resumen: object,
 * }}
 */
export function planearCargaPlantilla({ filas, existentes = [], proveedor = null } = {}) {
  const forma = validarFormaFilas(filas);
  const normalizada = forma.ok
    ? normalizarHojaEquivalencias(filas, { topeFilas: TOPE_FILAS_CARGA })
    : null;

  const plan = {
    ok: false,
    aplicable: false,
    motivo_no_aplicable: null,
    errores: forma.ok ? [...normalizada.errores] : [forma.mensaje],
    advertencias: forma.ok ? [...normalizada.advertencias] : [],
    filas: [],
    rechazadas: [],
    a_desactivar: [],
    desactivacion_omitida: null,
    resumen: {
      leidas: 0,
      validas: 0,
      nuevas: 0,
      actualizadas: 0,
      sin_cambios: 0,
      sin_equivalencia: 0,
      duplicadas: 0,
      rechazadas: 0,
      unidades_invalidas: 0,
      sin_item: 0,
      a_desactivar: 0,
      a_desactivar_omitidas: 0,
    },
  };
  if (!forma.ok || !normalizada.ok) {
    plan.motivo_no_aplicable = plan.errores[0] || null;
    return plan;
  }

  plan.ok = true;
  plan.rechazadas = normalizada.rechazadas;
  Object.assign(plan.resumen, normalizada.resumen);

  const porClave = new Map(existentes.map((e) => [claveFila(e), e]));
  for (const fila of normalizada.filas) {
    const { estado, cambios } = clasificarFila(fila, porClave.get(claveFila(fila)));
    plan.filas.push({ ...fila, estado, cambios });
    if (estado === ESTADOS_FILA.NUEVA) plan.resumen.nuevas++;
    else if (estado === ESTADOS_FILA.ACTUALIZADA) plan.resumen.actualizadas++;
    else plan.resumen.sin_cambios++;
  }

  // La hoja de otro proveedor dejaría la plantilla actual dada de baja. No se
  // bloquea (el Excel de Sánchez trae NIT sucios y es legítimo), pero se avisa.
  if (proveedor && normalizada.terceros.length > 0) {
    const nit = String(proveedor.nit ?? "").trim();
    const coincide = normalizada.terceros.some((t) => t.nit === nit);
    if (!coincide) {
      plan.advertencias.push(
        `Las filas de la hoja traen otro NIT (${normalizada.terceros
          .map((t) => `${t.nit}/${t.sucursal}`)
          .join(", ")}) y no el de este proveedor (${nit}/${proveedor.sucursal ?? "001"}). ` +
          "Revisá que sea la hoja correcta.",
      );
    }
  }

  if (plan.filas.length === 0) {
    plan.motivo_no_aplicable = MENSAJE_SIN_FILAS_VALIDAS;
    plan.desactivacion_omitida = MENSAJE_SIN_FILAS_VALIDAS;
    plan.resumen.a_desactivar_omitidas = idsADesactivar(existentes, []).length;
    return plan;
  }
  plan.aplicable = true;

  const ids = new Set(idsADesactivar(existentes, plan.filas));
  const aDesactivar = existentes.filter((e) => ids.has(e.id)).map(describirExistente);
  if (plan.rechazadas.length > 0) {
    plan.desactivacion_omitida = MENSAJE_DESACTIVACION_POR_RECHAZOS;
    plan.resumen.a_desactivar_omitidas = aDesactivar.length;
  } else {
    plan.a_desactivar = aDesactivar;
    plan.resumen.a_desactivar = aDesactivar.length;
  }
  return plan;
}

// ─── Lo que se escribe ─────────────────────────────────────────────────────

/**
 * Filas a upsertear: solo las nuevas y las actualizadas. Las que no cambian no se
 * reescriben (menos escrituras y `updated_at` no se mueve sin motivo).
 */
export function filasAGuardar(plan, proveedorId) {
  return plan.filas
    .filter((f) => f.estado !== ESTADOS_FILA.SIN_CAMBIOS)
    .map((f) => ({
      proveedor_id: proveedorId,
      codigo_item: f.codigo_item,
      descripcion_item: f.descripcion_item,
      unidad: f.unidad,
      equivalencia: f.equivalencia,
      orden: f.orden,
      activo: true,
    }));
}

/** Ids a desactivar (ya vacío si el plan omitió la desactivación). */
export function idsADesactivarDelPlan(plan) {
  return plan.a_desactivar.map((e) => e.id);
}

/** El plan sin el detalle fila a fila: lo que se devuelve tras APLICAR. */
export function resumenParaRespuesta(plan) {
  return {
    resumen: plan.resumen,
    advertencias: plan.advertencias,
    rechazadas: plan.rechazadas,
    desactivacion_omitida: plan.desactivacion_omitida,
  };
}
