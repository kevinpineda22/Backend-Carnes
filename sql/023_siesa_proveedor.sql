-- =============================================================================
-- Migration 023: los envíos a SIESA del recibidor de proveedores
-- =============================================================================
--
-- La recepción de un proveedor (sql/022, `carnes_proveedor_recepciones`) viaja a
-- SIESA por el MISMO conector 256783 que la entrada de los talleres, y cada
-- intento queda en `carnes_siesa_envios`, igual que los demás. Esta migración le
-- enseña a esa tabla dos tipos nuevos y a qué recepción pertenece cada uno:
--
--   'entrada_proveedor'  la CEA con la cantidad y el valor FACTURADOS completos
--                        (17 caracteres).
--   'nc_proveedor'       la nota crédito con SOLO lo devuelto (12 caracteres).
--
-- La columna `tipo` mide VARCHAR(20) desde sql/019: los dos nombres caben sin
-- ensancharla. Cualquier tipo nuevo de más de 20 caracteres exigiría otra
-- migración, así que se mantienen cortos.
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   1. El CHECK de `tipo` no conoce los tipos nuevos. Se reemplaza conservando
--      los de siempre ('inicial', 'oficial', 'ajuste_visceras', 'ajuste_faltante').
--
--   2. `recepcion_proveedor_id`: la recepción de proveedor a la que pertenece el
--      envío. `recepcion_id` es de `carnes_recepciones` (talleres) y no sirve:
--      son tablas distintas con ids distintos. ON DELETE RESTRICT: una recepción
--      con envíos a SIESA no se borra, se anula. (Un borrador, que es lo único
--      que se borra, nunca tiene envíos.)
--
--   3. Un CHECK que ata las dos cosas: un envío de proveedor TIENE
--      `recepcion_proveedor_id` y no tiene `recepcion_id` ni `liquidacion_id`; los
--      demás tipos NO tienen `recepcion_proveedor_id`. Así una fila no puede
--      apuntar a la vez a una recepción de taller y a una de proveedor.
--
--   4. Los candados. Mismo patrón de sql/010, sql/012, sql/020 y sql/021: el envío
--      se RESERVA antes de mandarse (fila en `enviando`) y un segundo intento
--      choca en la base (23505) en vez de llegar a SIESA.
--
--        uq_carnes_siesa_envios_proveedor_vigente
--            a lo sumo UN envío vigente (enviando, ok, sin_confirmar) por
--            recepción de proveedor y tipo. Un `error` o un `anulado` no ocupan el
--            lugar: la entrada rechazada se puede reintentar.
--
--        uq_carnes_siesa_envios_proveedor_en_vuelo
--            a lo sumo UN envío EN CURSO (enviando, sin_confirmar) por recepción
--            de proveedor, sea cual sea el tipo: la nota crédito nunca sale
--            mientras la entrada está en vuelo ni a la par de otra nota. Un `ok`
--            no cuenta: la nota crédito sale DESPUÉS de que la entrada quedó ok.
--
--      Ojo: los índices anteriores NO cubren estas filas. El de sql/010 es sobre
--      (recepcion_id, tipo) y estos envíos tienen `recepcion_id` NULL (en un
--      índice único cada NULL cuenta como distinto, así que nunca chocarían); los
--      de sql/012, sql/020 y sql/021 filtran por tipos de talleres.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/019, sql/021 y sql/022 (ya corridas)
--   2. sql/023_siesa_proveedor.sql   ← esta, ANTES del backend que envía
--   3. Backend
--   4. Frontend
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
--   · Al finalizar una recepción de proveedor, el insert del envío falla (columna
--     `recepcion_proveedor_id` inexistente, o el CHECK de `tipo`). El backend lo
--     traduce a un 503 que dice que falta esta migración: no se manda nada a
--     SIESA y la recepción queda Finalizada, lista para reintentar.
--   · Lo que NO se puede simular sin la migración es el candado: sin los índices,
--     dos reintentos simultáneos mandarían dos entradas a SIESA. Por eso va ANTES
--     del backend. Talleres no se entera: no comparte nada con estas filas.
--
-- Idempotente: se puede correr dos veces. Todo o nada.
-- =============================================================================

BEGIN;

-- 0. Precondiciones.
DO $$
DECLARE
  largo INTEGER;
BEGIN
  -- sql/019: la columna tipo tiene que caber 'entrada_proveedor' (17).
  SELECT character_maximum_length INTO largo
  FROM information_schema.columns
  WHERE table_name = 'carnes_siesa_envios' AND column_name = 'tipo';

  IF largo IS NULL OR largo < 17 THEN
    RAISE EXCEPTION
      'Falta sql/019_ajuste_visceras.sql: la columna tipo mide % y ''entrada_proveedor'' tiene 17. '
      'Correla antes de esta migración.', largo;
  END IF;

  -- sql/021: el CHECK que se reemplaza abajo tiene que conservar 'ajuste_faltante'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'carnes_siesa_envios'
      AND indexname = 'uq_carnes_siesa_envios_ajuste_en_vuelo'
  ) THEN
    RAISE EXCEPTION
      'Falta sql/021_ajuste_faltante.sql (índice uq_carnes_siesa_envios_ajuste_en_vuelo). '
      'Correla antes de esta migración.';
  END IF;

  -- sql/022: la tabla a la que apunta la columna nueva.
  IF to_regclass('carnes_proveedor_recepciones') IS NULL THEN
    RAISE EXCEPTION
      'Falta sql/022_proveedores.sql (tabla carnes_proveedor_recepciones). '
      'Correla antes de esta migración.';
  END IF;
END $$;

-- 1. El vínculo con la recepción de proveedor. Va ANTES del CHECK que lo usa.
ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS recepcion_proveedor_id BIGINT
    REFERENCES carnes_proveedor_recepciones(id) ON DELETE RESTRICT;

COMMENT ON COLUMN carnes_siesa_envios.recepcion_proveedor_id IS
  'entrada_proveedor / nc_proveedor: la recepción de proveedor (carnes_proveedor_recepciones) a la que pertenece el envío. NULL en los demás tipos.';

-- 2. El CHECK de `tipo`. Se busca por nombre y por definición, como en sql/019 y
--    sql/021: un CHECK de columna puede haberse renombrado a mano.
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
  CHECK (tipo IN (
    'inicial', 'oficial', 'ajuste_visceras', 'ajuste_faltante',
    'entrada_proveedor', 'nc_proveedor'
  ));

-- 3. Un envío es de proveedor O de talleres, nunca de los dos. No menciona
--    'inicial', así que el borrado de arriba no lo toca en una segunda corrida.
ALTER TABLE carnes_siesa_envios
  DROP CONSTRAINT IF EXISTS carnes_siesa_envios_proveedor_check;

ALTER TABLE carnes_siesa_envios
  ADD CONSTRAINT carnes_siesa_envios_proveedor_check
  CHECK (
    (
      tipo IN ('entrada_proveedor', 'nc_proveedor')
      AND recepcion_proveedor_id IS NOT NULL
      AND recepcion_id IS NULL
      AND liquidacion_id IS NULL
    )
    OR (
      tipo NOT IN ('entrada_proveedor', 'nc_proveedor')
      AND recepcion_proveedor_id IS NULL
    )
  );

-- 4. Los candados.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_proveedor_vigente
  ON carnes_siesa_envios (recepcion_proveedor_id, tipo)
  WHERE recepcion_proveedor_id IS NOT NULL
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

-- Un solo envío en curso por recepción de proveedor, entre la entrada y la nota
-- crédito. El índice de arriba solo impide dos del MISMO tipo; este impide que la
-- nota crédito se reserve mientras la entrada sigue en vuelo o sin confirmar, que
-- es cuando todavía no se sabe si la entrada existe en SIESA.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_proveedor_en_vuelo
  ON carnes_siesa_envios (recepcion_proveedor_id)
  WHERE recepcion_proveedor_id IS NOT NULL
    AND estado IN ('enviando', 'sin_confirmar');

-- Lo que consultan el detalle y el panel: los envíos de una recepción, el más
-- reciente primero. Parcial, para no inflar el índice con las filas de talleres.
CREATE INDEX IF NOT EXISTS idx_carnes_siesa_envios_proveedor
  ON carnes_siesa_envios (recepcion_proveedor_id, tipo, enviado_at DESC)
  WHERE recepcion_proveedor_id IS NOT NULL;

COMMIT;
