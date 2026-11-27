-- =============================================================================
-- ROLLBACK de sql/042_preliquidacion_corte_manual.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Revierte SOLO sql/042:
--   * restaura carnes_preliq_actualizar_servicio y carnes_preliq_liquidar a su versión de sql/039
--     (el corte vuelve a ser solo el `p_corte` que calcula JS);
--   * elimina carnes_preliq_fijar_corte;
--   * elimina las columnas corte_manual, corte_manual_por y corte_manual_at (se pierden los cortes
--     fijados a mano: las preliquidaciones abiertas vuelven a la regla automática 21:30 Bogotá).
--
-- Antes de correrlo: desplegar un backend que no use corte_manual (o apagar CARNES_PRELIQUIDACION),
-- porque el backend nuevo lee y escribe esas columnas.
--
-- Idempotente (IF EXISTS / CREATE OR REPLACE) y todo o nada. lock_timeout de 5s.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS carnes_preliq_fijar_corte(BIGINT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT);

CREATE OR REPLACE FUNCTION carnes_preliq_actualizar_servicio(
  p_id                    BIGINT,
  p_servicio              NUMERIC,
  p_por                   TEXT,
  p_fecha_primer_ingreso  DATE,
  p_corte                 TIMESTAMPTZ,
  p_desbloqueo            BOOLEAN
) RETURNS JSONB AS $fn$
DECLARE
  v_header  carnes_preliquidaciones%ROWTYPE;
  v_tardio  BOOLEAN;
BEGIN
  IF p_servicio IS NULL OR p_servicio < 0 THEN
    RETURN jsonb_build_object('resultado', 'servicio_invalido');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_header.estado = 'anulada' THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF v_header.fecha_primer_ingreso IS DISTINCT FROM p_fecha_primer_ingreso THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  IF COALESCE(p_desbloqueo, false) THEN
    IF NOT EXISTS (
      SELECT 1 FROM carnes_preliquidaciones
       WHERE id = p_id
         AND liquidada_at IS NULL
         AND COALESCE(servicio_precorte, 0) <= 0
         AND servicio_por_animal <= 0
    ) THEN
      RETURN jsonb_build_object('resultado', 'version_cambiada');
    END IF;
  END IF;

  v_tardio := v_header.liquidada_at IS NOT NULL OR (p_corte IS NOT NULL AND now() > p_corte);

  UPDATE carnes_preliquidaciones
     SET servicio = p_servicio,
         servicio_at = now(),
         servicio_precorte = CASE
           WHEN NOT v_tardio OR COALESCE(p_desbloqueo, false) THEN p_servicio
           ELSE servicio_precorte
         END,
         servicio_precorte_at = CASE
           WHEN NOT v_tardio OR COALESCE(p_desbloqueo, false) THEN now()
           ELSE servicio_precorte_at
         END,
         version = version + 1
   WHERE id = p_id;

  RETURN jsonb_build_object(
    'resultado', CASE WHEN v_tardio THEN 'tardio' ELSE 'ok' END,
    'congelada', v_header.liquidada_at IS NOT NULL,
    'desbloqueo', COALESCE(p_desbloqueo, false)
  );
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION carnes_preliq_liquidar(
  p_id      BIGINT,
  p_version INTEGER,
  p_corte   TIMESTAMPTZ,
  p_plan    JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_header   carnes_preliquidaciones%ROWTYPE;
  v_en_base  BIGINT[];
  v_en_plan  BIGINT[];
BEGIN
  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  IF v_header.estado = 'anulada' THEN
    RETURN jsonb_build_object('resultado', 'no_liquidable');
  END IF;

  IF v_header.liquidada_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'resultado', 'ya_liquidada',
      'servicio_aplicado', v_header.servicio_aplicado,
      'gasto_total', v_header.gasto_total_aplicado,
      'costo_por_animal', v_header.costo_por_animal
    );
  END IF;

  IF p_corte IS NULL OR now() < p_corte THEN
    RETURN jsonb_build_object('resultado', 'antes_del_corte');
  END IF;

  IF v_header.version <> p_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  -- Los saldos que JS sumó deben ser exactamente los pendientes dirigidos a esta cabecera.
  SELECT COALESCE(array_agg(id ORDER BY id), '{}'::BIGINT[]) INTO v_en_base
    FROM carnes_preliquidacion_saldos
   WHERE destino_preliquidacion_id = p_id AND estado = 'pendiente';
  SELECT COALESCE(array_agg(value::BIGINT ORDER BY value::BIGINT), '{}'::BIGINT[]) INTO v_en_plan
    FROM jsonb_array_elements_text(COALESCE(p_plan->'saldo_ids', '[]'::jsonb));
  IF v_en_base <> v_en_plan THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada', 'motivo', 'saldos');
  END IF;

  UPDATE carnes_preliquidaciones
     SET servicio_aplicado = (p_plan->>'servicio_aplicado')::NUMERIC,
         gasto_total_aplicado = (p_plan->>'gasto_total')::NUMERIC,
         costo_por_animal = (p_plan->>'costo_por_animal')::NUMERIC,
         liquidada_at = now(),
         orden_version = orden_version + 1
   WHERE id = p_id;

  UPDATE carnes_preliquidacion_saldos
     SET estado = 'aplicado'
   WHERE destino_preliquidacion_id = p_id AND estado = 'pendiente';

  -- Ya liquidada: esos avisos no aplican.
  DELETE FROM carnes_preliquidacion_alertas
   WHERE preliquidacion_id = p_id
     AND enviado_ok = false
     AND evento IN ('corrida_perdida', 'servicio_cero');

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'servicio_aplicado', (p_plan->>'servicio_aplicado')::NUMERIC,
    'gasto_total', (p_plan->>'gasto_total')::NUMERIC,
    'costo_por_animal', (p_plan->>'costo_por_animal')::NUMERIC
  );
END;
$fn$ LANGUAGE plpgsql;

ALTER TABLE carnes_preliquidaciones
  DROP COLUMN IF EXISTS corte_manual,
  DROP COLUMN IF EXISTS corte_manual_por,
  DROP COLUMN IF EXISTS corte_manual_at;

COMMIT;

-- Verificación: no debe devolver filas.
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'carnes_preliquidaciones'
   AND column_name IN ('corte_manual', 'corte_manual_por', 'corte_manual_at');

SELECT proname FROM pg_proc WHERE proname = 'carnes_preliq_fijar_corte';
