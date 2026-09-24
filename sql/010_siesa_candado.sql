-- =============================================================================
-- Migration 010: un solo envío vigente por recepción y tipo
-- =============================================================================
--
-- Pasó en la prueba de cerdo: R2O y R4O entraron DOS veces a SIESA. El front
-- cortaba la espera a los 30 s mientras el backend seguía mandando sede por
-- sede; el botón se volvía a habilitar, alguien hacía clic de nuevo, y el
-- segundo pedido mandaba las sedes que el primero todavía no había anotado.
--
-- La pregunta "¿ya se mandó?" y el envío eran dos pasos separados, y entre los
-- dos cabía otro pedido. Ahora el envío se RESERVA antes de mandarse: se
-- inserta la fila en `enviando`, y este índice único hace que un segundo
-- intento choque en la base en vez de llegar a SIESA.
--
-- Estados:
--   enviando       reservado, el POST está en curso (o la función murió en el
--                  medio — por eso bloquea hasta que alguien lo resuelva).
--   ok             SIESA lo recibió.
--   error          SIESA lo rechazó, o no se mandó por un bloqueo. Se puede
--                  reintentar.
--   sin_confirmar  no se sabe: timeout o corte de red DESPUÉS de mandar. SIESA
--                  pudo haberlo creado. Bloquea el reintento hasta que alguien
--                  mire en SIESA y lo marque desde el panel.
--   duplicado      un envío que ya estaba en SIESA y se mandó de nuevo. Solo
--                  para los de antes de esta migración; queda como rastro.

-- 1. `sin_confirmar` no entra en VARCHAR(10).
ALTER TABLE carnes_siesa_envios
  ALTER COLUMN estado TYPE VARCHAR(20);

ALTER TABLE carnes_siesa_envios
  DROP CONSTRAINT IF EXISTS carnes_siesa_envios_estado_check;

ALTER TABLE carnes_siesa_envios
  ADD CONSTRAINT carnes_siesa_envios_estado_check
  CHECK (estado IN ('enviando', 'ok', 'error', 'sin_confirmar', 'duplicado'));

-- 2. Los duplicados que ya existen. Se queda el PRIMERO de cada recepción y
--    tipo; los demás pasan a `duplicado`. Sin esto el índice de abajo no se
--    puede crear. En SIESA hay que anular a mano el documento repetido.
WITH ordenados AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY recepcion_id, tipo
           ORDER BY enviado_at, id
         ) AS n
  FROM carnes_siesa_envios
  WHERE estado = 'ok'
)
UPDATE carnes_siesa_envios e
SET estado = 'duplicado',
    error  = COALESCE(e.error || ' ', '') ||
             'Duplicado: esta recepción ya tenía un envío ok de este tipo. Anular en SIESA.'
FROM ordenados o
WHERE e.id = o.id
  AND o.n > 1;

-- 3. El candado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_vigente
  ON carnes_siesa_envios (recepcion_id, tipo)
  WHERE estado IN ('enviando', 'ok', 'sin_confirmar');

-- 4. Quién resolvió un `sin_confirmar` y cuándo.
ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS resuelto_por VARCHAR(150),
  ADD COLUMN IF NOT EXISTS resuelto_at  TIMESTAMPTZ;
