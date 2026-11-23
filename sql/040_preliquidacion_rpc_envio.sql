-- =============================================================================
-- Migration 040: RPC de envío a SIESA de la preliquidación de talleres (S2)
-- =============================================================================
--
-- Igual que sql/039, estas funciones NO deciden nada: bloquean, validan versiones y
-- escriben lo que JS ya calculó con las funciones puras de src/shared
-- (puedeReclamar, planearEnvios, transicionSede, mapearEnvio). No hay fórmulas de
-- negocio aquí (R8): una prueba estática (test/preliquidacion-rpc.test.js) lo verifica.
--
-- Contenido:
--   * carnes_preliq_reclamar_sede     claim CAS de una sede (capa 1 contra doble envío)
--   * carnes_preliq_cerrar_envio      cierra el envío con el plan de transicionSede
--   * carnes_preliq_sincronizar_envio hook de resolver(): CAS por envio_id
--   * carnes_preliq_cerrar            cierre de la preliquidación (monto_no_asignado)
--   * carnes_preliq_transicionar_sede REEMPLAZA la de 039: amplía la lista de columnas
--                                     permitidas (M2: correccion_orden_version,
--                                     claim_costeo_orden_version; M1: claim_token, claimed_at)
--
-- sql/039 NO se edita (ya está en producción): la función se redefine aquí con
-- CREATE OR REPLACE. Su versión de 039 se restaura con sql/040_rollback.sql.
--
-- Cambio adicional en transicionar_sede (M2): al borrar los avisos sin enviar de
-- versiones anteriores se conserva el aviso `requiere_correccion` mientras la sede
-- siga con el flag levantado (un envío con montos anteriores al recálculo no lo limpia).
--
-- Contrato de retorno: JSONB `{resultado: ...}`; los resultados de negocio no son
-- excepciones. Orden de bloqueo: cabecera -> sede -> recepción.
--
-- SECURITY INVOKER (por defecto). Idempotente: CREATE OR REPLACE. Todo o nada.
--
-- Nota: sql/041 exige esta versión de 040 (carnes_preliq_cerrar_envio con el CAS
-- `correccion_orden_version_esperada`) y aborta si la base tiene una 040 anterior. Si ya se
-- corrió una 040 sin ese CAS, vuelva a correr este archivo completo (es idempotente) antes de 041.
-- Orden de despliegue: 038 -> 039 -> 040 -> backend con CARNES_PRELIQUIDACION apagado.
-- Reversión: sql/040_rollback.sql (antes de sql/038_039_rollback.sql).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'carnes_preliq_transicionar_sede'
  ) THEN
    RAISE EXCEPTION
      'Falta sql/039_preliquidacion_rpc.sql (carnes_preliq_transicionar_sede). Correla antes de esta migración.';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- carnes_preliq_reclamar_sede(p_sede_id, p_sede_version, p_desde, p_token, p_corrida_id,
--                             p_origen, p_reset_intentos)
--
-- La decisión de si la sede es reclamable la toma JS (`puedeReclamar`). Aquí se aplica de
-- forma atómica como CAS sobre la foto que JS evaluó (`estado = p_desde AND version =
-- p_sede_version`): cualquier cambio concurrente hace fallar el reclamo (`no_reclamada`).
--
-- Guarda de montos obsoletos (T2, todos los orígenes, admin incluido): toma FOR SHARE sobre
-- la cabecera (serializa contra vincular/novillos/recalcular, que toman FOR UPDATE) y
-- devuelve `costeo_desactualizado` sin escribir si la sede no tiene costeo vigente.
--
-- Compuerta de la inicial (C4): debe existir un envío INICIAL `ok` de la recepción. Si
-- falta, se marca `motivo_pendiente = 'inicial_pendiente'` (una sola vez: los fallos
-- repetidos no suben la versión) y se devuelve `inicial_pendiente`. JS no llama a esta
-- función con SIESA apagado (R10).
--
-- Al reclamar guarda `claim_costeo_orden_version` (M2): la versión de costeo con la que
-- saldrá el CEA; decide después si el envío puede limpiar `requiere_correccion`.
--
-- Cabecera cerrada o anulada (JD S2): con el lock FOR SHARE de la cabecera ya tomado devuelve
-- `no_abierta` sin escribir, para que un reclamo no corra contra un cierre concurrente.
--
-- Resultados: ok | corrida_requerida | origen_invalido | desde_invalido | no_encontrada |
--             no_abierta | no_reclamada | costeo_desactualizado | inicial_pendiente
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


-- -----------------------------------------------------------------------------
-- carnes_preliq_cerrar_envio(p_sede_id, p_token, p_plan)
--
-- Cierra el intento de envío: solo escribe el resultado de `transicionSede` calculado en
-- JS a partir del evento de `mapearEnvio`. Exige `estado = 'enviando'` y el token del
-- reclamo (si otra instancia reclamó entre tanto, el token no coincide).
--
-- p_plan: {hacia, campos?: {envio_id?, error_tipo?, intentos?, motivo_pendiente?,
--          motivo_bloqueo?, detalle_bloqueo?, liberada_at?, requiere_correccion?,
--          correccion_orden_version?}, recepcion_estado?: 'Costeado'|'Enviado_SIESA',
--          correccion_orden_version_esperada?: la `correccion_orden_version` que JS leyó de la sede}
--
-- M2 (carrera con "recalcular no enviadas"): mientras el CEA viaja, un recálculo puede levantar
-- `requiere_correccion` en esta misma sede (está `enviando`). JS calculó el cierre con lo que leyó
-- ANTES; si la `correccion_orden_version` guardada ya no es la que JS vio (compare-and-set sobre el
-- campo, sin fórmula de negocio), NO se escriben requiere_correccion ni correccion_orden_version:
-- el aviso nuevo se conserva y exige la anulación y el reenvío con los montos nuevos.
--
-- Al salir de `enviando` se liberan claim_token y claimed_at; en `enviando -> enviando`
-- (envío repetido en vuelo) se conservan. La recepción pasa a Enviado_SIESA en `enviada`.
--
-- Resultados: ok | token_invalido | no_encontrada | hacia_invalido | recepcion_estado_invalido
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_cerrar_envio(
  p_sede_id  BIGINT,
  p_token    UUID,
  p_plan     JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_sede     carnes_preliquidacion_sedes%ROWTYPE;
  v_hacia    TEXT;
  v_campos   JSONB;
  v_rec      TEXT;
  v_nueva    INTEGER;
  v_requiere BOOLEAN;
  v_conserva BOOLEAN;
BEGIN
  v_hacia := p_plan->>'hacia';
  v_campos := COALESCE(p_plan->'campos', '{}'::jsonb);
  v_rec := p_plan->>'recepcion_estado';

  IF v_hacia IS NULL OR v_hacia NOT IN ('enviada', 'enviando', 'sin_confirmar', 'error', 'bloqueada') THEN
    RETURN jsonb_build_object('resultado', 'hacia_invalido');
  END IF;
  IF v_rec IS NOT NULL AND v_rec NOT IN ('Costeado', 'Enviado_SIESA') THEN
    RETURN jsonb_build_object('resultado', 'recepcion_estado_invalido');
  END IF;

  SELECT * INTO v_sede FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF v_sede.estado <> 'enviando' OR p_token IS NULL OR v_sede.claim_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('resultado', 'token_invalido');
  END IF;

  v_nueva := v_sede.version + 1;

  -- M2: el aviso cambió mientras viajaba el envío -> no se pisa.
  v_conserva := (p_plan ? 'correccion_orden_version_esperada')
    AND v_sede.correccion_orden_version IS DISTINCT FROM NULLIF(p_plan->>'correccion_orden_version_esperada', '')::INTEGER;

  UPDATE carnes_preliquidacion_sedes
     SET estado = v_hacia,
         claim_token = CASE WHEN v_hacia = 'enviando' THEN claim_token ELSE NULL END,
         claimed_at = CASE WHEN v_hacia = 'enviando' THEN claimed_at ELSE NULL END,
         envio_id = CASE WHEN v_campos ? 'envio_id' THEN NULLIF(v_campos->>'envio_id', '')::BIGINT ELSE envio_id END,
         error_tipo = CASE WHEN v_campos ? 'error_tipo' THEN NULLIF(v_campos->>'error_tipo', '') ELSE error_tipo END,
         intentos = CASE WHEN v_campos ? 'intentos' THEN (v_campos->>'intentos')::INTEGER ELSE intentos END,
         motivo_pendiente = CASE WHEN v_campos ? 'motivo_pendiente' THEN NULLIF(v_campos->>'motivo_pendiente', '') ELSE motivo_pendiente END,
         motivo_bloqueo = CASE WHEN v_campos ? 'motivo_bloqueo' THEN NULLIF(v_campos->>'motivo_bloqueo', '') ELSE motivo_bloqueo END,
         detalle_bloqueo = CASE WHEN v_campos ? 'detalle_bloqueo' THEN NULLIF(v_campos->>'detalle_bloqueo', '') ELSE detalle_bloqueo END,
         liberada_at = CASE WHEN v_campos ? 'liberada_at' THEN NULLIF(v_campos->>'liberada_at', '')::TIMESTAMPTZ ELSE liberada_at END,
         requiere_correccion = CASE WHEN v_campos ? 'requiere_correccion' AND NOT v_conserva THEN (v_campos->>'requiere_correccion')::BOOLEAN ELSE requiere_correccion END,
         correccion_orden_version = CASE WHEN v_campos ? 'correccion_orden_version' AND NOT v_conserva THEN (v_campos->>'correccion_orden_version')::INTEGER ELSE correccion_orden_version END,
         version = v_nueva
   WHERE id = p_sede_id;

  IF v_rec IS NOT NULL THEN
    UPDATE carnes_recepciones SET estado = v_rec WHERE id = v_sede.recepcion_id AND estado <> v_rec;
  END IF;

  SELECT requiere_correccion INTO v_requiere FROM carnes_preliquidacion_sedes WHERE id = p_sede_id;
  DELETE FROM carnes_preliquidacion_alertas
   WHERE sede_id = p_sede_id AND enviado_ok = false AND ocurrencia < v_nueva
     AND NOT (evento = 'requiere_correccion' AND v_requiere);

  RETURN jsonb_build_object('resultado', 'ok', 'estado', v_hacia, 'sede_version', v_nueva);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_sincronizar_envio(p_envio_id, p_sede_version, p_desde, p_hacia, p_campos)
--
-- Hook del resolver() de SiesaEnvio y de la anulación: cuando una persona confirma el
-- resultado de un envío dudoso, la sede que lo referencia debe seguirlo. JS busca la sede por
-- `envio_id`, calcula `transicionSede(estado, evento)` y escribe el resultado por el mismo CAS
-- de `carnes_preliq_transicionar_sede` (estado + versión). Sin sede para ese envío es un
-- no-op (`sin_sede`): la mayoría de los envíos no son de preliquidación.
--
-- Resultados: los de carnes_preliq_transicionar_sede (ok | version_cambiada | no_encontrada |
--             recepcion_estado_invalido) | sin_sede
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_sincronizar_envio(
  p_envio_id      BIGINT,
  p_sede_version  INTEGER,
  p_desde         TEXT,
  p_hacia         TEXT,
  p_campos        JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_sede_id BIGINT;
BEGIN
  SELECT id INTO v_sede_id FROM carnes_preliquidacion_sedes WHERE envio_id = p_envio_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'sin_sede');
  END IF;

  RETURN carnes_preliq_transicionar_sede(v_sede_id, p_sede_version, p_desde, p_hacia, p_campos);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_cerrar(p_id, p_orden_version, p_monto_no_asignado)
--
-- Cierra la preliquidación (cierre manual del admin o auto-cierre decidido en JS). El monto
-- no asignado (gasto_total_aplicado menos lo asignado a sedes enviadas) lo calcula JS en
-- centavos; aquí solo se guarda. `p_orden_version` cubre la carrera con vincular/novillos:
-- si el conjunto de sedes cambió desde que JS decidió cerrar, devuelve `version_cambiada`.
--
-- Revalidación bajo el lock (JD S2): con la cabecera ya bloqueada FOR UPDATE, si alguna sede
-- sigue pendiente o en vuelo (`enviando` incluida) devuelve `no_cerrable` sin escribir. Los
-- reclamos toman FOR SHARE sobre la cabecera, así que no pueden colarse entre la decisión de
-- JS y este cierre.
--
-- Resultados: ok | no_encontrada | no_abierta | no_liquidada | version_cambiada | monto_invalido |
--             no_cerrable
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_cerrar(
  p_id                  BIGINT,
  p_orden_version       INTEGER,
  p_monto_no_asignado   NUMERIC
) RETURNS JSONB AS $fn$
DECLARE
  v_header carnes_preliquidaciones%ROWTYPE;
BEGIN
  IF p_monto_no_asignado IS NULL THEN
    RETURN jsonb_build_object('resultado', 'monto_invalido');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF v_header.estado <> 'abierta' THEN
    RETURN jsonb_build_object('resultado', 'no_abierta');
  END IF;
  IF v_header.liquidada_at IS NULL THEN
    RETURN jsonb_build_object('resultado', 'no_liquidada');
  END IF;
  IF v_header.orden_version <> p_orden_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;
  IF EXISTS (
    SELECT 1 FROM carnes_preliquidacion_sedes s
     WHERE s.preliquidacion_id = p_id
       AND s.estado IN ('vinculada', 'calculada', 'lista_para_enviar', 'error', 'simulada', 'anulada', 'enviando', 'sin_confirmar')
  ) THEN
    RETURN jsonb_build_object('resultado', 'no_cerrable');
  END IF;

  UPDATE carnes_preliquidaciones
     SET estado = 'cerrada',
         cerrada_at = now(),
         monto_no_asignado = p_monto_no_asignado,
         version = version + 1
   WHERE id = p_id;

  -- Cerrada ya no hay nada que avisar de lo pendiente: las alertas sin enviar quedan obsoletas.
  -- La alerta `cerrada` la encola JS DESPUÉS de este cierre, así que no se la lleva este borrado.
  DELETE FROM carnes_preliquidacion_alertas
   WHERE preliquidacion_id = p_id AND enviado_ok = false;

  RETURN jsonb_build_object('resultado', 'ok', 'monto_no_asignado', p_monto_no_asignado);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_transicionar_sede(p_sede_id, p_sede_version, p_desde, p_hacia, p_campos)
--
-- REEMPLAZA la versión de sql/039 (misma firma). Cambios:
--   * lista de columnas permitidas ampliada: correccion_orden_version y
--     claim_costeo_orden_version (M2), claim_token y claimed_at (M1: liberar el reclamo de un
--     `enviando` abandonado al recostear);
--   * los avisos `requiere_correccion` sin enviar se conservan mientras el flag siga activo.
--
-- Resultados: ok | version_cambiada | no_encontrada | recepcion_estado_invalido
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_transicionar_sede(
  p_sede_id      BIGINT,
  p_sede_version INTEGER,
  p_desde        TEXT,
  p_hacia        TEXT,
  p_campos       JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_sede     carnes_preliquidacion_sedes%ROWTYPE;
  v_nueva    INTEGER;
  v_rec      TEXT;
  v_requiere BOOLEAN;
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
         correccion_orden_version = CASE WHEN p_campos ? 'correccion_orden_version' THEN (p_campos->>'correccion_orden_version')::INTEGER ELSE correccion_orden_version END,
         claim_costeo_orden_version = CASE WHEN p_campos ? 'claim_costeo_orden_version' THEN (p_campos->>'claim_costeo_orden_version')::INTEGER ELSE claim_costeo_orden_version END,
         claim_token = CASE WHEN p_campos ? 'claim_token' THEN NULLIF(p_campos->>'claim_token', '')::UUID ELSE claim_token END,
         claimed_at = CASE WHEN p_campos ? 'claimed_at' THEN NULLIF(p_campos->>'claimed_at', '')::TIMESTAMPTZ ELSE claimed_at END,
         error_tipo = CASE WHEN p_campos ? 'error_tipo' THEN NULLIF(p_campos->>'error_tipo', '') ELSE error_tipo END,
         intentos = CASE WHEN p_campos ? 'intentos' THEN (p_campos->>'intentos')::INTEGER ELSE intentos END,
         envio_id = CASE WHEN p_campos ? 'envio_id' THEN NULLIF(p_campos->>'envio_id', '')::BIGINT ELSE envio_id END,
         version = version + 1
   WHERE id = p_sede_id;

  IF v_rec IS NOT NULL THEN
    UPDATE carnes_recepciones SET estado = v_rec WHERE id = v_sede.recepcion_id AND estado <> v_rec;
  END IF;

  SELECT requiere_correccion INTO v_requiere FROM carnes_preliquidacion_sedes WHERE id = p_sede_id;
  DELETE FROM carnes_preliquidacion_alertas
   WHERE sede_id = p_sede_id AND enviado_ok = false AND ocurrencia < v_nueva
     AND NOT (evento = 'requiere_correccion' AND v_requiere);

  RETURN jsonb_build_object('resultado', 'ok', 'estado', p_hacia, 'sede_version', v_nueva);
END;
$fn$ LANGUAGE plpgsql;

COMMIT;

-- Verificación: debe listar las cinco funciones de esta migración.
SELECT proname
  FROM pg_proc
 WHERE proname IN (
   'carnes_preliq_reclamar_sede', 'carnes_preliq_cerrar_envio', 'carnes_preliq_sincronizar_envio',
   'carnes_preliq_cerrar', 'carnes_preliq_transicionar_sede'
 )
 ORDER BY proname;
