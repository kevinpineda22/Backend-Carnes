# Variables de entorno — Backend Carnes

Copiá este bloque a un `.env` en la raíz del repo (y a Vercel → Settings →
Environment Variables cuando se despliegue).

> No pude crear el `.env.example` yo mismo: el entorno bloquea la escritura de
> archivos `.env*`. Este documento cumple la misma función.

## Lo que falta en el `.env` actual

El `.env` que ya existe tiene Supabase y SMTP. Faltan cuatro, y sin las dos
primeras el módulo queda a medias:

| Variable | Qué pasa si falta |
|---|---|
| `CARNES_MAIL_ADMIN` | **el aviso al admin no sale**. Queda en el log del server y nada más. |
| `CARNES_ADMIN_KEY` | `GET /api/sedes/tokens` y `regenerar-token` responden 503. No se pueden imprimir los stickers de QR. |
| `CARNES_PANEL_URL` | el botón del correo apunta al default. |
| `CARNES_SANDBOX` | sin ella el sandbox queda **apagado** y los correos de prueba salen de verdad. |

```env
# ─── Supabase ────────────────────────────────────────────────────────────────
SUPABASE_URL=
# La SERVICE key, no la anon: este backend escribe con permisos plenos.
SUPABASE_SERVICE_KEY=

# ─── Correo (SMTP Office365) ─────────────────────────────────────────────────
# El host/puerto/TLS se leen como SMTP_* con respaldo a EMAIL_*, para que un
# .env copiado de traslados o inventarios (que usan el prefijo EMAIL_) funcione
# igual en vez de fallar por un nombre de variable.
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
EMAIL_USER=
EMAIL_PASS=

# Quién recibe el aviso de "el recibidor ya terminó". Acepta varios separados
# por coma. Sin esto el correo no sale, y queda registrado en el log del server.
CARNES_MAIL_ADMIN=

# A dónde apunta el botón "Revisar y aprobar" del correo.
CARNES_PANEL_URL=https://merkahorro.com/carnes/admin

# ─── Llave de los endpoints de tokens de QR ──────────────────────────────────
# Protege GET /api/sedes/tokens y POST /api/sedes/:id/regenerar-token, que son
# los únicos que exponen el secreto del que depende la verificación de sede.
# NO se pone en el front: una variable VITE_* termina en el bundle.
CARNES_ADMIN_KEY=

# ─── Autenticación de la API (off | reportar | exigir) ───────────────────────
# Sin la variable, o con cualquier otro valor, es "off": la API se comporta como
# siempre. Ver la sección "Autenticación de la API" más abajo antes de cambiarla.
CARNES_AUTH=off

# ─── SIESA: vísceras de res al cerrar la recepción ───────────────────────────
# En true, cerrar una recepción de res manda sus vísceras a SIESA (un CEI por
# recepción) en vez de esperar al ajuste de la liquidación. Necesita también
# CARNES_SIESA_ACTIVO=true y correr antes sql/025_visceras_recepcion.sql.
# El CEI se contabiliza al importarse: no se prende hasta que se decida.
# Sin esta variable (o en false) todo funciona como antes.
CARNES_SIESA_VISCERAS_AL_CIERRE=false

# ─── Pruebas ─────────────────────────────────────────────────────────────────
# En true no sale ni un correo.
CARNES_SANDBOX=true
```

## Autenticación de la API (`CARNES_AUTH`)

El front manda el JWT de la sesión de Supabase (`Authorization: Bearer …`) y el
backend lo verifica contra el MISMO proyecto de Supabase de la app. No hay
secretos nuevos: usa el `SUPABASE_SERVICE_KEY` que ya está.

| Modo | Qué hace |
|---|---|
| `off` (por defecto) | Nada. Ni siquiera verifica el token. Idéntico a antes. |
| `reportar` | Verifica si viene token y NUNCA bloquea. Cuenta las anomalías y escribe logs `[carnes-auth]` (ver "Logs"). |
| `exigir` | 401 sin token / token inválido o vencido, 403 si el usuario no tiene fila en `profiles`, 503 si Supabase Auth no responde (o tarda más de 2,5 s), 403 en endpoints de admin si el usuario no puede abrir `/carnes/admin`. |

Siempre quedan afuera: `/api/health*`, las preflight CORS (`OPTIONS`) y los dos
endpoints de tokens de QR (esos siguen cerrados por `X-Admin-Key`).

**Cambiar el modo requiere redeploy.** `CARNES_AUTH` se lee de las variables de
entorno de Vercel: cambiarla no tiene efecto hasta que se vuelve a desplegar. El
rollback (`CARNES_AUTH=off` + redeploy) toma ~1-2 minutos.

**Solo personal.** Después de verificar el token se exige que exista una fila en
`profiles` para ese usuario (cualquiera puede registrarse en Supabase Auth, pero
solo el personal tiene perfil). Sin perfil: `reportar` registra `sin_perfil` y
deja pasar; `exigir` responde 403 `AUTH_SIN_PERFIL`.

**Quién es admin.** Es la misma regla de `RutaProtegida` del front: las rutas del
usuario son `profiles.personal_routes` si tiene alguna, y si no
`role_permissions.permissions` de su rol; puede administrar si alguna cubre
`/carnes/admin` (por segmento: `/carnes` sí, `/carnes/adm` no) o si el
`redirect` de su rol es `/carnes/admin`. Cambios de permisos se notan en ≤ 60 s
(un "no" se recuerda 15 s).

**Cachés (por instancia).** Token válido 60 s (nunca más allá de su `exp`), un
«sin perfil» o «sin permiso» 15 s, un token inválido 10 s. Viven en la memoria
de cada instancia de Vercel: no se comparten entre instancias, y se pierden al
reciclarse. Las verificaciones simultáneas del mismo token (o del mismo usuario
para permisos) se comparten en una sola consulta. Los fallos del proveedor no se
cachean.

**Códigos de error** (`codigo` en el JSON, estables; el front los mapea a
mensajes): `AUTH_REQUERIDA` (401), `AUTH_INVALIDA` (401), `AUTH_SIN_PERFIL`
(403), `AUTH_SIN_PERMISO` (403), `AUTH_NO_DISPONIBLE` (503).

**Auditoría.** En `exigir`, los campos `por`, `recibido_por`, `editado_por`,
`agregado_por`, `subido_por` y `enviado_por` salen del correo del token y el que
mande el cliente se ignora (si el usuario no tiene correo, 403). En `off` y
`reportar` se usa el del body como siempre; en `reportar` se cuenta
`identidad_distinta` si no coincide con el del token.

### Logs

Con `reportar` (o `exigir`) activo no hay una línea por pedido anómalo:

- **Resumen:** una línea `auth_resumen` por instancia cada 5 minutos o cada 1000
  eventos (lo que pase primero), con los contadores `ok`, `sin_token`,
  `token_invalido`, `sin_perfil`, `proveedor_no_disponible`, `admin_denegaria`,
  `admin_denegado` e `identidad_distinta`. Se escribe cuando llega el siguiente
  evento tras vencer la ventana: lo último de una instancia que se apaga puede
  perderse.
- **Detalle:** a lo sumo una línea por tipo por minuto y por instancia (método,
  ruta sin ids, origen, id del usuario). Nunca se loguean tokens ni correos: se
  usa el id del usuario o un hash corto.

### Plan de despliegue

1. **Backend** con `CARNES_AUTH` sin definir (= `off`). No cambia nada. El CORS ya
   acepta la cabecera `Authorization` (el paquete `cors` refleja las cabeceras de
   la preflight), así que esto tiene que estar desplegado ANTES del front.
2. **Front** (manda el token en cada llamada de `carnesApi`). Sin sesión manda la
   petición sin cabecera; no redirige ni falla.
3. `CARNES_AUTH=reportar` en Vercel y redeploy. Mirar los `auth_resumen` unos días:
   - `sin_token`: front viejo en caché u otro cliente que llama a la API.
   - `sin_perfil`: un usuario con sesión pero sin fila en `profiles`.
   - `admin_denegaria`: alguien que usa el panel sin tener el permiso en
     `profiles` / `role_permissions` — arreglar el dato antes de exigir.
   - `identidad_distinta`: el front manda un correo que no es el de la sesión.
   - `proveedor_no_disponible`: Supabase Auth no respondió a tiempo.
4. **Criterio de salida de `reportar` a `exigir`:** varios días seguidos (que
   incluyan días de operación normal en todas las sedes) con CERO en `sin_token`,
   `sin_perfil`, `admin_denegaria` e `identidad_distinta` en los `auth_resumen`.
   Mientras haya alguno, se investiga cada caso en las líneas de detalle.
5. **Checklist antes de `exigir`:**
   - [ ] Verificar que la RLS de `profiles` en Supabase NO deja a un usuario
     actualizar su propio `role` ni `personal_routes` (si lo permite, cualquiera
     con sesión se daría permiso de admin).
   - [ ] Verificar que el registro de usuarios (signups) está deshabilitado o
     restringido: la exigencia de perfil protege la API, pero no reemplaza esto.
6. `CARNES_AUTH=exigir` y redeploy.

**Rollback en cualquier paso:** `CARNES_AUTH=off` y redeploy (~1-2 min).

## Generar la llave de admin

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Comprobar que el correo funciona

Levantá el server y pegale a:

```bash
curl http://localhost:3002/api/health/email
```

Se conecta al SMTP y autentica **sin enviar nada**. Un `503` significa que las
credenciales están mal o que el tenant tiene SMTP AUTH apagado — cosas que
"las variables están cargadas" no alcanza para descartar.

## Por qué `CARNES_SANDBOX=true` mientras se prueba

Cada vez que un recibidor cierra una recepción le llega un correo al admin. Si
se prueba el flujo con el sandbox apagado, esa persona recibe avisos de
recepciones de mentira hasta que aprende a ignorarlos — y ese es exactamente el
día en que el correo que sí importa no lo va a leer.
