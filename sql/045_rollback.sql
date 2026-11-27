-- =============================================================================
-- ROLLBACK de sql/045_alerta_siesa_proveedor.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Elimina las columnas de dedupe de la alerta de
-- recepciones de proveedor sin SIESA (se pierde qué recepciones ya se avisaron: un nuevo
-- despliegue del barrido volvería a avisarlas). El backend nuevo tolera que no existan.
--
-- Idempotente (IF EXISTS) y todo o nada. lock_timeout de 5s.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE carnes_proveedor_recepciones
  DROP COLUMN IF EXISTS alerta_siesa_at,
  DROP COLUMN IF EXISTS alerta_siesa_enviada_at,
  DROP COLUMN IF EXISTS alerta_siesa_motivo;

COMMIT;
