-- =============================================================================
-- 031b: corregir fechas guardadas con el día siguiente (bug de UTC)
-- =============================================================================
--
-- NO CORRER A CIEGAS. Pasos:
--   1. Correr 031_fecha_bogota.sql y desplegar el backend con hoyBogota().
--   2. Correr SOLO los dos SELECT de abajo y revisar cada fila.
--   3. Si todo cuadra, descomentar los UPDATE y correrlos en una transacción.
--
-- ─── Qué marca de tiempo es la fuente correcta ──────────────────────────────
--
-- `created_at`. La fecha por defecto se calculaba al CREAR la fila (el backend
-- la fijaba al abrir la recepción / crear la liquidación), así que la fecha
-- correcta es el día de Bogotá de `created_at`.
--   · NO `recibido_at` / "CERRADA": una recepción abierta a las 6 p. m. y cerrada
--     a las 7:34 p. m. sí tiene el día correcto, y el cierre no define la fecha.
--   · NO `iniciado_at`: es la primera cantidad digitada y puede ser otro día.
--
-- ─── Qué filas se consideran afectadas ──────────────────────────────────────
--
-- Las que cumplen LAS DOS:
--   (a) fecha ≠ día de Bogotá de created_at, y
--   (b) fecha = día UTC de created_at (es decir, es exactamente lo que daba el bug).
-- (b) evita tocar fechas que alguien cargó a mano (una entrega de ayer, una
-- liquidación editada por el admin): esas no coinciden con el día UTC. El front
-- actual no manda `fecha_ingreso`, pero la API lo acepta; si alguien cargó a
-- mano justo el día UTC siguiente, se vería igual que el bug: por eso hay que
-- revisar el SELECT antes del UPDATE.
--
-- ─── SIESA (leer antes de actualizar) ───────────────────────────────────────
--
-- `fecha_ingreso` de una recepción de Res/Cerdo viaja a SIESA como FECHA_DOCTO
-- (siesaEntrada.js, fechaSiesa) tanto en la entrada como en el consolidado
-- (se usa la fecha MÁS ANTIGUA de las recepciones). Cambiar la fecha acá NO
-- cambia lo que ya está en SIESA: el documento enviado conserva el día
-- equivocado, y un reenvío/anulación usaría la fecha corregida. Por eso los
-- SELECT traen `envios_vigentes`: las filas con valor > 0 ya salieron a SIESA
-- y hay que decidir con contabilidad si se corrigen (y se reenvía) o se dejan.
-- El UPDATE de abajo EXCLUYE esas filas a propósito; quitar el filtro solo con
-- esa decisión tomada.
--
-- Las recepciones de proveedores (`carnes_proveedor_recepciones`) NO están
-- afectadas: su fecha ya se calculaba con hoyBogota() y no tiene default.
-- =============================================================================


-- ─── 1. Recepciones de Res / Cerdo (Talleres) ───────────────────────────────

SELECT r.id,
       r.especie,
       r.sede_id,
       r.estado,
       r.fecha_ingreso                                         AS fecha_actual,
       (r.created_at AT TIME ZONE 'America/Bogota')::date      AS fecha_bogota,
       r.created_at,
       r.recibido_at,
       r.liquidacion_id,
       (SELECT count(*) FROM carnes_siesa_envios e
         WHERE (e.recepcion_id = r.id OR r.id = ANY (e.recepcion_ids))
           AND e.estado IN ('enviando','ok','duplicado','sin_confirmar') AND e.anulado_at IS NULL)       AS envios_vigentes
  FROM carnes_recepciones r
 WHERE r.fecha_ingreso <> (r.created_at AT TIME ZONE 'America/Bogota')::date
   AND r.fecha_ingreso =  (r.created_at AT TIME ZONE 'UTC')::date
 ORDER BY r.created_at;


-- ─── 2. Liquidaciones ───────────────────────────────────────────────────────

SELECT l.id,
       l.especie,
       l.estado,
       l.fecha                                                 AS fecha_actual,
       (l.created_at AT TIME ZONE 'America/Bogota')::date      AS fecha_bogota,
       l.created_at,
       (SELECT count(*) FROM carnes_siesa_envios e
         WHERE e.liquidacion_id = l.id
           AND e.estado IN ('enviando','ok','duplicado','sin_confirmar') AND e.anulado_at IS NULL)       AS envios_vigentes
  FROM carnes_liquidaciones l
 WHERE l.fecha <> (l.created_at AT TIME ZONE 'America/Bogota')::date
   AND l.fecha =  (l.created_at AT TIME ZONE 'UTC')::date
 ORDER BY l.created_at;


-- ─── 3. Corrección (COMENTADA: descomentar tras revisar los SELECT) ─────────
--
-- Solo filas SIN envío vigente a SIESA. Las que sí tienen envío se resuelven
-- aparte (ver nota SIESA arriba).
--
-- BEGIN;
--
-- UPDATE carnes_recepciones r
--    SET fecha_ingreso = (r.created_at AT TIME ZONE 'America/Bogota')::date
--  WHERE r.fecha_ingreso <> (r.created_at AT TIME ZONE 'America/Bogota')::date
--    AND r.fecha_ingreso =  (r.created_at AT TIME ZONE 'UTC')::date
--    AND NOT EXISTS (SELECT 1 FROM carnes_siesa_envios e
--                     WHERE (e.recepcion_id = r.id OR r.id = ANY (e.recepcion_ids))
--                       AND e.estado IN ('enviando','ok','duplicado','sin_confirmar') AND e.anulado_at IS NULL);
--
-- UPDATE carnes_liquidaciones l
--    SET fecha = (l.created_at AT TIME ZONE 'America/Bogota')::date
--  WHERE l.fecha <> (l.created_at AT TIME ZONE 'America/Bogota')::date
--    AND l.fecha =  (l.created_at AT TIME ZONE 'UTC')::date
--    AND NOT EXISTS (SELECT 1 FROM carnes_siesa_envios e
--                     WHERE e.liquidacion_id = l.id
--                       AND e.estado IN ('enviando','ok','duplicado','sin_confirmar') AND e.anulado_at IS NULL);
--
-- -- Revisar los conteos devueltos y los SELECT de nuevo (deben salir vacíos,
-- -- salvo las filas con envío a SIESA) y recién ahí:
-- COMMIT;   -- o ROLLBACK;
