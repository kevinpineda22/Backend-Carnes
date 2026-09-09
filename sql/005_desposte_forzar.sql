-- =============================================================================
-- Migration 005: poder adjuntar un informe de un lote ya usado, dejando rastro
-- =============================================================================
--
-- La 004 puso un índice ÚNICO sobre `lote`, así que el mismo informe no se podía
-- adjuntar dos veces ni aunque el admin insistiera: la base lo rechazaba.
--
-- Eso convertía una advertencia en un muro. Y el muro es demasiado duro para lo
-- que hay del otro lado: el informe es un CONTRASTE, no una fuente de plata. No
-- alimenta el costeo ni el documento de SIESA. Que el mismo lote quede en dos
-- recepciones no mueve un peso — deja mal el cruce de una de las dos, que es un
-- problema real pero no uno que justifique frenar a alguien a las seis de la
-- mañana con el camión abierto.
--
-- Entonces: sigue avisando, sigue siendo lo primero que se ve, pero ahora el
-- admin puede pasar por encima. Y cuando pasa, queda escrito QUIÉN lo hizo y que
-- este informe en particular entró forzado.
--
-- El índice único se reemplaza por uno común: hace falta igual, porque la
-- consulta "¿este lote ya está en otra recepción?" corre en cada adjunto.
-- =============================================================================

DROP INDEX IF EXISTS idx_carnes_desposte_lote;

CREATE INDEX IF NOT EXISTS idx_carnes_desposte_lote
  ON carnes_desposte_informes(lote)
  WHERE lote IS NOT NULL;

-- Misma idea que `sede_verificada` en la recepción: la pregunta dentro de seis
-- meses no es "¿el sistema avisaba?" sino "¿ESTE informe se metió a la fuerza?".
-- Un flag global en el código no contesta eso; una columna por fila sí.
ALTER TABLE carnes_desposte_informes
  ADD COLUMN IF NOT EXISTS forzado BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN carnes_desposte_informes.forzado IS
  'true = el admin lo adjuntó a pesar de una advertencia (sede distinta o lote repetido).';
