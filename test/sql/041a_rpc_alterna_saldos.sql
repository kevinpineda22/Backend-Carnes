-- =============================================================================
-- Verificación MANUAL de sql/041 (parte A): registrar_alterna y saldos
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038, 039, 040 y 041 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-rpc-correcciones.test.js).
-- No llama a SIESA: solo ejercita funciones SQL. Todo corre dentro de una transacción con
-- ROLLBACK, así que no deja datos.
--
-- Cubre: alterna idempotente por (preliquidacion_id, servicio_at), saldo nuevo / actualizado /
-- ajuste sobre un saldo aplicado, mover a otra especie (E-S6) y a una liquidada, editar y
-- descartar solo saldos pendientes, y que cada toque suba la versión del destino.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  res1    BIGINT;
  res2    BIGINT;
  cerdo1  BIGINT;
  r       JSONB;
  s1      BIGINT;
  s2      BIGINT;
  res3    BIGINT;
  v0      INTEGER;
  v1      INTEGER;
  t1      TIMESTAMPTZ := now() - interval '2 hours';
  t2      TIMESTAMPTZ := now() - interval '1 hour';
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie IN ('res', 'cerdo');

  -- Origen: una preliquidación de res ya liquidada (alterna solo existe tras la liquidación).
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 9000000}'::jsonb);
  res1 := (r->>'preliquidacion_id')::BIGINT;
  IF res1 IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de res de prueba: %', r; END IF;

  -- Sin liquidar: no_liquidada.
  r := carnes_preliq_registrar_alterna(res1, 700000, t1, '[]'::jsonb, 200000, '{"accion":"nada"}'::jsonb);
  IF r->>'resultado' <> 'no_liquidada' THEN RAISE EXCEPTION 'sin liquidar debía ser no_liquidada: %', r; END IF;

  -- Se liquida a mano (la liquidación real la prueba 039b): solo importa liquidada_at y servicio_aplicado.
  UPDATE carnes_preliquidaciones
     SET liquidada_at = now(), servicio_aplicado = 500000, gasto_total_aplicado = 9500000, costo_por_animal = 950000
   WHERE id = res1;

  -- Segunda preliquidación de res como destino: la primera ya no cuenta como abierta en curso.
  UPDATE carnes_preliquidaciones SET ventana_fin = now() - interval '1 day', fecha_primer_ingreso = current_date - 5 WHERE id = res1;
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 9000000}'::jsonb);
  res2 := (r->>'preliquidacion_id')::BIGINT;
  IF res2 IS NULL THEN RAISE EXCEPTION 'No se pudo crear la segunda preliquidación de res: %', r; END IF;

  r := carnes_preliq_crear('cerdo', '{"animales": 5, "animal_en_pie": 1000000}'::jsonb);
  cerdo1 := (r->>'preliquidacion_id')::BIGINT;
  IF cerdo1 IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de cerdo: %', r; END IF;

  -- ── registrar_alterna: crea el saldo (primer registro) con destino res2 ──
  SELECT version INTO v0 FROM carnes_preliquidaciones WHERE id = res2;
  r := carnes_preliq_registrar_alterna(
    res1, 700000, t1, '[{"sede_id":1,"diferencia":"200000.00"}]'::jsonb, 200000,
    jsonb_build_object('accion', 'crear_ajuste', 'valor', '200000.00', 'destino_preliquidacion_id', res2, 'por', 'qa')
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'registrar_alterna debía ser ok: %', r; END IF;
  s1 := (r->>'saldo_id')::BIGINT;
  IF s1 IS NULL THEN RAISE EXCEPTION 'debía crear el saldo: %', r; END IF;
  IF (SELECT valor FROM carnes_preliquidacion_saldos WHERE id = s1) <> 200000
     OR (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = s1) <> 'pendiente'
     OR (SELECT destino_preliquidacion_id FROM carnes_preliquidacion_saldos WHERE id = s1) <> res2
     OR (SELECT especie FROM carnes_preliquidacion_saldos WHERE id = s1) <> 'res' THEN
    RAISE EXCEPTION 'saldo creado con datos inesperados';
  END IF;
  SELECT version INTO v1 FROM carnes_preliquidaciones WHERE id = res2;
  IF v1 <> v0 + 1 THEN RAISE EXCEPTION 'el destino debía subir su versión: % -> %', v0, v1; END IF;

  -- ── Idempotencia: repetir con el mismo servicio_at -> ya_registrada, sin saldo ni alterna nuevos ──
  r := carnes_preliq_registrar_alterna(
    res1, 700000, t1, '[]'::jsonb, 200000,
    jsonb_build_object('accion', 'crear_ajuste', 'valor', '200000.00', 'destino_preliquidacion_id', res2)
  );
  IF r->>'resultado' <> 'ya_registrada' THEN RAISE EXCEPTION 'repetir debía ser ya_registrada: %', r; END IF;
  IF (SELECT count(*) FROM carnes_preliquidacion_alternas WHERE preliquidacion_id = res1) <> 1 THEN
    RAISE EXCEPTION 'la repetición no debía crear otra alterna';
  END IF;
  IF (SELECT count(*) FROM carnes_preliquidacion_saldos WHERE origen_preliquidacion_id = res1) <> 1 THEN
    RAISE EXCEPTION 'la repetición no debía crear otro saldo';
  END IF;

  -- ── Otro servicio tardío (otro servicio_at): actualiza el pendiente en el lugar ──
  r := carnes_preliq_registrar_alterna(
    res1, 800000, t2, '[]'::jsonb, 300000,
    jsonb_build_object('accion', 'actualizar_pendiente', 'saldo_id', s1, 'valor', '300000.00')
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'actualizar_pendiente debía ser ok: %', r; END IF;
  IF (SELECT valor FROM carnes_preliquidacion_saldos WHERE id = s1) <> 300000 THEN
    RAISE EXCEPTION 'el pendiente debía quedar en 300000';
  END IF;
  IF (SELECT count(*) FROM carnes_preliquidacion_saldos WHERE origen_preliquidacion_id = res1) <> 1 THEN
    RAISE EXCEPTION 'actualizar no debía crear otra fila';
  END IF;

  -- Versión de la cabecera distinta de la que leyó JS (un recálculo concurrente) -> version_cambiada,
  -- sin alterna escrita; con las versiones vigentes se registra.
  SELECT version INTO v0 FROM carnes_preliquidaciones WHERE id = res1;
  r := carnes_preliq_registrar_alterna(
    res1, 850000, now() - interval '30 minutes', '[]'::jsonb, 350000,
    jsonb_build_object('accion', 'nada', 'version_esperada', v0 + 1,
                       'orden_version_esperada', (SELECT orden_version FROM carnes_preliquidaciones WHERE id = res1))
  );
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'version distinta debía ser version_cambiada: %', r; END IF;
  r := carnes_preliq_registrar_alterna(
    res1, 850000, now() - interval '30 minutes', '[]'::jsonb, 350000,
    jsonb_build_object('accion', 'nada', 'version_esperada', v0,
                       'orden_version_esperada', (SELECT orden_version FROM carnes_preliquidaciones WHERE id = res1) + 1)
  );
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'orden_version distinta debía ser version_cambiada: %', r; END IF;
  IF (SELECT count(*) FROM carnes_preliquidacion_alternas WHERE preliquidacion_id = res1) <> 2 THEN
    RAISE EXCEPTION 'version_cambiada no debía dejar alterna escrita';
  END IF;
  r := carnes_preliq_registrar_alterna(
    res1, 850000, now() - interval '30 minutes', '[]'::jsonb, 350000,
    jsonb_build_object('accion', 'nada', 'version_esperada', v0,
                       'orden_version_esperada', (SELECT orden_version FROM carnes_preliquidaciones WHERE id = res1))
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'con las versiones vigentes debía ser ok: %', r; END IF;

  -- Plan inválido: saldo ajeno / acción desconocida.
  r := carnes_preliq_registrar_alterna(
    res1, 900000, now(), '[]'::jsonb, 400000,
    jsonb_build_object('accion', 'actualizar_pendiente', 'saldo_id', 987654321, 'valor', '400000.00')
  );
  IF r->>'resultado' <> 'saldo_invalido' THEN RAISE EXCEPTION 'saldo inexistente debía ser saldo_invalido: %', r; END IF;
  r := carnes_preliq_registrar_alterna(res1, 900000, now(), '[]'::jsonb, 400000, '{"accion":"inventada"}'::jsonb);
  IF r->>'resultado' <> 'saldo_invalido' THEN RAISE EXCEPTION 'acción desconocida debía ser saldo_invalido: %', r; END IF;

  -- Destino de otra especie para un ajuste nuevo -> destino_invalido (E-S6 desde el origen).
  r := carnes_preliq_registrar_alterna(
    res1, 900000, now(), '[]'::jsonb, 400000,
    jsonb_build_object('accion', 'crear_ajuste', 'valor', '100000.00', 'destino_preliquidacion_id', cerdo1)
  );
  IF r->>'resultado' <> 'destino_invalido' THEN RAISE EXCEPTION 'destino de otra especie debía ser destino_invalido: %', r; END IF;
  IF (SELECT count(*) FROM carnes_preliquidacion_alternas WHERE preliquidacion_id = res1) <> 3 THEN
    RAISE EXCEPTION 'un plan inválido no debía dejar alterna escrita';
  END IF;

  -- ── Ajuste sobre un saldo APLICADO: nunca se reescribe; se crea una fila nueva ──
  UPDATE carnes_preliquidacion_saldos SET estado = 'aplicado' WHERE id = s1;
  r := carnes_preliq_registrar_alterna(
    res1, 1000000, now(), '[]'::jsonb, 500000,
    jsonb_build_object('accion', 'crear_ajuste', 'valor', '200000.00', 'ajuste_de_saldo_id', s1, 'destino_preliquidacion_id', res2)
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'crear_ajuste sobre aplicado debía ser ok: %', r; END IF;
  s2 := (r->>'saldo_id')::BIGINT;
  IF (SELECT valor FROM carnes_preliquidacion_saldos WHERE id = s1) <> 300000
     OR (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = s1) <> 'aplicado' THEN
    RAISE EXCEPTION 'la fila aplicada no debía tocarse';
  END IF;
  IF (SELECT ajuste_de_saldo_id FROM carnes_preliquidacion_saldos WHERE id = s2) <> s1 THEN
    RAISE EXCEPTION 'el ajuste debía apuntar a la fila aplicada';
  END IF;

  -- Actualizar un saldo que ya no está pendiente -> version_cambiada, sin alterna escrita.
  -- Otro servicio_at: now() es fijo dentro de la transacción y el caso anterior ya registró
  -- una alterna con now(), así que repetirlo devolvería ya_registrada (idempotencia).
  r := carnes_preliq_registrar_alterna(
    res1, 1100000, now() + interval '1 minute', '[]'::jsonb, 600000,
    jsonb_build_object('accion', 'actualizar_pendiente', 'saldo_id', s1, 'valor', '1.00')
  );
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'actualizar un aplicado debía ser version_cambiada: %', r; END IF;

  -- ── saldo_editar: solo pendiente ──
  SELECT version INTO v0 FROM carnes_preliquidaciones WHERE id = res2;
  r := carnes_preliq_saldo_editar(s2, 150000, 'qa');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'editar pendiente debía ser ok: %', r; END IF;
  IF (SELECT valor FROM carnes_preliquidacion_saldos WHERE id = s2) <> 150000 THEN RAISE EXCEPTION 'valor no editado'; END IF;
  SELECT version INTO v1 FROM carnes_preliquidaciones WHERE id = res2;
  IF v1 <> v0 + 1 THEN RAISE EXCEPTION 'editar debía subir la versión del destino'; END IF;
  r := carnes_preliq_saldo_editar(s2, 150000, 'qa');
  IF r->>'resultado' <> 'sin_cambios' THEN RAISE EXCEPTION 'mismo valor debía ser sin_cambios: %', r; END IF;
  r := carnes_preliq_saldo_editar(s1, 1, 'qa');
  IF r->>'resultado' <> 'no_pendiente' THEN RAISE EXCEPTION 'editar aplicado debía ser no_pendiente: %', r; END IF;
  r := carnes_preliq_saldo_editar(987654321, 1, 'qa');
  IF r->>'resultado' <> 'no_encontrada' THEN RAISE EXCEPTION 'saldo inexistente: %', r; END IF;

  -- ── saldo_mover: a otra especie se rechaza (E-S6) ──
  r := carnes_preliq_saldo_mover(s2, cerdo1, 'qa');
  IF r->>'resultado' <> 'especie_distinta' THEN RAISE EXCEPTION 'mover a cerdo debía ser especie_distinta: %', r; END IF;
  -- A una preliquidación liquidada se rechaza.
  r := carnes_preliq_saldo_mover(s2, res1, 'qa');
  IF r->>'resultado' <> 'destino_liquidada' THEN RAISE EXCEPTION 'mover a liquidada debía ser destino_liquidada: %', r; END IF;
  -- Al mismo destino: sin cambios.
  r := carnes_preliq_saldo_mover(s2, res2, 'qa');
  IF r->>'resultado' <> 'sin_cambios' THEN RAISE EXCEPTION 'mover al mismo destino: %', r; END IF;

  -- Un destino válido: otra preliquidación de res abierta y sin liquidar.
  UPDATE carnes_preliquidaciones
     SET ventana_fin = now() - interval '1 day', fecha_primer_ingreso = current_date - 4
   WHERE id = res2;
  r := carnes_preliq_crear('res', '{"animales": 4, "animal_en_pie": 1000000}'::jsonb);
  res3 := (r->>'preliquidacion_id')::BIGINT;
  IF res3 IS NULL THEN RAISE EXCEPTION 'No se pudo crear la tercera preliquidación de res: %', r; END IF;
  r := carnes_preliq_saldo_mover(s2, res3, 'qa');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'mover a otra de res debía ser ok: %', r; END IF;
  IF (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = s2) <> 'movido'
     OR (SELECT movido_a_saldo_id FROM carnes_preliquidacion_saldos WHERE id = s2) IS NULL THEN
    RAISE EXCEPTION 'la fila vieja debía quedar movido con enlace';
  END IF;
  s2 := (r->>'saldo_id')::BIGINT;
  IF (SELECT destino_preliquidacion_id FROM carnes_preliquidacion_saldos WHERE id = s2) <> res3
     OR (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = s2) <> 'pendiente'
     OR (SELECT valor FROM carnes_preliquidacion_saldos WHERE id = s2) <> 150000 THEN
    RAISE EXCEPTION 'la fila nueva debía quedar pendiente en el nuevo destino con el mismo valor';
  END IF;
  r := carnes_preliq_saldo_mover(987654321, res3, 'qa');
  IF r->>'resultado' <> 'no_encontrada' THEN RAISE EXCEPTION 'mover un saldo inexistente: %', r; END IF;

  -- ── saldo_descartar: solo pendiente; la fila queda descartada, no se borra ──
  SELECT version INTO v0 FROM carnes_preliquidaciones WHERE id = res3;
  r := carnes_preliq_saldo_descartar(s2, 'qa');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'descartar pendiente debía ser ok: %', r; END IF;
  IF (SELECT estado FROM carnes_preliquidacion_saldos WHERE id = s2) <> 'descartado' THEN RAISE EXCEPTION 'debía quedar descartado'; END IF;
  SELECT version INTO v1 FROM carnes_preliquidaciones WHERE id = res3;
  IF v1 <> v0 + 1 THEN RAISE EXCEPTION 'descartar debía subir la versión del destino'; END IF;
  r := carnes_preliq_saldo_descartar(s2, 'qa');
  IF r->>'resultado' <> 'no_pendiente' THEN RAISE EXCEPTION 'descartar dos veces: %', r; END IF;
  r := carnes_preliq_saldo_descartar(s1, 'qa');
  IF r->>'resultado' <> 'no_pendiente' THEN RAISE EXCEPTION 'descartar aplicado: %', r; END IF;

  RAISE NOTICE '041a OK: alterna idempotente, saldos (crear/actualizar/ajustar/editar/mover/descartar) y versiones del destino';
END $$;

ROLLBACK;
