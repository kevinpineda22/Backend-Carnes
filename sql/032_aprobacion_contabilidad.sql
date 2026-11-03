-- =============================================================================
-- Migration 032: aprobación de contabilidad en las recepciones de proveedor
-- =============================================================================
--
-- Contabilidad "causa" la factura en SIESA y después la marca como aprobada acá
-- (botón "Aprobar" de la página /carnes/contabilidad). La marca es SOLO nuestra:
-- no se manda nada a SIESA. Guarda quién y cuándo.
--
--   aprobado_contabilidad_at   NULL = pendiente de aprobar; con valor = aprobada.
--   aprobado_contabilidad_por  correo de quien aprobó (con CARNES_AUTH=exigir sale
--                              del token de la sesión).
--
-- Sin deshacer por ahora: el backend no tiene un endpoint para quitar la marca.
--
-- Idempotente: se puede correr más de una vez.
-- ORDEN: correr ANTES de desplegar el backend. El listado del admin ahora pide estas
-- dos columnas; sin ellas responde 503 "A la base le falta sql/032_...".
-- =============================================================================

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS aprobado_contabilidad_at  timestamptz,
  ADD COLUMN IF NOT EXISTS aprobado_contabilidad_por text;

COMMENT ON COLUMN carnes_proveedor_recepciones.aprobado_contabilidad_at IS
  'Cuándo contabilidad marcó la factura como aprobada (ya causada en SIESA). NULL = pendiente.';
COMMENT ON COLUMN carnes_proveedor_recepciones.aprobado_contabilidad_por IS
  'Correo de quien la aprobó por contabilidad.';

-- La lista de contabilidad filtra por "Por aprobar" (NULL) y "Aprobadas" sobre las
-- que están en SIESA. Índice parcial: solo las filas en Enviada_SIESA, que es lo
-- único que contabilidad lista.
CREATE INDEX IF NOT EXISTS idx_carnes_prov_rec_contabilidad
  ON carnes_proveedor_recepciones (fecha_recepcion DESC, id DESC)
  WHERE estado = 'Enviada_SIESA';

-- Verificación (solo lectura): deben salir las dos columnas.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'carnes_proveedor_recepciones'
  AND column_name IN ('aprobado_contabilidad_at', 'aprobado_contabilidad_por');
