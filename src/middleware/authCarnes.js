import { supabase } from "../config/supabase.js";
import { bitacoraAuth, crearAutenticar, crearRequireAdmin } from "./auth.js";
import { crearExistePerfil, crearPuedeAdministrar, crearVerificar } from "./authSupabase.js";

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
