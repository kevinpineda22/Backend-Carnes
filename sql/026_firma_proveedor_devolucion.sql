-- =============================================================================
-- Migration 026: firma del proveedor cuando la recepción tiene devoluciones
-- =============================================================================
--
-- Hasta hoy, al finalizar una recepción de proveedor firmaba SOLO el recibidor
-- (sql/022: firma_data + recibidor_*). Cuando hay mercancía devuelta, el
-- proveedor tiene que dejar constancia de que se la llevó: su representante
-- firma con nombre, documento y trazo, y de ahí sale el "Acta de devolución".
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   Tres columnas NULL en carnes_proveedor_recepciones:
--     · proveedor_firma            PNG como data URL (igual que firma_data)
--     · proveedor_firma_nombre     quien firma por el proveedor
--     · proveedor_firma_documento  su cédula / documento
--
--   NULL a propósito: las recepciones sin devolución no la llevan, y las que se
--   finalizaron antes de esta migración tampoco (el acta deja esas líneas en
--   blanco para firmarla a mano). Que sea obligatoria cuando hay devolución lo
--   decide el backend (shared/finalizarProveedor.js), no la base: un CHECK acá
--   rompería las recepciones ya finalizadas con devolución.
--
--   Una sola restricción: si hay firma, tienen que estar nombre y documento.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/026_firma_proveedor_devolucion.sql   ← esta, ANTES del backend
--   2. Backend
--   3. Frontend
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
--   · Finalizar una recepción SIN devolución sigue igual: el UPDATE solo escribe
--     las columnas nuevas cuando hay firma del proveedor.
--   · Finalizar una CON devolución falla por columna inexistente.
--   · El detalle del admin pide las columnas nuevas y falla siempre.
--
-- Idempotente: se puede correr dos veces. Todo o nada.
-- =============================================================================

BEGIN;

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS proveedor_firma TEXT,
  ADD COLUMN IF NOT EXISTS proveedor_firma_nombre VARCHAR(120),
  ADD COLUMN IF NOT EXISTS proveedor_firma_documento VARCHAR(15);

COMMENT ON COLUMN carnes_proveedor_recepciones.proveedor_firma IS
  'Firma (PNG como data URL) del representante del proveedor. Solo si la recepción tiene devoluciones. Pesada: NO traerla en listados.';
COMMENT ON COLUMN carnes_proveedor_recepciones.proveedor_firma_nombre IS
  'Nombre de quien firma por el proveedor la devolución.';
COMMENT ON COLUMN carnes_proveedor_recepciones.proveedor_firma_documento IS
  'Documento (cédula) de quien firma por el proveedor la devolución.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'carnes_proveedor_recepciones'::regclass
      AND conname = 'carnes_prov_rec_firma_proveedor_check'
  ) THEN
    ALTER TABLE carnes_proveedor_recepciones
      ADD CONSTRAINT carnes_prov_rec_firma_proveedor_check
      CHECK (
        proveedor_firma IS NULL
        OR (proveedor_firma_nombre IS NOT NULL AND proveedor_firma_documento IS NOT NULL)
      );
  END IF;
END $$;

COMMIT;
