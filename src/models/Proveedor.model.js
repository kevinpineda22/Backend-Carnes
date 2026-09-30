import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { formatearProveedores } from "../shared/equivalenciasProveedor.js";

/* =============================================
   Catálogo de proveedores del recibidor.

   Solo lectura por ahora: la carga la hace `scripts/seed-proveedores.js` y el
   endpoint de subir plantilla llega en un corte posterior. Las tablas viven en
   sql/022; si esa migración no se corrió, `fallarSiFaltaMigracion` responde 503
   con el nombre del archivo en vez de un 500 opaco.
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
 * (abrir la factura fallaría). `!inner` hace ese filtro en la base y no en JS.
 * Sin la bandera salen todos, con su conteo (puede ser 0) — es lo que va a
 * necesitar el admin para ver a quién le falta cargar la plantilla.
 */
export async function listar({ conPlantilla = false } = {}) {
  const relacion = conPlantilla
    ? "carnes_proveedor_equivalencias!inner(count)"
    : "carnes_proveedor_equivalencias(count)";

  const { data, error } = await supabase
    .from("carnes_proveedores")
    .select(`${CAMPOS_PROVEEDOR}, ${relacion}`)
    .eq("activo", true)
    // Sin este filtro el conteo incluiría las filas dadas de baja.
    .eq("carnes_proveedor_equivalencias.activo", true)
    .order("razon_social")
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer los proveedores", MIGRACIONES);
  return formatearProveedores(data || []);
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
