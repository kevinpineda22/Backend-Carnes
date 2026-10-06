# Pendientes de seguridad: autenticación de Carnes y RLS de Supabase

> Estado al 06/10/2026. Documento de trabajo para retomar. Nada de lo descrito en
> "Pendiente" está aplicado todavía.

## 1. Resumen

| Tema | Estado | Riesgo hoy |
|---|---|---|
| Autenticación de la API de Carnes (`CARNES_AUTH`) | Desplegada en `off` (no hace nada) | La API sigue abierta: cualquiera con la URL puede leer, borrar o mandar a SIESA |
| RLS de `profiles` y `role_permissions` en Supabase | Políticas `ALL` a `public` con `true` | **Crítico, afecta a toda la app**: sin login, con la anon key (pública en el bundle del front), se pueden leer, editar y borrar perfiles y permisos |

Orden para cerrar todo:

1. Fase 1 de RLS (sección 3): quitarle la escritura al anónimo.
2. Fase 2 de RLS (sección 4): que un usuario logueado no pueda darse permisos.
3. `CARNES_AUTH=reportar` y después `exigir` (sección 5).

**No pasar `CARNES_AUTH` a `exigir` antes de terminar la Fase 2**: mientras cualquiera
pueda editar `profiles.personal_routes` o `role_permissions`, puede hacerse admin de
Carnes y la autenticación no protege nada.

## 2. Hallazgo en Supabase (verificado el 06/10/2026)

Consultas ejecutadas en el SQL Editor (solo lectura):

```sql
select relname as tabla, relrowsecurity as rls_activa
from pg_class where relname in ('profiles', 'role_permissions');

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where tablename in ('profiles', 'role_permissions');

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_name in ('profiles', 'role_permissions')
  and grantee in ('anon', 'authenticated');
```

Resultado:

- RLS activa en las dos tablas.
- Una única política por tabla: `Permitir todo a profiles` / `Permitir todo a role_permissions`,
  comando `ALL`, rol `public`, `USING true`, `WITH CHECK true`. Equivale a no tener RLS.
- `anon` y `authenticated` tienen todos los privilegios (es el default de Supabase; lo que
  protege es la RLS). Incluye `TRUNCATE`, que **no** respeta RLS.

## 3. Quién usa estas tablas (mapeo del 06/10/2026)

### Front (`Pagina-web_React`, cliente con anon key + sesión del usuario)

| Archivo | Operación | Cuándo |
|---|---|---|
| `pages/admin/Login.jsx` | SELECT `profiles` (por `user_id`) y `role_permissions` (por `role`) | Después de `signInWithPassword` (logueado) |
| `RutaProtegida.jsx` | SELECT de ambas | Logueado |
| `Acceso.jsx` | SELECT de ambas; **UPDATE de su propio `personal_routes`** (quitar un acceso) | Logueado. Es la vía de autoescalada |
| `AdminUsuarios.jsx` | SELECT de todos los perfiles | Logueado |
| `UserList.jsx` | **UPDATE masivo** de `role`, `company`, `sede_id` de otros usuarios | Logueado (admin de usuarios) |
| `AsignarEquipo.jsx` | **UPDATE** de `lider_id` de otros usuarios | Logueado (líder) |
| `UserForm.jsx`, `TeamManagerForm.jsx` | Edge Functions `create-user` / `update-user` | Con el JWT del usuario |
| `TeamManager.jsx`, `GestionPickers.jsx`, `HistorialConteos.jsx`, `GeneradorReporteIA.jsx`, `AdminTrazabilidad.jsx`, `SolicitudDesarrollo.jsx` | SELECT | Logueado |
| `SedeContext.jsx` | SELECT de su perfil **por `correo`** (no por uid) | Logueado |

Nadie escribe `role_permissions` desde el navegador. Ninguna pantalla pública lee estas
tablas sin sesión.

### Backends que comparten el proyecto

| Backend | Uso | Key |
|---|---|---|
| Backend-Carnes | SELECT ambas | service role |
| Backend-DespachoMega | SELECT ambas | service role |
| Backend-woocomerce | **UPDATE `sede_id`**, SELECT | `SUPABASE_KEY` (el código dice service role, **sin verificar**) |
| Trazabilidad-Backend | SELECT | `SUPABASE_KEY` (el código dice service role) |
| Backend_GastosMK | SELECT `nombre` por `correo` | `SUPABASE_KEY` (sin determinar) |
| Backend-Inventario-General | SELECT `user_id, nombre, correo` | **anon key sin sesión** (`Conteo.model.js`) |
| Edge Function `fotos-empleados` | SELECT ambas | JWT del usuario + anon key (respeta RLS) |
| Edge Functions `create-user` / `update-user` | Escriben `profiles` | **Código fuente fuera de los repos**: key sin determinar |

### Sin determinar

- La key real de las Edge Functions `create-user` / `update-user`.
- Si `SUPABASE_KEY` de Backend-woocomerce y de Backend_GastosMK es service role o anon.
- Si `profiles.id` existe y es igual a `user_id`.
- Si Escuela-Riqueza usa este mismo proyecto (tiene otro `profiles`).
- Quién edita hoy `role_permissions` (se asume el dashboard).

## 4. Fase 1: sin escritura para el anónimo (pendiente)

Qué logra: sin login ya no se puede escribir ni borrar. La lectura anónima se mantiene
**temporalmente** porque Backend-Inventario-General la usa. `role_permissions` queda de
solo lectura para la API (el dashboard de Supabase no pasa por RLS).

**Antes de ejecutarla**, verificar que `SUPABASE_KEY` de Backend-woocomerce en Vercel es la
`service_role` (comparar primeros y últimos caracteres con *Settings → API Keys*; no pegar
la key en ningún lado). Si es la `anon`, esta fase rompe la asignación de sede del
ecommerce: hay que cambiarle la key primero.

```sql
begin;

drop policy "Permitir todo a profiles" on public.profiles;
drop policy "Permitir todo a role_permissions" on public.role_permissions;

-- profiles: leer sin login (temporal), escribir solo logueado
create policy "profiles_leer" on public.profiles
  for select to anon, authenticated using (true);
create policy "profiles_escribir_autenticado" on public.profiles
  for all to authenticated using (true) with check (true);

-- role_permissions: solo lectura (se edita desde el dashboard)
create policy "role_permissions_leer" on public.role_permissions
  for select to anon, authenticated using (true);

-- TRUNCATE no respeta RLS: nadie desde la API lo necesita
revoke truncate, trigger, references on public.profiles, public.role_permissions from anon, authenticated;

commit;
```

Vuelta atrás (deja todo como estaba):

```sql
begin;
drop policy if exists "profiles_leer" on public.profiles;
drop policy if exists "profiles_escribir_autenticado" on public.profiles;
drop policy if exists "role_permissions_leer" on public.role_permissions;
create policy "Permitir todo a profiles" on public.profiles for all to public using (true) with check (true);
create policy "Permitir todo a role_permissions" on public.role_permissions for all to public using (true) with check (true);
commit;
```

Después de aplicarla, probar: login, entrar a una pantalla protegida, `Acceso` (quitar un
acceso), `UserList` (cambio de rol), `AsignarEquipo`, crear/editar usuario, asignación de
sede del ecommerce.

## 5. Fase 2: que nadie se dé permisos a sí mismo (pendiente de diseño)

Problema que queda tras la Fase 1: cualquier usuario logueado puede hacer UPDATE de
cualquier perfil (incluido el suyo: `role`, `personal_routes`).

Diseño propuesto:

1. Función `SECURITY DEFINER` `es_admin_usuarios()` que decide si quien llama puede
   administrar usuarios (mismo criterio que la ruta de `AdminUsuarios`/`UserList` en el
   front: rol o `personal_routes`/`role_permissions` que cubran esa ruta). **Falta definir la
   ruta exacta y qué roles son.**
2. Trigger `BEFORE UPDATE` en `profiles` que rechace cambios en `role`, `personal_routes`,
   `company`, `sede_id`, `lider_id` y `user_id` salvo que:
   - quien llama sea la service role, o
   - `es_admin_usuarios()` sea verdadero, o
   - sea un líder cambiando `lider_id` (caso `AsignarEquipo`; definir regla exacta), o
   - sea el propio usuario **quitando** rutas de su `personal_routes` (caso `Acceso`), nunca
     agregando.
3. Reemplazar `profiles_escribir_autenticado` por UPDATE a `authenticated` (el trigger hace
   el control fino); INSERT y DELETE sin política (solo service role).
4. Fase 3 opcional: pasar Backend-Inventario-General a service role y quitar la lectura a
   `anon`.

Probar primero con un usuario de prueba, no con un usuario real.

## 6. Autenticación de la API de Carnes

Implementada en `877bb02` (backend) y en el front (`services/authHeader.js`, interceptor en
`carnesApi.js`). Detalle de modos y despliegue en `docs/VARIABLES_DE_ENTORNO.md`.

| Modo | Qué hace |
|---|---|
| `off` (actual) | No revisa nada; igual que antes |
| `reportar` | Revisa y anota en los logs (`auth_resumen`) quién sería rechazado; no bloquea |
| `exigir` | Bloquea sin sesión válida (401), sin perfil (403), sin permiso de admin (403) |

Cambiar `CARNES_AUTH` en Vercel **requiere redeploy** (1–2 min).

Pasos:

1. Terminar Fases 1 y 2 de RLS.
2. Verificar que el registro público esté apagado (*Authentication → Sign In / Providers →
   Allow new users to sign up*), si los usuarios los crea un admin.
3. `CARNES_AUTH=reportar` + redeploy. Mirar `auth_resumen` varios días.
4. Pasar a `exigir` solo con `sin_token`, `sin_perfil`, `admin_denegaria` e
   `identidad_distinta` en cero.

## 7. Otros pendientes relacionados

- La regla de admin de Carnes está duplicada entre el front (`RutaProtegida`/`Login`) y
  `src/shared/permisoAdminCarnes.js`: si cambia una, cambiar la otra.
- `ModalFinalizarTalleres` duplica ~120 líneas del paso "¿Quién recibió?" de
  `ModalFinalizarProveedor` (deuda técnica).
