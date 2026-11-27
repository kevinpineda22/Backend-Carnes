-- =============================================================================
-- Migration 045: dedupe de la alerta "recepción de proveedor sin subir a SIESA"
-- =============================================================================
--
-- El backend avisa por correo cuando una recepción de proveedor finalizada no llega a SIESA
-- (alerta inmediata en `registrarYEnviar` y barrido cada 15 minutos). Para no repetir el
-- aviso se anota en la propia recepción:
--
--   alerta_siesa_at      cuándo se reclamó/envió la alerta. NULL = sin alertar.
--   alerta_siesa_motivo  sin_envio | error | sin_confirmar | enviando_abandonado
--
-- El backend la RECLAMA con un UPDATE condicional (`alerta_siesa_at IS NULL`) antes de mandar el
-- correo y la libera si el correo no sale. Cuando el admin reintenta el envío se vuelve a NULL.
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
  ADD COLUMN IF NOT EXISTS alerta_siesa_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS alerta_siesa_motivo TEXT;

COMMENT ON COLUMN carnes_proveedor_recepciones.alerta_siesa_at IS
  'Cuándo se avisó por correo que la recepción no llegó a SIESA. NULL = sin alertar; se limpia al reintentar el envío.';
COMMENT ON COLUMN carnes_proveedor_recepciones.alerta_siesa_motivo IS
  'Motivo de la última alerta: sin_envio, error, sin_confirmar o enviando_abandonado.';

COMMIT;
