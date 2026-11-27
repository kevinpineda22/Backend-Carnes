-- =============================================================================
-- ROLLBACK de sql/044_preliquidacion_oficial_sin_inicial.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Revierte SOLO sql/044:
--   * restaura carnes_preliq_reclamar_sede a su versión de sql/040 (la compuerta exige una inicial `ok`);
--   * elimina el trigger y la función que bloquean la inicial, y carnes_preliq_omitir_inicial;
--   * elimina las columnas inicial_omitida_at e inicial_omitida_por (se pierde la auditoría de qué
--     recepciones omitieron la inicial: esas sedes volverían a quedar en `inicial_pendiente`).
--
-- Antes de correrlo: desplegar un backend sin los endpoints de omitir-inicial; el backend nuevo lee la
-- columna inicial_omitida_at y llama a la RPC.
--
-- Idempotente (IF EXISTS / CREATE OR REPLACE) y todo o nada. lock_timeout de 5s.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS carnes_siesa_envios_inicial_omitida ON carnes_siesa_envios;
DROP FUNCTION IF EXISTS carnes_siesa_envios_guardar_inicial_omitida();
DROP FUNCTION IF EXISTS carnes_preliq_omitir_inicial(BIGINT, TEXT);

CREATE OR REPLACE FUNCTION carnes_preliq_reclamar_sede(
  p_sede_id         BIGINT,
  p_sede_version    INTEGER,
  p_desde           TEXT,
  p_token           UUID,
  p_corrida_id      BIGINT,
  p_origen          TEXT,
  p_reset_intentos  BOOLEAN
) RETURNS JSONB AS $fn$
DECLARE
  v_pid     BIGINT;
  v_header  carnes_preliquidaciones%ROWTYPE;
  v_sede    carnes_preliquidacion_sedes%ROWTYPE;
  v_nueva   INTEGER;
  v_intentos INTEGER;
BEGIN
  IF p_corrida_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'corrida_requerida');
  END IF;
  IF p_origen IS NULL OR p_origen NOT IN ('schedule', 'sweep', 'dispatch', 'admin', 'inmediato') THEN
    RETURN jsonb_build_object('resultado', 'origen_invalido');
  END IF;
  IF p_desde IS NULL OR p_desde NOT IN ('calculada', 'simulada', 'error', 'enviando', 'lista_para_enviar') THEN
    RETURN jsonb_build_object('resultado', 'desde_invalido');
  END IF;

  SELECT preliquidacion_id INTO v_pid FROM carnes_preliquidacion_sedes WHERE id = p_sede_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = v_pid FOR SHARE;
  SELECT * INTO v_sede FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF v_header.estado <> 'abierta' THEN
    RETURN jsonb_build_object('resultado', 'no_abierta');
  END IF;

  IF v_sede.estado <> p_desde OR v_sede.version <> p_sede_version THEN
    RETURN jsonb_build_object('resultado', 'no_reclamada');
  END IF;

  IF v_sede.gasto_sede IS NULL
     OR v_sede.costeo_orden_version IS DISTINCT FROM v_header.orden_version
     OR v_sede.costeo_animales IS DISTINCT FROM v_sede.animales
  THEN
    RETURN jsonb_build_object('resultado', 'costeo_desactualizado');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM carnes_siesa_envios e
     WHERE e.recepcion_id = v_sede.recepcion_id AND e.tipo = 'inicial' AND e.estado = 'ok'
  ) THEN
    IF v_sede.motivo_pendiente IS DISTINCT FROM 'inicial_pendiente' THEN
      UPDATE carnes_preliquidacion_sedes
         SET motivo_pendiente = 'inicial_pendiente', version = version + 1
       WHERE id = p_sede_id;
    END IF;
    RETURN jsonb_build_object('resultado', 'inicial_pendiente');
  END IF;

  v_nueva := v_sede.version + 1;
  v_intentos := CASE WHEN COALESCE(p_reset_intentos, false) THEN 0 ELSE v_sede.intentos END + 1;

  UPDATE carnes_preliquidacion_sedes
     SET estado = 'enviando',
         claim_token = p_token,
         claimed_at = now(),
         claim_costeo_orden_version = v_sede.costeo_orden_version,
         intentos = v_intentos,
         ultimo_intento_at = now(),
         ultima_corrida = p_corrida_id,
         motivo_pendiente = NULL,
         error_tipo = CASE WHEN COALESCE(p_reset_intentos, false) THEN NULL ELSE error_tipo END,
         version = v_nueva
   WHERE id = p_sede_id;

  -- Los avisos de versiones anteriores ya no aplican; el de requiere_correccion se conserva.
  DELETE FROM carnes_preliquidacion_alertas
   WHERE sede_id = p_sede_id AND enviado_ok = false AND ocurrencia < v_nueva
     AND NOT (evento = 'requiere_correccion' AND v_sede.requiere_correccion);

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'sede_version', v_nueva,
    'intentos', v_intentos,
    'claim_costeo_orden_version', v_sede.costeo_orden_version
  );
END;
$fn$ LANGUAGE plpgsql;

ALTER TABLE carnes_recepciones
  DROP COLUMN IF EXISTS inicial_omitida_at,
  DROP COLUMN IF EXISTS inicial_omitida_por;

COMMIT;
