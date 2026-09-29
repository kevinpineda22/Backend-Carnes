-- =============================================================================
-- Migration 021: el ajuste por faltante (compensación de inventario)
-- =============================================================================
--
-- Cuando SIESA rechaza el ajuste de vísceras (sql/019, sql/020) con "Item sin
-- cantidad disponible", el backend manda PRIMERO un ajuste de inventario CPE por
-- exactamente lo que falta —UNO por bodega— y DESPUÉS reenvía el ajuste de
-- vísceras. Cada intento queda en `carnes_siesa_envios`, con un `tipo` nuevo:
-- 'ajuste_faltante'.
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   1. El CHECK de `tipo` no conoce 'ajuste_faltante' (sql/019 lo dejó en
--      'inicial', 'oficial', 'ajuste_visceras'). Se reemplaza. La columna ya
--      mide VARCHAR(20) desde sql/019 y 'ajuste_faltante' tiene 15.
--
--   2. `envio_origen_id`: el envío del ajuste de vísceras que SIESA rechazó y que
--      esta compensación quiere destrabar. Es lo que permite que cada intento de
--      compensar tenga su propio candado: a cada rechazo nuevo le toca un origen
--      nuevo. ON DELETE SET NULL: borrar una fila `error` desde el panel (que el
--      admin puede hacer) no debe fallar porque algo apunte a ella.
--
--   3. `bodega`: la bodega que se compensa. Un documento por bodega.
--
--   4. El candado. Un índice único parcial sobre (envio_origen_id, bodega) para
--      los estados que ocupan el lugar (enviando, ok, sin_confirmar): a lo sumo
--      una compensación vigente por origen y bodega. Es el mismo patrón de
--      sql/010 y sql/012: el envío se RESERVA antes de mandarse, y un segundo
--      intento choca en la base (23505) en vez de llegar a SIESA. Un `error` o un
--      `anulado` no ocupan el lugar, así que un rechazo se puede reintentar con
--      la cantidad subida.
--
--      Ojo: los índices de sql/010 y sql/012 NO cubren estas filas. Una
--      compensación no tiene `recepcion_id` (queda NULL y en (recepcion_id, tipo)
--      cada NULL cuenta como distinto), y el de sql/012 es solo de tipo 'oficial'.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/019_ajuste_visceras.sql y sql/020_ajuste_visceras_liquidacion.sql
--      (ya corridas en producción)
--   2. sql/021_ajuste_faltante.sql   ← esta, ANTES del backend
--   3. Backend
--   4. Frontend
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
--   · Al compensar, el insert falla (columna `bodega` o `envio_origen_id` que no
--     existe, o el CHECK de `tipo`). El backend lo traduce a un 503 que dice que
--     falta esta migración: no se manda nada a SIESA. El ajuste de vísceras que
--     no necesita compensar sigue funcionando.
--   · El listado de Envíos a SIESA, el detalle y la vista previa del ajuste
--     saben esperar la falta de las columnas y siguen mostrando lo de antes.
--   · Lo único que NO se puede simular sin la migración es el candado: sin el
--     índice, dos compensaciones simultáneas del mismo origen y bodega mandarían
--     dos ajustes de inventario. Por eso va ANTES del backend.
--
-- Idempotente: se puede correr dos veces. Todo o nada.
-- =============================================================================

BEGIN;

-- 1. sql/019 y sql/020 tienen que estar.
DO $$
DECLARE
  largo INTEGER;
BEGIN
  SELECT character_maximum_length INTO largo
  FROM information_schema.columns
  WHERE table_name = 'carnes_siesa_envios' AND column_name = 'tipo';

  IF largo IS NULL OR largo < 15 THEN
    RAISE EXCEPTION
      'Falta sql/019_ajuste_visceras.sql: la columna tipo mide % y ''ajuste_faltante'' tiene 15. '
      'Correla antes de esta migración.', largo;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'carnes_siesa_envios'
      AND indexname = 'uq_carnes_siesa_envios_ajuste_liquidacion_vigente'
  ) THEN
    RAISE EXCEPTION
      'Falta sql/020_ajuste_visceras_liquidacion.sql (índice '
      'uq_carnes_siesa_envios_ajuste_liquidacion_vigente). Correla antes de esta migración.';
  END IF;
END $$;

-- 2. El CHECK de `tipo`. Se busca por nombre y por definición, como en sql/019.
ALTER TABLE carnes_siesa_envios
  DROP CONSTRAINT IF EXISTS carnes_siesa_envios_tipo_check;

DO $$
DECLARE
  restriccion TEXT;
BEGIN
  FOR restriccion IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'carnes_siesa_envios'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%tipo%'
      AND pg_get_constraintdef(c.oid) ILIKE '%inicial%'
  LOOP
    EXECUTE format('ALTER TABLE carnes_siesa_envios DROP CONSTRAINT %I', restriccion);
  END LOOP;
END $$;

ALTER TABLE carnes_siesa_envios
  ADD CONSTRAINT carnes_siesa_envios_tipo_check
  CHECK (tipo IN ('inicial', 'oficial', 'ajuste_visceras', 'ajuste_faltante'));

-- 3. Las columnas.
ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS envio_origen_id BIGINT
    REFERENCES carnes_siesa_envios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bodega VARCHAR(10);

COMMENT ON COLUMN carnes_siesa_envios.envio_origen_id IS
  'ajuste_faltante: el envío del ajuste de vísceras que SIESA rechazó por inventario insuficiente y que esta compensación destraba.';
COMMENT ON COLUMN carnes_siesa_envios.bodega IS
  'ajuste_faltante: la bodega que se compensa (un documento por bodega).';

-- 4. El candado: una sola compensación vigente por origen y bodega.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_faltante_vigente
  ON carnes_siesa_envios (envio_origen_id, bodega)
  WHERE tipo = 'ajuste_faltante'
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

CREATE INDEX IF NOT EXISTS idx_carnes_siesa_envios_faltante_liquidacion
  ON carnes_siesa_envios (liquidacion_id, enviado_at DESC)
  WHERE tipo = 'ajuste_faltante';

-- Un solo envío EN CURSO por liquidación, entre el ajuste de vísceras y sus
-- compensaciones. El índice de arriba solo evita dos compensaciones del MISMO
-- rechazo; sin este, dos clics casi simultáneos podían compensar el mismo
-- faltante dos veces: el clic A compensa el rechazo de su ajuste mientras el
-- clic B manda otro ajuste, recibe el mismo faltante (el de A todavía no entró)
-- y lo compensa con otro origen. Los dos documentos quedan contabilizados.
--
-- Dentro de un mismo pedido los envíos son secuenciales (cada uno termina en
-- ok/error antes de reservar el siguiente), así que el pedido nunca choca
-- consigo mismo. Un `sin_confirmar` también ocupa el lugar: hasta que alguien
-- lo resuelva, no se manda nada más de esa liquidación.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_ajuste_en_vuelo
  ON carnes_siesa_envios (liquidacion_id)
  WHERE recepcion_id IS NULL
    AND tipo IN ('ajuste_visceras', 'ajuste_faltante')
    AND estado IN ('enviando', 'sin_confirmar');

COMMIT;
