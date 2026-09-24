-- =============================================================================
-- Migration 012: una sola CEA oficial por liquidación
-- =============================================================================
--
-- Hasta acá la oficial salía como una CEA por sede: nueve documentos para una
-- entrega de nueve sedes. Contabilidad la quiere consolidada, y el conector lo
-- permite: la cabecera de la CEA no tiene nada de la sede —la bodega y el CO
-- van en cada movimiento—, así que un documento puede llevar los renglones de
-- todas las sedes de la entrega.
--
-- El envío consolidado es UNA fila con `recepcion_id` vacío y `liquidacion_id`
-- lleno. Las filas viejas (una por sede) se quedan como historial.
--
-- La inicial NO cambia: sigue siendo una por recepción, porque sale sola cuando
-- cada sede cierra, a horas distintas.

-- 1. La oficial consolidada no es de UNA recepción.
ALTER TABLE carnes_siesa_envios
  ALTER COLUMN recepcion_id DROP NOT NULL;

-- 2. Qué recepciones iban en el documento, tal como estaban al mandarlo. La
--    liquidación puede cambiar después (reabrir, desvincular); el rastro no.
ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS recepcion_ids BIGINT[];

-- 3. El candado de sql/010, a nivel liquidación: una sola oficial consolidada
--    vigente (enviando, ok o sin_confirmar) por liquidación. El índice de 010
--    no la cubre: con `recepcion_id` NULL, dos filas nunca chocan ahí.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_liquidacion_vigente
  ON carnes_siesa_envios (liquidacion_id)
  WHERE recepcion_id IS NULL
    AND tipo = 'oficial'
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

CREATE INDEX IF NOT EXISTS idx_carnes_siesa_envios_liquidacion
  ON carnes_siesa_envios (liquidacion_id, tipo, enviado_at DESC);
