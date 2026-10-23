-- =============================================================================
-- Migration 029: cortes adicionales y descuentos dinámicos (global + por corte)
-- =============================================================================
--
-- Dos cambios del recibidor de proveedores que comparten tabla:
--
--   1. CORTES ADICIONALES. El recibidor puede agregar a un borrador un corte que
--      no está en la plantilla del proveedor. Es un renglón más (cantidad, valor,
--      devolución, SIESA, nota crédito…); solo se marca con `origen` para
--      mostrarlo aparte, bajo "Cortes adicionales".
--
--   2. DESCUENTOS DINÁMICOS. Hasta hoy el descuento era un snapshot fijo del
--      proveedor (sql/028). Ahora el recibidor lo edita en el borrador:
--        · un porcentaje GLOBAL de la recepción (`descuento_pct` de la cabecera,
--          que ya existía), y
--        · opcionalmente un porcentaje PROPIO por renglón que REEMPLAZA al global
--          (no se suman). Porcentaje efectivo de un renglón = propio ?? global.
--      Un propio de 0 es un valor: "este corte va sin descuento".
--
-- ─── Qué cambia ──────────────────────────────────────────────────────────────
--
--   carnes_proveedor_recepciones
--     · descuento_pct_proveedor   el descuento por defecto del proveedor al abrir
--                                 la recepción (snapshot, NO editable). Es al que
--                                 vuelve el global si el recibidor desmarca
--                                 "Aplicar descuentos": no puede perder el 5 %
--                                 pactado de Bucanero con solo apagar el chulito.
--                                 Las recepciones ya abiertas se rellenan con su
--                                 `descuento_pct` actual (que hasta hoy ES el del
--                                 proveedor).
--
--   carnes_proveedor_recepcion_items
--     · descuento_pct             porcentaje propio del renglón; NULL = usa el
--                                 global. 0 <= x < 100.
--     · origen                    'plantilla' (por defecto) o 'adicional'.
--     · índice único parcial      un mismo corte (código + unidad) no puede estar
--                                 dos veces como adicional en la misma recepción.
--                                 La llave de sql/028 (recepcion_id,
--                                 equivalencia_id, seccion) no sirve para esto
--                                 porque un adicional tiene `equivalencia_id` NULL.
--
--   `valor_total` de los renglones sigue siendo BRUTO. El descuento se calcula por
--   renglón al mostrar y al armar los documentos de SIESA (shared/proveedorValores.js,
--   `pctEfectivo` + `aplicarDescuento`).
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/029_cortes_adicionales_descuentos.sql   ← esta, ANTES o junto al backend
--   2. Backend
--   3. Frontend
--
-- Es ADITIVA: solo columnas nuevas con valor por defecto, un CHECK sobre ellas y un
-- índice parcial. No se toca ninguna llave existente, así que el backend desplegado
-- hoy (que hace upsert con onConflict recepcion_id,equivalencia_id,seccion) sigue
-- funcionando si esta migración corre primero. El backend nuevo SÍ la necesita: lee
-- `descuento_pct_proveedor`, `descuento_pct` y `origen`.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS descuento_pct_proveedor NUMERIC(5,2) NOT NULL DEFAULT 0;

ALTER TABLE carnes_proveedor_recepcion_items
  ADD COLUMN IF NOT EXISTS descuento_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'plantilla';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_prov_rec_desc_proveedor'
  ) THEN
    ALTER TABLE carnes_proveedor_recepciones
      ADD CONSTRAINT ck_carnes_prov_rec_desc_proveedor
      CHECK (descuento_pct_proveedor >= 0 AND descuento_pct_proveedor < 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_prov_rec_items_descuento_pct'
  ) THEN
    ALTER TABLE carnes_proveedor_recepcion_items
      ADD CONSTRAINT ck_carnes_prov_rec_items_descuento_pct
      CHECK (descuento_pct IS NULL OR (descuento_pct >= 0 AND descuento_pct < 100));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_prov_rec_items_origen'
  ) THEN
    ALTER TABLE carnes_proveedor_recepcion_items
      ADD CONSTRAINT ck_carnes_prov_rec_items_origen
      CHECK (origen IN ('plantilla', 'adicional'));
  END IF;
END $$;

-- Un corte adicional no se repite dentro de la recepción (mismo código y unidad).
-- Parcial: no afecta a los renglones de la plantilla.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_prov_rec_items_adicional
  ON carnes_proveedor_recepcion_items (recepcion_id, codigo_item, unidad)
  WHERE origen = 'adicional';

-- Las recepciones ya abiertas: su descuento actual ES el del proveedor al abrir
-- (hasta hoy no se podía editar). Solo donde aún está en 0, para que correr la
-- migración dos veces no pise nada.
UPDATE carnes_proveedor_recepciones
   SET descuento_pct_proveedor = descuento_pct
 WHERE descuento_pct_proveedor = 0
   AND descuento_pct > 0;

-- -----------------------------------------------------------------------------
-- Quitar un corte adicional, de forma ATÓMICA
-- -----------------------------------------------------------------------------
--
-- El guardián de sql/022 cubre INSERT y UPDATE de renglones, no DELETE (y no se le
-- agrega un trigger BEFORE DELETE: el borrado en cascada de la cabecera lo cruzaría).
-- Por eso el borrado va en una función: bloquea la cabecera (FOR UPDATE, la misma
-- fila sobre la que el finalizar hace su UPDATE condicional), exige Borrador, borra
-- SOLO un renglón de esa recepción con origen 'adicional' y toca `updated_at` de la
-- cabecera en la misma transacción, así un finalizar que ya había leído los
-- renglones no pasa sobre una lista distinta.
--
-- Devuelve un código de texto que el backend traduce a 404/409:
--   'ok' | 'no_recepcion' | 'no_borrador' | 'no_item' | 'no_adicional'
--
-- SECURITY INVOKER (por defecto): el proyecto no tiene otras funciones RPC ni GRANTs
-- propios; corre con los permisos de quien llama (el backend, con su clave de servicio).
CREATE OR REPLACE FUNCTION carnes_quitar_corte_adicional(p_recepcion_id BIGINT, p_item_id BIGINT)
RETURNS TEXT AS $fn$
DECLARE
  v_estado VARCHAR(20);
  v_origen TEXT;
BEGIN
  SELECT estado INTO v_estado
  FROM carnes_proveedor_recepciones
  WHERE id = p_recepcion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'no_recepcion';
  END IF;
  IF v_estado <> 'Borrador' THEN
    RETURN 'no_borrador';
  END IF;

  SELECT origen INTO v_origen
  FROM carnes_proveedor_recepcion_items
  WHERE id = p_item_id AND recepcion_id = p_recepcion_id;

  IF NOT FOUND THEN
    RETURN 'no_item';
  END IF;
  IF v_origen <> 'adicional' THEN
    RETURN 'no_adicional';
  END IF;

  DELETE FROM carnes_proveedor_recepcion_items
  WHERE id = p_item_id AND recepcion_id = p_recepcion_id AND origen = 'adicional';

  UPDATE carnes_proveedor_recepciones SET updated_at = now() WHERE id = p_recepcion_id;

  RETURN 'ok';
END;
$fn$ LANGUAGE plpgsql;
