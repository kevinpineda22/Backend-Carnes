-- =============================================================================
-- Migration 043: vincular a una preliquidación liquidada una recepción de hasta 2 días antes
-- =============================================================================
--
-- Hoy carnes_preliq_vincular rechaza (fuera_ventana) toda recepción con fecha_ingreso anterior a
-- fecha_primer_ingreso cuando la preliquidación ya se liquidó ("una preliquidación ya liquidada no
-- mueve su fecha de inicio"). Un admin necesita, a mano, sumar una recepción del día anterior.
--
-- Qué hace: redefine carnes_preliq_vincular (versión de 039; 040-042 no la tocaron) con UN cambio.
-- Si el plan trae `anterior: true` (solo el endpoint manual lo manda, con `permitir_anterior`), la
-- recepción se acepta si, bajo el lock de la cabecera:
--   * la preliquidación está liquidada y abierta (estado = 'abierta', no cerrada ni anulada),
--   * el plan NO mueve la fecha (mueve_fecha = false),
--   * la recepción es de la misma especie,
--   * fecha_ingreso < fecha_primer_ingreso y fecha_ingreso >= fecha_primer_ingreso - 2 días.
-- Fuera de eso responde fuera_ventana. NO se modifica fecha_primer_ingreso, ventana_fin, corte ni
-- ningún monto: la sede nueva entra como cualquier sede vinculada después de liquidar (la costea y
-- envía la corrida / "procesar"). Se conservan las guardas de 039: versión, ya_vinculada,
-- oficial_legacy (liquidación legada u oficial vigente) y el CHECK ck_carnes_recepciones_liq_xor_preliq.
--
-- Sin `anterior` el comportamiento es idéntico al de 039. Mismos parámetros y resultados.
-- SECURITY INVOKER. Idempotente (CREATE OR REPLACE). Todo o nada.
--
-- Precondición: 038 y 039 aplicadas.
-- Orden de despliegue: ... -> 042 -> 043 -> backend con `permitir_anterior`.
-- Reversión: sql/043_rollback.sql (restaura la versión de 039).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'carnes_preliq_vincular') THEN
    RAISE EXCEPTION 'Falta carnes_preliq_vincular. Corra sql/039_preliquidacion_rpc.sql antes de esta migración.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION carnes_preliq_vincular(
  p_recepcion_id      BIGINT,
  p_preliquidacion_id BIGINT,
  p_orden_version     INTEGER,
  p_plan              JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_header    carnes_preliquidaciones%ROWTYPE;
  v_rec       carnes_recepciones%ROWTYPE;
  v_motivo    TEXT;
  v_fecha_ini DATE;
  v_fin       TIMESTAMPTZ;
  v_mueve     BOOLEAN;
  v_anterior  BOOLEAN;
  v_cand      JSONB;
  v_estado    TEXT;
BEGIN
  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_preliquidacion_id FOR UPDATE;
  IF NOT FOUND OR v_header.estado <> 'abierta' THEN
    RETURN jsonb_build_object('resultado', 'sin_preliquidacion');
  END IF;

  SELECT * INTO v_rec FROM carnes_recepciones WHERE id = p_recepcion_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'sin_recepcion');
  END IF;
  IF v_rec.preliquidacion_id IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'ya_vinculada', 'preliquidacion_id', v_rec.preliquidacion_id);
  END IF;

  IF v_header.orden_version <> p_orden_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  -- Una recepción ya incluida en una liquidación legada o con una oficial vigente
  -- (por recepción o por fecha) no se vincula: entraría dos veces a SIESA.
  IF v_rec.liquidacion_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM carnes_siesa_envios e
     WHERE e.tipo = 'oficial'
       AND e.estado IN ('enviando', 'ok', 'sin_confirmar')
       AND (e.recepcion_id = p_recepcion_id OR p_recepcion_id = ANY (e.recepcion_ids))
  ) THEN
    RETURN jsonb_build_object('resultado', 'oficial_legacy');
  END IF;

  v_motivo := carnes_preliq_validar_plan_sedes(p_preliquidacion_id, p_plan);
  IF v_motivo IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada', 'motivo', v_motivo);
  END IF;

  -- La ventana del plan debe contener la fecha de ingreso de la recepción. Una
  -- preliquidación ya liquidada no mueve su fecha de inicio.
  --
  -- Excepción (043): con `anterior` en el plan (vínculo manual del admin) una liquidada acepta una
  -- recepción de la misma especie con ingreso hasta 2 días calendario antes de su primer ingreso, SIN
  -- mover fecha_primer_ingreso, corte ni ventana. La base revalida bajo lock lo que depende del estado.
  v_mueve := COALESCE((p_plan->>'mueve_fecha')::BOOLEAN, false);
  v_anterior := COALESCE((p_plan->>'anterior')::BOOLEAN, false);
  IF v_anterior AND (
       v_mueve
       OR v_header.liquidada_at IS NULL
       OR v_header.fecha_primer_ingreso IS NULL
       OR v_rec.especie IS DISTINCT FROM v_header.especie
       OR v_rec.fecha_ingreso >= v_header.fecha_primer_ingreso
       OR v_rec.fecha_ingreso < v_header.fecha_primer_ingreso - 2
  ) THEN
    RETURN jsonb_build_object('resultado', 'fuera_ventana');
  END IF;
  v_fecha_ini := COALESCE((p_plan->>'fecha_primer_ingreso')::DATE, v_header.fecha_primer_ingreso);
  v_fin := COALESCE((p_plan->>'ventana_fin')::TIMESTAMPTZ, v_header.ventana_fin);
  IF v_fecha_ini IS NULL
     OR v_fin IS NULL
     OR (v_mueve AND v_header.liquidada_at IS NOT NULL)
     OR (NOT v_anterior AND v_rec.fecha_ingreso < v_fecha_ini)
     OR (v_rec.fecha_ingreso::TIMESTAMP AT TIME ZONE 'America/Bogota') > v_fin
  THEN
    RETURN jsonb_build_object('resultado', 'fuera_ventana');
  END IF;

  IF v_mueve OR v_header.fecha_primer_ingreso IS NULL THEN
    UPDATE carnes_preliquidaciones
       SET fecha_primer_ingreso = v_fecha_ini,
           ventana_fin = v_fin,
           version = version + 1
     WHERE id = p_preliquidacion_id;
  END IF;

  PERFORM carnes_preliq_aplicar_plan_sedes(p_preliquidacion_id, p_plan);

  v_cand := p_plan->'candidata';
  v_estado := v_cand->>'estado';
  INSERT INTO carnes_preliquidacion_sedes (
    preliquidacion_id, recepcion_id, animales, orden, estado, motivo_bloqueo
  ) VALUES (
    p_preliquidacion_id,
    p_recepcion_id,
    (v_cand->>'animales')::INTEGER,
    (v_cand->>'orden')::INTEGER,
    v_estado,
    NULLIF(v_cand->>'motivo_bloqueo', '')
  );

  -- Aquí salta el CHECK de novillos entero > 0 si la recepción no cumple.
  UPDATE carnes_recepciones SET preliquidacion_id = p_preliquidacion_id WHERE id = p_recepcion_id;

  UPDATE carnes_preliquidaciones
     SET orden_version = orden_version + 1
   WHERE id = p_preliquidacion_id;

  -- Resuelto: los avisos de "no se pudo vincular" de esta recepción ya no aplican.
  DELETE FROM carnes_preliquidacion_alertas
   WHERE enviado_ok = false
     AND evento IN ('sin_preliquidacion', 'fuera_ventana', 'oficial_legacy')
     AND sede_id = 0
     AND ocurrencia = p_recepcion_id;

  RETURN jsonb_build_object(
    'resultado', CASE WHEN v_estado = 'bloqueada' THEN 'excede' ELSE 'vinculada' END,
    'preliquidacion_id', p_preliquidacion_id,
    'restantes', p_plan->'restantes'
  );
EXCEPTION
  WHEN check_violation THEN
    RETURN jsonb_build_object('resultado', 'novillos_invalido', 'detalle', SQLERRM);
END;
$fn$ LANGUAGE plpgsql;

COMMIT;

-- Verificación: debe aparecer la función.
SELECT proname FROM pg_proc WHERE proname = 'carnes_preliq_vincular';
