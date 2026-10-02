import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { formatearProveedores } from "../shared/equivalenciasProveedor.js";
import {
  filasAGuardar,
  idsADesactivarDelPlan,
  planearCargaPlantilla,
  validarFormaFilas,
} from "../shared/plantillaProveedor.js";

/* =============================================
   Catálogo de proveedores del recibidor.

   Lectura (`listar`, `obtenerPlantilla`) y la carga de plantilla del admin
   (`cargarPlantilla`, al final del archivo); la primera carga masiva la hizo
   `scripts/seed-proveedores.js`. Las tablas viven en sql/022; si esa migración no
   se corrió, `fallarSiFaltaMigracion` responde 503 con el nombre del archivo en
   vez de un 500 opaco.
   ============================================= */

const MIGRACIONES = ["sql/022_proveedores.sql"];

/**
 * Lo que el front necesita de un proveedor. `desc_sucursal` y las fechas no
 * viajan: el selector solo muestra razón social y NIT.
 */
const CAMPOS_PROVEEDOR = "id, nit, sucursal, razon_social";

/** Columnas de una fila de plantilla que ve el recibidor. */
const CAMPOS_EQUIVALENCIA = "id, codigo_item, descripcion_item, unidad, equivalencia, orden";

/**
 * Proveedores activos, por razón social.
 *
 * Con `conPlantilla` solo los que tienen al menos una equivalencia ACTIVA: es el
 * selector del recibidor, y un proveedor sin plantilla no tiene qué recibir
 * (abrir la factura fallaría). Sin la bandera salen todos, con su conteo (puede
 * ser 0) — es lo que va a necesitar el admin para ver a quién le falta cargar la
 * plantilla.
 *
 * El filtro va sobre el conteo y NO con `!inner(count)`: con un agregado,
 * PostgREST devuelve siempre una fila `{ count: 0 }`, así que el `!inner` nunca
 * excluye a nadie y el selector mostraba los 16 proveedores.
 */
export async function listar({ conPlantilla = false } = {}) {
  const { data, error } = await supabase
    .from("carnes_proveedores")
    .select(`${CAMPOS_PROVEEDOR}, carnes_proveedor_equivalencias(count)`)
    .eq("activo", true)
    // Sin este filtro el conteo incluiría las filas dadas de baja.
    .eq("carnes_proveedor_equivalencias.activo", true)
    .order("razon_social")
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer los proveedores", MIGRACIONES);
  const proveedores = formatearProveedores(data || []);
  return conPlantilla ? proveedores.filter((p) => p.equivalencias_activas > 0) : proveedores;
}

/**
 * La plantilla de un proveedor: sus equivalencias activas en el orden de la hoja.
 *
 * Se ordena por `orden`, nunca alfabéticamente: es la secuencia en la que el
 * proveedor baja la mercancía y la que el recibidor sigue con la factura en la
 * mano. Una plantilla vacía es una respuesta válida (200 con lista vacía); quien
 * abre la recepción es el que la rechaza.
 */
export async function obtenerPlantilla(id) {
  const { data: proveedor, error: errorProveedor } = await supabase
    .from("carnes_proveedores")
    .select(CAMPOS_PROVEEDOR)
    .eq("id", id)
    .eq("activo", true)
    .maybeSingle();
  if (errorProveedor) {
    fallarSiFaltaMigracion(errorProveedor, "Error al leer el proveedor", MIGRACIONES);
  }
  if (!proveedor) throw createError(404, "Proveedor no encontrado.");

  const { data, error } = await supabase
    .from("carnes_proveedor_equivalencias")
    .select(CAMPOS_EQUIVALENCIA)
    .eq("proveedor_id", id)
    .eq("activo", true)
    .order("orden")
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer la plantilla", MIGRACIONES);

  return { proveedor, equivalencias: data || [] };
}

/* =============================================
   Carga de la plantilla desde el admin (PUT /proveedores/:id/plantilla).

   Las reglas viven en `shared/plantillaProveedor.js` (puro, probado sin Supabase);
   acá solo está la lectura de lo existente y las escrituras.
   ============================================= */

/** Filas por lote de upsert. Igual que la siembra. */
const LOTE_ESCRITURA = 500;
/** Ids por `.in()` al desactivar: la lista viaja en la URL y 2000 ids la desbordan. */
const LOTE_DESACTIVAR = 200;
/** PostgREST responde como máximo 1000 filas por consulta sin avisar. */
const PAGINA_LECTURA = 1000;
const MAX_PAGINAS = 50;

const CAMPOS_EXISTENTES = "id, codigo_item, descripcion_item, unidad, equivalencia, orden, activo";

/** El proveedor, solo si está activo (cargarle plantilla a uno dado de baja no tiene sentido). */
async function leerProveedorActivo(id) {
  const { data, error } = await supabase
    .from("carnes_proveedores")
    .select(CAMPOS_PROVEEDOR)
    .eq("id", id)
    .eq("activo", true)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el proveedor", MIGRACIONES);
  if (!data) throw createError(404, "Proveedor no encontrado.");
  return data;
}

/**
 * TODAS las filas de plantilla del proveedor, activas e inactivas, paginando: una
 * lectura sin paginar se corta en 1000 sin error y el plan creería que lo que no
 * llegó "no existe" (lo trataría como nuevo y no lo desactivaría).
 */
async function leerEquivalenciasExistentes(proveedorId) {
  const todas = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const desde = pagina * PAGINA_LECTURA;
    const { data, error } = await supabase
      .from("carnes_proveedor_equivalencias")
      .select(CAMPOS_EXISTENTES)
      .eq("proveedor_id", proveedorId)
      .order("id")
      .range(desde, desde + PAGINA_LECTURA - 1);
    if (error) fallarSiFaltaMigracion(error, "Error al leer la plantilla", MIGRACIONES);
    todas.push(...(data || []));
    if (!data || data.length < PAGINA_LECTURA) return todas;
  }
  throw new Error("La plantilla del proveedor tiene demasiadas filas para leerla completa.");
}

/**
 * Vista previa o carga de la plantilla de un proveedor.
 *
 * `aplicar: false` NO escribe nada. `aplicar: true` recalcula el plan contra la base
 * en ese momento (no confía en una vista previa anterior: otro admin pudo cambiar la
 * plantilla entre medio) y escribe:
 *   1. upsert de las filas nuevas y las que cambian, por la llave del UNIQUE;
 *   2. desactivación de las activas que ya no vienen (solo si la hoja no tuvo
 *      rechazadas). Nunca se borra.
 * No es transaccional (Supabase REST): si algo falla a la mitad, volver a cargar la
 * misma hoja es seguro porque el upsert es idempotente.
 *
 * @returns {Promise<{ proveedor: object, plan: object, aplicado: boolean,
 *                     guardadas: number, desactivadas: number }>}
 */
export async function cargarPlantilla(id, { filas, aplicar = false, por }) {
  // La forma se revisa ANTES de ir a la base: una petición mal formada no gasta lecturas.
  const forma = validarFormaFilas(filas);
  if (!forma.ok) throw createError(400, forma.mensaje);

  const proveedor = await leerProveedorActivo(id);
  const existentes = await leerEquivalenciasExistentes(id);
  const plan = planearCargaPlantilla({ filas, existentes, proveedor });

  if (!aplicar) {
    return { proveedor, plan, aplicado: false, guardadas: 0, desactivadas: 0 };
  }
  if (!plan.aplicable) {
    throw createError(
      422,
      plan.motivo_no_aplicable || "La hoja no se puede aplicar.",
      "PLANTILLA_NO_APLICABLE",
    );
  }

  const aGuardar = filasAGuardar(plan, id);
  for (let i = 0; i < aGuardar.length; i += LOTE_ESCRITURA) {
    const { error } = await supabase
      .from("carnes_proveedor_equivalencias")
      .upsert(aGuardar.slice(i, i + LOTE_ESCRITURA), {
        onConflict: "proveedor_id,codigo_item,unidad,equivalencia",
      });
    if (error) fallarSiFaltaMigracion(error, "No se pudo guardar la plantilla", MIGRACIONES);
  }

  const aDesactivar = idsADesactivarDelPlan(plan);
  for (let i = 0; i < aDesactivar.length; i += LOTE_DESACTIVAR) {
    const { error } = await supabase
      .from("carnes_proveedor_equivalencias")
      .update({ activo: false })
      .eq("proveedor_id", id)
      .in("id", aDesactivar.slice(i, i + LOTE_DESACTIVAR));
    if (error) fallarSiFaltaMigracion(error, "No se pudieron desactivar filas", MIGRACIONES);
  }

  console.log(
    `📋 Plantilla del proveedor #${id} cargada por ${por}: ${aGuardar.length} guardadas, ` +
      `${aDesactivar.length} desactivadas, ${plan.rechazadas.length} rechazadas`,
  );
  return {
    proveedor,
    plan,
    aplicado: true,
    guardadas: aGuardar.length,
    desactivadas: aDesactivar.length,
  };
}
