-- =============================================================================
-- Verificación MANUAL de la obsolescencia de alertas (4.3, R4)
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038, 039, 040 y 041 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-alertas-wiring.test.js).
-- No llama a SIESA ni envía correo: solo ejercita funciones SQL sobre la tabla de alertas.
-- Todo corre dentro de una transacción con ROLLBACK, así que no deja datos.
--
-- Qué verifica (diseño, "Alert dedupe", obsolescencia):
--   * vincular            borra sin_preliquidacion / fuera_ventana / oficial_legacy sin enviar de la recepción.
--   * transicionar_sede   borra las alertas sin enviar de la sede con ocurrencia < versión nueva
--                         (conserva las ya enviadas y las de la versión nueva).
--   * congelar_sede       ídem.
--   * reclamar_sede       ídem, y conserva requiere_correccion mientras la sede lo siga requiriendo.
--   * cerrar_envio        ídem.
--   * liquidar            borra corrida_perdida y servicio_cero sin enviar de la preliquidación.
--   * cerrar              borra TODAS las alertas sin enviar de la preliquidación (la enviada se conserva).
--   * anular              borra todas las sin enviar de la preliquidación y de sus sedes.
--
-- Necesita una recepción de res sin vincular con novillos enteros > 0. Los pasos de reclamar y
-- cerrar_envio necesitan además un envío INICIAL `ok` de esa recepción (compuerta C4); si no
-- existe, esos pasos se omiten con un aviso.
-- =============================================================================

BEGIN;

CREATE FUNCTION pg_temp.sembrar(p_evento TEXT, p_pre BIGINT, p_sede BIGINT, p_ocu BIGINT, p_enviado BOOLEAN)
RETURNS VOID AS $f$
  INSERT INTO carnes_preliquidacion_alertas (evento, preliquidacion_id, sede_id, ocurrencia, enviado_ok)
  VALUES (p_evento, p_pre, p_sede, p_ocu, p_enviado);
$f$ LANGUAGE sql;

CREATE FUNCTION pg_temp.existe(p_evento TEXT, p_pre BIGINT, p_sede BIGINT, p_ocu BIGINT)
RETURNS BOOLEAN AS $f$
  SELECT EXISTS (
    SELECT 1 FROM carnes_preliquidacion_alertas
     WHERE evento = p_evento AND preliquidacion_id = p_pre AND sede_id = p_sede AND ocurrencia = p_ocu
  );
$f$ LANGUAGE sql;

DO $$
DECLARE
  pre     BIGINT;
  pre_liq BIGINT;
  pre_cer BIGINT;
  rec     BIGINT;
  fecha   DATE;
  sede    BIGINT;
  ver     INTEGER;
  ov      INTEGER;
  hv      INTEGER;
  tok     UUID := gen_random_uuid();
  corrida BIGINT;
  con_inicial BOOLEAN;
  r       JSONB;
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie IN ('res', 'cerdo');
  r := carnes_preliq_crear('res', '{"animales": 50, "animal_en_pie": 5000000}'::jsonb);
  pre := (r->>'preliquidacion_id')::BIGINT;
  IF pre IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de prueba: %', r; END IF;

  SELECT r2.id, r2.fecha_ingreso INTO rec, fecha
    FROM carnes_recepciones r2
   WHERE r2.especie = 'res' AND r2.preliquidacion_id IS NULL AND r2.liquidacion_id IS NULL
     AND r2.novillos > 0 AND r2.novillos = trunc(r2.novillos)
   ORDER BY (EXISTS (SELECT 1 FROM carnes_siesa_envios e WHERE e.recepcion_id = r2.id AND e.tipo = 'inicial' AND e.estado = 'ok')) DESC, r2.id
   LIMIT 1;
  IF rec IS NULL THEN
    RAISE NOTICE 'Sin recepción de res vinculable: se omite el script';
    RETURN;
  END IF;
  con_inicial := EXISTS (SELECT 1 FROM carnes_siesa_envios e WHERE e.recepcion_id = rec AND e.tipo = 'inicial' AND e.estado = 'ok');

  -- ── vincular: borra los avisos sin enviar de la recepción (y solo los de esa recepción) ──
  PERFORM pg_temp.sembrar('sin_preliquidacion', 0, 0, rec, false);
  PERFORM pg_temp.sembrar('fuera_ventana', 0, 0, rec, false);
  PERFORM pg_temp.sembrar('oficial_legacy', 0, 0, rec, true);          -- ya enviada: se conserva
  PERFORM pg_temp.sembrar('sin_preliquidacion', 0, 0, rec + 100000, false); -- otra recepción: se conserva

  SELECT orden_version INTO ov FROM carnes_preliquidaciones WHERE id = pre;
  r := carnes_preliq_vincular(
    rec, pre, ov,
    jsonb_build_object(
      'fecha_primer_ingreso', fecha,
      'ventana_fin', ((fecha + 2)::timestamp AT TIME ZONE 'America/Bogota') - interval '1 millisecond',
      'mueve_fecha', false,
      'candidata', jsonb_build_object('animales', (SELECT novillos::int FROM carnes_recepciones WHERE id = rec), 'orden', 1, 'estado', 'vinculada'),
      'restantes', 0
    )
  );
  IF r->>'resultado' <> 'vinculada' THEN RAISE EXCEPTION 'no se pudo vincular la sede de prueba: %', r; END IF;
  IF pg_temp.existe('sin_preliquidacion', 0, 0, rec) THEN RAISE EXCEPTION 'vincular no borró sin_preliquidacion de la recepción'; END IF;
  IF pg_temp.existe('fuera_ventana', 0, 0, rec) THEN RAISE EXCEPTION 'vincular no borró fuera_ventana de la recepción'; END IF;
  IF NOT pg_temp.existe('oficial_legacy', 0, 0, rec) THEN RAISE EXCEPTION 'vincular borró una alerta ya enviada'; END IF;
  IF NOT pg_temp.existe('sin_preliquidacion', 0, 0, rec + 100000) THEN RAISE EXCEPTION 'vincular borró la alerta de OTRA recepción'; END IF;

  SELECT id, version INTO sede, ver FROM carnes_preliquidacion_sedes WHERE recepcion_id = rec;

  -- ── transicionar_sede: borra sin enviar con ocurrencia < versión nueva; conserva enviadas y la nueva ──
  PERFORM pg_temp.sembrar('costeo_invalido', pre, sede, ver, false);       -- obsoleta
  PERFORM pg_temp.sembrar('armado_invalido', pre, sede, ver, true);        -- enviada: se conserva
  PERFORM pg_temp.sembrar('excede_animales', pre, sede, ver + 1, false);   -- ocurrencia = versión nueva: se conserva
  r := carnes_preliq_transicionar_sede(
    sede, ver, 'vinculada', 'bloqueada',
    '{"motivo_bloqueo":"costeo_invalido","detalle_bloqueo":"prueba"}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'transicionar_sede debía ser ok: %', r; END IF;
  IF pg_temp.existe('costeo_invalido', pre, sede, ver) THEN RAISE EXCEPTION 'transicionar_sede no borró la alerta obsoleta'; END IF;
  IF NOT pg_temp.existe('armado_invalido', pre, sede, ver) THEN RAISE EXCEPTION 'transicionar_sede borró una alerta ya enviada'; END IF;
  IF NOT pg_temp.existe('excede_animales', pre, sede, ver + 1) THEN RAISE EXCEPTION 'transicionar_sede borró la alerta de la versión nueva'; END IF;
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;

  -- ── congelar_sede: costea la sede (bloqueada -> calculada) y borra las obsoletas ──
  UPDATE carnes_preliquidaciones SET liquidada_at = now() WHERE id = pre;
  SELECT orden_version INTO ov FROM carnes_preliquidaciones WHERE id = pre;
  PERFORM pg_temp.sembrar('utilidad_negativa', pre, sede, ver, false);     -- obsoleta tras congelar
  r := carnes_preliq_congelar_sede(
    sede, ver, ov,
    '{"desde":"bloqueada","hacia":"calculada","gasto_sede":"1000.00","utilidad":"10.00","servicio_compra":"5.00"}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'congelar_sede debía ser ok: %', r; END IF;
  IF pg_temp.existe('utilidad_negativa', pre, sede, ver) THEN RAISE EXCEPTION 'congelar_sede no borró la alerta obsoleta'; END IF;
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;

  -- ── reclamar_sede y cerrar_envio (necesitan la inicial ok) ──
  IF con_inicial THEN
    INSERT INTO carnes_preliquidacion_corridas (origen) VALUES ('schedule') RETURNING id INTO corrida;

    UPDATE carnes_preliquidacion_sedes SET requiere_correccion = true WHERE id = sede;
    PERFORM pg_temp.sembrar('envio_error', pre, sede, ver, false);              -- obsoleta
    PERFORM pg_temp.sembrar('requiere_correccion', pre, sede, ver, false);      -- se conserva mientras el flag siga
    r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', tok, corrida, 'admin', false);
    IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'reclamar_sede debía ser ok: %', r; END IF;
    IF pg_temp.existe('envio_error', pre, sede, ver) THEN RAISE EXCEPTION 'reclamar_sede no borró la alerta obsoleta'; END IF;
    IF NOT pg_temp.existe('requiere_correccion', pre, sede, ver) THEN
      RAISE EXCEPTION 'reclamar_sede borró requiere_correccion con la sede aún marcada';
    END IF;
    SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;

    PERFORM pg_temp.sembrar('sin_confirmar', pre, sede, ver, false);            -- obsoleta tras cerrar el envío
    r := carnes_preliq_cerrar_envio(sede, tok, '{"hacia":"error","campos":{"error_tipo":"transitorio"}}'::jsonb);
    IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'cerrar_envio debía ser ok: %', r; END IF;
    IF pg_temp.existe('sin_confirmar', pre, sede, ver) THEN RAISE EXCEPTION 'cerrar_envio no borró la alerta obsoleta'; END IF;
    IF NOT pg_temp.existe('requiere_correccion', pre, sede, ver - 1) THEN
      RAISE EXCEPTION 'cerrar_envio borró requiere_correccion con la sede aún marcada';
    END IF;
    SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  ELSE
    RAISE NOTICE 'Sin recepción con inicial ok: se omiten reclamar_sede y cerrar_envio';
  END IF;

  -- ── liquidar: borra corrida_perdida y servicio_cero sin enviar; conserva el resto ──
  r := carnes_preliq_crear('cerdo', '{"animales": 5, "animal_en_pie": 1000000}'::jsonb);
  pre_liq := (r->>'preliquidacion_id')::BIGINT;
  IF pre_liq IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de cerdo: %', r; END IF;
  PERFORM pg_temp.sembrar('corrida_perdida', pre_liq, 0, 0, false);
  PERFORM pg_temp.sembrar('servicio_cero', pre_liq, 0, 1, false);
  PERFORM pg_temp.sembrar('ventana_vencida', pre_liq, 0, 0, false);        -- otra alerta: se conserva
  SELECT version INTO hv FROM carnes_preliquidaciones WHERE id = pre_liq;
  r := carnes_preliq_liquidar(
    pre_liq, hv, now() - interval '1 day',
    '{"servicio_aplicado":"5000.00","gasto_total":"1005000.00","costo_por_animal":"201000.00","saldo_ids":[]}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'liquidar debía ser ok: %', r; END IF;
  IF pg_temp.existe('corrida_perdida', pre_liq, 0, 0) THEN RAISE EXCEPTION 'liquidar no borró corrida_perdida'; END IF;
  IF pg_temp.existe('servicio_cero', pre_liq, 0, 1) THEN RAISE EXCEPTION 'liquidar no borró servicio_cero'; END IF;
  IF NOT pg_temp.existe('ventana_vencida', pre_liq, 0, 0) THEN RAISE EXCEPTION 'liquidar borró una alerta que no le corresponde'; END IF;

  -- ── cerrar: borra TODAS las alertas sin enviar de la preliquidación; la enviada se conserva ──
  PERFORM pg_temp.sembrar('cerrada', pre_liq, 0, 0, true);
  PERFORM pg_temp.sembrar('envio_error', pre_liq, 77, 3, false);
  SELECT orden_version INTO ov FROM carnes_preliquidaciones WHERE id = pre_liq;
  r := carnes_preliq_cerrar(pre_liq, ov, 0);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'cerrar debía ser ok: %', r; END IF;
  IF pg_temp.existe('ventana_vencida', pre_liq, 0, 0) THEN RAISE EXCEPTION 'cerrar no borró ventana_vencida sin enviar'; END IF;
  IF pg_temp.existe('envio_error', pre_liq, 77, 3) THEN RAISE EXCEPTION 'cerrar no borró envio_error sin enviar'; END IF;
  IF NOT pg_temp.existe('cerrada', pre_liq, 0, 0) THEN RAISE EXCEPTION 'cerrar borró una alerta ya enviada'; END IF;

  -- Un cierre RECHAZADO no puede borrar nada (la guarda va antes del borrado).
  r := carnes_preliq_crear('cerdo', '{"animales": 5, "animal_en_pie": 1000000}'::jsonb);
  pre_cer := (r->>'preliquidacion_id')::BIGINT;
  PERFORM pg_temp.sembrar('corrida_perdida', pre_cer, 0, 0, false);
  r := carnes_preliq_cerrar(pre_cer, 0, 0);   -- sin liquidar: no_liquidada
  IF r->>'resultado' = 'ok' THEN RAISE EXCEPTION 'cerrar sin liquidar debía rechazarse'; END IF;
  IF NOT pg_temp.existe('corrida_perdida', pre_cer, 0, 0) THEN RAISE EXCEPTION 'un cierre rechazado borró alertas'; END IF;

  -- ── anular: borra todas las sin enviar de la preliquidación y de sus sedes ──
  PERFORM pg_temp.sembrar('ventana_vencida', pre, 0, 0, false);
  PERFORM pg_temp.sembrar('envio_en_vuelo', pre, sede, ver + 50, false);
  PERFORM pg_temp.sembrar('cerrada', pre, 0, 0, true);                     -- enviada: se conserva
  SELECT version, orden_version INTO hv, ov FROM carnes_preliquidaciones WHERE id = pre;
  r := carnes_preliq_anular(pre, hv, ov, 'qa', 'prueba de obsolescencia');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'anular debía ser ok: %', r; END IF;
  IF pg_temp.existe('ventana_vencida', pre, 0, 0) THEN RAISE EXCEPTION 'anular no borró la alerta de la preliquidación'; END IF;
  IF pg_temp.existe('envio_en_vuelo', pre, sede, ver + 50) THEN RAISE EXCEPTION 'anular no borró la alerta de la sede'; END IF;
  IF NOT pg_temp.existe('cerrada', pre, 0, 0) THEN RAISE EXCEPTION 'anular borró una alerta ya enviada'; END IF;

  RAISE NOTICE 'alertas_obsolescencia: OK';
END
$$;

ROLLBACK;
