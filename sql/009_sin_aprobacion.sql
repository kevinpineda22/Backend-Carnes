-- =============================================================================
-- Migration 009: la recepción cerrada ya queda lista para liquidar
-- =============================================================================
--
-- Se quitó la aprobación manual (y el rechazo). Cerrar la recepción la deja en
-- `Aprobado`, que es lo que la liquidación acepta para vincular.
--
-- Las que quedaron en `Recibido` esperando un clic que ya no existe se pasan a
-- `Aprobado`. Sin esto quedarían trabadas: ningún endpoint las mueve.
--
-- `aprobado_at` toma la hora del cierre y `aprobado_por` queda vacío, igual que
-- en las que se cierran de ahora en adelante.
--
-- Las `Rechazado` NO se tocan: el recibidor las reabre al volver a esa sede y
-- día, las corrige y al cerrar pasan a `Aprobado` solas.

UPDATE carnes_recepciones
SET estado      = 'Aprobado',
    aprobado_at = COALESCE(aprobado_at, recibido_at, NOW())
WHERE estado = 'Recibido';
