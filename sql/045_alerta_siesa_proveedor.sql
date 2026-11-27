-- =============================================================================
-- Migration 045: dedupe de la alerta "recepción de proveedor sin subir a SIESA"
-- =============================================================================
--
-- El backend avisa por correo cuando una recepción de proveedor finalizada no llega a SIESA
-- (alerta inmediata en `registrarYEnviar` y barrido cada 15 minutos). Para no repetir el
-- aviso se anota en la propia recepción:
--
--   alerta_siesa_at          cuándo se RECLAMÓ la alerta (antes de mandar el correo). NULL = sin alertar.
--   alerta_siesa_enviada_at  cuándo el correo SALIÓ de verdad. NULL con reclamo = en curso o huérfano.
--   alerta_siesa_motivo      sin_envio | siesa_apagado | error | sin_confirmar | enviando_abandonado
--
-- El backend la RECLAMA con un UPDATE condicional (`alerta_siesa_at IS NULL`) antes de mandar el
-- correo, anota `alerta_siesa_enviada_at` cuando sale y libera el reclamo si no sale. Un reclamo
-- sin `alerta_siesa_enviada_at` y de más de 15 minutos es huérfano (la función murió entre el
-- reclamo y el correo): el barrido lo vuelve a reclamar. Cuando el admin reintenta el envío o
-- resuelve el que quedó sin confirmar, las tres columnas vuelven a NULL.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--   Se puede correr antes o después del backend: sin estas columnas el backend no falla (la
--   alerta inmediata sale sin dedupe y el barrido se omite con un aviso en el log).
--
-- Requiere sql/022_proveedores.sql. Idempotente. Rollback: sql/045_rollback.sql.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS alerta_siesa_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerta_siesa_enviada_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerta_siesa_motivo     TEXT;

COMMENT ON COLUMN carnes_proveedor_recepciones.alerta_siesa_at IS
  'Cuándo se RECLAMÓ el aviso por correo de que la recepción no llegó a SIESA. NULL = sin alertar; se limpia al reintentar el envío.';
COMMENT ON COLUMN carnes_proveedor_recepciones.alerta_siesa_enviada_at IS
  'Cuándo el correo de la alerta salió de verdad. Un reclamo sin esto y de más de 15 minutos es huérfano y se reclama de nuevo.';
COMMENT ON COLUMN carnes_proveedor_recepciones.alerta_siesa_motivo IS
  'Motivo de la última alerta: sin_envio, siesa_apagado, error, sin_confirmar o enviando_abandonado.';

COMMIT;
