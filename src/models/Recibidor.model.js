import { supabase } from "../config/supabase.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";

/* =============================================
   Quienes pueden firmar "recibí" en una recepción de proveedor.

   Acá vive solo la lista que ve el RECIBIDOR. La gestión del admin (con cédula,
   altas, bajas) va aparte y más adelante, en su propia ruta.
   ============================================= */

const MIGRACIONES = ["sql/022_proveedores.sql"];

/**
 * Recibidores activos: SOLO `id` y `nombre`.
 *
 * La cédula no sale de acá a propósito. Esta lista se descarga en el celular de
 * cualquier recibidor, y la cédula es un dato personal que el modal de firma no
 * necesita mostrar: al finalizar, el backend la lee de la base por el `id` que
 * llegó, no del cliente. Es la misma razón por la que `/sedes` no devuelve el
 * `qr_token`.
 *
 * Ordenados por `orden` (la lista que armó el admin) y luego por id, no
 * alfabéticamente.
 */
export async function listarActivos() {
  const { data, error } = await supabase
    .from("carnes_recibidores")
    .select("id, nombre")
    .eq("activo", true)
    .order("orden")
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer los recibidores", MIGRACIONES);
  return data || [];
}
