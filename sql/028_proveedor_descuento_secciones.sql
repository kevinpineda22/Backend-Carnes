-- =============================================================================
-- Migration 028: descuento por proveedor y secciones "Despresado / Sin despresar"
-- =============================================================================
--
-- Primer caso: POLLOS EL BUCANERO SA (NIT 800197463). Dos reglas de negocio:
--
--   1. La pantalla del recibidor muestra la MISMA lista de productos dos veces,
--      bajo "Despresado" y "Sin despresar". No son items nuevos de SIESA: es el
--      mismo codigo_item, solo una separación visual.
--   2. Descuento automático sobre el total, solo para este proveedor. Los valores
--      ya con descuento son los que viajan a SIESA (entrada y nota crédito).
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   carnes_proveedores
--     · descuento_pct          porcentaje de descuento, 0 <= x < 100 (0 = sin descuento)
--     · secciones_despresado   si es true, la recepción duplica la plantilla en
--                              dos secciones
--
--   carnes_proveedor_recepciones
--     · descuento_pct          SNAPSHOT del porcentaje al abrir la recepción:
--                              cambiar el maestro después no altera las ya abiertas
--
--   carnes_proveedor_recepcion_items
--     · seccion                '' (sin secciones), 'despresado' o 'sin_despresar'
--     · UNIQUE (recepcion_id, equivalencia_id) pasa a incluir `seccion`, porque
--       ahora una misma fila de la plantilla aparece dos veces por recepción.
--
--   `valor_total` de los renglones sigue siendo BRUTO. El descuento se calcula por
--   renglón al mostrar y al armar el documento de SIESA (shared/proveedorValores.js).
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/028_proveedor_descuento_secciones.sql   ← esta, ANTES del backend
--   2. Backend
--   3. Frontend
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

ALTER TABLE carnes_proveedores
  ADD COLUMN IF NOT EXISTS descuento_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS secciones_despresado BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS descuento_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

ALTER TABLE carnes_proveedor_recepcion_items
  ADD COLUMN IF NOT EXISTS seccion TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_proveedores_descuento_pct'
  ) THEN
    ALTER TABLE carnes_proveedores
      ADD CONSTRAINT ck_carnes_proveedores_descuento_pct
      CHECK (descuento_pct >= 0 AND descuento_pct < 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_prov_rec_descuento_pct'
  ) THEN
    ALTER TABLE carnes_proveedor_recepciones
      ADD CONSTRAINT ck_carnes_prov_rec_descuento_pct
      CHECK (descuento_pct >= 0 AND descuento_pct < 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_prov_rec_items_seccion'
  ) THEN
    ALTER TABLE carnes_proveedor_recepcion_items
      ADD CONSTRAINT ck_carnes_prov_rec_items_seccion
      CHECK (seccion IN ('', 'despresado', 'sin_despresar'));
  END IF;
END $$;

-- La llave única de la plantilla incluye la sección. El nombre nuevo es distinto
-- para que el DROP del viejo (sql/022) y el ADD sean idempotentes por separado.
ALTER TABLE carnes_proveedor_recepcion_items
  DROP CONSTRAINT IF EXISTS uq_carnes_prov_rec_items_equivalencia;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_carnes_prov_rec_items_equiv_seccion'
  ) THEN
    ALTER TABLE carnes_proveedor_recepcion_items
      ADD CONSTRAINT uq_carnes_prov_rec_items_equiv_seccion
      UNIQUE (recepcion_id, equivalencia_id, seccion);
  END IF;
END $$;

-- POLLOS EL BUCANERO SA: 5 % de descuento y lista en dos secciones.
UPDATE carnes_proveedores
   SET descuento_pct = 5,
       secciones_despresado = true
 WHERE nit = '800197463';

-- Borradores abiertos ANTES de esta migración: su snapshot quedó en 0. Solo los
-- que siguen en Borrador (una recepción ya firmada o enviada a SIESA no cambia
-- de valor). No se les crean secciones: sus renglones ya existen sin ellas.
UPDATE carnes_proveedor_recepciones r
   SET descuento_pct = p.descuento_pct
  FROM carnes_proveedores p
 WHERE p.id = r.proveedor_id
   AND r.estado = 'Borrador'
   AND p.descuento_pct > 0
   AND r.descuento_pct <> p.descuento_pct;
