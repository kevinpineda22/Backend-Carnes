-- =============================================================================
-- Migration 034: observación de logística en las recepciones de proveedor
-- =============================================================================
--
-- Logística (página /carnes/consulta-recepciones) puede dejar UNA observación por
-- recepción para que contabilidad la vea. Es opcional y editable; borrarla deja las
-- tres columnas en NULL.
--
--   observacion_logistica      texto libre (el backend limita a 1000 caracteres).
--   observacion_logistica_por  correo de quien la guardó por última vez (con
--                              CARNES_AUTH=exigir sale del token de la sesión).
--   observacion_logistica_at   cuándo se guardó por última vez.
--
-- Solo se escribe sobre recepciones en Enviada_SIESA (las únicas que ve contabilidad).
--
-- Idempotente: se puede correr más de una vez.
-- ORDEN: correr ANTES de desplegar el backend. El listado y el detalle ahora piden
-- estas tres columnas; sin ellas responden 503 "A la base le falta sql/034_...".
-- =============================================================================

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS observacion_logistica     text,
  ADD COLUMN IF NOT EXISTS observacion_logistica_por text,
  ADD COLUMN IF NOT EXISTS observacion_logistica_at  timestamptz;

COMMENT ON COLUMN carnes_proveedor_recepciones.observacion_logistica IS
  'Observación de logística para contabilidad (una por recepción, editable). NULL = sin observación.';
COMMENT ON COLUMN carnes_proveedor_recepciones.observacion_logistica_por IS
  'Correo de quien guardó la observación de logística por última vez.';
COMMENT ON COLUMN carnes_proveedor_recepciones.observacion_logistica_at IS
  'Cuándo se guardó la observación de logística por última vez.';

-- Verificación (solo lectura): deben salir las tres columnas.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'carnes_proveedor_recepciones'
  AND column_name IN ('observacion_logistica', 'observacion_logistica_por', 'observacion_logistica_at');
