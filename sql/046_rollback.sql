-- =============================================================================
-- ROLLBACK de sql/046_preliquidacion_anular_enviada.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Elimina la RPC carnes_preliq_anular_enviada y la tabla de
-- auditoría carnes_preliquidacion_sedes_anuladas (se PIERDE el historial de las sedes liberadas).
--
-- NO revierte los datos: una preliquidación ya anulada con esta RPC sigue `anulada`, sus recepciones
-- siguen libres (o vinculadas a otra preliquidación) y sus envíos oficiales siguen `anulado`. Si hace
-- falta el historial, copie la tabla antes de correr este script.
--
-- Idempotente (IF EXISTS) y todo o nada. lock_timeout de 5s.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS carnes_preliq_anular_enviada(BIGINT, INTEGER, INTEGER, TEXT, TEXT);
DROP TABLE IF EXISTS carnes_preliquidacion_sedes_anuladas;

COMMIT;
