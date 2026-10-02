-- =============================================================================
-- Migration 025: las vísceras de res salen a SIESA al cerrar la recepción
-- =============================================================================
--
-- Hasta hoy las vísceras (documento CEI, conector AJUSTE_INV_VISCERAS) las
-- mandaba el admin DESPUÉS de la entrada oficial, en UN documento por
-- liquidación (sql/019, sql/020). Con CARNES_SIESA_VISCERAS_AL_CIERRE=true salen
-- al cerrar la recepción de res, UN documento por recepción, con un `tipo` de
-- envío nuevo: 'visceras_recepcion' (18 caracteres, caben en el VARCHAR(20)
-- que dejó sql/019).
--
-- En la liquidación, si el admin tocó las vísceras de esa recepción después del
-- cierre, hay que reenviarlas: antes alguien borra A MANO el documento viejo en
-- SIESA (el CEI se contabiliza al importar y es una ENTRADA de inventario,
-- mandarlo dos veces duplica el stock) y el envío viejo pasa a 'anulado'.
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   Solo el CHECK de `tipo`: se reemplaza conservando TODOS los tipos que ya
--   existen ('inicial', 'oficial', 'ajuste_visceras', 'ajuste_faltante',
--   'entrada_proveedor', 'nc_proveedor') y se suma 'visceras_recepcion'.
--
--   El candado es el de sql/010: el índice único parcial
--   uq_carnes_siesa_envios_vigente (recepcion_id, tipo) sobre enviando/ok/
--   sin_confirmar ya cubre el tipo nuevo. Un 'anulado' o un 'error' no ocupan el
--   lugar, así que después de anular el viejo se puede mandar el nuevo.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/023_siesa_proveedor.sql (ya corrida: este CHECK conserva sus tipos)
--   2. sql/025_visceras_recepcion.sql   ← esta, ANTES del backend
--   3. Backend (con CARNES_SIESA_VISCERAS_AL_CIERRE apagada hasta que se decida)
--   4. Frontend
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
--   · Con la variable apagada, nada: el backend se comporta como antes.
--   · Con la variable prendida, al cerrar una recepción de res el insert del
--     envío falla por el CHECK. El backend lo traduce a un error que dice que
--     falta esta migración: la recepción se cierra igual y no se manda nada.
--
-- Idempotente: se puede correr dos veces. Todo o nada.
-- =============================================================================

BEGIN;

-- 0. Precondiciones: sql/023 tiene que estar (su CHECK de tipos es el que se
--    reemplaza; si faltara, este lo dejaría sin 'entrada_proveedor').
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'carnes_siesa_envios' AND column_name = 'recepcion_proveedor_id'
  ) THEN
    RAISE EXCEPTION
      'Falta sql/023_siesa_proveedor.sql (columna recepcion_proveedor_id). '
      'Correla antes de esta migración.';
  END IF;
END $$;

-- 1. El CHECK de `tipo`. Se busca por nombre y por definición, como en sql/019,
--    sql/021 y sql/023: un CHECK de columna puede haberse renombrado a mano.
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
    'entrada_proveedor', 'nc_proveedor', 'visceras_recepcion'
  ));

COMMIT;
