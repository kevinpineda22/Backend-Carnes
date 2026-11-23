-- =============================================================================
-- Verificación MANUAL de sql/041 (parte B): recalcular_no_enviadas y anular
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038, 039, 040 y 041 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-rpc-correcciones.test.js).
-- No llama a SIESA: solo ejercita funciones SQL. Todo corre dentro de una transacción con
-- ROLLBACK, así que no deja datos.
--
-- Necesita una recepción de res sin vincular y con novillos enteros > 0. Si no existe, el
-- bloque lo avisa y se omite.
--
-- Cubre: recalcular (guardas de versión, claves permitidas, motivo, recosteo puro que solo sube
-- orden_version, marcado de sedes enviadas, cambios con gastos, datos inválidos sin escritura
-- parcial) y anular (guardas: sede enviada, saldo aplicado, versión; efectos: recepción vuelve
-- al flujo legado, saldos consumidos vuelven a pendiente, saldos propios descartados, avisos
-- sin enviar borrados, índice de "sin iniciar" liberado).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  pre     BIGINT;
  cerdo1  BIGINT;
  rec     BIGINT;
  fecha   DATE;
  sede    BIGINT;
  ver     INTEGER;
  ov      INTEGER;
  hv      INTEGER;
  r       JSONB;
  saldo_c BIGINT;
  saldo_p BIGINT;
  saldo_a BIGINT;
  alt     BIGINT;
  alt2    BIGINT;
  sa_orig NUMERIC;
  v_cerdo INTEGER;
  res2    BIGINT;
  v_res2  INTEGER;
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie IN ('res', 'cerdo');
  r := carnes_preliq_crear('res', '{"animales": 50, "animal_en_pie": 5000000}'::jsonb);
  pre := (r->>'preliquidacion_id')::BIGINT;
  IF pre IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de prueba: %', r; END IF;
  r := carnes_preliq_crear('cerdo', '{"animales": 5, "animal_en_pie": 1000000}'::jsonb);
  cerdo1 := (r->>'preliquidacion_id')::BIGINT;
  IF cerdo1 IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de cerdo: %', r; END IF;

  SELECT r2.id, r2.fecha_ingreso INTO rec, fecha
    FROM carnes_recepciones r2
   WHERE r2.especie = 'res' AND r2.preliquidacion_id IS NULL AND r2.liquidacion_id IS NULL
     AND r2.novillos > 0 AND r2.novillos = trunc(r2.novillos)
   ORDER BY r2.id LIMIT 1;
  IF rec IS NULL THEN
    RAISE NOTICE 'Sin recepción de res vinculable: se omite el bloque';
    RETURN;
  END IF;

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
  SELECT id INTO sede FROM carnes_preliquidacion_sedes WHERE recepcion_id = rec;

  -- ── recalcular: sin liquidar -> no_liquidada ──
  SELECT version, orden_version INTO hv, ov FROM carnes_preliquidaciones WHERE id = pre;
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', NULL);
  IF r->>'resultado' <> 'no_liquidada' THEN RAISE EXCEPTION 'sin liquidar debía ser no_liquidada: %', r; END IF;

  UPDATE carnes_preliquidaciones
     SET liquidada_at = now(), servicio_aplicado = 50000, gasto_total_aplicado = 5050000, costo_por_animal = 101000
   WHERE id = pre;
  r := carnes_preliq_congelar_sede(
    sede, (SELECT version FROM carnes_preliquidacion_sedes WHERE id = sede), ov,
    '{"desde":"vinculada","hacia":"calculada","gasto_sede":"1000.00","utilidad":"10.00","servicio_compra":"5.00"}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'congelar debía ser ok: %', r; END IF;
  SELECT version, orden_version INTO hv, ov FROM carnes_preliquidaciones WHERE id = pre;

  -- Versión de cabecera u orden distinta de la leída -> version_cambiada.
  r := carnes_preliq_recalcular_no_enviadas(pre, hv - 1, '{}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', NULL);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'version vieja debía ser version_cambiada: %', r; END IF;
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{}'::jsonb, jsonb_build_object('orden_version', ov - 1), 'qa', NULL);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'orden_version vieja debía ser version_cambiada: %', r; END IF;
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{}'::jsonb, '{}'::jsonb, 'qa', NULL);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'plan sin orden_version debía ser version_cambiada: %', r; END IF;

  -- Clave no permitida y cambios sin motivo.
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{"liquidada_at":"2020-01-01"}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', 'x');
  IF r->>'resultado' <> 'cambios_invalidos' THEN RAISE EXCEPTION 'clave ajena debía ser cambios_invalidos: %', r; END IF;
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{"animal_en_pie": 1}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', '  ');
  IF r->>'resultado' <> 'motivo_requerido' THEN RAISE EXCEPTION 'cambios sin motivo debía ser motivo_requerido: %', r; END IF;

  -- Datos inválidos (animales = 0): sin escritura parcial.
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{"animales": 0}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', 'prueba');
  IF r->>'resultado' <> 'datos_invalidos' THEN RAISE EXCEPTION 'animales 0 debía ser datos_invalidos: %', r; END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = pre) <> hv
     OR (SELECT orden_version FROM carnes_preliquidaciones WHERE id = pre) <> ov THEN
    RAISE EXCEPTION 'datos_invalidos no debía dejar escrituras';
  END IF;

  -- Recosteo puro (T1): sin sedes enviadas solo sube orden_version.
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', NULL);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'recosteo puro debía ser ok: %', r; END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = pre) <> hv THEN RAISE EXCEPTION 'recosteo puro no debía subir version'; END IF;
  IF (SELECT orden_version FROM carnes_preliquidaciones WHERE id = pre) <> ov + 1 THEN RAISE EXCEPTION 'recosteo puro debía subir orden_version'; END IF;
  IF jsonb_array_length(r->'sedes_marcadas') <> 0 THEN RAISE EXCEPTION 'sin sedes enviadas no debía marcar ninguna'; END IF;
  ov := ov + 1;
  -- La sede no enviada no se tocó (la recostea JS con congelar).
  IF (SELECT estado FROM carnes_preliquidacion_sedes WHERE id = sede) <> 'calculada'
     OR (SELECT requiere_correccion FROM carnes_preliquidacion_sedes WHERE id = sede) THEN
    RAISE EXCEPTION 'una sede no enviada no debía cambiar';
  END IF;

  -- Servicio aplicado distinto con un saldo vigente de una alterna -> saldo_alterna_vigente, sin escribir.
  INSERT INTO carnes_preliquidacion_alternas (preliquidacion_id, servicio_real, servicio_at, servicio_aplicado, diferencia)
  VALUES (pre, 700000, now(), 50000, 650000) RETURNING id INTO alt;
  INSERT INTO carnes_preliquidacion_saldos (origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado, alterna_id)
  VALUES (pre, 'res', 650000, NULL, 'pendiente', alt) RETURNING id INTO saldo_a;
  r := carnes_preliq_recalcular_no_enviadas(
    pre, hv, '{"servicio_por_animal": 2000}'::jsonb,
    jsonb_build_object('orden_version', ov, 'gasto_total', '5100000.00', 'servicio_aplicado', '100000.00', 'costo_por_animal', '102000.00'),
    'qa', 'cambio de servicio'
  );
  IF r->>'resultado' <> 'saldo_alterna_vigente' THEN RAISE EXCEPTION 'servicio aplicado distinto debía ser saldo_alterna_vigente: %', r; END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = pre) <> hv THEN RAISE EXCEPTION 'saldo_alterna_vigente no debía escribir'; END IF;
  -- Con el saldo descartado ya no estorba; con otro valor de servicio igual al aplicado tampoco.
  UPDATE carnes_preliquidacion_saldos SET estado = 'descartado' WHERE id = saldo_a;
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', NULL);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'recosteo puro debía ser ok: %', r; END IF;
  ov := ov + 1;
  DELETE FROM carnes_preliquidacion_saldos WHERE id = saldo_a;
  DELETE FROM carnes_preliquidacion_alternas WHERE id = alt;

  -- Solo saldos aplicados (el dinero ya entró a otra preliquidación): no bloquea, avisa que no se recomputó.
  SELECT servicio_aplicado INTO sa_orig FROM carnes_preliquidaciones WHERE id = pre;
  INSERT INTO carnes_preliquidacion_alternas (preliquidacion_id, servicio_real, servicio_at, servicio_aplicado, diferencia)
  VALUES (pre, 700000, now() + interval '1 minute', 50000, 650000) RETURNING id INTO alt2;
  INSERT INTO carnes_preliquidacion_saldos (origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado, alterna_id)
  VALUES (pre, 'res', 650000, cerdo1, 'aplicado', alt2) RETURNING id INTO saldo_a;
  r := carnes_preliq_recalcular_no_enviadas(
    pre, hv, '{}'::jsonb,
    jsonb_build_object('orden_version', ov, 'gasto_total', '5100000.00', 'servicio_aplicado', '100000.00', 'costo_por_animal', '102000.00'),
    'qa', NULL
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'solo saldos aplicados debía permitir el recálculo: %', r; END IF;
  IF r->>'aviso' IS DISTINCT FROM 'saldo_alterna_aplicado' THEN RAISE EXCEPTION 'solo saldos aplicados debía avisar saldo_alterna_aplicado: %', r; END IF;
  ov := ov + 1;
  UPDATE carnes_preliquidaciones SET servicio_aplicado = sa_orig WHERE id = pre;

  -- Un pendiente que compensa al aplicado (neto cero): no bloquea ni avisa.
  INSERT INTO carnes_preliquidacion_saldos (origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado, alterna_id)
  VALUES (pre, 'res', -650000, NULL, 'pendiente', alt2);
  r := carnes_preliq_recalcular_no_enviadas(
    pre, hv, '{}'::jsonb,
    jsonb_build_object('orden_version', ov, 'gasto_total', '5100000.00', 'servicio_aplicado', '100000.00', 'costo_por_animal', '102000.00'),
    'qa', NULL
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'neto cero debía permitir el recálculo: %', r; END IF;
  IF r->>'aviso' IS NOT NULL THEN RAISE EXCEPTION 'neto cero no debía avisar: %', r; END IF;
  ov := ov + 1;
  UPDATE carnes_preliquidaciones SET servicio_aplicado = sa_orig WHERE id = pre;
  DELETE FROM carnes_preliquidacion_saldos WHERE origen_preliquidacion_id = pre AND alterna_id = alt2;
  DELETE FROM carnes_preliquidacion_alternas WHERE id = alt2;

  -- Con la sede ya enviada: cambios reales (gastos) -> version + 1, sede marcada con la nueva orden_version.
  UPDATE carnes_preliquidacion_sedes SET estado = 'enviada' WHERE id = sede;
  r := carnes_preliq_recalcular_no_enviadas(
    pre, hv,
    '{"animal_en_pie": 6000000, "gastos": [{"concepto":"Flete","valor":"150000.00","signo":1},{"concepto":"Descuento","valor":"50000.00","signo":-1}]}'::jsonb,
    jsonb_build_object('orden_version', ov, 'gasto_total', '6150000.00', 'servicio_aplicado', '50000.00', 'costo_por_animal', '123000.00'),
    'qa', 'cambio de precio del animal en pie'
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'recalcular con cambios debía ser ok: %', r; END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = pre) <> hv + 1 THEN RAISE EXCEPTION 'con cambios debía subir version'; END IF;
  IF (SELECT animal_en_pie FROM carnes_preliquidaciones WHERE id = pre) <> 6000000
     OR (SELECT gasto_total_aplicado FROM carnes_preliquidaciones WHERE id = pre) <> 6150000
     OR (SELECT costo_por_animal FROM carnes_preliquidaciones WHERE id = pre) <> 123000 THEN
    RAISE EXCEPTION 'valores de cabecera no escritos';
  END IF;
  IF (SELECT count(*) FROM carnes_preliquidacion_gastos WHERE preliquidacion_id = pre) <> 2 THEN
    RAISE EXCEPTION 'debía reemplazar los gastos por dos filas';
  END IF;
  IF jsonb_array_length(r->'sedes_marcadas') <> 1 THEN RAISE EXCEPTION 'debía marcar la sede enviada: %', r; END IF;
  IF NOT (SELECT requiere_correccion FROM carnes_preliquidacion_sedes WHERE id = sede)
     OR (SELECT correccion_orden_version FROM carnes_preliquidacion_sedes WHERE id = sede)
        <> (SELECT orden_version FROM carnes_preliquidaciones WHERE id = pre) THEN
    RAISE EXCEPTION 'la sede enviada debía quedar con requiere_correccion y la nueva orden_version';
  END IF;
  SELECT version, orden_version INTO hv, ov FROM carnes_preliquidaciones WHERE id = pre;

  -- ── anular: guardas ──
  r := carnes_preliq_anular(pre, hv, ov, 'qa', '');
  IF r->>'resultado' <> 'motivo_requerido' THEN RAISE EXCEPTION 'sin motivo debía ser motivo_requerido: %', r; END IF;

  r := carnes_preliq_anular(pre, hv, ov, 'qa', 'prueba');
  IF r->>'resultado' <> 'no_anulable' OR r->>'motivo' <> 'sede_enviada' THEN
    RAISE EXCEPTION 'con una sede enviada debía ser no_anulable(sede_enviada): %', r;
  END IF;

  -- Sede de nuevo sin enviar; un saldo originado por la preliquidación ya aplicado en otra -> no_anulable.
  UPDATE carnes_preliquidacion_sedes SET estado = 'calculada', requiere_correccion = false WHERE id = sede;
  INSERT INTO carnes_preliquidacion_saldos (origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado)
  VALUES (pre, 'res', 1000, cerdo1, 'aplicado');
  r := carnes_preliq_anular(pre, hv, ov, 'qa', 'prueba');
  IF r->>'resultado' <> 'no_anulable' OR r->>'motivo' <> 'saldo_aplicado' THEN
    RAISE EXCEPTION 'con un saldo propio aplicado debía ser no_anulable(saldo_aplicado): %', r;
  END IF;
  DELETE FROM carnes_preliquidacion_saldos WHERE origen_preliquidacion_id = pre;

  -- Versión vieja -> version_cambiada.
  r := carnes_preliq_anular(pre, hv - 1, ov, 'qa', 'prueba');
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'version vieja debía ser version_cambiada: %', r; END IF;
  r := carnes_preliq_anular(pre, hv, ov - 1, 'qa', 'prueba');
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'orden_version vieja debía ser version_cambiada: %', r; END IF;

  -- ── anular: efectos ──
  -- Ya hay otra preliquidación de res abierta y sin liquidar: los saldos liberados deben pasar a ella.
  UPDATE carnes_preliquidaciones SET ventana_fin = now() - interval '1 day', fecha_primer_ingreso = current_date - 5 WHERE id = pre;
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 100}'::jsonb);
  res2 := (r->>'preliquidacion_id')::BIGINT;
  IF res2 IS NULL THEN RAISE EXCEPTION 'No se pudo crear la segunda preliquidación de res: %', r; END IF;
  -- Saldo consumido por esta preliquidación (origen ajeno, aplicado, destino = pre) y saldo propio pendiente.
  INSERT INTO carnes_preliquidacion_saldos (origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado)
  VALUES (cerdo1, 'res', 2000, pre, 'aplicado') RETURNING id INTO saldo_c;
  INSERT INTO carnes_preliquidacion_saldos (origen_preliquidacion_id, especie, valor, destino_preliquidacion_id, estado)
  VALUES (pre, 'res', 3000, cerdo1, 'pendiente') RETURNING id INTO saldo_p;
  INSERT INTO carnes_preliquidacion_alertas (evento, preliquidacion_id, sede_id, ocurrencia)
  VALUES ('excede_animales', pre, sede, 1), ('ventana_vencida', pre, 0, 0);
  UPDATE carnes_recepciones SET estado = 'Costeado', costeado_at = now() WHERE id = rec AND estado = 'Aprobado';
  SELECT version INTO v_cerdo FROM carnes_preliquidaciones WHERE id = cerdo1;
  SELECT version INTO v_res2 FROM carnes_preliquidaciones WHERE id = res2;

  r := carnes_preliq_anular(pre, hv, ov, 'qa', 'prueba de anulación');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'anular debía ser ok: %', r; END IF;
  IF (SELECT estado FROM carnes_preliquidaciones WHERE id = pre) <> 'anulada'
     OR (SELECT anulada_at FROM carnes_preliquidaciones WHERE id = pre) IS NULL
     OR (SELECT motivo_anulacion FROM carnes_preliquidaciones WHERE id = pre) <> 'prueba de anulación' THEN
    RAISE EXCEPTION 'cabecera no anulada como se esperaba';
  END IF;
  IF EXISTS (SELECT 1 FROM carnes_preliquidacion_sedes WHERE preliquidacion_id = pre) THEN
    RAISE EXCEPTION 'las sedes debían borrarse';
  END IF;
  IF (SELECT preliquidacion_id FROM carnes_recepciones WHERE id = rec) IS NOT NULL THEN
    RAISE EXCEPTION 'la recepción debía quedar desvinculada';
  END IF;
  IF (SELECT estado FROM carnes_recepciones WHERE id = rec) = 'Costeado' THEN
    RAISE EXCEPTION 'la recepción Costeado debía volver a Aprobado';
  END IF;
  IF (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = saldo_c) <> 'pendiente'
     OR (SELECT destino_preliquidacion_id FROM carnes_preliquidacion_saldos WHERE id = saldo_c) IS DISTINCT FROM res2 THEN
    RAISE EXCEPTION 'el saldo consumido debía volver a pendiente hacia la otra preliquidación abierta de res';
  END IF;
  IF (r->>'saldos_reasignados')::INTEGER <> 1 OR (r->>'saldos_destino_id')::BIGINT <> res2 THEN
    RAISE EXCEPTION 'anular debía informar la reasignación: %', r;
  END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = res2) <> v_res2 + 1 THEN
    RAISE EXCEPTION 'el nuevo destino de los saldos debía subir su versión';
  END IF;
  IF (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = saldo_p) <> 'descartado' THEN
    RAISE EXCEPTION 'el saldo propio pendiente debía quedar descartado';
  END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = cerdo1) <> v_cerdo + 1 THEN
    RAISE EXCEPTION 'el destino del saldo propio debía subir su versión';
  END IF;
  IF EXISTS (SELECT 1 FROM carnes_preliquidacion_alertas WHERE preliquidacion_id = pre AND enviado_ok = false) THEN
    RAISE EXCEPTION 'los avisos sin enviar debían borrarse';
  END IF;

  -- Repetir: ya no es abierta. Y el índice de "sin iniciar" quedó libre para otra de res.
  r := carnes_preliq_anular(pre, hv, ov, 'qa', 'otra vez');
  IF r->>'resultado' <> 'no_anulable' OR r->>'motivo' <> 'no_abierta' THEN
    RAISE EXCEPTION 'anular dos veces debía ser no_anulable(no_abierta): %', r;
  END IF;
  -- Sin otra abierta los saldos quedan sin destino (NULL): se simula quitando la segunda de res.
  UPDATE carnes_preliquidaciones SET estado = 'anulada', anulada_at = now() WHERE id = res2;
  UPDATE carnes_preliquidacion_saldos SET destino_preliquidacion_id = NULL WHERE id = saldo_c;
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 100}'::jsonb);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'tras anular se debía poder crear otra de res: %', r; END IF;
  -- Y el saldo que esperaba se adjunta a la nueva (carnes_preliq_crear).
  IF (SELECT destino_preliquidacion_id FROM carnes_preliquidacion_saldos WHERE id = saldo_c) IS NULL THEN
    RAISE EXCEPTION 'el saldo liberado debía adjuntarse a la nueva preliquidación';
  END IF;

  -- Restan: recalcular sobre una anulada.
  r := carnes_preliq_recalcular_no_enviadas(pre, hv, '{}'::jsonb, jsonb_build_object('orden_version', ov), 'qa', NULL);
  IF r->>'resultado' <> 'no_abierta' THEN RAISE EXCEPTION 'recalcular una anulada debía ser no_abierta: %', r; END IF;

  RAISE NOTICE '041b OK: recalcular_no_enviadas y anular (guardas, efectos y versiones)';
END $$;

ROLLBACK;

-- =============================================================================
-- PARTE 2: carreras (DOS sesiones psql contra QA)
-- =============================================================================
--
-- (a) recalcular_no_enviadas vs congelar_sede concurrente  [orden_version]
--
--   Sesión 1: SELECT carnes_preliq_recalcular_no_enviadas(P, V, '{}', plan, 'qa', NULL); -- sin COMMIT
--   Sesión 2: SELECT carnes_preliq_congelar_sede(S, SV, OV, plan);   -- espera el lock de la cabecera
--   Sesión 1: COMMIT;   -- orden_version = OV + 1
--   Sesión 2: -- Esperado: {"resultado":"version_cambiada"} (el costeo con la orden vieja es obsoleto)
--
-- (b) anular vs reclamar_sede concurrente  [no se envía una sede de una preliquidación anulada]
--
--   Sesión 1: SELECT carnes_preliq_anular(P, V, OV, 'qa', 'prueba');   -- sin COMMIT
--   Sesión 2: SELECT carnes_preliq_reclamar_sede(S, SV, 'calculada', tok, C, 'admin', true);  -- espera
--   Sesión 1: COMMIT;
--   Sesión 2: -- Esperado: {"resultado":"no_encontrada"} (la sede ya no existe)
-- =============================================================================
