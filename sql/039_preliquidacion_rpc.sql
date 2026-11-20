-- =============================================================================
-- Migration 039: RPC de la preliquidación de talleres (persistencia fina)
-- =============================================================================
--
-- Estas funciones NO deciden nada. Cada una:
--
--   1. toma los locks de fila (cabecera primero, luego sede, luego recepción),
--   2. valida las VERSIONES que leyó JS (`orden_version`, `version`) y las
--      precondiciones de estado,
--   3. escribe el plan JSONB que JS ya calculó con las funciones puras de
--      src/shared (planearVinculacion, transicionSede, gastoTotal, ...).
--
-- No hay fórmulas de negocio aquí (R8): una prueba estática
-- (test/preliquidacion-rpc.test.js) rechaza cualquier fórmula de plata en este archivo.
--
-- Contrato de retorno: JSONB `{resultado: ...}`. Los resultados de negocio NO son
-- excepciones: el modelo los traduce a HTTP 409/422. Si la versión cambió
-- (`version_cambiada`) JS vuelve a leer, recalcula y reintenta (máx. 3 veces).
--
-- Conjunto A: crear, vincular, desvincular (M4), actualizar_novillos y dos ayudantes
-- internos que validan/aplican el plan de sedes.
-- Conjunto B: actualizar_servicio (M3), liquidar, congelar_sede y transicionar_sede.
-- (Las RPC de envío van en sql/040 y las de correcciones en sql/041.)
--
-- Orden de bloqueo en TODAS las funciones: cabecera -> sede -> recepción.
--
-- SECURITY INVOKER (por defecto). Idempotente: CREATE OR REPLACE. Todo o nada.
--
-- Orden de despliegue: 038 -> 039 -> backend con CARNES_PRELIQUIDACION apagado.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'carnes_preliquidaciones'
  ) THEN
    RAISE EXCEPTION
      'Falta sql/038_preliquidacion.sql (tabla carnes_preliquidaciones). Correla antes de esta migración.';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- Ayudante: valida que el plan de sedes sea aplicable a lo que hay AHORA en la base.
-- Devuelve NULL si es válido, o el motivo. Se llama ANTES de escribir nada, para que
-- una función pueda salir con `version_cambiada` sin dejar escrituras a medias.
--
-- p_plan.reordenar: [{recepcion_id, orden}]  solo sedes en `vinculada` (R3)
-- p_plan.excede:    [recepcion_id]           sedes `vinculada` que ya no caben
-- p_plan.liberadas: [recepcion_id]           `bloqueada(excede_animales)` aún no liberadas
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_validar_plan_sedes(p_preliquidacion_id BIGINT, p_plan JSONB)
RETURNS TEXT AS $fn$
DECLARE
  v_item JSONB;
  v_rec  BIGINT;
BEGIN
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_plan->'reordenar', '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM carnes_preliquidacion_sedes s
       WHERE s.preliquidacion_id = p_preliquidacion_id
         AND s.recepcion_id = (v_item->>'recepcion_id')::BIGINT
         AND s.estado = 'vinculada'
    ) THEN
      RETURN 'reordena_no_vinculada';
    END IF;
  END LOOP;

  FOR v_rec IN
    SELECT value::BIGINT FROM jsonb_array_elements_text(COALESCE(p_plan->'excede', '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM carnes_preliquidacion_sedes s
       WHERE s.preliquidacion_id = p_preliquidacion_id
         AND s.recepcion_id = v_rec
         AND s.estado = 'vinculada'
    ) THEN
      RETURN 'excede_no_vinculada';
    END IF;
  END LOOP;

  FOR v_rec IN
    SELECT value::BIGINT FROM jsonb_array_elements_text(COALESCE(p_plan->'liberadas', '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM carnes_preliquidacion_sedes s
       WHERE s.preliquidacion_id = p_preliquidacion_id
         AND s.recepcion_id = v_rec
         AND s.estado = 'bloqueada'
         AND s.motivo_bloqueo = 'excede_animales'
         AND s.liberada_at IS NULL
    ) THEN
      RETURN 'liberada_invalida';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- Ayudante: escribe el plan de sedes ya validado. Cada sede tocada sube su `version`.
--   reordenar -> nuevo `orden`
--   excede    -> vinculada pasa a bloqueada(excede_animales), sin liberar
--   liberadas -> `liberada_at = now()` (sigue bloqueada(excede_animales); entra a la
--                cola de costeo y consume animales; nunca queda lista_para_enviar sin costeo)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_aplicar_plan_sedes(p_preliquidacion_id BIGINT, p_plan JSONB)
RETURNS VOID AS $fn$
BEGIN
  UPDATE carnes_preliquidacion_sedes s
     SET orden = (i.valor->>'orden')::INTEGER,
         version = s.version + 1
    FROM jsonb_array_elements(COALESCE(p_plan->'reordenar', '[]'::jsonb)) AS i(valor)
   WHERE s.preliquidacion_id = p_preliquidacion_id
     AND s.recepcion_id = (i.valor->>'recepcion_id')::BIGINT;

  UPDATE carnes_preliquidacion_sedes
     SET estado = 'bloqueada',
         motivo_bloqueo = 'excede_animales',
         liberada_at = NULL,
         version = version + 1
   WHERE preliquidacion_id = p_preliquidacion_id
     AND estado = 'vinculada'
     AND recepcion_id IN (
       SELECT value::BIGINT FROM jsonb_array_elements_text(COALESCE(p_plan->'excede', '[]'::jsonb))
     );

  UPDATE carnes_preliquidacion_sedes
     SET liberada_at = now(),
         version = version + 1
   WHERE preliquidacion_id = p_preliquidacion_id
     AND estado = 'bloqueada'
     AND motivo_bloqueo = 'excede_animales'
     AND liberada_at IS NULL
     AND recepcion_id IN (
       SELECT value::BIGINT FROM jsonb_array_elements_text(COALESCE(p_plan->'liberadas', '[]'::jsonb))
     );
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_crear(p_especie, p_datos)
--
-- p_datos: {animales, animal_en_pie, servicio?, servicio_precorte?, tercero_id?, creado_por?}
-- Antes del primer ingreso no hay corte, así que JS manda `servicio_precorte` junto a
-- `servicio` cuando corresponde.
--
-- Resultados: ok | abierta_en_curso | config_servicio_cero | datos_invalidos
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_crear(p_especie TEXT, p_datos JSONB)
RETURNS JSONB AS $fn$
DECLARE
  v_config   NUMERIC;
  v_abierta  BIGINT;
  v_id       BIGINT;
  v_saldos   INTEGER;
  v_servicio NUMERIC;
  v_precorte NUMERIC;
BEGIN
  IF p_especie IS NULL OR p_especie NOT IN ('res', 'cerdo') THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos', 'motivo', 'especie');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('preliq:' || p_especie));

  SELECT servicio_por_animal INTO v_config
    FROM carnes_preliquidacion_config
   WHERE especie = p_especie;
  IF NOT FOUND OR v_config <= 0 THEN
    RETURN jsonb_build_object('resultado', 'config_servicio_cero');
  END IF;

  SELECT id INTO v_abierta
    FROM carnes_preliquidaciones
   WHERE especie = p_especie
     AND estado = 'abierta'
     AND (ventana_fin IS NULL OR ventana_fin >= now())
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('resultado', 'abierta_en_curso', 'preliquidacion_id', v_abierta);
  END IF;

  v_servicio := NULLIF(p_datos->>'servicio', '')::NUMERIC;
  v_precorte := NULLIF(p_datos->>'servicio_precorte', '')::NUMERIC;

  INSERT INTO carnes_preliquidaciones (
    especie, animales, animal_en_pie, servicio, servicio_at, servicio_precorte, servicio_precorte_at,
    servicio_por_animal, tercero_id, creado_por
  ) VALUES (
    p_especie,
    (p_datos->>'animales')::INTEGER,
    COALESCE(NULLIF(p_datos->>'animal_en_pie', '')::NUMERIC, 0),
    v_servicio,
    CASE WHEN v_servicio IS NOT NULL THEN now() END,
    v_precorte,
    CASE WHEN v_precorte IS NOT NULL THEN now() END,
    v_config,
    COALESCE(NULLIF(p_datos->>'tercero_id', ''), 'frigorifico'),
    NULLIF(p_datos->>'creado_por', '')
  )
  RETURNING id INTO v_id;

  -- Los saldos que esperaban una preliquidación de esta especie se adjuntan a la nueva.
  UPDATE carnes_preliquidacion_saldos
     SET destino_preliquidacion_id = v_id
   WHERE destino_preliquidacion_id IS NULL
     AND especie = p_especie
     AND estado = 'pendiente';
  GET DIAGNOSTICS v_saldos = ROW_COUNT;

  RETURN jsonb_build_object('resultado', 'ok', 'preliquidacion_id', v_id, 'saldos_adjuntos', v_saldos);
EXCEPTION
  WHEN check_violation OR not_null_violation OR invalid_text_representation THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos', 'detalle', SQLERRM);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_vincular(p_recepcion_id, p_preliquidacion_id, p_orden_version, p_plan)
--
-- JS eligió la preliquidación (`elegirPreliquidacion`) y calculó el plan
-- (`planearVinculacion` + `planearVentana`). p_plan:
--   fecha_primer_ingreso, ventana_fin, mueve_fecha   ventana a fijar (o la existente)
--   candidata: {animales, orden, estado: 'vinculada'|'bloqueada', motivo_bloqueo?}
--   reordenar / excede / liberadas                   ver carnes_preliq_validar_plan_sedes
--   restantes                                        animales que quedan por vincular
--
-- El orden SOLO cambia en sedes `vinculada` (R3); un plan que mueva otra es obsoleto.
--
-- Resultados: vinculada | excede | sin_preliquidacion | sin_recepcion | fuera_ventana |
--             ya_vinculada | oficial_legacy | version_cambiada | novillos_invalido
-- -----------------------------------------------------------------------------
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
  v_mueve := COALESCE((p_plan->>'mueve_fecha')::BOOLEAN, false);
  v_fecha_ini := COALESCE((p_plan->>'fecha_primer_ingreso')::DATE, v_header.fecha_primer_ingreso);
  v_fin := COALESCE((p_plan->>'ventana_fin')::TIMESTAMPTZ, v_header.ventana_fin);
  IF v_fecha_ini IS NULL
     OR v_fin IS NULL
     OR (v_mueve AND v_header.liquidada_at IS NOT NULL)
     OR v_rec.fecha_ingreso < v_fecha_ini
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


-- -----------------------------------------------------------------------------
-- carnes_preliq_desvincular(p_sede_id, p_orden_version, p_plan)    [M4]
--
-- Recibe `p_plan` como vincular: al liberarse cupo, las sedes `bloqueada(excede_animales)`
-- que ahora caben llegan en `p_plan.liberadas` y quedan con `liberada_at` puesto
-- (consumen animales; no pasan a lista_para_enviar sin costeo). También trae `reordenar`
-- (solo sedes `vinculada`) y `restantes`.
--
-- Solo se desvincula una sede que nunca se envió. Se devuelve la recepción al flujo
-- legado: Costeado -> Aprobado con los costos limpios (igual que reabrir una liquidación).
--
-- Resultados: ok | no_vinculada | sede_enviada | version_cambiada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_desvincular(
  p_sede_id       BIGINT,
  p_orden_version INTEGER,
  p_plan          JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_pid    BIGINT;
  v_header carnes_preliquidaciones%ROWTYPE;
  v_sede   carnes_preliquidacion_sedes%ROWTYPE;
  v_motivo TEXT;
BEGIN
  SELECT preliquidacion_id INTO v_pid FROM carnes_preliquidacion_sedes WHERE id = p_sede_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_vinculada');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_sede FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_vinculada');
  END IF;

  IF v_sede.estado IN ('enviando', 'enviada', 'sin_confirmar', 'anulada')
     OR (
       v_sede.envio_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM carnes_siesa_envios e
          WHERE e.id = v_sede.envio_id AND e.estado IN ('ok', 'enviando', 'sin_confirmar')
       )
     )
  THEN
    RETURN jsonb_build_object('resultado', 'sede_enviada');
  END IF;

  IF v_header.orden_version <> p_orden_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  v_motivo := carnes_preliq_validar_plan_sedes(v_pid, p_plan);
  IF v_motivo IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada', 'motivo', v_motivo);
  END IF;

  DELETE FROM carnes_preliquidacion_alertas WHERE sede_id = p_sede_id AND enviado_ok = false;
  DELETE FROM carnes_preliquidacion_sedes WHERE id = p_sede_id;

  UPDATE carnes_recepcion_items
     SET costo_ajustado = NULL, costo_total = NULL
   WHERE recepcion_id = v_sede.recepcion_id;
  UPDATE carnes_recepciones
     SET estado = 'Aprobado', costeado_at = NULL
   WHERE id = v_sede.recepcion_id AND estado = 'Costeado';
  UPDATE carnes_recepciones SET preliquidacion_id = NULL WHERE id = v_sede.recepcion_id;

  PERFORM carnes_preliq_aplicar_plan_sedes(v_pid, p_plan);

  UPDATE carnes_preliquidaciones
     SET orden_version = orden_version + 1
   WHERE id = v_pid;

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'preliquidacion_id', v_pid,
    'restantes', p_plan->'restantes'
  );
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_actualizar_novillos(p_recepcion_id, p_novillos, p_orden_version, p_plan)
--
-- JS volvió a correr `planearVinculacion` con los animales nuevos; p_plan trae
-- `reordenar` / `excede` / `liberadas` / `restantes`. Solo se edita una sede en
-- vinculada, bloqueada o lista_para_enviar; en las demás -> sede_no_editable (409).
-- Los costos de una lista_para_enviar quedan desactualizados por `costeo_animales`.
--
-- Resultados: ok | excede | no_vinculada | sede_no_editable | invalido | version_cambiada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_actualizar_novillos(
  p_recepcion_id  BIGINT,
  p_novillos      NUMERIC,
  p_orden_version INTEGER,
  p_plan          JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_pid    BIGINT;
  v_header carnes_preliquidaciones%ROWTYPE;
  v_sede   carnes_preliquidacion_sedes%ROWTYPE;
  v_motivo TEXT;
  v_excede BOOLEAN;
BEGIN
  SELECT preliquidacion_id INTO v_pid FROM carnes_recepciones WHERE id = p_recepcion_id;
  IF NOT FOUND OR v_pid IS NULL THEN
    RETURN jsonb_build_object('resultado', 'no_vinculada');
  END IF;

  IF p_novillos IS NULL OR p_novillos <= 0 OR p_novillos <> trunc(p_novillos) THEN
    RETURN jsonb_build_object('resultado', 'invalido');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_sede FROM carnes_preliquidacion_sedes WHERE recepcion_id = p_recepcion_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_vinculada');
  END IF;

  IF v_sede.estado NOT IN ('vinculada', 'bloqueada', 'lista_para_enviar') THEN
    RETURN jsonb_build_object('resultado', 'sede_no_editable', 'estado', v_sede.estado);
  END IF;

  IF v_header.orden_version <> p_orden_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  v_motivo := carnes_preliq_validar_plan_sedes(v_pid, p_plan);
  IF v_motivo IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada', 'motivo', v_motivo);
  END IF;

  v_excede := v_sede.estado = 'vinculada'
          AND COALESCE((p_plan->'excede') @> to_jsonb(p_recepcion_id), false);

  UPDATE carnes_recepciones SET novillos = p_novillos WHERE id = p_recepcion_id;
  UPDATE carnes_preliquidacion_sedes
     SET animales = p_novillos::INTEGER,
         version = version + 1
   WHERE id = v_sede.id;

  PERFORM carnes_preliq_aplicar_plan_sedes(v_pid, p_plan);

  UPDATE carnes_preliquidaciones
     SET orden_version = orden_version + 1
   WHERE id = v_pid;

  RETURN jsonb_build_object(
    'resultado', CASE WHEN v_excede THEN 'excede' ELSE 'ok' END,
    'preliquidacion_id', v_pid,
    'restantes', p_plan->'restantes'
  );
EXCEPTION
  WHEN check_violation THEN
    RETURN jsonb_build_object('resultado', 'invalido', 'detalle', SQLERRM);
END;
$fn$ LANGUAGE plpgsql;

-- =============================================================================
-- CONJUNTO B: servicio, liquidación (congelamiento de la cabecera), costeo de sede
-- y transición genérica
-- =============================================================================

-- -----------------------------------------------------------------------------
-- carnes_preliq_actualizar_servicio(p_id, p_servicio, p_por, p_fecha_primer_ingreso,
--                                   p_corte, p_desbloqueo)
--
-- `p_corte` = corteBogota(fecha_primer_ingreso), calculado en JS (NULL si todavía no
-- hay primer ingreso). La fecha va como p_fecha_primer_ingreso: si cambió entre la
-- lectura y el bloqueo, `version_cambiada`.
--
-- Tardío (R5): `liquidada_at` ya puesto (sin importar la hora) o now() pasó el corte.
-- Solo un servicio NO tardío actualiza el snapshot `servicio_precorte`.
--
-- Desbloqueo de servicio_cero (T3, M3): `p_desbloqueo` viene de `desbloqueaServicioCero`
-- (JS). Bajo el lock se revalida con el MISMO criterio que `gastoTotal`: un precorte
-- <= 0 cuenta como no cargado y un predeterminado <= 0 como cero. Si vale, el servicio
-- también queda como `servicio_precorte` aunque sea tardío, para que la PRIMERA
-- liquidación lo aplique.
--
-- Resultados: ok | tardio | version_cambiada | no_encontrada | servicio_invalido
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- carnes_preliq_liquidar(p_id, p_version, p_corte, p_plan)
--
-- Congela la cabecera UNA vez. `p_plan` sale de `gastoTotal` (JS) sobre las filas leídas
-- con `version = p_version`: {servicio_aplicado, gasto_total, costo_por_animal, saldo_ids[]}.
-- Toma el mismo lock que el PATCH de servicio, así que si éste se coló primero la
-- versión cambió y JS relee y recalcula.
--
-- Orden de los chequeos: ya_liquidada -> antes_del_corte (reloj de la base) ->
-- version_cambiada (incluye el conjunto de saldos pendientes). Un `servicio_cero` se
-- decide en JS y nunca llega aquí.
--
-- Resultados: ok | ya_liquidada | antes_del_corte | version_cambiada | no_encontrada | no_liquidable
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- carnes_preliq_congelar_sede(p_sede_id, p_sede_version, p_orden_version, p_plan)
--
-- Escribe el costeo de UNA sede. Bloquea la cabecera y la sede; valida
-- `header.liquidada_at`, `header.orden_version = p_orden_version`,
-- `sede.version = p_sede_version` y `sede.estado = p_plan.desde`. Un `vincular`
-- concurrente sube `orden_version` y el plan viejo se rechaza.
--
-- p_plan (de montoSedes + costearSede + transicionSede):
--   desde, hacia, motivo_bloqueo?, detalle_bloqueo?,
--   gasto_sede?, utilidad?, servicio_compra?, valor_viceras?, valor_retomas?, costeo?,
--   items?: [{id, costo_ajustado, costo_total}], recepcion_costeado?: bool,
--   campos?: {intentos?, error_tipo?, motivo_pendiente?}   (limpiezas de la transición)
--
-- Precondición: una `bloqueada(excede_animales)` sin `liberada_at` nunca se costea
-- (`no_liberada`).
--
-- Resultados: ok | version_cambiada | no_liberada | no_encontrada | desde_invalido
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_congelar_sede(
  p_sede_id       BIGINT,
  p_sede_version  INTEGER,
  p_orden_version INTEGER,
  p_plan          JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_pid        BIGINT;
  v_header     carnes_preliquidaciones%ROWTYPE;
  v_sede       carnes_preliquidacion_sedes%ROWTYPE;
  v_hacia      TEXT;
  v_campos     JSONB;
  v_nueva      INTEGER;
BEGIN
  SELECT preliquidacion_id INTO v_pid FROM carnes_preliquidacion_sedes WHERE id = p_sede_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_sede FROM carnes_preliquidacion_sedes WHERE id = p_sede_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;

  IF NOT (p_plan->>'desde' IN (
    'vinculada', 'calculada', 'error', 'lista_para_enviar', 'anulada', 'simulada', 'bloqueada'
  )) THEN
    RETURN jsonb_build_object('resultado', 'desde_invalido');
  END IF;

  IF v_header.liquidada_at IS NULL
     OR v_header.orden_version <> p_orden_version
     OR v_sede.version <> p_sede_version
     OR v_sede.estado <> p_plan->>'desde'
  THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  IF v_sede.estado = 'bloqueada' AND v_sede.motivo_bloqueo = 'excede_animales' AND v_sede.liberada_at IS NULL THEN
    RETURN jsonb_build_object('resultado', 'no_liberada');
  END IF;

  v_hacia := p_plan->>'hacia';
  v_campos := COALESCE(p_plan->'campos', '{}'::jsonb);
  v_nueva := v_sede.version + 1;

  UPDATE carnes_preliquidacion_sedes
     SET estado = v_hacia,
         motivo_bloqueo = NULLIF(p_plan->>'motivo_bloqueo', ''),
         detalle_bloqueo = NULLIF(p_plan->>'detalle_bloqueo', ''),
         liberada_at = CASE WHEN v_hacia = 'bloqueada' THEN liberada_at ELSE NULL END,
         gasto_sede = CASE WHEN p_plan ? 'gasto_sede' THEN (p_plan->>'gasto_sede')::NUMERIC ELSE gasto_sede END,
         utilidad = CASE WHEN p_plan ? 'utilidad' THEN (p_plan->>'utilidad')::NUMERIC ELSE utilidad END,
         servicio_compra = CASE WHEN p_plan ? 'servicio_compra' THEN (p_plan->>'servicio_compra')::NUMERIC ELSE servicio_compra END,
         valor_viceras = CASE WHEN p_plan ? 'valor_viceras' THEN (p_plan->>'valor_viceras')::NUMERIC ELSE valor_viceras END,
         valor_retomas = CASE WHEN p_plan ? 'valor_retomas' THEN (p_plan->>'valor_retomas')::NUMERIC ELSE valor_retomas END,
         costeo = CASE WHEN p_plan ? 'costeo' THEN p_plan->'costeo' ELSE costeo END,
         intentos = CASE WHEN v_campos ? 'intentos' THEN (v_campos->>'intentos')::INTEGER ELSE intentos END,
         error_tipo = CASE WHEN v_campos ? 'error_tipo' THEN NULLIF(v_campos->>'error_tipo', '') ELSE error_tipo END,
         motivo_pendiente = CASE WHEN v_campos ? 'motivo_pendiente' THEN NULLIF(v_campos->>'motivo_pendiente', '') ELSE motivo_pendiente END,
         calculado_at = now(),
         costeo_orden_version = p_orden_version,
         costeo_animales = v_sede.animales,
         version = v_nueva
   WHERE id = p_sede_id;

  -- Costos por renglón de la recepción (los que se congelan y se envían).
  UPDATE carnes_recepcion_items it
     SET costo_ajustado = (i.valor->>'costo_ajustado')::NUMERIC,
         costo_total = (i.valor->>'costo_total')::NUMERIC
    FROM jsonb_array_elements(COALESCE(p_plan->'items', '[]'::jsonb)) AS i(valor)
   WHERE it.id = (i.valor->>'id')::BIGINT
     AND it.recepcion_id = v_sede.recepcion_id;

  IF COALESCE((p_plan->>'recepcion_costeado')::BOOLEAN, false) THEN
    UPDATE carnes_recepciones
       SET estado = 'Costeado', costeado_at = now()
     WHERE id = v_sede.recepcion_id AND estado = 'Aprobado';
  END IF;

  -- Resuelto o cambiado de estado: los avisos de versiones anteriores ya no aplican.
  DELETE FROM carnes_preliquidacion_alertas
   WHERE sede_id = p_sede_id AND enviado_ok = false AND ocurrencia < v_nueva;

  RETURN jsonb_build_object('resultado', 'ok', 'estado', v_hacia, 'sede_version', v_nueva);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_transicionar_sede(p_sede_id, p_sede_version, p_desde, p_hacia, p_campos)
--
-- Escritura CAS genérica del resultado de `transicionSede` (corregida, siesa_apagado,
-- anulacion_confirmada, correccion_descartada, ...). Valida `estado = p_desde` y
-- `version = p_sede_version`; solo escribe columnas de la lista permitida.
-- `p_campos.recepcion_estado` (opcional) mueve la recepción: solo a 'Costeado' o
-- 'Enviado_SIESA'.
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

-- Verificación: debe listar las diez funciones (conjuntos A y B).
SELECT proname
  FROM pg_proc
 WHERE proname IN (
   'carnes_preliq_validar_plan_sedes', 'carnes_preliq_aplicar_plan_sedes', 'carnes_preliq_crear',
   'carnes_preliq_vincular', 'carnes_preliq_desvincular', 'carnes_preliq_actualizar_novillos',
   'carnes_preliq_actualizar_servicio', 'carnes_preliq_liquidar', 'carnes_preliq_congelar_sede',
   'carnes_preliq_transicionar_sede'
 )
 ORDER BY proname;
