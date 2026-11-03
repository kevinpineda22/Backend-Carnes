import { supabase } from "../config/supabase.js";
import { bitacoraAuth, crearAutenticar, crearRequireAdmin } from "./auth.js";
import {
  crearExistePerfil,
  crearPuedeAdministrar,
  crearPuedeAprobarContabilidad,
  crearPuedeVerContabilidad,
  crearVerificar,
} from "./authSupabase.js";

/**
 * Cableado real de `auth.js` contra Supabase. Se separa para que `auth.js` y
 * `authSupabase.js` se puedan probar sin red ni variables de entorno.
 *
 * Los dos middlewares comparten la bitácora (`bitacoraAuth`) para que el resumen
 * periódico por instancia sea una sola línea.
 */
export const autenticar = crearAutenticar({
  verificar: crearVerificar(supabase),
  existePerfil: crearExistePerfil(supabase),
  bitacora: bitacoraAuth,
});

export const requireAdminCarnes = crearRequireAdmin({
  puedeAdministrar: crearPuedeAdministrar(supabase),
  bitacora: bitacoraAuth,
});

/**
 * Página de contabilidad, SOLO LECTURA: contabilidad o admin. Mismo modo
 * (`CARNES_AUTH`), misma bitácora y misma caché por instancia que el guard de
 * admin, pero con su propia pregunta de permiso.
 */
export const requireContabilidadCarnes = crearRequireAdmin({
  puedeAdministrar: crearPuedeVerContabilidad(supabase),
  bitacora: bitacoraAuth,
});

/** "Aprobar por contabilidad": SOLO contabilidad (un admin no). */
export const requireAprobarContabilidadCarnes = crearRequireAdmin({
  puedeAdministrar: crearPuedeAprobarContabilidad(supabase),
  bitacora: bitacoraAuth,
});
