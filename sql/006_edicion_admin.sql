-- =============================================================================
-- Migration 006: el admin puede corregir un renglón, y queda escrito que lo hizo
-- =============================================================================
--
-- El admin puede cambiar cantidad, costo base, código y descripción de cualquier
-- renglón de una recepción ya cerrada. Es necesario —un recibidor se equivoca de
-- tecla, un costo base quedó viejo en la plantilla— pero tiene un costo que no se
-- ve: el cruce contra el informe del frigorífico compara "lo que dijo la planta"
-- con "lo que contó el recibidor". Si el admin puede reescribir el conteo sin
-- rastro, la segunda mitad de esa comparación deja de ser el conteo del recibidor
-- y pasa a ser lo que el admin quiso que fuera.
--
-- Por eso la primera vez que se toca la cantidad se guarda la ORIGINAL, y cada
-- edición deja quién y cuándo. La corrección se hace; lo que no se hace es
-- borrar que hubo una corrección.
-- =============================================================================

ALTER TABLE carnes_recepcion_items
  ADD COLUMN IF NOT EXISTS cantidad_original NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS editado_por       VARCHAR(150),
  ADD COLUMN IF NOT EXISTS editado_at        TIMESTAMPTZ;

COMMENT ON COLUMN carnes_recepcion_items.cantidad_original IS
  'Lo que digitó el recibidor antes de la primera corrección del admin. NULL = nunca se corrigió la cantidad.';
COMMENT ON COLUMN carnes_recepcion_items.editado_por IS
  'Correo del admin que hizo la última corrección. NULL = el renglón está como lo dejó el recibidor.';
