-- =============================================================================
-- Migration 019: el ajuste de inventario de vísceras (documento CEI)
-- =============================================================================
--
-- Las vísceras salieron de la CEA (una CEA es la factura, solo lleva cortes) y
-- ahora entran al inventario por un documento propio: el conector 257135
-- AJUSTE_INV_VISCERAS, tipo CEI, que SIESA CONTABILIZA al importar. Un documento
-- por recepción, porque la cabecera lleva una sola bodega.
--
-- Cada intento queda en `carnes_siesa_envios`, igual que la inicial y la
-- oficial, con un `tipo` nuevo: 'ajuste_visceras'.
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   1. `tipo` era VARCHAR(10) con CHECK IN ('inicial', 'oficial') (sql/007).
--      'ajuste_visceras' tiene 15 caracteres y no está en la lista: se ensancha
--      la columna y se reemplaza el CHECK.
--
--   2. El candado de una sola vigente por recepción y tipo YA existe:
--      `uq_carnes_siesa_envios_vigente` (sql/010) es un índice único parcial
--      sobre (recepcion_id, tipo) para estado IN ('enviando', 'ok',
--      'sin_confirmar'). No mira el valor de `tipo`, así que cubre el tipo nuevo
--      sin tocarlo: dos ajustes vigentes de la misma recepción chocan en la base.
--      Un índice propio del tipo sería un duplicado exacto, así que no se crea.
--
--   3. Verificación: falla la migración si falta el índice de sql/010, porque el
--      ajuste se CONTABILIZA al importarse y el candado es lo único que impide
--      que un segundo clic lo duplique.
--
-- ─── Orden de despliegue: ESTA MIGRACIÓN VA ANTES DEL BACKEND ────────────────
--
-- Con el backend nuevo y la base vieja, el primer envío falla al reservar. En
-- una base sin migrar `tipo` es VARCHAR(10) y 'ajuste_visceras' (15) no cabe:
-- Postgres responde 22001 (valor demasiado largo), no el CHECK. Con la columna
-- ya ensanchada pero sin el CHECK nuevo sería 23514. El backend mapea las dos
-- a un 503 que dice que falta esta migración: no duplica ni pierde nada. Y el
-- front nuevo contra
-- el backend viejo simplemente recibe 404 en los endpoints del ajuste.
--
--   1. Correr sql/019_ajuste_visceras.sql en Supabase.
--   2. Desplegar el backend.
--   3. Desplegar el frontend.
-- =============================================================================

-- 1. La columna.
-- Todo o nada: si algo falla, la tabla no queda sin el CHECK de `tipo`.
BEGIN;

ALTER TABLE carnes_siesa_envios
  ALTER COLUMN tipo TYPE VARCHAR(20);

-- 2. El CHECK. Se busca por nombre y por definición: en una base creada desde
--    sql/007 se llama carnes_siesa_envios_tipo_check, pero un CHECK de columna
--    puede haberse renombrado a mano.
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
  CHECK (tipo IN ('inicial', 'oficial', 'ajuste_visceras'));

-- 3. El candado de sql/010 tiene que estar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'carnes_siesa_envios'
      AND indexname = 'uq_carnes_siesa_envios_vigente'
  ) THEN
    RAISE EXCEPTION
      'Falta el índice uq_carnes_siesa_envios_vigente (sql/010_siesa_candado.sql). '
      'Correlo antes de esta migración: el ajuste de vísceras se contabiliza en SIESA y sin ese '
      'candado un segundo clic lo duplicaría.';
  END IF;
END $$;

COMMIT;
