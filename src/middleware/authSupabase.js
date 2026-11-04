import {
  puedeAbrirAdminCarnes,
  puedeAprobarContabilidadCarnes,
  puedeObservarLogisticaCarnes,
  puedeVerContabilidadCarnes,
  ROL_CON_RESPALDO,
  ROL_RESPALDO,
} from "../shared/permisoAdminCarnes.js";

/**
 * Consultas a Supabase que necesita `auth.js`, con el cliente por parámetro.
 *
 * Se separan de `authCarnes.js` (que crea el cliente real y exige variables de
 * entorno) para poder probarlas con un cliente falso, sin red.
 *
 * El proyecto de Supabase es el MISMO de la app (el de Login.jsx), así que el
 * JWT que manda el front lo verifica el cliente de service-role sin ningún
 * secreto nuevo. `auth.getUser(token)` consulta al servidor de Auth, y por eso
 * sirve igual con llaves de firma HS256 (legacy) o asimétricas.
 */

/**
 * `{ id, email }` si el token es válido, `null` si no lo es, y LANZA si el
 * servidor de Auth no responde (red, 5xx, 429): eso no es culpa del token.
 */
export function crearVerificar(cliente) {
  return async function verificarConSupabase(token) {
    const { data, error } = await cliente.auth.getUser(token);
    if (error) {
      const estado = Number(error.status);
      if (estado >= 400 && estado < 500 && estado !== 429) return null;
      throw error;
    }
    return data?.user ? { id: data.user.id, email: data.user.email } : null;
  };
}

/** ¿Hay fila en `profiles` para este usuario? Solo el personal la tiene. Lanza si no puede consultarlo. */
export function crearExistePerfil(cliente) {
  return async function existePerfil(usuarioId) {
    const { data, error } = await cliente
      .from("profiles")
      .select("user_id")
      .eq("user_id", usuarioId)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  };
}

/**
 * Lee el perfil y la config del rol, con las mismas tablas y columnas que
 * `Login.jsx` y `RutaProtegida.jsx`. Devuelve `null` si no hay perfil; lanza si
 * no puede consultar.
 */
function crearLeerContexto(cliente) {
  async function configDelRol(role) {
    const { data, error } = await cliente
      .from("role_permissions")
      .select("permissions, redirect")
      .eq("role", role)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  return async function leerContexto(usuarioId) {
    const { data: profile, error } = await cliente
      .from("profiles")
      .select("role, personal_routes")
      .eq("user_id", usuarioId)
      .maybeSingle();
    if (error) throw error;
    if (!profile) return null;

    let roleConfig = profile.role ? await configDelRol(profile.role) : null;
    if ((!roleConfig || !roleConfig.permissions) && profile.role === ROL_CON_RESPALDO) {
      roleConfig = (await configDelRol(ROL_RESPALDO)) || roleConfig;
    }
    return { profile, roleConfig };
  };
}

/** Arma "¿este usuario puede X?" a partir de la regla pura `regla({ profile, roleConfig })`. */
function crearPregunta(cliente, regla) {
  const leerContexto = crearLeerContexto(cliente);
  return async function pregunta(usuarioId) {
    const contexto = await leerContexto(usuarioId);
    return contexto ? regla(contexto) : false;
  };
}

/** ¿Puede abrir `/carnes/admin`? */
export function crearPuedeAdministrar(cliente) {
  return crearPregunta(cliente, puedeAbrirAdminCarnes);
}

/** ¿Puede ver la página de contabilidad (lectura)? Contabilidad o admin. */
export function crearPuedeVerContabilidad(cliente) {
  return crearPregunta(cliente, puedeVerContabilidadCarnes);
}

/** ¿Puede marcar una recepción como aprobada por contabilidad? Solo contabilidad. */
export function crearPuedeAprobarContabilidad(cliente) {
  return crearPregunta(cliente, puedeAprobarContabilidadCarnes);
}

/** ¿Puede escribir la observación de logística? Solo quien abre la consulta de recepciones. */
export function crearPuedeObservarLogistica(cliente) {
  return crearPregunta(cliente, puedeObservarLogisticaCarnes);
}
