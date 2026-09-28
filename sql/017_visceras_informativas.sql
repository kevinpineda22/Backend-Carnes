-- =============================================================================
-- Migration 017: las 6 vísceras "por novillo" NO se descuentan de la liquidación
-- =============================================================================
--
-- Corrección de negocio sobre sql/016_visceras_siesa.sql: el gerente aclaró que
-- el toggle "Sumar Viceras (SI/NO)" de la liquidación tiene que descontar SOLO
-- las 5 que se pesan/cuentan a mano — Viceras, Mondongo, Lengua, Chunchulla,
-- Entrañita —, nunca las 6 que se calculan por novillo — Higado, Riñon,
-- Corazon, Bofe, Pajarilla, Punta de falda.
--
-- Las 6 SIGUEN yendo a SIESA con su código, unidad y precio exactamente como
-- quedó en la 016 — eso no cambia. Lo único que cambia es que dejan de restar
-- del costo real de la sede: van al ERP, pero no abaratan los cortes.
--
-- ─── Por qué el mecanismo es `bloque` y no una columna nueva ────────────────
--
-- `carnes_viceras_items.bloque` YA es exactamente esta distinción —
-- 'bonificacion' descuenta, 'informativo' no— solo que hasta ahora
-- 'informativo' también significaba "no tiene renglón en la recepción, no va a
-- SIESA". Se reutiliza el mismo campo y se separa esa segunda mitad: si una
-- víscera 'informativo' tiene código de SIESA o factor por novillo, AHORA sí
-- tiene renglón y SÍ va a SIESA (ver `Recepcion.model.js#renglonesDesdePlantilla`);
-- lo único que decide 'bloque' de acá en más es si el toggle la descuenta.
--
-- ─── Qué hace ────────────────────────────────────────────────────────────────
--
-- 1. Vuelve a 'informativo' las 6 vísceras de RES que se calculan por novillo
--    (sql/016 las había dejado en 'bonificacion' porque, en ese momento, ese
--    era el único valor de `bloque` que hacía que `renglonesDesdePlantilla` les
--    creara un renglón — antes de que "ir a SIESA" y "descontar" se separaran).
--
-- 2. Agrega `carnes_recepcion_items.bloque` (snapshot, igual que `costo_base`,
--    `unidad` y `factor_novillo`): el renglón de una recepción ya cerrada tiene
--    que seguir descontando (o no) lo mismo aunque el admin edite el catálogo
--    el mes que viene.
--
--    NULL es un valor legítimo y no "falta backfillear": son los renglones que
--    ya existían ANTES de esta migración. Por construcción, TODOS salieron de
--    un catálogo donde ya estaban en 'bonificacion' — el negocio confirmó que
--    las once vísceras de res estuvieron en 'bonificacion' en producción hasta
--    ahora. Por eso el código trata NULL/undefined como 'bonificacion' (ver
--    `shared/visceras.js#descuentaEnLiquidacion`), y por lo que dice la nota 3
--    de abajo, hoy no hay ningún renglón real al que ese NULL le cambie el
--    número.
--
-- 3. Backfillea `bloque` en los renglones YA EXISTENTES de tipo 'vicera', desde
--    el catálogo por `vicera_item_id`, SOLO en recepciones que todavía se
--    pueden tocar (Borrador, Recibido, Aprobado) — igual que la 016. Los
--    renglones de recepciones Costeado/Enviado_SIESA quedan en NULL a
--    propósito: esas liquidaciones YA corrieron `calcularCosteo` con el número
--    que tenían, y escribirles `bloque` ahora no cambia ese costo ya escrito
--    (`carnes_recepcion_items.costo_ajustado`/`costo_total` son historia
--    congelada) — tocarlas sería simular un recosteo que nunca se pidió.
--
--    Verificado con una consulta de SOLO LECTURA contra producción antes de
--    escribir esta migración (no se deja como script porque era de un solo
--    uso): a la fecha, NO HAY ninguna recepción de RES en Costeado ni en
--    Enviado_SIESA con renglones de Higado/Riñon/Corazon/Bofe/Pajarilla/Punta
--    de falda — el único estado con esos renglones hoy es Aprobado (54 filas:
--    las 9 recepciones #12–#20 × 6 vísceras). O sea: el caso "renglón viejo en
--    una liquidación ya costeada" que el punto 2 explica en teoría, HOY no
--    tiene ni un solo renglón real al que le importe.
--
-- ─── Qué le pasa a #12–#20 (Aprobado, liquidacion_id NULL, nada costeado) ────
--
-- Sí entran en el backfill del punto 3: sus 54 renglones de las 6 vísceras
-- (con cantidad ya puesta por el backfill de la 016, algunas en 0 según los
-- novillos de cada una) reciben `bloque = 'informativo'`. Sus 5 renglones
-- tipeados (Viceras, Mondongo, Lengua, Chunchulla, Entrañita) reciben
-- `bloque = 'bonificacion'`. Nada de esto mueve `cantidad`, `costo_base` ni
-- ningún otro campo — y como estas 9 recepciones no tienen liquidación
-- vinculada todavía (`liquidacion_id IS NULL`), `calcularCosteo` no corrió
-- sobre ellas ni una vez: no hay ningún costo ya escrito que este cambio
-- pudiera contradecir. El efecto real es únicamente sobre el PRÓXIMO costeo
-- que se corra para ellas: ese sí va a descontar solo las 5, no las 11.
--
-- ─── Orden de despliegue: ESTA MIGRACIÓN VA ANTES DEL BACKEND ────────────────
--
-- El código nuevo hace dos cosas con la columna `bloque` de
-- `carnes_recepcion_items`:
--
--   · La LEE en `shared/visceras.js#descuentaEnLiquidacion` para decidir el
--     descuento. Tolerante por diseño: `undefined` (columna inexistente) o
--     `null` (renglón viejo, o de antes de que esta migración corra) cuentan
--     como 'bonificacion' — que es exactamente el comportamiento actual, así
--     que si el backend se despliega ANTES de esta migración, el toggle sigue
--     descontando las 11 como hoy, ni un renglón se rompe, simplemente la
--     corrección de negocio no está activa todavía.
--   · La ESCRIBE en `Recepcion.model.js#renglonesDesdePlantilla`, al abrir
--     una recepción NUEVA. Ese insert es TOLERANTE (mismo patrón que
--     `unidad`/`factor_novillo` en la 016): si la columna todavía no existe,
--     reintenta sin `bloque` y loguea un aviso — abrir recepciones sigue
--     funcionando, y el renglón queda en NULL (que el resto del sistema ya
--     sabe leer como 'bonificacion') hasta que la migración corra.
--
-- Idempotente y transaccional, igual que la 016.
-- =============================================================================

BEGIN;

-- 1. Catálogo: las 6 vuelven a 'informativo'. Código/unidad/factor NO se tocan
--    — siguen yendo a SIESA exactamente igual que con la 016.
UPDATE carnes_viceras_items SET bloque = 'informativo'
  WHERE especie = 'res'
    AND nombre IN ('Higado', 'Riñon', 'Corazon', 'Bofe', 'Pajarilla', 'Punta de falda');

-- 2. Snapshot en el renglón de la recepción.
ALTER TABLE carnes_recepcion_items
  ADD COLUMN IF NOT EXISTS bloque VARCHAR(15);

ALTER TABLE carnes_recepcion_items
  DROP CONSTRAINT IF EXISTS carnes_recepcion_items_bloque_check;
ALTER TABLE carnes_recepcion_items
  ADD CONSTRAINT carnes_recepcion_items_bloque_check
  CHECK (bloque IS NULL OR bloque IN ('bonificacion', 'informativo'));

COMMENT ON COLUMN carnes_recepcion_items.bloque IS
  'Snapshot de carnes_viceras_items.bloque al abrir la recepción. Decide si el toggle "Sumar Viceras" de la liquidación descuenta este renglón (bonificacion) o no (informativo) — NO decide si va a SIESA (eso es codigo_item + cantidad, ver vaASiesa). NULL = renglón de antes de sql/017: tratar como bonificacion (shared/visceras.js#descuentaEnLiquidacion).';

-- 3. Backfill: solo recepciones todavía tocables, y solo tipo 'vicera'.
--    Costeado / Enviado_SIESA quedan en NULL a propósito (ver header: hoy no
--    hay ningún renglón real de las 6 en esos estados).
UPDATE carnes_recepcion_items ri
SET bloque = v.bloque
FROM carnes_viceras_items v, carnes_recepciones r
WHERE ri.vicera_item_id = v.id
  AND ri.recepcion_id = r.id
  AND ri.tipo = 'vicera'
  AND r.estado IN ('Borrador', 'Recibido', 'Aprobado');

COMMIT;
