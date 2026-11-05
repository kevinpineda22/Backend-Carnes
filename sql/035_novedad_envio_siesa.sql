-- =============================================================================
-- Migration 035: novedad en los envíos a SIESA
-- =============================================================================
--
-- La entrada INICIAL ya no se frena cuando un producto no tiene código de SIESA:
-- sube el resto de los renglones y deja fuera los que no se pueden subir. La
-- novedad dice cuáles quedaron fuera, para homologarlos antes de liquidar. Ejemplo:
--
--   1 renglón sin código de SIESA no se subió: ASADURA DE CERDO. Homologarlo antes de liquidar.
--
--   novedad   texto libre armado por el backend. NULL = el envío salió completo.
--
-- Se guarda al reservar el envío (estado "enviando"), así que queda sin importar si
-- después sale ok, sin_confirmar o error.
--
-- Idempotente: se puede correr más de una vez.
-- ORDEN: correr ANTES de desplegar el backend. El listado de envíos ahora pide esta
-- columna; sin ella cae a las columnas de antes (sin novedad), y un envío con
-- novedad no se puede registrar.
-- =============================================================================

ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS novedad text;

COMMENT ON COLUMN carnes_siesa_envios.novedad IS
  'Lo que quedó fuera del documento enviado (p. ej. renglones sin código de SIESA en la inicial). NULL = sin novedad.';

-- Verificación (solo lectura): debe salir la columna.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'carnes_siesa_envios'
  AND column_name = 'novedad';
