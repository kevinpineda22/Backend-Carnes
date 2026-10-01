import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { validarCedula, validarNombre, validarPersona } from "../shared/finalizarProveedor.js";

/* =============================================
   Quienes pueden firmar "recibí" en una recepción de proveedor.

   Dos caras, a propósito separadas:
     · `listarActivos`: lo que ve el RECIBIDOR (solo id + nombre).
     · `listarAdmin` / `crear` / `actualizar`: la gestión del admin, que SÍ lleva la
       cédula. Borrar no existe: se DESACTIVA (`activo = false`), porque cada
       recepción firmada guarda su propia copia de cédula y nombre y la fila de acá
       es solo la lista que se ofrece.

   Backend-Carnes no tiene autenticación: "admin" es una frontera de la pantalla,
   no un control de acceso (misma postura que el resto de las rutas de Carnes).
   ============================================= */

const TABLE = "carnes_recibidores";
const MIGRACIONES = ["sql/022_proveedores.sql"];

/** Todo lo de una fila para el admin. La cédula SOLO sale por acá. */
const CAMPOS_ADMIN = "id, cedula, nombre, activo, orden, created_at, updated_at";

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
    .from(TABLE)
    .select("id, nombre")
    .eq("activo", true)
    .order("orden")
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer los recibidores", MIGRACIONES);
  return data || [];
}

/**
 * Una fila por id, activa o no, con la cédula. Es lo que lee `finalizar` para
 * armar el snapshot desde la base (nunca desde el cliente) y decidir si el
 * recibidor sigue disponible. `null` si no existe.
 */
export async function obtenerPorId(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, cedula, nombre, activo")
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el recibidor", MIGRACIONES);
  return data || null;
}

// ─── Admin ─────────────────────────────────────────────────────────────────

/**
 * La lista completa del admin: activos E inactivos (para poder reactivar), con
 * cédula. Primero los activos, en el orden que armó el admin.
 */
export async function listarAdmin() {
  const { data, error } = await supabase
    .from(TABLE)
    .select(CAMPOS_ADMIN)
    .order("activo", { ascending: false })
    .order("orden")
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer los recibidores", MIGRACIONES);
  return data || [];
}

/**
 * 23505 sobre la cédula (`uq_carnes_recibidores_cedula`). Si la que choca está
 * DESACTIVADA se le dice a quien da de alta: lo que quiere es reactivarla, no
 * crear otra.
 */
async function errorCedulaRepetida(cedula) {
  const { data } = await supabase
    .from(TABLE)
    .select("id, nombre, activo")
    .eq("cedula", cedula)
    .maybeSingle();
  const detalle = data
    ? data.activo
      ? ` (${data.nombre})`
      : ` (${data.nombre}, desactivado: reactivalo en vez de crear uno nuevo)`
    : "";
  return createError(409, `Ya existe un recibidor con esa cédula${detalle}.`, "CEDULA_DUPLICADA");
}

/** Siguiente `orden`: al final de la lista. Una carrera entre dos altas solo repite un número, que es inofensivo. */
async function siguienteOrden() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("orden")
    .order("orden", { ascending: false })
    .limit(1);
  if (error) fallarSiFaltaMigracion(error, "Error al leer los recibidores", MIGRACIONES);
  return (data?.[0]?.orden ?? 0) + 1;
}

/**
 * Alta de un recibidor. Nombre y cédula son obligatorios y se normalizan igual que
 * el "Otro" del modal de firma (`validarPersona`).
 */
export async function crear({ cedula, nombre, orden }) {
  const persona = validarPersona({ cedula, nombre });
  if (!persona.ok) throw createError(400, persona.mensaje, "RECIBIDOR_INVALIDO");

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      cedula: persona.cedula,
      nombre: persona.nombre,
      orden: orden ?? (await siguienteOrden()),
    })
    .select(CAMPOS_ADMIN)
    .single();
  if (error?.code === "23505") throw await errorCedulaRepetida(persona.cedula);
  if (error) fallarSiFaltaMigracion(error, "Error al crear el recibidor", MIGRACIONES);
  return data;
}

/**
 * Edita, activa o desactiva. Solo se escriben los campos que llegaron
 * (`cedula`, `nombre`, `activo`, `orden`). Desactivar no toca las recepciones ya
 * firmadas: guardan su propia copia.
 */
export async function actualizar(id, { cedula, nombre, activo, orden }) {
  const cambios = {};
  if (cedula !== undefined) {
    const c = validarCedula(cedula);
    if (!c.ok) throw createError(400, c.mensaje, "RECIBIDOR_INVALIDO");
    cambios.cedula = c.valor;
  }
  if (nombre !== undefined) {
    const n = validarNombre(nombre);
    if (!n.ok) throw createError(400, n.mensaje, "RECIBIDOR_INVALIDO");
    cambios.nombre = n.valor;
  }
  if (activo !== undefined) cambios.activo = activo;
  if (orden !== undefined && orden !== null) cambios.orden = orden;
  if (!Object.keys(cambios).length) throw createError(400, "No hay nada para cambiar.");

  const { data, error } = await supabase
    .from(TABLE)
    .update(cambios)
    .eq("id", id)
    .select(CAMPOS_ADMIN);
  if (error?.code === "23505") throw await errorCedulaRepetida(cambios.cedula);
  if (error) fallarSiFaltaMigracion(error, "Error al actualizar el recibidor", MIGRACIONES);
  if (!data?.length) throw createError(404, "Recibidor no encontrado.");
  return data[0];
}
