-- =============================================================================
-- Migration 016: nueve vísceras de res suben a SIESA, seis se calculan solas
-- =============================================================================
--
-- Hasta acá NINGUNA víscera iba a SIESA (`siesaEntrada.js` las excluía a todas:
-- "el catálogo no tiene código de ítem"). El negocio confirmó que 9 de las 11
-- vísceras de res SÍ tienen homólogo en el ERP, con su propio código, unidad
-- (Lengua es UND, el resto KL) y — para 6 de ellas — una cantidad que no pesa
-- el recibidor sino que se calcula como `factor × cantidad de novillos`
-- (exactamente como el bloque informativo del Excel). Cerdo no cambia: sus
-- "retomas" nunca tuvieron este tratamiento y esta migración no las toca.
--
-- ─── Qué agrega ─────────────────────────────────────────────────────────────
--
--   carnes_viceras_items     (el catálogo que edita el admin)
--     + codigo_item    VARCHAR(20) NULL           — código de SIESA, si lo tiene
--     + unidad         VARCHAR(5)  DEFAULT 'KL'   — 'KL' o 'UND'
--     + factor_novillo NUMERIC(10,5) NULL         — NULL = el recibidor la pesa/cuenta
--
--   carnes_recepcion_items   (el renglón de cada recepción — `codigo_item` YA EXISTE
--                             acá, se usa para los adicionales homologados)
--     + unidad         VARCHAR(5)  DEFAULT 'KL'
--     + factor_novillo NUMERIC(10,5) NULL
--
-- Snapshot y no referencia: igual que `costo_base`, `codigo_item`/`unidad`/
-- `factor_novillo` se COPIAN al renglón cuando se abre la recepción (ver
-- `Recepcion.model.js#renglonesDesdePlantilla`). Si el admin corrige el
-- catálogo el mes que viene, una recepción ya cerrada no tiene que cambiar de
-- significado.
--
-- NOTA (29/09/2026): esta migración dejó las vísceras con código dentro de la CEA.
-- Eso cambió: hoy NO van en la entrada (inicial ni oficial) sino en el ajuste de
-- vísceras CEI (sql/019, sql/020, sql/025). Los códigos y el snapshot que se
-- guardan acá son los que ese ajuste usa.
--
-- ─── Qué actualiza ──────────────────────────────────────────────────────────
--
-- 1. El catálogo de RES con los códigos/unidad/factor confirmados por el
--    negocio (tabla de la propuesta). Las once tienen que estar en
--    'bonificacion': es lo que hace que las seis calculadas tengan fila en cada
--    recepción (`renglonesDesdePlantilla` solo copia ese bloque) y que las once
--    se descuenten con el SI/NO. En producción ya lo están (verificado el
--    28/09/2026); el seed 002 dejaba seis en 'informativo', así que se fuerza
--    igual para que una base armada desde el seed quede con la misma regla.
--
-- 2. Los RENGLONES YA EXISTENTES de tipo 'vicera' en recepciones que TODAVÍA
--    se pueden tocar (Borrador, Recibido, Aprobado) — nunca Costeado ni
--    Enviado_SIESA, que ya movieron plata o subieron al ERP con los números
--    que tenían. Se les copia código/unidad/factor desde el catálogo por
--    `vicera_item_id`, y a las que quedan con factor se les recalcula
--    `cantidad = ROUND(factor * novillos, 3)` — PERO SOLO cuando la recepción
--    ya tiene `novillos > 0`. Sin novillos cargados el valor se deja como
--    estaba (0, casi siempre) en vez de escribir un 0 "nuevo" que tape el
--    hecho de que a esa recepción todavía le falta ese dato.
--
-- ─── Orden de despliegue: ESTA MIGRACIÓN VA ANTES DEL BACKEND ────────────────
--
-- El código nuevo escribe `unidad` y `factor_novillo` en dos lugares:
--
--   · `Recepcion.model.js#abrir()` — cada recepción NUEVA. Si el backend nuevo
--     corriera contra la base vieja, CADA apertura de recepción fallaría
--     (42703/PGRST204, columna inexistente). Por eso ese INSERT es TOLERANTE:
--     si la columna todavía no existe, reintenta sin `unidad`/`factor_novillo`
--     y loguea un aviso — abrir recepciones sigue funcionando, simplemente sin
--     el cálculo por novillo hasta que esta migración corra.
--   · El endpoint nuevo `PATCH /recepciones/:id/novillos` — recién se usa
--     cuando el admin lo aprieta, así que ahí SÍ se falla duro con un 503
--     ("Falta la migración sql/016…"), igual que `agregarRenglonAdmin` con la
--     015: es una función nueva, no una que ya existía y no puede romperse.
--
-- Los reads son tolerantes por construcción: `select("*")` simplemente no trae
-- una columna que no existe, así que `item.factor_novillo` da `undefined` y
-- `esViceraPorFactor`/`vaASiesa` (`shared/visceras.js`) lo tratan como "no
-- aplica" en vez de reventar.
--
-- Idempotente: correrla dos veces dan el mismo resultado (los ALTER son
-- IF NOT EXISTS, el UPDATE del catálogo es por nombre con los mismos valores,
-- y el backfill recalcula desde `novillos` y `factor_novillo` actuales, no
-- desde un contador que sume cada vez). Todo en una transacción: o queda
-- aplicada entera, o no queda nada a medio camino.
-- =============================================================================

BEGIN;

-- 1. Catálogo: código, unidad y factor por novillo.
ALTER TABLE carnes_viceras_items
  ADD COLUMN IF NOT EXISTS codigo_item    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS unidad         VARCHAR(5) NOT NULL DEFAULT 'KL',
  ADD COLUMN IF NOT EXISTS factor_novillo NUMERIC(10,5);

ALTER TABLE carnes_viceras_items
  DROP CONSTRAINT IF EXISTS carnes_viceras_items_unidad_check;
ALTER TABLE carnes_viceras_items
  ADD CONSTRAINT carnes_viceras_items_unidad_check CHECK (unidad IN ('KL', 'UND'));

COMMENT ON COLUMN carnes_viceras_items.codigo_item IS
  'Código de SIESA (f120_id). NULL = esta víscera no tiene homólogo en el ERP (hoy: Viceras, Entrañita) y no se manda.';
COMMENT ON COLUMN carnes_viceras_items.unidad IS
  'Unidad de medida del renglón en SIESA: KL (la mayoría) o UND (Lengua).';
COMMENT ON COLUMN carnes_viceras_items.factor_novillo IS
  'NULL = el recibidor pesa/cuenta esta víscera. Con valor: cantidad = factor_novillo * recepcion.novillos, no se digita.';

-- 2. Renglón de la recepción: mismo trío, snapshot al abrir (ver header).
--    `codigo_item` YA EXISTE en esta tabla (lo usan los adicionales homologados).
ALTER TABLE carnes_recepcion_items
  ADD COLUMN IF NOT EXISTS unidad         VARCHAR(5) NOT NULL DEFAULT 'KL',
  ADD COLUMN IF NOT EXISTS factor_novillo NUMERIC(10,5);

ALTER TABLE carnes_recepcion_items
  DROP CONSTRAINT IF EXISTS carnes_recepcion_items_unidad_check;
ALTER TABLE carnes_recepcion_items
  ADD CONSTRAINT carnes_recepcion_items_unidad_check CHECK (unidad IN ('KL', 'UND'));

COMMENT ON COLUMN carnes_recepcion_items.unidad IS
  'Snapshot de carnes_viceras_items.unidad al abrir la recepción. KL para carne/adicional (default), KL o UND para vísceras.';
COMMENT ON COLUMN carnes_recepcion_items.factor_novillo IS
  'Snapshot de carnes_viceras_items.factor_novillo al abrir. NULL en carne/adicional y en las vísceras que se pesan a mano.';

-- 3. El catálogo de RES: códigos, unidad y factor confirmados por el negocio.
--    Primero el bloque (ver header): en producción no cambia ninguna fila.
UPDATE carnes_viceras_items SET bloque = 'bonificacion'
  WHERE especie = 'res'
    AND nombre IN ('Higado', 'Riñon', 'Corazon', 'Bofe', 'Pajarilla', 'Punta de falda')
    AND bloque <> 'bonificacion';
UPDATE carnes_viceras_items SET codigo_item = '15168', unidad = 'KL',  factor_novillo = NULL
  WHERE especie = 'res' AND nombre = 'Mondongo';
UPDATE carnes_viceras_items SET codigo_item = '15192', unidad = 'UND', factor_novillo = NULL
  WHERE especie = 'res' AND nombre = 'Lengua';
UPDATE carnes_viceras_items SET codigo_item = '15144', unidad = 'KL',  factor_novillo = NULL
  WHERE especie = 'res' AND nombre = 'Chunchulla';
UPDATE carnes_viceras_items SET codigo_item = '15159', unidad = 'KL',  factor_novillo = 4.16167
  WHERE especie = 'res' AND nombre = 'Higado';
UPDATE carnes_viceras_items SET codigo_item = '15188', unidad = 'KL',  factor_novillo = 1.33333
  WHERE especie = 'res' AND nombre = 'Riñon';
UPDATE carnes_viceras_items SET codigo_item = '15148', unidad = 'KL',  factor_novillo = 1.01667
  WHERE especie = 'res' AND nombre = 'Corazon';
UPDATE carnes_viceras_items SET codigo_item = '15134', unidad = 'KL',  factor_novillo = 2.72500
  WHERE especie = 'res' AND nombre = 'Bofe';
UPDATE carnes_viceras_items SET codigo_item = '15175', unidad = 'KL',  factor_novillo = 0.93333
  WHERE especie = 'res' AND nombre = 'Pajarilla';
UPDATE carnes_viceras_items SET codigo_item = '15187', unidad = 'KL',  factor_novillo = 0.56167
  WHERE especie = 'res' AND nombre = 'Punta de falda';
-- Sin código: no van a SIESA (ver `vaASiesa` en shared/visceras.js). Se dejan
-- explícitas para que quede escrito acá, y no solo en el silencio de un WHERE
-- que nunca las toca.
UPDATE carnes_viceras_items SET codigo_item = NULL, factor_novillo = NULL
  WHERE especie = 'res' AND nombre = 'Viceras';
UPDATE carnes_viceras_items SET codigo_item = NULL, factor_novillo = NULL
  WHERE especie = 'res' AND nombre = 'Entrañita';

-- 4. Backfill de los renglones YA EXISTENTES, solo en recepciones que todavía
--    se pueden tocar (nunca Costeado / Enviado_SIESA — ver header).
UPDATE carnes_recepcion_items ri
SET
  codigo_item    = v.codigo_item,
  unidad         = v.unidad,
  factor_novillo = v.factor_novillo
FROM carnes_viceras_items v, carnes_recepciones r
WHERE ri.vicera_item_id = v.id
  AND ri.recepcion_id = r.id
  AND ri.tipo = 'vicera'
  AND r.estado IN ('Borrador', 'Recibido', 'Aprobado');

-- 5. De esas, las que quedaron con factor: recalcular la cantidad — PERO SOLO
--    donde ya hay novillos cargados (> 0). Sin eso, se deja como estaba: no
--    hay factor sin novillos que dé un número real, y escribir un 0 "de la
--    migración" se vería igual que un 0 que puso el recibidor.
UPDATE carnes_recepcion_items ri
SET cantidad = ROUND((ri.factor_novillo * r.novillos)::numeric, 3)
FROM carnes_recepciones r
WHERE ri.recepcion_id = r.id
  AND ri.tipo = 'vicera'
  AND ri.factor_novillo IS NOT NULL
  AND r.estado IN ('Borrador', 'Recibido', 'Aprobado')
  AND COALESCE(r.novillos, 0) > 0;

COMMIT;
