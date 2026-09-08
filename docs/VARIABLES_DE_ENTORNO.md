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

# ─── Pruebas ─────────────────────────────────────────────────────────────────
# En true no sale ni un correo.
CARNES_SANDBOX=true
```

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
