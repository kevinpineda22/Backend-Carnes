-- =============================================================================
-- Migration 033: la entrada oficial y el ajuste de vísceras salen UNO POR FECHA
-- =============================================================================
--
-- Problema. Una liquidación agrupa recepciones de varias sedes y de días
-- distintos (talleres de carne). Hasta acá la oficial salía como UNA CEA con la
-- fecha de la recepción más antigua: SIESA recibía carne en días en que no
-- existía y contabilidad tenía que hacer ajustes grandes de inventario. Lo mismo
-- pasaba con el ajuste de vísceras (CEI) de la liquidación.
--
-- Regla nueva: UN documento por cada `fecha_ingreso` distinta (todas las sedes
-- que recibieron ese día van juntas), cada uno con esa fecha. Los costos son por
-- recepción (`carnes_recepcion_items.costo_ajustado`), así que partir por fecha
-- no prorratea nada.
--
-- Cada documento es su propia fila de `carnes_siesa_envios`:
--
--   fecha_docto   la fecha del documento (date). NULL en las filas de ANTES de
--                 esta migración, que eran UN documento con todas las
--                 recepciones: se dejan como están (no se rellenan), porque
--                 cubren todas las fechas de la liquidación y así las lee el
--                 backend (`planearDocumentosPorFecha`).
--   recepcion_ids las recepciones de ESA fecha (sql/012).
--
-- ─── Los candados ────────────────────────────────────────────────────────────
--
-- Antes había uno por liquidación para cada tipo:
--
--   uq_carnes_siesa_envios_liquidacion_vigente         (sql/012, 'oficial')
--   uq_carnes_siesa_envios_ajuste_liquidacion_vigente  (sql/020, 'ajuste_visceras')
--
-- Con varios documentos por liquidación esos índices los bloquearían. Cada uno se
-- reemplaza por DOS, porque en Postgres dos NULL nunca chocan en un índice único
-- y una fila de antes (fecha_docto NULL) tiene que seguir siendo única:
--
--   *_fecha_vigente    único por (liquidacion_id, fecha_docto) — filas nuevas.
--   *_legado_vigente   único por liquidación para las filas con fecha_docto NULL
--                      — exactamente el candado de antes, solo para las viejas.
--
-- Vigente = enviando, ok o sin_confirmar. Un `error` o un `anulado` no ocupan el
-- lugar, así que se puede reintentar o reenviar.
--
-- No se toca `uq_carnes_siesa_envios_ajuste_en_vuelo` (sql/021): sigue dejando UN
-- solo ajuste de vísceras o compensación EN CURSO por liquidación. Con varias
-- fechas eso es lo que se quiere: los documentos de vísceras salen de a uno, y un
-- `sin_confirmar` frena los siguientes hasta que alguien lo resuelva.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. Esta migración, ANTES del backend nuevo. El backend nuevo escribe
--      `fecha_docto` en cada envío de oficial y de ajuste: sin la columna, esos
--      envíos fallan con "le falta sql/033" (no mandan nada a SIESA).
--   2. Backend.
--
-- Es seguro correrla con el backend VIEJO todavía arriba: el backend viejo no
-- escribe `fecha_docto`, sus filas caen en el índice *_legado_vigente, que es el
-- mismo candado de antes. Y es seguro con datos existentes: las oficiales y los
-- ajustes consolidados ya enviados quedan con `fecha_docto` NULL y siguen
-- cubriendo toda la liquidación, así que no se vuelven a mandar por fecha (eso
-- sería carne duplicada en SIESA). Para reenviarlos por fecha, primero se anulan
-- en SIESA y se registra la anulación desde el panel, como siempre.
--
-- Una liquidación con un envío a medias durante el despliegue (`enviando`) queda
-- igual: el backend nuevo lo ve como el consolidado de antes (fecha_docto NULL).
--
-- ─── Ojo con el hueco entre las dos cosas ────────────────────────────────────
--
-- Correr esta migración y desplegar el backend, UNO DETRÁS DEL OTRO, y sin enviar
-- nada a SIESA en el medio. Un backend VIEJO con filas por fecha ya guardadas no
-- las entiende: vería una sola fila `ok` por fecha como "la oficial" y cerraría la
-- liquidación con las otras fechas sin mandar.
--
-- Y NO volver a correr sql/012, sql/020 ni sql/021 después de esta migración:
--   · 012 y 020 recrean (IF NOT EXISTS) los índices por liquidación que esta
--     migración suelta, y con ellos volvería a ser imposible más de un documento
--     por liquidación.
--   · 021 tiene una guarda que exige el índice de 020 y abortaría.
-- En una base nueva el orden es 012, 020, 021 y recién después 033.
--
-- Idempotente: se puede correr dos veces. Los índices nuevos se crean ANTES de
-- soltar los viejos, así nunca queda un hueco sin candado.
-- =============================================================================

BEGIN;

-- 1. La columna.
ALTER TABLE carnes_siesa_envios
  ADD COLUMN IF NOT EXISTS fecha_docto DATE;

COMMENT ON COLUMN carnes_siesa_envios.fecha_docto IS
  'oficial / ajuste_visceras de una liquidación: la fecha de ingreso que lleva este documento (uno por fecha). NULL = envío anterior a sql/033, un solo documento con todas las recepciones.';

-- 2. Oficial: un candado por fecha y el de siempre para las filas viejas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_oficial_fecha_vigente
  ON carnes_siesa_envios (liquidacion_id, fecha_docto)
  WHERE recepcion_id IS NULL
    AND tipo = 'oficial'
    AND fecha_docto IS NOT NULL
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_oficial_legado_vigente
  ON carnes_siesa_envios (liquidacion_id)
  WHERE recepcion_id IS NULL
    AND tipo = 'oficial'
    AND fecha_docto IS NULL
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

DROP INDEX IF EXISTS uq_carnes_siesa_envios_liquidacion_vigente;

-- 3. Ajuste de vísceras: lo mismo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_ajuste_fecha_vigente
  ON carnes_siesa_envios (liquidacion_id, fecha_docto)
  WHERE recepcion_id IS NULL
    AND tipo = 'ajuste_visceras'
    AND fecha_docto IS NOT NULL
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_ajuste_legado_vigente
  ON carnes_siesa_envios (liquidacion_id)
  WHERE recepcion_id IS NULL
    AND tipo = 'ajuste_visceras'
    AND fecha_docto IS NULL
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

DROP INDEX IF EXISTS uq_carnes_siesa_envios_ajuste_liquidacion_vigente;

COMMIT;
