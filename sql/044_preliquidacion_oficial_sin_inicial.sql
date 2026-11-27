-- =============================================================================
-- Migration 044: oficial sin inicial (omitir la CEA inicial de una recepción)
-- =============================================================================
--
-- Normalmente la recepción manda una CEA "inicial" provisional al cerrarse y la preliquidación manda
-- después la "oficial" completa, con la que una persona anula a mano la inicial en SIESA. Para algunas
-- recepciones el negocio decide NO mandar la inicial: solo sale la oficial. Hoy la compuerta de
-- carnes_preliq_reclamar_sede (C4) exige una inicial `ok` y, si falta, marca la sede con
-- motivo_pendiente = 'inicial_pendiente' aunque la procese un admin.
--
-- Qué hace:
--   1. Columnas nuevas en carnes_recepciones (NULL = la inicial sale como siempre):
--        inicial_omitida_at   TIMESTAMPTZ  cuándo un admin decidió omitirla
--        inicial_omitida_por  TEXT         quién lo decidió (auditoría)
--   2. carnes_preliq_omitir_inicial(p_sede_id, p_por)  marca la omisión bajo lock. Rechaza si la
--      recepción ya tiene una inicial vigente (enviando, ok o sin_confirmar), si su oficial ya salió
--      (o va en vuelo) o si la sede está anulada o bloqueada (`sede_no_enviable`); es idempotente (`ya_omitida`). Al marcar, limpia el motivo_pendiente
--      'inicial_pendiente' de la sede (con subida de versión) y sus avisos sin enviar.
--      Orden de bloqueo: cabecera -> sede -> recepción.
--   3. Trigger BEFORE INSERT en carnes_siesa_envios: ninguna fila de tipo `inicial` puede nacer para una
--      recepción con la inicial omitida. Toma FOR SHARE sobre la recepción, así que se serializa contra
--      carnes_preliq_omitir_inicial (FOR UPDATE): o la inicial entra antes y la omisión la ve, o la
--      omisión entra antes y la inicial se rechaza. Es la barrera final de toda ruta que mande una inicial.
--   4. carnes_preliq_reclamar_sede (de sql/040; 041-043 no la tocaron) se redefine con UN cambio: la
--      compuerta de la inicial también pasa si la recepción tiene inicial_omitida_at.
--
-- Contrato de retorno: JSONB `{resultado: ...}`. SECURITY INVOKER (por defecto).
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE + DROP TRIGGER IF EXISTS. Todo o nada.
--
-- Precondición: 038 a 040 aplicadas.
-- Orden de despliegue: ... -> 043 -> 044 -> backend con los endpoints de omitir-inicial.
-- Reversión: sql/044_rollback.sql.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'carnes_preliq_reclamar_sede') THEN
    RAISE EXCEPTION 'Falta carnes_preliq_reclamar_sede. Corra sql/040_preliquidacion_rpc_envio.sql antes de esta migración.';
  END IF;
END $$;

ALTER TABLE carnes_recepciones
  ADD COLUMN IF NOT EXISTS inicial_omitida_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inicial_omitida_por TEXT;

COMMENT ON COLUMN carnes_recepciones.inicial_omitida_at IS
  'Un admin decidió que esta recepción NO manda la CEA inicial a SIESA: solo sale la oficial. NULL = la inicial sale como siempre.';


-- -----------------------------------------------------------------------------
-- carnes_preliq_omitir_inicial(p_sede_id, p_por)
--
-- Marca la recepción de la sede como "sin inicial". La decisión de quién puede hacerlo es del endpoint
-- (admin); aquí solo se revalida bajo lock lo que depende del estado de la base.
--
-- Resultados: ok | ya_omitida | no_encontrada | no_abierta | sede_no_enviable | inicial_vigente | oficial_enviada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_omitir_inicial(
  p_sede_id BIGINT,
  p_por     TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_pid       BIGINT;
  v_header    carnes_preliquidaciones%ROWTYPE;
  v_sede      carnes_preliquidacion_sedes%ROWTYPE;
  v_rec       carnes_recepciones%ROWTYPE;
  v_inicial   carnes_siesa_envios%ROWTYPE;
  v_resultado TEXT;
BEGIN
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

  -- Una sede anulada o bloqueada (cualquier motivo, incluido excede_animales) nunca podrá mandar su oficial:
  -- omitirle la inicial no tiene sentido.
  IF v_sede.estado IN ('anulada', 'bloqueada') THEN
    RETURN jsonb_build_object('resultado', 'sede_no_enviable', 'estado', v_sede.estado);
  END IF;

  SELECT * INTO v_rec FROM carnes_recepciones WHERE id = v_sede.recepcion_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF v_rec.inicial_omitida_at IS NOT NULL THEN
    v_resultado := 'ya_omitida';
  ELSE
    -- La oficial ya salió (o va en vuelo): omitir la inicial ya no tiene sentido.
    IF v_sede.estado IN ('enviando', 'enviada', 'sin_confirmar') OR EXISTS (
      SELECT 1 FROM carnes_siesa_envios e
       WHERE e.tipo = 'oficial'
         AND e.estado IN ('enviando', 'ok', 'sin_confirmar')
         AND (e.recepcion_id = v_sede.recepcion_id OR v_sede.recepcion_id = ANY (e.recepcion_ids))
    ) THEN
      RETURN jsonb_build_object('resultado', 'oficial_enviada');
    END IF;

    SELECT * INTO v_inicial FROM carnes_siesa_envios e
     WHERE e.recepcion_id = v_sede.recepcion_id
       AND e.tipo = 'inicial'
       AND e.estado IN ('enviando', 'ok', 'sin_confirmar')
     ORDER BY e.enviado_at DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'resultado', 'inicial_vigente',
        'estado', v_inicial.estado,
        'referencia', v_inicial.referencia
      );
    END IF;

    UPDATE carnes_recepciones
       SET inicial_omitida_at = now(), inicial_omitida_por = p_por
     WHERE id = v_sede.recepcion_id;
    v_resultado := 'ok';
  END IF;

  -- La sede ya no espera la inicial: vuelve a ser elegible (la versión sube, como en todo cambio de sede).
  IF v_sede.motivo_pendiente = 'inicial_pendiente' THEN
    UPDATE carnes_preliquidacion_sedes
       SET motivo_pendiente = NULL, version = version + 1
     WHERE id = p_sede_id;
  END IF;
  DELETE FROM carnes_preliquidacion_alertas
   WHERE sede_id = p_sede_id AND evento = 'inicial_pendiente' AND enviado_ok = false;

  RETURN jsonb_build_object(
    'resultado', v_resultado,
    'sede_id', p_sede_id,
    'recepcion_id', v_sede.recepcion_id
  );
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- Barrera de la omisión: ninguna CEA inicial nace para una recepción con la inicial omitida.
--
-- FOR SHARE sin filtro por inicial_omitida_at: si una omisión está en curso (FOR UPDATE sobre la
-- recepción) el INSERT espera a que termine y relee la fila ya confirmada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_siesa_envios_guardar_inicial_omitida()
RETURNS TRIGGER AS $fn$
DECLARE
  v_omitida TIMESTAMPTZ;
BEGIN
  IF NEW.tipo = 'inicial' AND NEW.recepcion_id IS NOT NULL THEN
    SELECT inicial_omitida_at INTO v_omitida FROM carnes_recepciones WHERE id = NEW.recepcion_id FOR SHARE;
    IF v_omitida IS NOT NULL THEN
      RAISE EXCEPTION 'inicial_omitida: la recepción % no manda la entrada inicial; solo sale la oficial.', NEW.recepcion_id
        USING ERRCODE = 'CA044';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS carnes_siesa_envios_inicial_omitida ON carnes_siesa_envios;
CREATE TRIGGER carnes_siesa_envios_inicial_omitida
  BEFORE INSERT ON carnes_siesa_envios
  FOR EACH ROW EXECUTE FUNCTION carnes_siesa_envios_guardar_inicial_omitida();


-- -----------------------------------------------------------------------------
-- carnes_preliq_reclamar_sede: la versión de sql/040 con UN cambio, la compuerta de la inicial (C4):
-- pasa si hay una inicial `ok` O si la recepción tiene inicial_omitida_at.
-- -----------------------------------------------------------------------------
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
  ) AND NOT EXISTS (
    SELECT 1 FROM carnes_recepciones r
     WHERE r.id = v_sede.recepcion_id AND r.inicial_omitida_at IS NOT NULL
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

COMMIT;
