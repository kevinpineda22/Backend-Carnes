-- =============================================================================
-- ROLLBACK de sql/041_preliquidacion_rpc_correcciones.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Revierte SOLO sql/041: elimina sus funciones.
-- 038, 039 y 040 quedan intactas (041 no redefine ninguna función anterior).
--
-- Orden: si también hay que revertir 040 o 038/039, correr ESTE archivo primero, luego
-- sql/040_rollback.sql y al final sql/038_039_rollback.sql (que además elimina las funciones
-- de 041 si siguen presentes, por si se corre solo).
--
-- Antes de correrlo: apagar CARNES_PRELIQUIDACION. Los datos (alternas, saldos) no se
-- borran: solo dejan de existir las funciones que los escriben.
--
-- Idempotente (IF EXISTS) y todo o nada. lock_timeout de 5s.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS carnes_preliq_anular(BIGINT, INTEGER, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_recalcular_no_enviadas(BIGINT, INTEGER, JSONB, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_saldo_mover(BIGINT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_saldo_descartar(BIGINT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_saldo_editar(BIGINT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_registrar_alterna(BIGINT, NUMERIC, TIMESTAMPTZ, JSONB, NUMERIC, JSONB);

COMMIT;

-- Verificación: no debe devolver filas.
SELECT proname
  FROM pg_proc
 WHERE proname IN (
   'carnes_preliq_registrar_alterna', 'carnes_preliq_saldo_editar',
   'carnes_preliq_saldo_descartar', 'carnes_preliq_saldo_mover',
   'carnes_preliq_recalcular_no_enviadas', 'carnes_preliq_anular'
 )
 ORDER BY proname;
