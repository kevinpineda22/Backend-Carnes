-- =============================================================================
-- 032b: permiso de contabilidad@merkahorrosas.com para /carnes/contabilidad
-- =============================================================================
--
-- Qué hace: le agrega a ese usuario la ruta /carnes/contabilidad (la página de solo
-- lectura de recepciones de proveedor con el botón "Aprobar"). No toca a nadie más.
--
-- LEER ANTES DE CORRER (es la trampa de este permiso):
--
--   Las rutas de un usuario son profiles.personal_routes SI TIENE ALGUNA; si está
--   vacía/NULL, salen de role_permissions.permissions de su rol (Login.jsx, "Prioridad
--   a rutas personales"). Si personal_routes está VACÍA y solo se le agrega la ruta
--   nueva, esa lista de UNA ruta REEMPLAZA las del rol: perdería todo lo que hoy ve.
--   Por eso el UPDATE de abajo, cuando personal_routes está vacía, parte de las rutas
--   del rol y agrega la nueva encima (no se pierde nada). Si ya tiene personal_routes,
--   solo se agrega al final. En los dos casos es idempotente (no duplica).
--
--   Es el único paso que toca permisos. Se ejecuta A MANO, en este orden:
--     1) el SELECT del paso 1: confirmar que el perfil existe y ver qué tiene hoy;
--     2) el UPDATE del paso 2;
--     3) el SELECT del paso 3: confirmar el resultado.
--
-- A dónde cae al iniciar sesión (Login.jsx):
--   navega a role_permissions.redirect de su rol (o a /acceso si el rol es admin_*).
--   RutaProtegida deja pasar si la ruta está en sus rutas o es su redirect. Mirar la
--   columna "redirect" del paso 1:
--     · /acceso   -> ve el botón "Contabilidad Carnes" y entra desde ahí (lo normal);
--     · otra ruta -> aterriza allá. Si ya no debería, cambiar role_permissions.redirect
--                    del rol a '/carnes/contabilidad' (ojo: afecta a TODO el rol) o
--                    avisar al usuario que entre por /carnes/contabilidad.
--   No hace falta tocar el front para el redirect.
--
-- Alternativa sin SQL: UserForm (admin de usuarios) -> editar el usuario -> tildar
-- "Contabilidad Carnes" (aparece en el selector porque está en masterRoutes.js).
-- Hace lo mismo que este script, con la misma trampa del reemplazo: UserForm guarda
-- exactamente lo que está tildado.
-- =============================================================================

-- ─── 1) Ver el estado actual (solo lectura) ──────────────────────────────────
SELECT p.user_id,
       u.email,
       p.role,
       jsonb_array_length(COALESCE(p.personal_routes, '[]'::jsonb)) AS n_rutas_personales,
       p.personal_routes,
       rp.redirect,
       rp.permissions AS rutas_del_rol
FROM profiles p
JOIN auth.users u ON u.id = p.user_id
LEFT JOIN role_permissions rp ON rp.role = p.role
WHERE lower(u.email) = 'contabilidad@merkahorrosas.com';
-- Si no devuelve filas: el usuario no existe o no tiene perfil. NO seguir; crearlo
-- primero desde la pantalla de usuarios.

-- ─── 2) Agregar la ruta ──────────────────────────────────────────────────────
UPDATE profiles p
SET personal_routes =
  CASE
    -- Ya la tiene: no hacer nada.
    WHEN COALESCE(p.personal_routes, '[]'::jsonb) @> '[{"path": "/carnes/contabilidad"}]'::jsonb
      THEN p.personal_routes
    -- Tiene rutas personales: agregar al final.
    WHEN jsonb_array_length(COALESCE(p.personal_routes, '[]'::jsonb)) > 0
      THEN p.personal_routes
           || '[{"path": "/carnes/contabilidad", "label": "Contabilidad Carnes", "permission": "read_only"}]'::jsonb
    -- Sin rutas personales: copiar las del rol y agregar (si el rol no tiene
    -- permisos, queda solo la nueva).
    ELSE COALESCE(
           (SELECT rp.permissions
              FROM role_permissions rp
             WHERE rp.role = p.role
               AND jsonb_typeof(rp.permissions) = 'array'),
           '[]'::jsonb
         )
         || '[{"path": "/carnes/contabilidad", "label": "Contabilidad Carnes", "permission": "read_only"}]'::jsonb
  END
FROM auth.users u
WHERE u.id = p.user_id
  AND lower(u.email) = 'contabilidad@merkahorrosas.com';
-- Debe decir "UPDATE 1". Si dice UPDATE 0, el paso 1 no devolvió filas.

-- ─── 3) Verificar (solo lectura) ─────────────────────────────────────────────
SELECT u.email, p.role, p.personal_routes
FROM profiles p
JOIN auth.users u ON u.id = p.user_id
WHERE lower(u.email) = 'contabilidad@merkahorrosas.com';
