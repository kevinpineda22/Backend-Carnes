-- =============================================================================
-- Migration 003: `iniciado_at` — cuándo EMPEZÓ de verdad la recepción
-- =============================================================================
--
-- El problema que resuelve:
--
-- `created_at` es cuándo se abrió la pantalla, y eso no es lo mismo que cuándo
-- se empezó a recibir. Alguien escanea el QR a las 8 de la mañana solo para ver
-- cómo funciona, deja el borrador abierto, y a las 2 de la tarde llega el camión
-- y recién ahí digita. Con `created_at` como referencia, ese documento diría que
-- la recepción arrancó a las 8 — seis horas antes de que llegara la carne.
--
-- `iniciado_at` se pone en el PRIMER guardado que trae una cantidad mayor a
-- cero. Antes de eso no hay recepción, hay una pantalla abierta.
--
-- Quedan entonces tres marcas y cada una dice algo distinto:
--   created_at  → se abrió la pantalla
--   iniciado_at → se digitó la primera cantidad   ← el inicio real
--   recibido_at → se cerró y se mandó al admin
-- =============================================================================

ALTER TABLE carnes_recepciones
  ADD COLUMN IF NOT EXISTS iniciado_at TIMESTAMPTZ;

COMMENT ON COLUMN carnes_recepciones.iniciado_at IS
  'Cuándo se digitó la primera cantidad. NULL = la pantalla se abrió pero no se recibió nada todavía.';

-- Backfill de lo que ya existe: para las recepciones que YA se cerraron, el
-- mejor dato disponible es `created_at`. No es exacto —no sabemos cuándo se
-- digitó el primer renglón— pero es mejor que dejarlo nulo y que la pantalla
-- muestre un guion en documentos históricos que sí se recibieron.
--
-- Los borradores NO se rellenan: si están sin cantidades, `iniciado_at` nulo es
-- justamente lo correcto.
UPDATE carnes_recepciones
   SET iniciado_at = created_at
 WHERE iniciado_at IS NULL
   AND estado <> 'Borrador';

-- Para la pestaña "En curso" del admin: encontrar rápido los borradores que
-- todavía no arrancaron.
CREATE INDEX IF NOT EXISTS idx_carnes_recepciones_iniciado
  ON carnes_recepciones(estado, iniciado_at);
