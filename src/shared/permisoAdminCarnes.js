/**
 * ¿Quién puede usar los endpoints de admin de Carnes?
 *
 * Es la MISMA regla con la que el front decide quién abre `/carnes/admin`:
 * `RutaProtegida.jsx` + `Login.jsx` + `config/autorizacionRutas.js` del repo
 * Pagina-web_React. Se copia acá a propósito —el backend no puede importar el
 * front— y se mantiene igual a ella; si allá cambia, esto cambia.
 *
 * Lo que dice el front, en orden:
 *   1. `/carnes` NO está en `RUTAS_ABIERTAS`, así que no basta con tener sesión.
 *   2. Las rutas del usuario son `profiles.personal_routes` si tiene alguna; si
 *      no, `role_permissions.permissions` de su rol. (Login, líneas "Prioridad
 *      a rutas personales".)
 *   3. Se abre si alguna ruta CUBRE `/carnes/admin`: igual, o es un ancestro por
 *      segmento (`/carnes` sí, `/carnes/adm` no).
 *   4. O si `/carnes/admin` es el `redirect` del rol (`role_permissions.redirect`)
 *      — salvo los roles admin_* , a quienes el Login les pisa el redirect con
 *      `/acceso`.
 *   5. `admin_clientes` sin configuración propia usa la de `admin_proveedores`
 *      (esa consulta la hace quien llama; ver `authCarnes.js`).
 */

export const RUTA_ADMIN_CARNES = "/carnes/admin";
/**
 * Página de solo lectura de contabilidad (recepciones de proveedor + "Aprobar").
 * Es una ruta APARTE de `/carnes/admin` a propósito: `/carnes/admin/x` no cubre
 * `/carnes/admin`, así que colgarla de ahí obligaba a rehacer el guard de admin.
 */
export const RUTA_CONTABILIDAD_CARNES = "/carnes/contabilidad";
/**
 * Consulta de recepciones de proveedor, SOLO LECTURA y SIN "Aprobar" (logística).
 * Ruta aparte de `/carnes/admin` y de `/carnes/contabilidad`: ninguna cubre a las otras.
 */
export const RUTA_CONSULTA_RECEPCIONES_CARNES = "/carnes/consulta-recepciones";

export const ROL_CON_RESPALDO = "admin_clientes";
export const ROL_RESPALDO = "admin_proveedores";

/** Roles cuyo `redirect` el Login reemplaza por `/acceso`. */
export const ROLES_REDIRIGIDOS_A_ACCESO = [
  "admin_proveedor",
  "admin_proveedores",
  "admin_cliente",
  "admin_clientes",
];

/** Igual a `cubre` de `config/autorizacionRutas.js` del front. */
export const cubre = (permiso, actual) =>
  actual === permiso || actual.startsWith(permiso + "/");

/**
 * @param {string} ruta la ruta del front que se quiere abrir
 * @param {{ role?: string|null, personal_routes?: Array<{path: string}>|null } | null} profile
 * @param {{ permissions?: Array<{path: string}>|null, redirect?: string|null } | null} roleConfig
 */
function puedeAbrirRuta(ruta, { profile, roleConfig } = {}) {
  if (!profile) return false; // sin perfil, el Login ya no deja entrar

  const personales = Array.isArray(profile.personal_routes) ? profile.personal_routes : [];
  const delRol = Array.isArray(roleConfig?.permissions) ? roleConfig.permissions : [];
  const rutas = personales.length > 0 ? personales : delRol;

  const redirect = ROLES_REDIRIGIDOS_A_ACCESO.includes(profile.role)
    ? "/acceso"
    : roleConfig?.redirect;

  if (redirect === ruta) return true;
  return rutas.some((r) => typeof r?.path === "string" && cubre(r.path, ruta));
}

/** ¿Puede abrir `/carnes/admin`? Ver el comentario del archivo. */
export function puedeAbrirAdminCarnes(contexto = {}) {
  return puedeAbrirRuta(RUTA_ADMIN_CARNES, contexto);
}

/** ¿Puede abrir `/carnes/contabilidad`? Misma regla, otra ruta. */
export function puedeAbrirContabilidadCarnes(contexto = {}) {
  return puedeAbrirRuta(RUTA_CONTABILIDAD_CARNES, contexto);
}

/** ¿Puede abrir `/carnes/consulta-recepciones`? Misma regla, otra ruta. */
export function puedeAbrirConsultaRecepcionesCarnes(contexto = {}) {
  return puedeAbrirRuta(RUTA_CONSULTA_RECEPCIONES_CARNES, contexto);
}

/**
 * Ver el listado y el detalle de recepciones (solo lectura): contabilidad, la
 * consulta de recepciones o un admin. El admin ya tiene sus propios endpoints; se
 * le deja entrar para que quien tenga los dos permisos no se tope con un 403 en
 * una pantalla suya. La consulta NO aprueba: ver `puedeAprobarContabilidadCarnes`.
 */
export function puedeVerContabilidadCarnes(contexto = {}) {
  return (
    puedeAbrirContabilidadCarnes(contexto) ||
    puedeAbrirConsultaRecepcionesCarnes(contexto) ||
    puedeAbrirAdminCarnes(contexto)
  );
}

/**
 * Marcar una recepción como aprobada por contabilidad: SOLO contabilidad. Quien
 * además abre `/carnes/admin` (un admin, o alguien con `/carnes` completo, que
 * cubre las dos rutas) NO aprueba: el botón es de contabilidad y no del admin.
 */
export function puedeAprobarContabilidadCarnes(contexto = {}) {
  return puedeAbrirContabilidadCarnes(contexto) && !puedeAbrirAdminCarnes(contexto);
}
