-- =============================================================================
-- Migration 011: anular en SIESA y volver a subir
-- =============================================================================
--
-- Una oficial que entró mal (o duplicada) se corrige ANULÁNDOLA en SIESA y
-- mandándola de nuevo. Hasta ahora eso no tenía salida acá: `Enviado_SIESA` y
-- `Cerrada` eran terminales, y el envío `ok` ocupaba el lugar en el índice
-- único de sql/010, así que no había forma de reenviar.
--
-- `anulado` es el estado de un envío que existió en SIESA y alguien anuló a
-- mano. No entra en el índice único (enviando/ok/sin_confirmar): libera el
-- lugar para un envío nuevo, pero queda como rastro de que estuvo.

ALTER TABLE carnes_siesa_envios
  DROP CONSTRAINT IF EXISTS carnes_siesa_envios_estado_check;

ALTER TABLE carnes_siesa_envios
  ADD CONSTRAINT carnes_siesa_envios_estado_check
  CHECK (estado IN ('enviando', 'ok', 'error', 'sin_confirmar', 'duplicado', 'anulado'));

ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS anulado_por      VARCHAR(150),
  ADD COLUMN IF NOT EXISTS anulado_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT;
