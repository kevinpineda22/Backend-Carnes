import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

/* =============================================
   La plantilla que edita el admin.

   Tres catálogos que se manejan igual, así que comparten las mismas funciones
   parametrizadas por tabla:

     · carnes_plantilla_items  — los cortes (`Datos ` de res, `ITEMS` de cerdo)
     · carnes_viceras_items    — las vísceras
     · carnes_conceptos_gasto  — los conceptos de gasto

   Todo se ordena por `orden`, NUNCA por código ni alfabéticamente. El admin arma
   la lista en el orden en que la carne baja del camión, y esa es la secuencia
   que el recibidor sigue con la canasta en la mano.
   ============================================= */

const TABLAS = {
  items: "carnes_plantilla_items",
  viceras: "carnes_viceras_items",
  conceptos: "carnes_conceptos_gasto",
};

/** Traduce el nombre corto del catálogo a su tabla, o falla claro. */
function tabla(catalogo) {
  const t = TABLAS[catalogo];
  if (!t) throw createError(400, `Catálogo desconocido: "${catalogo}".`);
  return t;
}

/** Columnas que el cliente puede escribir, por catálogo. */
const ESCRIBIBLES = {
  items: ["codigo_tabla", "codigo_item", "descripcion", "costo_base", "orden", "activo"],
  viceras: ["bloque", "nombre", "precio", "orden", "activo"],
  conceptos: ["nombre", "signo", "orden", "activo"],
};

/**
 * Deja pasar solo las columnas escribibles.
 *
 * Es una lista blanca y no una negra a propósito: el body llega tal cual desde
 * una grilla del front, con `id`, `created_at` y lo que el componente haya
 * colgado de la fila. Sin este filtro, un `updated_at` viajado desde el cliente
 * pisa el que pone el trigger, y la columna deja de servir para saber cuándo
 * cambió algo de verdad.
 */
function limpiar(catalogo, fila) {
  const permitidas = ESCRIBIBLES[catalogo];
  const salida = {};
  for (const col of permitidas) {
    if (fila[col] !== undefined) salida[col] = fila[col];
  }
  return salida;
}

/**
 * Lee un catálogo completo de una especie.
 *
 * `incluirInactivos` separa las dos audiencias: el recibidor ve solo lo activo
 * —una lista con ítems dados de baja lo hace dudar— y el admin ve todo, porque
 * si no, un ítem desactivado desaparece de su pantalla y no lo puede reactivar.
 */
export async function listar(catalogo, especie, { incluirInactivos = false } = {}) {
  let q = supabase
    .from(tabla(catalogo))
    .select("*")
    .eq("especie", especie)
    .order("orden")
    .order("id");
  if (!incluirInactivos) q = q.eq("activo", true);

  const { data, error } = await q;
  if (error) throw new Error(`Error al leer ${catalogo}: ${error.message}`);
  return data || [];
}

/** Los tres catálogos de una especie en una sola llamada. */
export async function listarTodo(especie, opciones) {
  const [items, viceras, conceptos] = await Promise.all([
    listar("items", especie, opciones),
    listar("viceras", especie, opciones),
    listar("conceptos", especie, opciones),
  ]);
  return { especie, items, viceras, conceptos };
}

export async function crear(catalogo, especie, fila) {
  const { data, error } = await supabase
    .from(tabla(catalogo))
    .insert({ ...limpiar(catalogo, fila), especie })
    .select("*")
    .single();
  if (error) throw new Error(`Error al crear en ${catalogo}: ${error.message}`);
  return data;
}

export async function actualizar(catalogo, id, cambios) {
  const limpio = limpiar(catalogo, cambios);
  if (Object.keys(limpio).length === 0) {
    throw createError(400, "No hay campos válidos para actualizar.");
  }

  const { data, error } = await supabase
    .from(tabla(catalogo))
    .update(limpio)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Error al actualizar ${catalogo}: ${error.message}`);
  if (!data) throw createError(404, "Registro no encontrado.");
  return data;
}

/**
 * Baja lógica: `activo = false`. NO hay borrado físico, y no es pereza.
 *
 * Cada renglón de `carnes_recepcion_items` apunta a su fila de plantilla. La FK
 * es `ON DELETE SET NULL`, así que borrar de verdad no rompe nada visible —
 * simplemente deja recepciones viejas sin de dónde vino cada ítem, y eso se
 * descubre el día que alguien audita una entrega de hace tres meses.
 *
 * Un ítem inactivo desaparece de la pantalla del recibidor, que es lo que el
 * admin realmente quiere cuando aprieta "eliminar".
 */
export async function desactivar(catalogo, id) {
  return actualizar(catalogo, id, { activo: false });
}

/**
 * Guardado masivo de la grilla: crea, actualiza y desactiva en una sola pasada.
 *
 * El admin edita esto "como si fuera un Excel", así que manda la tabla entera,
 * no una fila. Las filas SIN `id` son nuevas; las que tienen `id` se actualizan;
 * las que estaban en la base y NO vinieron en el envío se desactivan.
 *
 * Ese último caso es el que hace falta pensar: si el admin borra una fila de la
 * grilla y guarda, esa fila tiene que dejar de aparecerle al recibidor. Sin este
 * paso, borrar en pantalla no borra nada y el ítem reaparece al recargar.
 *
 * NO es atómico —Supabase por HTTP no da una transacción— así que el orden es
 * deliberado: primero se escribe lo que el admin quiere que exista y recién
 * después se desactiva lo que sacó. Si el proceso se cae en el medio, el peor
 * estado posible es un catálogo con ítems de más, nunca uno con ítems de menos.
 * Un ítem sobrante el recibidor lo deja en cero; uno faltante no lo puede recibir.
 *
 * @returns {{creados: number, actualizados: number, desactivados: number}}
 */
export async function guardarLote(catalogo, especie, filas = []) {
  const t = tabla(catalogo);

  const nuevas = filas.filter((f) => !f.id);
  const existentes = filas.filter((f) => f.id);

  // Se piden los ids de vuelta porque tienen que entrar en `conservados`: si no,
  // la desactivación de abajo —que da de baja todo lo que no vino en el envío—
  // apagaría las filas que se acaban de crear. Se guardaban y desaparecían.
  const idsNuevos = [];
  let creados = 0;
  if (nuevas.length) {
    const { data, error } = await supabase
      .from(t)
      .insert(nuevas.map((f) => ({ ...limpiar(catalogo, f), especie })))
      .select("id");
    if (error) throw new Error(`Error al crear en ${catalogo}: ${error.message}`);
    idsNuevos.push(...(data || []).map((f) => f.id));
    creados = nuevas.length;
  }

  let actualizados = 0;
  for (const fila of existentes) {
    const limpio = limpiar(catalogo, fila);
    if (Object.keys(limpio).length === 0) continue;
    const { error } = await supabase.from(t).update(limpio).eq("id", fila.id);
    if (error) {
      throw new Error(`Error al actualizar ${catalogo} #${fila.id}: ${error.message}`);
    }
    actualizados++;
  }

  // Desactivar lo que el admin sacó de la grilla.
  const conservados = [...existentes.map((f) => f.id), ...idsNuevos];
  let q = supabase.from(t).update({ activo: false }).eq("especie", especie).eq("activo", true);
  if (conservados.length) q = q.not("id", "in", `(${conservados.join(",")})`);

  const { data: bajas, error: errorBaja } = await q.select("id");
  if (errorBaja) throw new Error(`Error al desactivar en ${catalogo}: ${errorBaja.message}`);

  return { creados, actualizados, desactivados: bajas?.length || 0 };
}

/**
 * Reordena. Body: `[{ id, orden }]`.
 *
 * Va aparte de `guardarLote` porque arrastrar una fila no es editarla: el
 * reordenamiento manda solo dos columnas y no debe poder desactivar nada. Si
 * compartieran endpoint, un front que reordena y manda la lista incompleta
 * daría de baja todo lo que no entró en la vista.
 */
export async function reordenar(catalogo, orden = []) {
  const t = tabla(catalogo);

  for (const { id, orden: posicion } of orden) {
    const { error } = await supabase
      .from(t)
      .update({ orden: Number(posicion) || 0 })
      .eq("id", id);
    if (error) throw new Error(`Error al reordenar ${catalogo}: ${error.message}`);
  }

  return { total: orden.length };
}
