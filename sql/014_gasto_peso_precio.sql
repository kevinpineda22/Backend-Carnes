-- =============================================================================
-- Migration 014: Peso y Precio KL opcionales en los gastos de liquidación
-- =============================================================================
--
-- Algunos conceptos de gasto (p. ej. "Valor de la carne") se cargan hoy
-- tipeando el `valor` a mano, calculado afuera en una calculadora o en la
-- cabeza. El admin pidió poder cargar en su lugar el peso (kg) y el precio por
-- kilo, y que el sistema calcule el valor solo.
--
-- Las dos columnas son OPCIONALES y NO reemplazan a `valor`: siguen sin existir
-- filas viejas, y una fila nueva puede seguir escribiendo `valor` a mano sin
-- tocarlas. Solo cuando AMBAS vienen cargadas (> 0) el backend calcula
-- `valor = ROUND(peso * precio_kilo, 2)` al guardar — nunca el cliente, para
-- que un cálculo hecho en el navegador no le gane a este.
--
-- `costeo.js` no se toca: sigue leyendo únicamente `valor`, sea que haya
-- salido de acá o de que el admin lo tipeó directo.

ALTER TABLE carnes_liquidacion_gastos
  ADD COLUMN IF NOT EXISTS peso        NUMERIC(12,3) CHECK (peso IS NULL OR peso >= 0),
  ADD COLUMN IF NOT EXISTS precio_kilo NUMERIC(14,2) CHECK (precio_kilo IS NULL OR precio_kilo >= 0);

COMMENT ON COLUMN carnes_liquidacion_gastos.peso IS
  'Peso en kilos, opcional. Junto con precio_kilo, el backend calcula valor = peso * precio_kilo al guardar.';
COMMENT ON COLUMN carnes_liquidacion_gastos.precio_kilo IS
  'Precio por kilo, opcional. Junto con peso, el backend calcula valor = peso * precio_kilo al guardar.';
