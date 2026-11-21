-- =============================================================================
-- ROLLBACK de sql/040_preliquidacion_rpc_envio.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Revierte SOLO sql/040: elimina las cuatro
-- funciones nuevas y restaura `carnes_preliq_transicionar_sede` a su versión de sql/039
-- (sin las columnas M1/M2 en la lista permitida). 038 y 039 quedan intactas.
--
-- Orden: si también hay que revertir 038/039, correr ESTE archivo primero y después
-- sql/038_039_rollback.sql (que además elimina las funciones de 040 si siguen presentes,
-- por si se corre solo).
--
-- Antes de correrlo: apagar CARNES_PRELIQUIDACION y deshabilitar el workflow del cron.
-- Con sedes en estado `enviando` hay que esperar a que terminen: sin `cerrar_envio` el
-- backend de S2 no puede cerrarlas.
--
-- Idempotente (IF EXISTS / CREATE OR REPLACE) y todo o nada. lock_timeout de 5s.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS carnes_preliq_cerrar(BIGINT, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS carnes_preliq_sincronizar_envio(BIGINT, INTEGER, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_cerrar_envio(BIGINT, UUID, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_reclamar_sede(BIGINT, INTEGER, TEXT, UUID, BIGINT, TEXT, BOOLEAN);

-- Versión de sql/039 de carnes_preliq_transicionar_sede (copia literal).
CREATE OR REPLACE FUNCTION carnes_preliq_transicionar_sede(
  p_sede_id      BIGINT,
  p_sede_version INTEGER,
  p_desde        TEXT,
  p_hacia        TEXT,
  p_campos       JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_sede   carnes_preliquidacion_sedes%ROWTYPE;
  v_nueva  INTEGER;
  v_rec    TEXT;
BEGIN
  v_rec := p_campos->>'recepcion_estado';
  IF v_rec IS NOT NULL AND v_rec NOT IN ('Costeado', 'Enviado_SIESA') THEN
    RETURN jsonb_build_object('resultado', 'recepcion_estado_invalido');
  END IF;

  SELECT * INTO v_sede FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF v_sede.estado <> p_desde OR v_sede.version <> p_sede_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  v_nueva := v_sede.version + 1;

  UPDATE carnes_preliquidacion_sedes
     SET estado = p_hacia,
         motivo_bloqueo = CASE WHEN p_campos ? 'motivo_bloqueo' THEN NULLIF(p_campos->>'motivo_bloqueo', '') ELSE motivo_bloqueo END,
         detalle_bloqueo = CASE WHEN p_campos ? 'detalle_bloqueo' THEN NULLIF(p_campos->>'detalle_bloqueo', '') ELSE detalle_bloqueo END,
         liberada_at = CASE WHEN p_campos ? 'liberada_at' THEN NULLIF(p_campos->>'liberada_at', '')::TIMESTAMPTZ ELSE liberada_at END,
         motivo_pendiente = CASE WHEN p_campos ? 'motivo_pendiente' THEN NULLIF(p_campos->>'motivo_pendiente', '') ELSE motivo_pendiente END,
         requiere_correccion = CASE WHEN p_campos ? 'requiere_correccion' THEN (p_campos->>'requiere_correccion')::BOOLEAN ELSE requiere_correccion END,
         error_tipo = CASE WHEN p_campos ? 'error_tipo' THEN NULLIF(p_campos->>'error_tipo', '') ELSE error_tipo END,
         intentos = CASE WHEN p_campos ? 'intentos' THEN (p_campos->>'intentos')::INTEGER ELSE intentos END,
         envio_id = CASE WHEN p_campos ? 'envio_id' THEN NULLIF(p_campos->>'envio_id', '')::BIGINT ELSE envio_id END,
         version = version + 1
   WHERE id = p_sede_id;

  IF v_rec IS NOT NULL THEN
    UPDATE carnes_recepciones SET estado = v_rec WHERE id = v_sede.recepcion_id AND estado <> v_rec;
  END IF;

  DELETE FROM carnes_preliquidacion_alertas
   WHERE sede_id = p_sede_id AND enviado_ok = false AND ocurrencia < v_nueva;

  RETURN jsonb_build_object('resultado', 'ok', 'estado', p_hacia, 'sede_version', v_nueva);
END;
$fn$ LANGUAGE plpgsql;

COMMIT;

-- Verificación: debe devolver solo carnes_preliq_transicionar_sede entre las funciones de 040.
SELECT proname
  FROM pg_proc
 WHERE proname IN (
   'carnes_preliq_reclamar_sede', 'carnes_preliq_cerrar_envio', 'carnes_preliq_sincronizar_envio',
   'carnes_preliq_cerrar', 'carnes_preliq_transicionar_sede'
 )
 ORDER BY proname;
