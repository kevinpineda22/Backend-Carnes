# Backend Carnes — Merkahorro

API REST de la recepción de carnes (res y cerdo): lo que digita el recibidor en
cada sede, la aprobación del administrador, y el costeo que reparte los gastos
de la entrega entre las sedes.

Reemplaza dos Excel: `01 Septiembre 2026.xlsx` (res) y `1. Principal.xlsm`
(cerdo).

## El cálculo

Los dos Excel corrían **el mismo algoritmo**, un prorrateo:

```
costo_teorico    = Σ (costo_base_i × cantidad_i)
costo_real       = Σ (gasto_j × signo_j) − bonificación de vísceras
factor           = (costo_teorico − costo_real) / costo_teorico
costo_ajustado_i = costo_base_i × (1 − factor)
costo_total_i    = costo_ajustado_i × cantidad_i
```

Reparte lo que de verdad se pagó entre los cortes, en proporción a lo que cada
corte vale en la lista de precios.

**El factor NO es global: cada sede calcula el suyo.** El costo real de una sede
es proporcional a sus KILOS, pero el teórico depende de su MEZCLA DE CORTES, y
la mezcla cambia por sede. Un factor global le cobraría a una el desvío de la
otra.

Vive en `src/shared/costeo.js` y `src/shared/consolidado.js`, módulos **puros**
—sin Supabase, sin Express— con tests que asertan contra los números reales de
los Excel. Si un número no cuadra, el problema está ahí y en ningún otro lado.

```bash
npm test
```

## Correr en local

```bash
npm install
npm run dev        # nodemon en el puerto 3002
```

Variables de entorno: ver `docs/VARIABLES_DE_ENTORNO.md`.

**Antes del primer arranque hay que correr las migraciones** en el SQL Editor de
Supabase, en orden:

1. `sql/001_create_tables.sql` — las 8 tablas
2. `sql/002_seed_catalogos.sql` — sedes, ítems, vísceras y conceptos, generados
   desde los Excel con un script (no transcritos a mano)

## Los QR de sede

Cada sede tiene un `qr_token` opaco y aleatorio. El recibidor elige la sede y
escanea el adhesivo pegado en la zona de recibo; si no coinciden, el backend
responde 409 diciendo **cuál** es la sede real.

```bash
npm run qr              # hoja imprimible con los 9 QR
npm run qr -- --demo    # códigos falsos, para ensayar el escaneo sin tocar la base
```

> `qr-sedes.html` lleva los tokens EN CLARO. Está en `.gitignore`: imprimí, pegá
> los adhesivos y borralo.

Si un adhesivo se filtra, se rota **esa sede sola**:

```bash
curl -X POST -H "X-Admin-Key: $CARNES_ADMIN_KEY" \
  https://<host>/api/sedes/5/regenerar-token
```

## Endpoints

| Ruta | Para qué |
|---|---|
| `GET /api/health` | vivo + si el sandbox de correo está prendido |
| `GET /api/health/email` | autentica contra el SMTP **sin enviar nada** |
| `/api/sedes` | catálogo y verificación del QR |
| `/api/plantilla/:especie` | cortes, vísceras y conceptos de gasto |
| `/api/recepciones` | lo que carga el recibidor y lo que aprueba el admin |
| `/api/liquidaciones` | gastos, reparto por sede y costeo |

`GET /api/sedes/tokens` y `POST /api/sedes/:id/regenerar-token` exigen el header
`X-Admin-Key`: son los únicos que exponen el secreto del que depende toda la
verificación de sede. Sin `CARNES_ADMIN_KEY` configurada responden 503 — fallan
cerrado.

## Estados

```
Borrador → Recibido → Aprobado → Costeado → Enviado_SIESA
              ↓  ↑
          Rechazado
```

`Enviado_SIESA` es **terminal**: el documento ya existe en el ERP y cambiarlo acá
crearía dos versiones de la misma entrega.

Un `Recibido` no vuelve a `Borrador`: se **rechaza**, y el rechazo deja el motivo
escrito. Una vuelta silenciosa borraría la razón y el recibidor no sabría qué
corregir.

## Arquitectura

```
src/
  config/      supabase, cors, sandbox
  middleware/  errorHandler, validators (zod), adminKey
  models/      acceso a datos (Sede, Plantilla, Recepcion, Liquidacion)
  controllers/ traducen HTTP ↔ modelo
  routes/      montaje
  services/    correo y notificaciones
  shared/      costeo, consolidado, estados — PUROS y testeados
```

Mismo patrón que `Backend-traslados`.

## Frontend

Vive en el repo `Pagina-web_React`, bajo `src/pages/Carnes/`:

- `/carnes/recibidor` — pensado para un celular en una cava
- `/carnes/admin` — recepciones, liquidaciones y plantilla

Necesita `VITE_CARNES_API_URL` apuntando a este backend.

## Pendiente

El **conector de SIESA**: la transición `Costeado → Enviado_SIESA`. Todo lo
demás funciona sin él.
