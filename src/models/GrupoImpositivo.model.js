import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { enLotes } from "../shared/adminProveedor.js";
import { traerTodasLasPaginas } from "../services/connekta.service.js";
import {
  CONSULTA_ITEMS_GRUPO,
  LOTE_UPSERT,
  PRESUPUESTO_MS,
  TAM_PAGINA_CONNEKTA,
  consolidarItems,
  construirSnapshots,
  evaluarCompletitud,
  huellaFila,
} from "../shared/gruposImpositivos.js";

/* =============================================
   Grupos impositivos de SIESA (sql/030): de qué grupo es cada ítem y qué IVA lleva.

   Dos cosas:
     · SINCRONIZAR el catálogo ítem -> grupo desde Connekta a Supabase (admin).
     · SNAPSHOT: dado un conjunto de códigos de ítem, el `{grupo_impositivo, iva_pct}`
       que se copia al renglón al crearlo.

   Las reglas (normalizar, consolidar, juzgar si lo traído está completo) viven en
   `shared/gruposImpositivos.js`, donde hay tests. Acá solo se lee y se escribe.
   ============================================= */

const TABLE_ITEMS = "carnes_items_grupo_impositivo";
const TABLE_GRUPOS = "carnes_grupos_impositivos";
const MIGRACIONES = ["sql/030_grupos_impositivos.sql"];

/** Páginas de Connekta en vuelo a la vez. Más de 3 deadlockea el SQL Server de atrás y topa el rate limit. */
const CONCURRENCIA = Number(process.env.CONNEKTA_CONCURRENCIA) || 3;

/** Códigos por consulta `in(...)`: la lista va en la URL y PostgREST la corta si es muy larga. */
const CODIGOS_POR_CONSULTA = 150;

function fallo(error, contexto) {
  return fallarSiFaltaMigracion(error, contexto, MIGRACIONES);
}

// ─── Snapshot para los renglones ───────────────────────────────────────────

/**
 * El snapshot de IVA de cada código de ítem: `Map<codigo, {grupo_impositivo, iva_pct}>`
 * con UNA entrada por código pedido (sin dato = nulls). Ver `construirSnapshots`.
 */
export async function snapshotsParaCodigos(codigos = []) {
  const unicos = [...new Set(codigos.map((c) => String(c ?? "").trim()).filter(Boolean))];
  if (!unicos.length) return new Map();

  const [respuestasItems, respuestaGrupos] = await Promise.all([
    Promise.all(
      enLotes(unicos, CODIGOS_POR_CONSULTA).map((lote) =>
        supabase.from(TABLE_ITEMS).select("codigo_item, grupo_impositivo").in("codigo_item", lote),
      ),
    ),
    supabase.from(TABLE_GRUPOS).select("codigo, iva_pct"),
  ]);

  const filasItems = [];
  for (const { data, error } of respuestasItems) {
    if (error) fallo(error, "Error al leer los grupos impositivos de los ítems");
    filasItems.push(...(data || []));
  }
  if (respuestaGrupos.error) fallo(respuestaGrupos.error, "Error al leer las tarifas de los grupos impositivos");

  return construirSnapshots(unicos, filasItems, respuestaGrupos.data || []);
}

// ─── Estado ────────────────────────────────────────────────────────────────

/**
 * Lo que ve el admin del catálogo sincronizado: cuántos ítems hay y cuándo fue la
 * última sincronización (el `actualizado_at` más reciente: cada sincronización
 * reescribe todas las filas).
 */
export async function estado() {
  const [cuenta, ultima, grupos] = await Promise.all([
    supabase.from(TABLE_ITEMS).select("codigo_item", { count: "exact", head: true }),
    supabase.from(TABLE_ITEMS).select("actualizado_at").order("actualizado_at", { ascending: false }).limit(1),
    supabase.from(TABLE_GRUPOS).select("codigo", { count: "exact", head: true }),
  ]);
  for (const r of [cuenta, ultima, grupos]) if (r.error) fallo(r.error, "Error al leer el estado de los grupos impositivos");
  return {
    items: cuenta.count ?? 0,
    grupos: grupos.count ?? 0,
    ultima_sincronizacion: ultima.data?.[0]?.actualizado_at ?? null,
    sincronizando: enCurso,
  };
}

// ─── Sincronización ────────────────────────────────────────────────────────

/**
 * Una sola sincronización a la vez POR INSTANCIA: en Vercel cada instancia serverless tiene
 * su propio flag, así que dos instancias pueden sincronizar a la vez. Es aceptable: los
 * upserts son idempotentes y lo peor es carga extra sobre Connekta. No hay lock distribuido.
 */
let enCurso = false;

/**
 * Trae TODAS las páginas de la consulta (ver `traerTodasLasPaginas`): el límite se
 * revisa antes de cada página y viaja a cada intento HTTP, así el presupuesto es un tope real.
 */
function traerTodo(limiteAbsoluto) {
  return traerTodasLasPaginas(CONSULTA_ITEMS_GRUPO, TAM_PAGINA_CONNEKTA, limiteAbsoluto, { concurrencia: CONCURRENCIA });
}

/**
 * Sincroniza el catálogo ítem -> grupo impositivo desde Connekta.
 *
 *   1. Trae todas las páginas (aborta sin escribir si alguna falla o se acaba el tiempo).
 *   2. Cuenta filas DISTINTAS contra el total declarado: la consulta puede paginar sin
 *      orden estable y repetir/saltarse filas (ver `evaluarCompletitud`). Debajo del
 *      umbral no se escribe.
 *   3. Una fila por `codigo_item` y UPSERT en lotes. Nunca borra: un ítem que deja de
 *      aparecer conserva su último grupo.
 *
 * @returns {Promise<object>} conteos y advertencias para el admin
 */
export async function sincronizar({ ahora = Date.now } = {}) {
  if (enCurso) throw createError(409, "Ya hay una sincronización en curso.", "SYNC_EN_CURSO");
  enCurso = true;
  const inicio = ahora();
  const limite = inicio + PRESUPUESTO_MS;
  try {
    const { crudas, totalDeclarado, totalPaginas } = await traerTodo(limite);

    const distintas = new Set(crudas.map(huellaFila)).size;
    const completitud = evaluarCompletitud({ totalDeclarado, distintas });
    if (!completitud.ok) throw createError(502, completitud.mensaje, "SYNC_INCOMPLETA");

    const { filas, invalidas, repetidas, conflictos } = consolidarItems(crudas);
    if (!filas.length) throw createError(502, "Connekta no devolvió ítems utilizables; no se escribió nada.", "SYNC_VACIA");

    // Grupos que los ítems usan y la tabla de tarifas no conoce: esos ítems quedarán
    // "sin dato" de IVA hasta que se agregue el grupo.
    const { data: conocidos, error: errorGrupos } = await supabase.from(TABLE_GRUPOS).select("codigo");
    if (errorGrupos) fallo(errorGrupos, "Error al leer los grupos impositivos");
    const codigosConocidos = new Set((conocidos || []).map((g) => g.codigo));
    const desconocidos = new Set();
    let sinGrupo = 0;
    for (const f of filas) {
      if (!f.grupo_impositivo) sinGrupo += 1;
      else if (!codigosConocidos.has(f.grupo_impositivo)) desconocidos.add(f.grupo_impositivo);
    }

    const actualizadoAt = new Date(ahora()).toISOString();
    let escritas = 0;
    let completa = true;
    for (const lote of enLotes(filas, LOTE_UPSERT)) {
      if (ahora() > limite) {
        completa = false;
        break;
      }
      const { error } = await supabase
        .from(TABLE_ITEMS)
        .upsert(
          lote.map((f) => ({ ...f, actualizado_at: actualizadoAt })),
          { onConflict: "codigo_item" },
        );
      if (error) fallo(error, "Error al guardar los grupos impositivos");
      escritas += lote.length;
    }

    const advertencias = [];
    if (!completa) advertencias.push(`Se acabó el tiempo: se guardaron ${escritas} de ${filas.length} ítems. Volvé a sincronizar para completar.`);
    if (conflictos > 0) advertencias.push(`${conflictos} ítem(s) vienen con más de un grupo distinto; se usó el primero.`);
    if (desconocidos.size > 0) advertencias.push(`Grupos que no están en la tabla de tarifas (sin IVA hasta agregarlos): ${[...desconocidos].sort().join(", ")}.`);
    if (completitud.completitud < 1) advertencias.push(`Llegaron ${distintas} filas distintas de ${totalDeclarado} declaradas.`);

    console.log(`🧾 Grupos impositivos sincronizados: ${escritas}/${filas.length} ítems en ${Math.round((ahora() - inicio) / 1000)} s`);
    return {
      completa,
      paginas: totalPaginas,
      filas_connekta: crudas.length,
      filas_distintas: distintas,
      total_declarado: totalDeclarado,
      items: filas.length,
      guardados: escritas,
      sin_grupo: sinGrupo,
      grupos_desconocidos: [...desconocidos].sort(),
      repetidas,
      conflictos,
      invalidas,
      advertencias,
      duracion_ms: ahora() - inicio,
      actualizado_at: actualizadoAt,
    };
  } finally {
    enCurso = false;
  }
}
