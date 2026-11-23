-- =============================================================================
-- Migration 041: RPC de servicio tardío, saldos y correcciones de la preliquidación (S3)
-- =============================================================================
--
-- Igual que sql/039 y sql/040, estas funciones NO deciden nada: bloquean, validan
-- versiones y precondiciones de estado, y escriben lo que JS ya calculó con las
-- funciones puras de src/shared (compararAlterna, planearSaldo, ...). No hay fórmulas
-- de negocio aquí (R8): una prueba estática (test/preliquidacion-rpc-correcciones.test.js)
-- lo verifica.
--
-- Parte A:
--   * carnes_preliq_registrar_alterna  alterna informativa idempotente + acción de saldo
--   * carnes_preliq_saldo_editar       edita el valor de un saldo pendiente
--   * carnes_preliq_saldo_descartar    descarta un saldo pendiente
--   * carnes_preliq_saldo_mover        mueve un saldo pendiente a otra preliquidación de la
--                                      misma especie (fila vieja `movido`, fila nueva pendiente)
-- Parte B:
--   * carnes_preliq_recalcular_no_enviadas  cambios de cabecera tras liquidar; marca las
--                                           sedes enviadas con requiere_correccion
--   * carnes_preliq_anular                  anula la preliquidación completa (nada enviado)
--
-- Contrato de retorno: JSONB `{resultado: ...}`; los resultados de negocio no son
-- excepciones. Orden de bloqueo: cabecera origen -> cabecera(s) destino (por id
-- ascendente) -> saldo. Toda escritura que toca un destino sube su `version`, porque el
-- gasto total de esa preliquidación suma sus saldos pendientes y `carnes_preliq_liquidar`
-- valida esa versión.
--
-- SECURITY INVOKER (por defecto). Idempotente: CREATE OR REPLACE. Todo o nada.
--
-- Orden de despliegue: 038 -> 039 -> 040 -> 041 -> backend con CARNES_PRELIQUIDACION apagado.
-- Reversión: sql/041_rollback.sql (antes de sql/040_rollback.sql y sql/038_039_rollback.sql).
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
-- carnes_preliq_registrar_alterna(p_id, p_servicio, p_servicio_at, p_por_sede, p_diferencia,
--                                 p_saldo_plan)
--
-- Registra la liquidación alterna INFORMATIVA de un servicio tardío (nunca va a SIESA) y
-- escribe la acción de saldo que decidió `planearSaldo` (C12). El servicio aplicado sale de
-- la cabecera (congelado en `carnes_preliq_liquidar`). Idempotente por
-- UNIQUE (preliquidacion_id, servicio_at): repetir la llamada devuelve `ya_registrada` sin
-- tocar el saldo.
--
-- p_saldo_plan: {accion: 'nada'|'actualizar_pendiente'|'crear_ajuste', por?,
--   actualizar_pendiente: saldo_id, valor, descartar?
--   crear_ajuste:         valor, ajuste_de_saldo_id?, destino_preliquidacion_id?}
--
-- Todo se valida ANTES de escribir; así un `version_cambiada` no deja la alterna a medias
-- (JS relee los saldos, vuelve a planear y reintenta).
--
-- Resultados: ok | ya_registrada | no_encontrada | no_liquidada | datos_invalidos |
--             saldo_invalido | destino_invalido | version_cambiada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_registrar_alterna(
  p_id           BIGINT,
  p_servicio     NUMERIC,
  p_servicio_at  TIMESTAMPTZ,
  p_por_sede     JSONB,
  p_diferencia   NUMERIC,
  p_saldo_plan   JSONB
) RETURNS JSONB AS $fn$
DECLARE
  v_header     carnes_preliquidaciones%ROWTYPE;
  v_dest       carnes_preliquidaciones%ROWTYPE;
  v_saldo      carnes_preliquidacion_saldos%ROWTYPE;
  v_alterna    BIGINT;
  v_accion     TEXT;
  v_destino_id BIGINT;
  v_saldo_id   BIGINT;
  v_valor      NUMERIC;
  v_por        TEXT;
BEGIN
  IF p_servicio IS NULL OR p_servicio_at IS NULL OR p_diferencia IS NULL THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos');
  END IF;

  v_accion := COALESCE(p_saldo_plan->>'accion', 'nada');
  IF v_accion NOT IN ('nada', 'actualizar_pendiente', 'crear_ajuste') THEN
    RETURN jsonb_build_object('resultado', 'saldo_invalido', 'motivo', 'accion');
  END IF;
  v_por := NULLIF(p_saldo_plan->>'por', '');

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_header.estado = 'anulada' THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  IF v_header.liquidada_at IS NULL THEN
    RETURN jsonb_build_object('resultado', 'no_liquidada');
  END IF;

  -- Idempotencia: ya hay alterna para ese servicio. No se toca el saldo.
  SELECT id INTO v_alterna
    FROM carnes_preliquidacion_alternas
   WHERE preliquidacion_id = p_id AND servicio_at = p_servicio_at;
  IF FOUND THEN
    RETURN jsonb_build_object('resultado', 'ya_registrada', 'alterna_id', v_alterna);
  END IF;

  -- Validación del saldo antes de escribir nada.
  IF v_accion = 'actualizar_pendiente' THEN
    v_saldo_id := NULLIF(p_saldo_plan->>'saldo_id', '')::BIGINT;
    v_valor := NULLIF(p_saldo_plan->>'valor', '')::NUMERIC;
    IF v_saldo_id IS NULL OR v_valor IS NULL THEN
      RETURN jsonb_build_object('resultado', 'saldo_invalido', 'motivo', 'datos');
    END IF;
    SELECT * INTO v_saldo
      FROM carnes_preliquidacion_saldos
     WHERE id = v_saldo_id AND origen_preliquidacion_id = p_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('resultado', 'saldo_invalido', 'motivo', 'saldo');
    END IF;
    v_destino_id := v_saldo.destino_preliquidacion_id;
  ELSIF v_accion = 'crear_ajuste' THEN
    v_valor := NULLIF(p_saldo_plan->>'valor', '')::NUMERIC;
    IF v_valor IS NULL THEN
      RETURN jsonb_build_object('resultado', 'saldo_invalido', 'motivo', 'datos');
    END IF;
    IF NULLIF(p_saldo_plan->>'ajuste_de_saldo_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM carnes_preliquidacion_saldos
       WHERE id = (p_saldo_plan->>'ajuste_de_saldo_id')::BIGINT AND origen_preliquidacion_id = p_id
    ) THEN
      RETURN jsonb_build_object('resultado', 'saldo_invalido', 'motivo', 'ajuste');
    END IF;
    v_destino_id := NULLIF(p_saldo_plan->>'destino_preliquidacion_id', '')::BIGINT;
  END IF;

  -- Destino: se bloquea antes del saldo (mismo orden en todas las funciones de saldo).
  IF v_destino_id IS NOT NULL THEN
    SELECT * INTO v_dest FROM carnes_preliquidaciones WHERE id = v_destino_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('resultado', 'destino_invalido');
    END IF;
    IF v_accion = 'crear_ajuste' AND (
      v_dest.estado <> 'abierta'
      OR v_dest.especie <> v_header.especie
      OR v_dest.liquidada_at IS NOT NULL
      OR v_dest.id = p_id
    ) THEN
      RETURN jsonb_build_object('resultado', 'destino_invalido');
    END IF;
  END IF;

  IF v_accion = 'actualizar_pendiente' THEN
    SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = v_saldo_id FOR UPDATE;
    IF v_saldo.estado <> 'pendiente' OR v_saldo.destino_preliquidacion_id IS DISTINCT FROM v_destino_id THEN
      RETURN jsonb_build_object('resultado', 'version_cambiada');
    END IF;
  END IF;

  INSERT INTO carnes_preliquidacion_alternas (
    preliquidacion_id, servicio_real, servicio_at, servicio_aplicado, por_sede, diferencia
  ) VALUES (
    p_id, p_servicio, p_servicio_at, v_header.servicio_aplicado, COALESCE(p_por_sede, '[]'::jsonb), p_diferencia
  )
  ON CONFLICT (preliquidacion_id, servicio_at) DO NOTHING
  RETURNING id INTO v_alterna;
  IF v_alterna IS NULL THEN
    RETURN jsonb_build_object('resultado', 'ya_registrada');
  END IF;

  IF v_accion = 'actualizar_pendiente' THEN
    UPDATE carnes_preliquidacion_saldos
       SET valor = v_valor,
           estado = CASE WHEN COALESCE((p_saldo_plan->>'descartar')::BOOLEAN, false) THEN 'descartado' ELSE estado END,
           alterna_id = v_alterna,
           editado_por = COALESCE(v_por, editado_por),
           updated_at = now()
     WHERE id = v_saldo_id;
  ELSIF v_accion = 'crear_ajuste' THEN
    INSERT INTO carnes_preliquidacion_saldos (
      origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado,
      ajuste_de_saldo_id, alterna_id, editado_por
    ) VALUES (
      p_id, v_header.especie, v_valor, v_destino_id, 'pendiente',
      NULLIF(p_saldo_plan->>'ajuste_de_saldo_id', '')::BIGINT, v_alterna, v_por
    )
    RETURNING id INTO v_saldo_id;
  END IF;

  IF v_accion <> 'nada' AND v_destino_id IS NOT NULL THEN
    UPDATE carnes_preliquidaciones SET version = version + 1 WHERE id = v_destino_id;
  END IF;

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'alterna_id', v_alterna,
    'saldo_accion', v_accion,
    'saldo_id', v_saldo_id
  );
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_saldo_editar(p_saldo_id, p_valor, p_por)
--
-- El encargado corrige el valor de un saldo PENDIENTE. Un saldo `aplicado` ya viajó en una
-- liquidación congelada y no se toca nunca. Sube la versión del destino (su gasto total
-- cambia).
--
-- Resultados: ok | sin_cambios | no_encontrada | no_pendiente | valor_invalido | version_cambiada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_saldo_editar(
  p_saldo_id  BIGINT,
  p_valor     NUMERIC,
  p_por       TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_saldo      carnes_preliquidacion_saldos%ROWTYPE;
  v_destino_id BIGINT;
BEGIN
  IF p_valor IS NULL THEN
    RETURN jsonb_build_object('resultado', 'valor_invalido');
  END IF;

  SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  v_destino_id := v_saldo.destino_preliquidacion_id;

  IF v_destino_id IS NOT NULL THEN
    PERFORM 1 FROM carnes_preliquidaciones WHERE id = v_destino_id FOR UPDATE;
  END IF;
  SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id FOR UPDATE;

  IF v_saldo.estado <> 'pendiente' THEN
    RETURN jsonb_build_object('resultado', 'no_pendiente');
  END IF;
  IF v_saldo.destino_preliquidacion_id IS DISTINCT FROM v_destino_id THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;
  IF v_saldo.valor = p_valor THEN
    RETURN jsonb_build_object('resultado', 'sin_cambios');
  END IF;

  UPDATE carnes_preliquidacion_saldos
     SET valor = p_valor, editado_por = COALESCE(NULLIF(p_por, ''), editado_por), updated_at = now()
   WHERE id = p_saldo_id;

  IF v_destino_id IS NOT NULL THEN
    UPDATE carnes_preliquidaciones SET version = version + 1 WHERE id = v_destino_id;
  END IF;

  RETURN jsonb_build_object('resultado', 'ok', 'saldo_id', p_saldo_id, 'destino_id', v_destino_id);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_saldo_descartar(p_saldo_id, p_por)
--
-- El encargado quita un saldo PENDIENTE: pasa a `descartado` y deja de sumar en el gasto
-- del destino. Sube la versión del destino.
--
-- Resultados: ok | no_encontrada | no_pendiente | version_cambiada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_saldo_descartar(
  p_saldo_id  BIGINT,
  p_por       TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_saldo      carnes_preliquidacion_saldos%ROWTYPE;
  v_destino_id BIGINT;
BEGIN
  SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  v_destino_id := v_saldo.destino_preliquidacion_id;

  IF v_destino_id IS NOT NULL THEN
    PERFORM 1 FROM carnes_preliquidaciones WHERE id = v_destino_id FOR UPDATE;
  END IF;
  SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id FOR UPDATE;

  IF v_saldo.estado <> 'pendiente' THEN
    RETURN jsonb_build_object('resultado', 'no_pendiente');
  END IF;
  IF v_saldo.destino_preliquidacion_id IS DISTINCT FROM v_destino_id THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  UPDATE carnes_preliquidacion_saldos
     SET estado = 'descartado', editado_por = COALESCE(NULLIF(p_por, ''), editado_por), updated_at = now()
   WHERE id = p_saldo_id;

  IF v_destino_id IS NOT NULL THEN
    UPDATE carnes_preliquidaciones SET version = version + 1 WHERE id = v_destino_id;
  END IF;

  RETURN jsonb_build_object('resultado', 'ok', 'saldo_id', p_saldo_id, 'destino_id', v_destino_id);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_saldo_mover(p_saldo_id, p_destino_id, p_por)
--
-- Mueve un saldo PENDIENTE a otra preliquidación abierta y sin liquidar de la MISMA
-- especie (E-S6: entre especies se rechaza). La fila vieja queda `movido` apuntando a la
-- nueva (`movido_a_saldo_id`) y la nueva nace `pendiente` con el mismo valor y origen. Sube
-- la versión del destino anterior y la del nuevo. Las cabeceras se bloquean por id
-- ascendente para evitar bloqueos cruzados entre dos movimientos opuestos.
--
-- Resultados: ok | sin_cambios | no_encontrada | no_pendiente | destino_invalido |
--             especie_distinta | destino_liquidada | version_cambiada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_saldo_mover(
  p_saldo_id    BIGINT,
  p_destino_id  BIGINT,
  p_por         TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_saldo     carnes_preliquidacion_saldos%ROWTYPE;
  v_dest      carnes_preliquidaciones%ROWTYPE;
  v_anterior  BIGINT;
  v_nuevo_id  BIGINT;
BEGIN
  IF p_destino_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'destino_invalido');
  END IF;

  SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  v_anterior := v_saldo.destino_preliquidacion_id;

  PERFORM 1 FROM carnes_preliquidaciones WHERE id IN (p_destino_id, v_anterior) ORDER BY id FOR UPDATE;
  SELECT * INTO v_saldo FROM carnes_preliquidacion_saldos WHERE id = p_saldo_id FOR UPDATE;

  IF v_saldo.estado <> 'pendiente' THEN
    RETURN jsonb_build_object('resultado', 'no_pendiente');
  END IF;
  IF v_saldo.destino_preliquidacion_id IS DISTINCT FROM v_anterior THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  SELECT * INTO v_dest FROM carnes_preliquidaciones WHERE id = p_destino_id;
  IF NOT FOUND OR v_dest.estado <> 'abierta' THEN
    RETURN jsonb_build_object('resultado', 'destino_invalido');
  END IF;
  IF v_dest.especie <> v_saldo.especie THEN
    RETURN jsonb_build_object('resultado', 'especie_distinta');
  END IF;
  IF v_dest.liquidada_at IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'destino_liquidada');
  END IF;
  IF v_anterior IS NOT DISTINCT FROM p_destino_id THEN
    RETURN jsonb_build_object('resultado', 'sin_cambios');
  END IF;

  INSERT INTO carnes_preliquidacion_saldos (
    origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado,
    ajuste_de_saldo_id, alterna_id, editado_por
  ) VALUES (
    v_saldo.origen_preliquidacion_id, v_saldo.especie, v_saldo.valor, p_destino_id, 'pendiente',
    v_saldo.ajuste_de_saldo_id, v_saldo.alterna_id, COALESCE(NULLIF(p_por, ''), v_saldo.editado_por)
  )
  RETURNING id INTO v_nuevo_id;

  UPDATE carnes_preliquidacion_saldos
     SET estado = 'movido',
         movido_a_saldo_id = v_nuevo_id,
         editado_por = COALESCE(NULLIF(p_por, ''), editado_por),
         updated_at = now()
   WHERE id = p_saldo_id;

  UPDATE carnes_preliquidaciones SET version = version + 1 WHERE id IN (p_destino_id, v_anterior);

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'saldo_id', v_nuevo_id,
    'saldo_anterior_id', p_saldo_id,
    'destino_id', p_destino_id,
    'destino_anterior_id', v_anterior
  );
END;
$fn$ LANGUAGE plpgsql;

-- =============================================================================
-- Parte B: recalcular no enviadas y anular la preliquidación
-- =============================================================================


-- -----------------------------------------------------------------------------
-- carnes_preliq_recalcular_no_enviadas(p_id, p_version, p_cambios, p_plan, p_por, p_motivo)
--
-- "Recalcular no enviadas": aplica cambios a la cabecera YA liquidada y prepara el
-- recosteo de las sedes que aún no salieron. JS decidió todo (gastoTotal, planearVinculacion);
-- aquí solo se bloquea, se valida la versión y se escribe.
--
-- p_cambios (puede ser '{}' = recosteo puro, T1): animales, animal_en_pie, servicio_por_animal,
--   tercero_id, gastos [{concepto, valor, signo}] (reemplaza la lista), retomas
--   [{vicera_item_id?, nombre, unidad, kilos, precio, precio_catalogo}] (reemplaza la lista).
--   Cualquier otra clave se rechaza (`cambios_invalidos`); con cambios el motivo es obligatorio.
-- p_plan: {orden_version (la que leyó JS), gasto_total?, servicio_aplicado?, costo_por_animal?,
--   reordenar / excede / liberadas (ver carnes_preliq_validar_plan_sedes), restantes}
--
-- Efectos: SIEMPRE sube `orden_version` (cambia el conjunto/orden de sedes o sus insumos de
-- costeo); sube `version` SOLO si hay cambios. Las sedes ya enviadas (enviando, enviada,
-- sin_confirmar) quedan con `requiere_correccion` y `correccion_orden_version` = la nueva
-- `orden_version` (M2): un envío con montos anteriores no limpia el aviso. Las sedes no
-- enviadas NO se recostean aquí: JS las recostea una a una con carnes_preliq_congelar_sede.
-- Devuelve las sedes marcadas con su nueva versión para que JS encole el aviso. `p_por` se
-- devuelve en la respuesta para el aviso; no hay columna de auditoría.
--
-- Resultados: ok | no_encontrada | no_abierta | no_liquidada | version_cambiada |
--             cambios_invalidos | motivo_requerido | datos_invalidos
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_recalcular_no_enviadas(
  p_id      BIGINT,
  p_version INTEGER,
  p_cambios JSONB,
  p_plan    JSONB,
  p_por     TEXT,
  p_motivo  TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_header      carnes_preliquidaciones%ROWTYPE;
  v_cambios     JSONB;
  v_hay_cambios BOOLEAN;
  v_clave       TEXT;
  v_invalido    TEXT;
  v_orden_nueva INTEGER;
  v_version     INTEGER;
  v_marcadas    JSONB;
BEGIN
  v_cambios := COALESCE(p_cambios, '{}'::jsonb);
  IF jsonb_typeof(v_cambios) <> 'object' THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos');
  END IF;
  FOR v_clave IN SELECT jsonb_object_keys(v_cambios) LOOP
    IF v_clave NOT IN ('animales', 'animal_en_pie', 'servicio_por_animal', 'tercero_id', 'gastos', 'retomas') THEN
      RETURN jsonb_build_object('resultado', 'cambios_invalidos', 'campo', v_clave);
    END IF;
  END LOOP;
  v_hay_cambios := v_cambios <> '{}'::jsonb;
  IF v_hay_cambios AND NULLIF(btrim(COALESCE(p_motivo, '')), '') IS NULL THEN
    RETURN jsonb_build_object('resultado', 'motivo_requerido');
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

  IF v_header.version <> p_version
     OR v_header.orden_version IS DISTINCT FROM NULLIF(p_plan->>'orden_version', '')::INTEGER
  THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  v_invalido := carnes_preliq_validar_plan_sedes(p_id, p_plan);
  IF v_invalido IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada', 'motivo', v_invalido);
  END IF;

  -- Orden de bloqueo: cabecera (ya tomada) -> sedes.
  PERFORM 1 FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id FOR UPDATE;

  UPDATE carnes_preliquidaciones
     SET animales = CASE WHEN v_cambios ? 'animales' THEN (v_cambios->>'animales')::INTEGER ELSE animales END,
         animal_en_pie = CASE WHEN v_cambios ? 'animal_en_pie' THEN (v_cambios->>'animal_en_pie')::NUMERIC ELSE animal_en_pie END,
         servicio_por_animal = CASE WHEN v_cambios ? 'servicio_por_animal' THEN (v_cambios->>'servicio_por_animal')::NUMERIC ELSE servicio_por_animal END,
         tercero_id = CASE WHEN v_cambios ? 'tercero_id' THEN COALESCE(NULLIF(v_cambios->>'tercero_id', ''), tercero_id) ELSE tercero_id END,
         servicio_aplicado = CASE WHEN p_plan ? 'servicio_aplicado' THEN (p_plan->>'servicio_aplicado')::NUMERIC ELSE servicio_aplicado END,
         gasto_total_aplicado = CASE WHEN p_plan ? 'gasto_total' THEN (p_plan->>'gasto_total')::NUMERIC ELSE gasto_total_aplicado END,
         costo_por_animal = CASE WHEN p_plan ? 'costo_por_animal' THEN (p_plan->>'costo_por_animal')::NUMERIC ELSE costo_por_animal END,
         version = CASE WHEN v_hay_cambios THEN version + 1 ELSE version END,
         orden_version = orden_version + 1
   WHERE id = p_id
  RETURNING orden_version, version INTO v_orden_nueva, v_version;

  IF v_cambios ? 'gastos' THEN
    DELETE FROM carnes_preliquidacion_gastos WHERE preliquidacion_id = p_id;
    INSERT INTO carnes_preliquidacion_gastos (preliquidacion_id, concepto, valor, signo, orden)
    SELECT p_id,
           g.valor->>'concepto',
           (g.valor->>'valor')::NUMERIC,
           COALESCE((g.valor->>'signo')::SMALLINT, 1),
           g.n::INTEGER
      FROM jsonb_array_elements(v_cambios->'gastos') WITH ORDINALITY AS g(valor, n);
  END IF;

  IF v_cambios ? 'retomas' THEN
    DELETE FROM carnes_preliquidacion_retomas WHERE preliquidacion_id = p_id;
    INSERT INTO carnes_preliquidacion_retomas (
      preliquidacion_id, vicera_item_id, nombre, unidad, kilos, precio, precio_catalogo, orden
    )
    SELECT p_id,
           NULLIF(r.valor->>'vicera_item_id', '')::BIGINT,
           r.valor->>'nombre',
           COALESCE(NULLIF(r.valor->>'unidad', ''), 'KL'),
           COALESCE(NULLIF(r.valor->>'kilos', '')::NUMERIC, 0),
           COALESCE(NULLIF(r.valor->>'precio', '')::NUMERIC, 0),
           COALESCE(NULLIF(r.valor->>'precio_catalogo', '')::NUMERIC, 0),
           r.n::INTEGER
      FROM jsonb_array_elements(v_cambios->'retomas') WITH ORDINALITY AS r(valor, n);
  END IF;

  PERFORM carnes_preliq_aplicar_plan_sedes(p_id, p_plan);

  -- Las sedes ya enviadas conservan sus montos: solo se marcan para revisión.
  WITH marcadas AS (
    UPDATE carnes_preliquidacion_sedes
       SET requiere_correccion = true,
           correccion_orden_version = v_orden_nueva,
           version = version + 1
     WHERE preliquidacion_id = p_id
       AND estado IN ('enviando', 'enviada', 'sin_confirmar')
    RETURNING id, version
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('sede_id', id, 'sede_version', version) ORDER BY id), '[]'::jsonb)
    INTO v_marcadas
    FROM marcadas;

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'version', v_version,
    'orden_version', v_orden_nueva,
    'sedes_marcadas', v_marcadas,
    'por', p_por
  );
EXCEPTION
  WHEN check_violation OR not_null_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos', 'detalle', SQLERRM);
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_anular(p_id, p_version, p_orden_version, p_por, p_motivo)  (R12)
--
-- Anula la preliquidación COMPLETA mientras no haya salido nada a SIESA. JS decide las
-- guardas y aquí se revalidan bajo el lock:
--   * estado = 'abierta';
--   * ninguna sede enviando/enviada/sin_confirmar/anulada, ningún envío vinculado
--     ok/enviando/sin_confirmar y ninguna recepción vinculada ya Enviado_SIESA;
--   * ningún saldo ORIGINADO por ella `aplicado` en otra preliquidación.
--
-- Efectos en una transacción: cabecera -> `anulada` (anulada_at/por, motivo); borra sus
-- sedes y desvincula cada recepción como `carnes_preliq_desvincular` (costos limpios,
-- Costeado -> Aprobado, preliquidacion_id NULL); los saldos que ELLA consumió
-- (aplicado) o tenía dirigidos (pendiente) vuelven a `pendiente` sin destino; sus propios
-- saldos pendientes pasan a `descartado` y suben la versión de su destino; borra los avisos
-- sin enviar. La anulada libera el índice parcial de "sin iniciar".
--
-- Resultados: ok | no_anulable(motivo) | version_cambiada | no_encontrada | motivo_requerido
--   motivos de no_anulable: no_abierta | sede_enviada | saldo_aplicado
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_anular(
  p_id            BIGINT,
  p_version       INTEGER,
  p_orden_version INTEGER,
  p_por           TEXT,
  p_motivo        TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_header      carnes_preliquidaciones%ROWTYPE;
  v_recepciones JSONB;
  v_destinos    BIGINT[];
  v_sedes       INTEGER;
BEGIN
  IF NULLIF(btrim(COALESCE(p_motivo, '')), '') IS NULL THEN
    RETURN jsonb_build_object('resultado', 'motivo_requerido');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  IF v_header.estado <> 'abierta' THEN
    RETURN jsonb_build_object('resultado', 'no_anulable', 'motivo', 'no_abierta');
  END IF;

  PERFORM 1 FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM carnes_preliquidacion_sedes s
     WHERE s.preliquidacion_id = p_id
       AND (
         s.estado IN ('enviando', 'enviada', 'sin_confirmar', 'anulada')
         OR (
           s.envio_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM carnes_siesa_envios e
              WHERE e.id = s.envio_id AND e.estado IN ('ok', 'enviando', 'sin_confirmar')
           )
         )
         OR EXISTS (
           SELECT 1 FROM carnes_recepciones r WHERE r.id = s.recepcion_id AND r.estado = 'Enviado_SIESA'
         )
       )
  ) THEN
    RETURN jsonb_build_object('resultado', 'no_anulable', 'motivo', 'sede_enviada');
  END IF;

  IF EXISTS (
    SELECT 1 FROM carnes_preliquidacion_saldos
     WHERE origen_preliquidacion_id = p_id AND estado = 'aplicado'
  ) THEN
    RETURN jsonb_build_object('resultado', 'no_anulable', 'motivo', 'saldo_aplicado');
  END IF;

  IF v_header.version <> p_version OR v_header.orden_version <> p_orden_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  -- Cabeceras destino de sus saldos pendientes, por id ascendente (sin bloqueos cruzados).
  SELECT COALESCE(array_agg(DISTINCT destino_preliquidacion_id), '{}'::BIGINT[]) INTO v_destinos
    FROM carnes_preliquidacion_saldos
   WHERE origen_preliquidacion_id = p_id AND estado = 'pendiente' AND destino_preliquidacion_id IS NOT NULL;
  PERFORM 1 FROM carnes_preliquidaciones WHERE id = ANY (v_destinos) ORDER BY id FOR UPDATE;

  SELECT COALESCE(jsonb_agg(recepcion_id ORDER BY recepcion_id), '[]'::jsonb) INTO v_recepciones
    FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id;

  -- Desvincular las recepciones al flujo legado (igual que carnes_preliq_desvincular).
  UPDATE carnes_recepcion_items
     SET costo_ajustado = NULL, costo_total = NULL
   WHERE recepcion_id IN (SELECT recepcion_id FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id);
  UPDATE carnes_recepciones
     SET estado = 'Aprobado', costeado_at = NULL
   WHERE id IN (SELECT recepcion_id FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id)
     AND estado = 'Costeado';
  UPDATE carnes_recepciones
     SET preliquidacion_id = NULL
   WHERE id IN (SELECT recepcion_id FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id);

  DELETE FROM carnes_preliquidacion_alertas
   WHERE enviado_ok = false
     AND (preliquidacion_id = p_id OR sede_id IN (SELECT id FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id));
  DELETE FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = p_id;
  GET DIAGNOSTICS v_sedes = ROW_COUNT;

  -- Saldos que consumió o tenía dirigidos: vuelven a esperar una preliquidación de su especie.
  UPDATE carnes_preliquidacion_saldos
     SET estado = 'pendiente', destino_preliquidacion_id = NULL, updated_at = now()
   WHERE destino_preliquidacion_id = p_id AND estado IN ('aplicado', 'pendiente');

  -- Sus propios saldos pendientes ya no tienen sentido; el destino cambia su gasto total.
  UPDATE carnes_preliquidacion_saldos
     SET estado = 'descartado', editado_por = COALESCE(NULLIF(p_por, ''), editado_por), updated_at = now()
   WHERE origen_preliquidacion_id = p_id AND estado = 'pendiente';
  UPDATE carnes_preliquidaciones SET version = version + 1 WHERE id = ANY (v_destinos);

  UPDATE carnes_preliquidaciones
     SET estado = 'anulada',
         anulada_at = now(),
         anulada_por = NULLIF(p_por, ''),
         motivo_anulacion = btrim(p_motivo),
         version = version + 1,
         orden_version = orden_version + 1
   WHERE id = p_id;

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'preliquidacion_id', p_id,
    'sedes_desvinculadas', v_sedes,
    'recepciones', v_recepciones
  );
END;
$fn$ LANGUAGE plpgsql;

COMMIT;

-- Verificación: deben aparecer las seis funciones de 041.
SELECT proname
  FROM pg_proc
 WHERE proname IN (
   'carnes_preliq_registrar_alterna', 'carnes_preliq_saldo_editar',
   'carnes_preliq_saldo_descartar', 'carnes_preliq_saldo_mover',
   'carnes_preliq_recalcular_no_enviadas', 'carnes_preliq_anular'
 )
 ORDER BY proname;
