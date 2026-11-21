# Runbook de producción: preliquidación de talleres (slice S1)

Fecha de ejecución: lunes 2026-11-23. Cambio: `preliquidacion-taller`, slice S1.

Alcance de S1: modelo de datos (038), RPC (039), lógica de costeo, rutas admin `/api/preliquidaciones`
y novillos obligatorio al finalizar una recepción (el backend responde 400 `NOVILLOS_INVALIDOS`).
No hay cron ni envío a SIESA. El interruptor `CARNES_PRELIQUIDACION` queda **apagado**.

Archivos involucrados:

| Archivo | Uso |
|---|---|
| `sql/038_preliquidacion.sql` | DDL (9 tablas, 1 columna, 10 índices nombrados, 2 CHECK, 6 triggers). Transacción única, `lock_timeout = 5s`. |
| `sql/039_preliquidacion_rpc.sql` | 10 funciones `carnes_preliq_*` (`SECURITY INVOKER`). Transacción única, sin `lock_timeout`. |
| `test/sql/038_check.sql`, `039a_rpc_vinculacion.sql`, `039b_rpc_liquidacion.sql` | Verificación (`BEGIN ... ROLLBACK`). |
| `sql/038_039_rollback.sql` | Red de seguridad. Transacción única, `lock_timeout = 5s`, aborta si algo se envió a SIESA. |

Convención: los bloques `-- >> ESPERADO` indican el resultado correcto. Cualquier desvío es un NO-GO: detenerse y evaluar la sección 9.

---

## 0. Precondiciones y go / no-go

Marcar todo antes de tocar la base. Si un punto falla, no se ejecuta.

- [ ] Personas presentes: quien ejecuta el SQL, quien despliega (Vercel/frontend) y una persona con acceso al panel de Supabase y Vercel para revertir.
- [ ] No hay actividad en el taller de carnes (sin recibidores con recepciones abiertas).
- [ ] Todas las liquidaciones cerradas (consulta 2.1: cero en `Abierta` y cero en `Costeada`).
- [ ] No hay recepciones en `Borrador` con trabajo reciente (consulta 2.1; las viejas abandonadas son aceptables).
- [ ] Copia de seguridad hecha y verificada (sección 1).
- [ ] Rama `feat/preliquidacion-taller` actualizada hasta `feat/preliquidacion-taller-23-flag-escrituras` (no más allá) y `npm test` en verde (sección 7.1).
- [ ] `CARNES_PRELIQUIDACION` **no** está definida en Vercel, o vale `off` (sección 7.3).
- [ ] Se conoce el valor actual de `CARNES_AUTH` en Vercel (según `docs/PENDIENTES_SEGURIDAD.md:10` es `off`; ver riesgo R1).
- [ ] Se entiende que los tres scripts de `test/sql/` dicen "SOLO en QA, NUNCA en producción" en su cabecera. Aquí se corren en producción porque no hay QA, y se justifica así: son `BEGIN ... ROLLBACK`, 038 y 039 no usan `NOTIFY`, `pg_net`, `http` ni `dblink` (verificado con búsqueda en ambos archivos), los únicos triggers que tocan son `updated_at`, y el lunes no hay actividad. Efectos residuales aceptados: bloqueos breves de fila sobre `carnes_recepciones` y consumo de valores de las secuencias `IDENTITY` (los ids de las tablas nuevas empiezan con huecos).

Ventana sugerida: 60 a 90 minutos. Usar `psql` contra la conexión directa para los scripts de prueba (una sola sesión garantiza que `BEGIN ... ROLLBACK` se respete); el editor SQL del dashboard sirve para el resto.

---

## 1. Copia de seguridad

### 1.1 Dashboard de Supabase

Project > Database > Backups. Confirmar que existe una copia diaria de hoy o, si el plan lo permite, crear una copia manual / punto de restauración (PITR). Anotar fecha y hora: `____________`.

### 1.2 pg_dump de las tablas `carnes_*` (obligatorio, además del dashboard)

Usar la conexión **directa** (puerto 5432) o el session pooler. El pooler en modo transacción (6543) no sirve para `pg_dump`. La versión mayor de `pg_dump` debe ser igual o superior a la del servidor.

```bash
pg_dump "postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres" \
  --format=custom --no-owner --no-privileges \
  --table='public.carnes_*' \
  --file=carnes_pre_038_2026-11-23.dump
```

Verificar que el archivo no está vacío y que lista las tablas:

```bash
pg_restore --list carnes_pre_038_2026-11-23.dump | head -50
```

Guardar el `.dump` fuera de la máquina de trabajo (OneDrive/SharePoint de la empresa). No subirlo a git.

---

## 2. Snapshot previo a la migración

Ejecutar y **guardar el resultado** (pantallazo o copiar a un archivo). Se compara en la sección 6.

### 2.1 Conteos

```sql
SELECT 'carnes_recepciones'      AS tabla, count(*) AS filas, max(id) AS max_id, max(updated_at)::text AS ultimo_cambio FROM carnes_recepciones
UNION ALL SELECT 'carnes_recepcion_items',   count(*), max(id), max(updated_at)::text FROM carnes_recepcion_items
UNION ALL SELECT 'carnes_liquidaciones',     count(*), max(id), max(updated_at)::text FROM carnes_liquidaciones
UNION ALL SELECT 'carnes_liquidacion_gastos',count(*), max(id), max(updated_at)::text FROM carnes_liquidacion_gastos
UNION ALL SELECT 'carnes_siesa_envios',      count(*), max(id), NULL                   FROM carnes_siesa_envios
ORDER BY 1;
```

### 2.2 Distribución por estado

```sql
SELECT 'recepciones' AS tabla, estado, count(*) FROM carnes_recepciones GROUP BY estado
UNION ALL
SELECT 'liquidaciones', estado, count(*) FROM carnes_liquidaciones GROUP BY estado
UNION ALL
SELECT 'siesa_envios', estado, count(*) FROM carnes_siesa_envios GROUP BY estado
ORDER BY 1, 2;
```

```
-- >> ESPERADO (gate de go/no-go):
--    liquidaciones: ninguna fila con estado 'Abierta' ni 'Costeada' (solo 'Cerrada').
--    recepciones:   ninguna fila reciente en 'Borrador' (taller sin actividad).
--    siesa_envios:  ninguna fila en 'enviando'.
```

### 2.3 Estado previo del esquema (debe estar limpio)

```sql
SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (table_name LIKE 'carnes\_preliquidacion%' OR table_name = 'carnes_preliquidaciones')) AS tablas_preliq,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'carnes_recepciones' AND column_name = 'preliquidacion_id') AS columna_vinculo,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'carnes\_preliq\_%') AS funciones_preliq,
  (SELECT count(*) FROM pg_proc WHERE proname = 'carnes_set_updated_at') AS fn_updated_at;
-- >> ESPERADO: 0 | 0 | 0 | 1
```

Si `tablas_preliq`, `columna_vinculo` o `funciones_preliq` no son 0, alguien ya aplicó algo: detenerse y averiguar (038 y 039 son idempotentes, pero hay que saber qué había).

---

## 3. Ejecutar `sql/038_preliquidacion.sql`

1. Abrir el archivo completo y pegarlo/ejecutarlo **de una sola vez** (contiene su propio `BEGIN ... COMMIT`).
2. Si falla con `canceling statement due to lock timeout`: no se aplicó nada (todo o nada). Esperar a que `carnes_recepciones` esté libre y reintentar. No se sube el `lock_timeout`.
3. Si falla con `Falta la función carnes_set_updated_at` o `Faltan tablas base`: no continuar; es un NO-GO (la base no tiene sql/001 a sql/037).

La última sentencia del script lista las tablas.

```
-- >> ESPERADO: 9 filas:
--    carnes_preliquidacion_alertas, _alternas, _config, _corridas, _gastos,
--    _retomas, _saldos, _sedes  y  carnes_preliquidaciones
```

### 3.1 Verificación posterior a 038

```sql
-- (a) Tablas: 9
SELECT count(*) AS tablas FROM information_schema.tables
 WHERE table_schema = 'public'
   AND (table_name LIKE 'carnes\_preliquidacion%' OR table_name = 'carnes_preliquidaciones');
-- >> 9

-- (b) Existencia por to_regclass: ninguna columna NULL
SELECT to_regclass('carnes_preliquidacion_config')    AS config,
       to_regclass('carnes_preliquidacion_corridas')  AS corridas,
       to_regclass('carnes_preliquidaciones')         AS cabecera,
       to_regclass('carnes_preliquidacion_gastos')    AS gastos,
       to_regclass('carnes_preliquidacion_retomas')   AS retomas,
       to_regclass('carnes_preliquidacion_alternas')  AS alternas,
       to_regclass('carnes_preliquidacion_sedes')     AS sedes,
       to_regclass('carnes_preliquidacion_saldos')    AS saldos,
       to_regclass('carnes_preliquidacion_alertas')   AS alertas;
-- >> 9 nombres, ningún NULL

-- (c) Columna nueva en carnes_recepciones
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'carnes_recepciones' AND column_name = 'preliquidacion_id';
-- >> preliquidacion_id | bigint | YES

-- (d) Índices nombrados de 038: 10
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public' AND indexname IN (
   'uq_carnes_preliquidaciones_sin_iniciar', 'idx_carnes_preliquidaciones_especie_estado',
   'idx_carnes_recepciones_preliquidacion',  'idx_carnes_preliq_corridas_iniciada',
   'idx_carnes_preliq_gastos_preliq',        'idx_carnes_preliq_retomas_preliq',
   'idx_carnes_preliq_sedes_preliq_estado',  'idx_carnes_preliq_saldos_destino',
   'idx_carnes_preliq_saldos_origen',        'idx_carnes_preliq_alertas_pendientes')
 ORDER BY 1;
-- >> 10 filas

-- (e) Los 2 CHECK nuevos sobre carnes_recepciones
SELECT conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE conrelid = 'carnes_recepciones'::regclass
   AND conname IN ('ck_carnes_recepciones_liq_xor_preliq', 'ck_carnes_recepciones_preliq_novillos')
 ORDER BY 1;
-- >> 2 filas:
--    ck_carnes_recepciones_liq_xor_preliq  CHECK (NOT (liquidacion_id IS NOT NULL AND preliquidacion_id IS NOT NULL))
--    ck_carnes_recepciones_preliq_novillos CHECK (preliquidacion_id IS NULL OR (novillos > 0 AND novillos = trunc(novillos)))

-- (f) FK de la columna nueva con ON DELETE RESTRICT (confdeltype = 'r')
SELECT conname, confdeltype FROM pg_constraint
 WHERE conrelid = 'carnes_recepciones'::regclass AND contype = 'f'
   AND confrelid = 'carnes_preliquidaciones'::regclass;
-- >> 1 fila, confdeltype = r

-- (g) Triggers updated_at: 6
SELECT tgname FROM pg_trigger
 WHERE NOT tgisinternal AND tgname LIKE 'set\_updated\_at\_carnes\_preliq%' ORDER BY 1;
-- >> 6 filas (config, preliquidaciones, gastos, retomas, sedes, saldos)

-- (h) Configuración inicial: res y cerdo en 0 (el servicio se carga después, ver sección 10)
SELECT especie, servicio_por_animal, ventana_dias FROM carnes_preliquidacion_config ORDER BY especie;
-- >> cerdo | 0.00 | 2
-- >> res   | 0.00 | 2

-- (i) Ninguna recepción existente quedó vinculada
SELECT count(*) AS vinculadas FROM carnes_recepciones WHERE preliquidacion_id IS NOT NULL;
-- >> 0
```

Opcional (idempotencia): volver a ejecutar 038 completo no debe fallar ni cambiar los resultados anteriores.

---

## 4. Ejecutar `sql/039_preliquidacion_rpc.sql`

Pegar/ejecutar completo (su propio `BEGIN ... COMMIT`). Si falla con `Falta sql/038_preliquidacion.sql`, la sección 3 no quedó aplicada. 039 no define `lock_timeout` (solo hace `CREATE OR REPLACE FUNCTION`, que no bloquea tablas).

### 4.1 Verificación posterior a 039

```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'carnes\_preliq\_%'
 ORDER BY p.proname;
```

```
-- >> ESPERADO: 10 filas, todas con security_definer = false:
--    carnes_preliq_actualizar_novillos   (bigint, numeric, integer, jsonb)
--    carnes_preliq_actualizar_servicio   (bigint, numeric, text, date, timestamp with time zone, boolean)
--    carnes_preliq_aplicar_plan_sedes    (bigint, jsonb)
--    carnes_preliq_congelar_sede         (bigint, integer, integer, jsonb)
--    carnes_preliq_crear                 (text, jsonb)
--    carnes_preliq_desvincular           (bigint, integer, jsonb)
--    carnes_preliq_liquidar              (bigint, integer, timestamp with time zone, jsonb)
--    carnes_preliq_transicionar_sede     (bigint, integer, text, text, jsonb)
--    carnes_preliq_validar_plan_sedes    (bigint, jsonb)
--    carnes_preliq_vincular              (bigint, bigint, integer, jsonb)
```

Las firmas deben coincidir con las de los `DROP FUNCTION` de `sql/038_039_rollback.sql`; si alguna difiere, el rollback dejaría funciones huérfanas.

---

## 5. Scripts de prueba (`test/sql/`)

Ejecutar **uno por uno, completos**, con `psql` (conexión directa):

```bash
psql "postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f test/sql/038_check.sql
psql "postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f test/sql/039a_rpc_vinculacion.sql
psql "postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f test/sql/039b_rpc_liquidacion.sql
```

Solo corre la PARTE 1 de 039a y 039b: la PARTE 2 (carreras con dos sesiones) está comentada y **no se ejecuta**.

Cómo se ve el éxito:

- El script termina **sin ninguna excepción** y el último comando es `ROLLBACK`. Cada bloque `DO` lanza `RAISE EXCEPTION` si una verificación falla; si no hay excepciones, todo está bien.
- Son normales los `NOTICE` del tipo `Sin recepción elegible: se omite vincular` o `No hay recepciones de res sin liquidación...`: esa parte de la prueba se omitió por falta de datos elegibles, no es un fallo. Anotar cuáles se omitieron; en producción, si hay recepciones de res/cerdo sin liquidación con `novillos` entero > 0 se ejercitarán más caminos (siempre dentro de la transacción).
- Si un script falla a mitad: la transacción queda abortada y se deshace al cerrar la sesión (con `ON_ERROR_STOP` psql termina). No hay datos que limpiar. Aun así, ejecutar la consulta 5.1.

### 5.1 Comprobar que no quedó nada (después de cada script y al final)

```sql
SELECT
  (SELECT count(*) FROM carnes_preliquidaciones)            AS cabeceras,
  (SELECT count(*) FROM carnes_preliquidacion_sedes)        AS sedes,
  (SELECT count(*) FROM carnes_preliquidacion_alertas)      AS alertas,
  (SELECT count(*) FROM carnes_preliquidacion_corridas)     AS corridas,
  (SELECT count(*) FROM carnes_recepciones WHERE preliquidacion_id IS NOT NULL) AS recepciones_vinculadas,
  (SELECT count(*) FROM carnes_preliquidacion_config WHERE servicio_por_animal <> 0) AS config_modificada;
-- >> 0 | 0 | 0 | 0 | 0 | 0
```

Cualquier valor distinto de 0 significa que algo se confirmó fuera de la transacción (por ejemplo, un cliente con autocommit que ignoró el `BEGIN`). Es un NO-GO: ir a la sección 9.

---

## 6. NOTIFY de PostgREST y comparación de snapshot

### 6.1 Recarga del esquema

El backend usa `supabase-js` (PostgREST) para leer tablas y llamar `supabase.rpc(...)`. Si la caché de esquema de PostgREST no se actualizó, las llamadas devuelven `PGRST202` (función no encontrada) o `PGRST204`/`42703` (columna no encontrada). El repositorio no ejecuta ningún `NOTIFY`; Supabase normalmente recarga el esquema solo tras DDL, pero no se puede confirmar desde el código, así que se fuerza (es inocuo e idempotente):

```sql
NOTIFY pgrst, 'reload schema';
```

Esperar unos segundos. Prueba rápida de que la API ve las tablas nuevas (con la `service_role` key, desde una terminal, sin imprimir la key en pantalla compartida):

```bash
curl -s "https://<PROJECT_REF>.supabase.co/rest/v1/carnes_preliquidacion_config?select=especie,servicio_por_animal" \
  -H "apikey: <SERVICE_ROLE_KEY>" -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
# >> [{"especie":"cerdo","servicio_por_animal":0.00},{"especie":"res","servicio_por_animal":0.00}]  (el orden puede variar)
```

Si responde `PGRST205` ("Could not find the table"), repetir el `NOTIFY` y esperar; si persiste, Project Settings > API > reiniciar / recargar caché de esquema.

### 6.2 Comparar snapshot

Volver a ejecutar las consultas 2.1 y 2.2 y compararlas **fila por fila** con el resultado previo.

```
-- >> ESPERADO: idéntico, incluidos max(updated_at). 038 solo agrega una columna NULL
--    y CHECK que no aplican a filas existentes; no debe cambiar ninguna fila.
```

Cualquier diferencia en conteos o en `ultimo_cambio` es un NO-GO.

---

## 7. Despliegue de código

Vercel despliega desde `main` (`vercel.json` usa `src/server.js` con `@vercel/node`). En el modelo `feature-branch-chain` solo el tracker `feat/preliquidacion-taller` se fusiona a `main`.

### 7.0 Orden obligatorio

1. SQL (secciones 3 a 6).
2. **Frontend primero** (`npm run deploy`, lo ejecuta la persona responsable).
3. **Backend después** (merge a `main`).

Motivo: el backend rechaza `finalizar` con 400 `NOVILLOS_INVALIDOS` cuando `novillos` no es un entero > 0 (`src/models/Recepcion.model.js:1160-1161`, `src/shared/novillosObligatorio.js:22-36`) y esa regla **no depende del interruptor**. El frontend anterior solo bloqueaba el cierre cuando faltaban novillos en res con vísceras por factor (el commit del frontend elimina `items.some((i) => esViceraPorFactor(i)) && aCantidad(novillos) <= 0`); con cerdo, o res sin vísceras por factor, permitía cerrar con 0, y ahora recibiría 400. El frontend nuevo (rama `feat/preliquidacion-taller-fe-01-novillos-obligatorio`, commit `47166f1e`) ya pide novillos y es compatible con el backend anterior, por lo que desplegarlo primero no rompe nada. Con el taller sin actividad el lunes, el riesgo real es el martes: recibidores con la SPA vieja en caché. Pedirles recargar la página (Ctrl+F5) antes de la primera recepción del martes.

### 7.1 Preparar el tracker (backend)

Ahora `main` y `feat/preliquidacion-taller` apuntan al mismo commit (`cafc578`) y la cadena de ramas va por delante. Antes del merge, el tracker debe llegar hasta `-23-flag-escrituras` y NO más allá: las ramas `-24` en adelante son la etapa 2 (envío a SIESA, sql/040), sin revisar y fuera de esta migración.

```bash
git switch feat/preliquidacion-taller
git merge --ff-only feat/preliquidacion-taller-23-flag-escrituras   # cadena -01 ... -23: etapa 1, reversa, runbook y bloqueo de escrituras
npm test                                                    # debe terminar en verde
git log --oneline main..HEAD | wc -l                        # revisar cuántos commits entran
```

Si `--ff-only` falla, la cadena no está linealizada: detenerse y resolverlo antes del lunes (no mezclar a ciegas el día de la migración).

### 7.2 Frontend

Repo `Pagina-web_React`, rama `feat/preliquidacion-taller-fe-01-novillos-obligatorio` (commit `47166f1e`). La integración a la rama de despliegue y `npm run deploy` los ejecuta el responsable del frontend (no se ejecuta build ni deploy desde este runbook). Verificar en producción que "Novillos que llegaron" / "Canales que llegaron" aparece como obligatorio en RecibidorTalleres.

### 7.3 Variables de entorno (solo nombres; verificar en Vercel, no en archivos)

| Variable | Valor el lunes | Nota |
|---|---|---|
| `CARNES_PRELIQUIDACION` | **sin definir** u `off` | Solo `on`, `true`, `1` la encienden (`src/config/preliquidacion.js:15-20`). Se lee en cada llamada, pero en Vercel un cambio de variable solo aplica tras un nuevo deploy. |
| `CARNES_AUTH` | no cambiar | Hoy `off` según `docs/PENDIENTES_SEGURIDAD.md:10`. Ver R1. |
| `CARNES_MAIL_PRELIQUIDACION` | opcional | Destinatarios de alertas; en S1 la alerta es un no-op registrado en log. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | sin cambios | Ya existentes. |
| `CARNES_SIESA_ACTIVO`, `CARNES_SIESA_VISCERAS_AL_CIERRE`, `CARNES_SANDBOX`, `CARNES_MAIL_ADMIN`, `CARNES_MAIL_PROVEEDORES`, `CARNES_PANEL_URL`, `CARNES_ADMIN_KEY`, `CARNES_ORIGENES` | sin cambios | No se tocan. |

### 7.4 Backend

```bash
git switch main
git merge --ff-only feat/preliquidacion-taller
git push origin main        # Vercel despliega main automáticamente
```

Esperar a que el deploy de Vercel termine en `Ready`. Anotar la URL del deploy anterior (para rollback instantáneo): `____________`.

---

## 8. Pruebas de humo posteriores al despliegue

`BASE` = URL de producción del backend. Si `CARNES_AUTH` fuera `exigir`, añadir `-H "Authorization: Bearer <JWT admin>"`; en `off` no hace falta.

```bash
# 8.1 Salud
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/health"
# >> 200

# 8.2 Flujos existentes siguen vivos (solo lectura)
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/sedes"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/recepciones"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/liquidaciones"
# >> 200 en las tres

# 8.3 El módulo nuevo lee las tablas (y no rompe)
curl -s "$BASE/api/preliquidaciones"
# >> {"ok":true,"data":[]}
curl -s "$BASE/api/preliquidaciones/config/res"
# >> {"ok":true,"data":{"especie":"res","servicio_por_animal":0 ... }}

# 8.4 Con el interruptor apagado, crear se rechaza SIN tocar la base
curl -s -w "\n%{http_code}\n" -X POST "$BASE/api/preliquidaciones" \
  -H "Content-Type: application/json" -d '{"especie":"res","animales":10}'
# >> 409, "codigo":"preliquidacion_apagada"

# 8.5 Vincular también está apagado (el id es irrelevante: la guarda corre antes de leer)
curl -s -w "\n%{http_code}\n" -X POST "$BASE/api/preliquidaciones/1/recepciones" \
  -H "Content-Type: application/json" -d '{"recepcion_ids":[1]}'
# >> 409, "codigo":"preliquidacion_apagada"
```

Con el interruptor apagado, **toda** escritura de `/api/preliquidaciones` (`POST /`, `PUT /config/:especie`, `PATCH /:id`, `PUT /:id/gastos`, `PUT /:id/retomas`, `POST /:id/recepciones`, `DELETE /:id/sedes/:sedeId`) responde 409 `preliquidacion_apagada` antes de validar y de tocar la base (ver R1). Por eso 8.4 y 8.5 son seguras; un `PUT /config/res` de prueba también debe devolver 409 y no escribe nada. No usar un `PUT /config/:especie` real como prueba: el día que el interruptor esté encendido sí escribe.

### 8.6 Novillos obligatorio en `finalizar` (400 `NOVILLOS_INVALIDOS`)

No se prueba con `curl` en producción: `POST /api/recepciones/:id/finalizar` exige un recibidor válido y una firma PNG real (`validators.finalizar`), y un intento mal armado podría cerrar una recepción de verdad. La cobertura es:

- `npm test` en verde antes del merge (sección 7.1).
- La primera recepción real del martes con el frontend nuevo: sin novillos entero > 0 el botón de cerrar está deshabilitado; si algún cliente viejo llega al backend, devuelve 400 `NOVILLOS_INVALIDOS` con el mensaje "Falta la cantidad de novillos (canales, en cerdo)...".

### 8.7 Revisar logs y estado de la base (a los 10 minutos)

- Vercel > Logs del deploy: sin 500 nuevos en `/api/recepciones` ni `/api/liquidaciones` (en particular ningún error `preliquidacion_id` / `42703` / `PGRST204`).
- Repetir la consulta 5.1: todo en 0. Si `config_modificada` > 0, alguien llamó `PUT /config/:especie` (ver R1).

---

## 9. Rollback

### 9.1 Criterios de decisión

Revertir si ocurre cualquiera de estos:

- La sección 5.1 o la 6.2 muestra datos o cambios inesperados.
- 038 o 039 fallan por algo distinto de un `lock_timeout` (que se reintenta, sin rollback porque no se aplicó nada).
- Tras el despliegue hay 500 sostenidos en rutas legadas (`/api/recepciones`, `/api/liquidaciones`, `/api/siesa`) atribuibles al cambio.
- Se detecta escritura no autorizada en `carnes_preliquidacion_*` (R1).

No revertir por: 409 `preliquidacion_apagada` (es lo esperado), ni por un 400 `NOVILLOS_INVALIDOS` aislado (es la regla nueva funcionando; revisar quién usa la SPA vieja).

### 9.2 Orden

1. **Interruptor apagado.** Confirmar que `CARNES_PRELIQUIDACION` no está definida u `off` en Vercel (el lunes ya debería estarlo). Si hubo que tocarla, redeploy.
2. **Código.** Vercel > Deployments > deploy anterior > **Instant Rollback** (Promote to Production). No hace falta revertir git de inmediato. Si el problema fuera solo el frontend, volver a desplegar el commit anterior del frontend (`npm run deploy` por el responsable).
3. **Base.** Ejecutar `sql/038_039_rollback.sql` completo (una transacción, `lock_timeout = 5s`). El script:
   - **aborta** (`Rollback abortado: ...`) si alguna sede está `enviando`, `enviada`, `sin_confirmar` o `anulada`, si su envío está `ok/enviando/sin_confirmar`, o si hay una recepción vinculada en `Enviado_SIESA`. En S1 no hay envío a SIESA, así que no debería ocurrir;
   - devuelve las recepciones vinculadas a `Aprobado` (limpiando costos) y elimina funciones, CHECK, índice, columna y las 9 tablas;
   - **borra todos los datos de preliquidación y la configuración por especie**: si se necesitan, exportar antes (`pg_dump --table='public.carnes_preliquidacion*' --table=public.carnes_preliquidaciones`).
4. **PostgREST.**

   ```sql
   NOTIFY pgrst, 'reload schema';
   ```

### 9.3 Verificación posterior al rollback

```sql
-- Ambas consultas: 0 filas
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND (table_name LIKE 'carnes\_preliquidacion%' OR table_name = 'carnes_preliquidaciones');
SELECT proname FROM pg_proc WHERE proname LIKE 'carnes\_preliq\_%';

-- Columna eliminada: 0
SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'carnes_recepciones' AND column_name = 'preliquidacion_id';

-- Snapshot: volver a ejecutar 2.1 y 2.2 y comparar con la sección 2 (idéntico,
-- salvo recepciones devueltas de Costeado a Aprobado, que el lunes no debería haber)
```

Qué esperar del backend sin 038 (o después del rollback), si el código nuevo siguiera desplegado:

- Rutas legadas funcionan: `COLUMNAS_RECEPCION` no incluye `preliquidacion_id` a propósito, y las guardas (`src/models/PreliquidacionGuardas.model.js:15-47`) tratan `42703`, `PGRST204` o "column ... does not exist" como "sin vínculo". Cubre `Recepcion.model.js:823, 1035, 1086` y `Liquidacion.model.js:848`.
- Las rutas `/api/preliquidaciones` (lectura y config) devuelven 500 porque las tablas no existen. Con el interruptor apagado, toda escritura (`POST /`, `PUT /config/:especie`, `PATCH`, gastos, retomas, `POST /:id/recepciones`, `DELETE .../sedes/:sedeId`) sigue respondiendo 409 `preliquidacion_apagada` antes de tocar la base.
- La regla de novillos (400 `NOVILLOS_INVALIDOS`) **sigue activa**: no depende de 038. Por eso el rollback de código es el paso 2.

Smoke posterior: repetir 8.1 y 8.2.

---

## 10. Riesgos conocidos y pendientes

### R1. Con `CARNES_AUTH=off`, `/api/preliquidaciones` es público; la protección de las escrituras es el interruptor

Evidencia:

- `docs/PENDIENTES_SEGURIDAD.md:10`: `CARNES_AUTH` está desplegada en `off` ("La API sigue abierta").
- `src/middleware/auth.js:93-104`: cualquier valor no reconocido (o vacío) es `off`.
- `src/middleware/auth.js:366` (`autenticar`) y `:436` (`requireAdminCarnes`): con modo `off` ambos hacen `return next()` sin verificar nada. El router aplica `router.use(requireAdminCarnes)` en `src/routes/preliquidaciones.routes.js`, así que en `off` esa "guarda de admin" no hace nada.

Estado actual (corregido): el router aplica a continuación `router.use(PreliquidacionesController.exigirEscrituraHabilitada)`. Con `CARNES_PRELIQUIDACION` apagado, **todo método distinto de GET** responde 409 `preliquidacion_apagada` antes de validar el cuerpo y de tocar la base. Cubre `POST /`, `PUT /config/:especie`, `PATCH /:id`, `PUT /:id/gastos`, `PUT /:id/retomas`, `POST /:id/recepciones` y `DELETE /:id/sedes/:sedeId`. Las lecturas (GET) siguen disponibles. Las pruebas están en `test/preliquidacion-flag-off.test.js` y `test/preliquidacion-routes.test.js`.

Consecuencias para la operación:

- Mientras el interruptor esté apagado, nadie puede modificar `carnes_preliquidacion_config` por el backend, aunque `CARNES_AUTH` siga en `off`. Se mantiene la premisa "config en 0 hasta decidirlo".
- **Configurar `servicio_por_animal` (`PUT /config/:especie`) exige el interruptor encendido.** Ya no es posible dejar la configuración lista antes de encenderlo; se hace justo después de encender, antes de crear la primera preliquidación (`crear` rechaza con 409 `config_servicio_cero` mientras el servicio sea 0).
- Desvincular sedes también queda bloqueado con el interruptor apagado.

Lo que este cambio **no** resuelve: el interruptor no es autenticación. Al encenderlo, con `CARNES_AUTH=off` cualquiera con la URL podrá escribir. La solución real es `CARNES_AUTH=exigir`, que debe estar activo **antes** de encender `CARNES_PRELIQUIDACION`. No pasar `CARNES_AUTH` a `exigir` el lunes: `docs/PENDIENTES_SEGURIDAD.md:19` lo desaconseja hasta terminar la Fase 2 de RLS. Tampoco cubre el acceso directo a PostgREST (ver R2).

Verificación opcional después del despliegue (solo lectura):

```sql
SELECT especie, servicio_por_animal, updated_at FROM carnes_preliquidacion_config ORDER BY especie;
-- >> 0.00 y updated_at = hora de la migración.
```

### R2. Las tablas y funciones nuevas no tienen RLS ni `REVOKE`

Ningún archivo de `sql/` activa RLS ni revoca permisos en tablas `carnes_*`, y 038/039 siguen esa práctica. En Supabase, las tablas y funciones del esquema `public` quedan expuestas por PostgREST con la anon key (pública en el bundle del frontend, ver `docs/PENDIENTES_SEGURIDAD.md:11`), de modo que lo anterior (R1) también se puede hacer directamente contra PostgREST, saltándose el backend y `CARNES_AUTH`. No es una exposición nueva en naturaleza (las demás tablas `carnes_*` están igual), pero amplía la superficie. Verificar el estado real:

```sql
SELECT c.relname, c.relrowsecurity AS rls_activa
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND (c.relname LIKE 'carnes\_preliquidacion%' OR c.relname IN ('carnes_preliquidaciones', 'carnes_recepciones'))
   AND c.relkind = 'r'
 ORDER BY 1;
```

Pendiente de seguridad (no bloquea el lunes): definir RLS/privilegios para `carnes_preliquidacion*` antes de encender el interruptor.

### R3. Scripts de prueba pensados para QA, ejecutados en producción

Mitigado por `BEGIN ... ROLLBACK`, ausencia de efectos externos y taller sin actividad (sección 0). Residual: huecos en las secuencias `IDENTITY` y bloqueos breves sobre `carnes_recepciones`. Si un cliente ignora el `BEGIN` (autocommit), los datos de prueba se confirmarían: por eso 5.1 es obligatoria y el script se corre con `psql`.

### R4. Desplegar el backend antes que el frontend rompe el cierre de recepciones

Ver 7.0. Orden obligatorio: frontend, luego backend. El código de rollback de backend no revierte el efecto en clientes que ya tienen la SPA nueva (es compatible hacia atrás).

### R5. Limpieza de datos si se enciende el interruptor para una prueba manual (no recomendado el lunes)

**Recomendación: no encender `CARNES_PRELIQUIDACION` el lunes.** S1 no tiene `anular` ni borrado de cabeceras en la API:

- Rutas disponibles (`src/routes/preliquidaciones.routes.js`): listar, crear, config, obtener, `PATCH`, gastos, retomas, vincular, `DELETE /:id/sedes/:sedeId` (desvincular) y previsualizar. **No existe** `POST /:id/anular`, aunque el comentario de `sql/038_preliquidacion.sql:338-339` lo menciona; tampoco hay RPC de anular en 039.
- Una cabecera de prueba `abierta` y sin iniciar bloquea la siguiente de la misma especie (índice único `uq_carnes_preliquidaciones_sin_iniciar` / resultado `abierta_en_curso`), y no se puede borrar desde la API.
- El endpoint `desvincular` solo suelta recepciones y las devuelve a su estado; no borra la cabecera.

Si aun así se prueba con el interruptor encendido, el orden de limpieza (primero desvincular por API, luego SQL en una transacción) es:

```sql
-- 1) Por API: DELETE /api/preliquidaciones/:id/sedes/:sedeId para cada sede (RPC carnes_preliq_desvincular).
-- 2) Verificar que no quedan recepciones vinculadas a la cabecera de prueba:
SELECT id FROM carnes_recepciones WHERE preliquidacion_id = <ID_PRUEBA>;   -- debe dar 0 filas

-- 3) Borrado manual (una transacción; reemplazar <ID_PRUEBA>):
BEGIN;
SET LOCAL lock_timeout = '5s';
DELETE FROM carnes_preliquidacion_saldos  WHERE origen_preliquidacion_id = <ID_PRUEBA> OR destino_preliquidacion_id = <ID_PRUEBA>;
DELETE FROM carnes_preliquidacion_alternas WHERE preliquidacion_id = <ID_PRUEBA>;
DELETE FROM carnes_preliquidacion_sedes   WHERE preliquidacion_id = <ID_PRUEBA>;
DELETE FROM carnes_preliquidacion_alertas WHERE preliquidacion_id = <ID_PRUEBA>;
DELETE FROM carnes_preliquidaciones       WHERE id = <ID_PRUEBA>;   -- gastos y retomas caen por CASCADE
COMMIT;
```

Si hay dudas, es más simple y seguro revertir con `sql/038_039_rollback.sql` (que borra todo) y volver a aplicar 038 y 039.

### R6. Otros pendientes (informativos)

- Cambiar `CARNES_PRELIQUIDACION` en Vercel requiere un nuevo deploy para aplicar, aunque el comentario de `src/config/preliquidacion.js:4-6` sugiere lo contrario (la lectura es por llamada, pero el valor de la variable lo fija el deploy). Así lo documenta `docs/VARIABLES_DE_ENTORNO.md:90-92` para `CARNES_AUTH`.
- 039 no define `lock_timeout`; es aceptable porque `CREATE OR REPLACE FUNCTION` no bloquea tablas.
- El rollback aborta si alguna sede está `anulada`; en S1 no existe el flujo que la produce.
- Cron, envío a SIESA y correcciones (sql/040, sql/041) no existen todavía: no hay nada que apagar fuera del interruptor.
- Antes de encender el interruptor: cerrar R1 (`CARNES_AUTH=exigir`) y R2, y ensayar el flujo en un entorno no productivo. Después de encenderlo, y antes de crear la primera preliquidación, cargar `servicio_por_animal` > 0 por especie vía `PUT /config/:especie` (con el interruptor apagado ese PUT responde 409; con `0`, `crear` devuelve `config_servicio_cero`).
