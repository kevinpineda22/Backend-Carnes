-- =============================================================================
-- Migration 013: la guía del frigorífico se puede subir ANTES de la recepción
-- =============================================================================
--
-- Hasta acá el informe de desposte colgaba de una recepción y solo se podía
-- adjuntar después de que el recibidor cerrara. El admin lo pidió al revés:
-- subir la guía apenas la manda el frigorífico, y que al cerrar la recepción el
-- sistema compare solo y le avise si sobra o falta carne.
--
-- La regla que NO cambia: el recibidor no ve la guía. Si la viera, no contaría
-- la carne —la transcribiría— y el cruce compararía el PDF contra sí mismo. Por
-- eso la guía anticipada queda SIN recepción hasta que el recibidor cierra: no
-- hay pantalla del recibidor que pueda encontrarla.
--
-- Se engancha por sede + especie + FECHA DE ENTREGA, que elige el admin. No por
-- la fecha del PDF: el frigorífico suele despostar un día y entregar al
-- siguiente, así que la fecha del desposte casi nunca es la de la recepción.

-- 1. Una guía anticipada todavía no tiene recepción.
ALTER TABLE carnes_desposte_informes
  ALTER COLUMN recepcion_id DROP NOT NULL;

-- 2. A qué recepción se va a enganchar cuando exista.
ALTER TABLE carnes_desposte_informes
  -- RESTRICT y no SET NULL: una guía esperando sin sede violaría el CHECK de
  -- abajo, y borrar la sede fallaría con un error de constraint que nadie
  -- entiende. Así el error dice lo que pasa: esa sede tiene una guía.
  ADD COLUMN IF NOT EXISTS sede_id        BIGINT REFERENCES carnes_sedes(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS especie        VARCHAR(10) CHECK (especie IN ('res', 'cerdo')),
  ADD COLUMN IF NOT EXISTS fecha_entrega  DATE,
  -- Cuándo se enganchó a la recepción. NULL en las que se adjuntaron después
  -- del cierre, como siempre.
  ADD COLUMN IF NOT EXISTS vinculado_at   TIMESTAMPTZ;

-- 3. Sin recepción, tiene que saber a cuál va. Si no, queda huérfana para
--    siempre: nadie la engancharía.
ALTER TABLE carnes_desposte_informes
  DROP CONSTRAINT IF EXISTS carnes_desposte_informes_destino_check;
ALTER TABLE carnes_desposte_informes
  ADD CONSTRAINT carnes_desposte_informes_destino_check
  CHECK (
    recepcion_id IS NOT NULL
    OR (sede_id IS NOT NULL AND especie IS NOT NULL AND fecha_entrega IS NOT NULL)
  );

-- 4. Una sola guía esperando por sede, especie y fecha. Subir otra la
--    REEMPLAZA (el caso normal es "me equivoqué de archivo").
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_desposte_anticipada
  ON carnes_desposte_informes (sede_id, especie, fecha_entrega)
  WHERE recepcion_id IS NULL;
