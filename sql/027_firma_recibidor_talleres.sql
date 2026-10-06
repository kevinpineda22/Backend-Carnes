-- =============================================================================
-- Migration 027: recibidor y firma al cerrar una recepción de talleres
-- =============================================================================
--
-- Hasta hoy, cerrar una recepción de talleres (POST /api/recepciones/:id/finalizar)
-- solo guardaba el correo de la sesión (`recibido_por`). Ahora el recibidor
-- elige quién recibió (de la lista de carnes_recibidores, o "Otro" con nombre y
-- cédula) y firma, igual que en proveedores (sql/022).
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   Cinco columnas en carnes_recepciones, mismas que en carnes_proveedor_recepciones:
--     · recibidor_id      FK a carnes_recibidores (SET NULL si se borra el recibidor)
--     · recibidor_cedula  snapshot de la cédula al firmar
--     · recibidor_nombre  snapshot del nombre al firmar
--     · recibidor_otro    true si firmó una persona fuera de la lista
--     · firma_data        PNG como data URL. Pesada: NO traerla en listados.
--
--   Todas NULL (recibidor_otro con DEFAULT false): las recepciones cerradas antes
--   de esta migración no tienen firma y el admin las muestra como "Sin firma".
--   Que recibidor y firma sean obligatorios al cerrar lo decide el backend
--   (shared/finalizarProveedor.js), no la base: un CHECK rompería las filas viejas.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/027_firma_recibidor_talleres.sql   ← esta, ANTES del backend
--   2. Backend
--   3. Frontend
--
--   (Requiere sql/022_proveedores.sql: ahí se crea carnes_recibidores.)
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
--   · Cerrar una recepción de talleres falla por columna inexistente.
--   · El detalle del admin tolera la falta: muestra "Sin firma" y avisa en el log.
--   · El resto de lecturas no pide las columnas nuevas y sigue igual.
--
-- Idempotente: se puede correr dos veces. Todo o nada.
-- =============================================================================

BEGIN;

ALTER TABLE carnes_recepciones
  ADD COLUMN IF NOT EXISTS recibidor_id     BIGINT REFERENCES carnes_recibidores(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recibidor_cedula VARCHAR(15),
  ADD COLUMN IF NOT EXISTS recibidor_nombre VARCHAR(120),
  ADD COLUMN IF NOT EXISTS recibidor_otro   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS firma_data       TEXT;

COMMENT ON COLUMN carnes_recepciones.recibidor_id IS
  'Recibidor de la lista que firmó al cerrar. NULL si fue "Otro" o si la recepción es anterior a sql/027.';
COMMENT ON COLUMN carnes_recepciones.recibidor_cedula IS
  'Snapshot de la cédula de quien firmó el recibí. Dato personal: NO viaja en listados ni al recibidor.';
COMMENT ON COLUMN carnes_recepciones.recibidor_nombre IS
  'Snapshot del nombre de quien firmó el recibí.';
COMMENT ON COLUMN carnes_recepciones.recibidor_otro IS
  'true si quien firmó no estaba en la lista de recibidores (nombre y cédula digitados).';
COMMENT ON COLUMN carnes_recepciones.firma_data IS
  'Firma del recibidor (PNG como data URL). Pesada: NO traerla en listados; solo el detalle del admin.';

COMMIT;
