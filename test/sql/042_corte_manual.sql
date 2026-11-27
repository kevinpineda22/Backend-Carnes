-- =============================================================================
-- Verificación MANUAL de sql/042 (corte manual de la preliquidación)
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038, 039 y 042 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-corte-sql.test.js).
--
-- PARTE 1: una sesión, todo dentro de una transacción con ROLLBACK.
-- PARTE 2: carrera con DOS sesiones (liquidar vs fijar_corte).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  pre    BIGINT;
  r      JSONB;
  auto   TIMESTAMPTZ;
  v      INTEGER;
  ov     INTEGER;
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie = 'res';
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 5000000}'::jsonb);
  pre := (r->>'preliquidacion_id')::BIGINT;
  IF pre IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de prueba: %', r; END IF;

  SELECT version, orden_version INTO v, ov FROM carnes_preliquidaciones WHERE id = pre;

  -- Sin primer ingreso no hay corte automático sobre el cual acotar.
  r := carnes_preliq_fijar_corte(pre, v, ov, now() + interval '1 hour', now() + interval '2 hours', now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'corte_sin_primer_ingreso' THEN RAISE EXCEPTION 'sin primer ingreso: %', r; END IF;

  -- Primer ingreso hoy: corte automático dentro de 3 h (simulado: lo calcula JS en producción).
  auto := now() + interval '3 hours';
  UPDATE carnes_preliquidaciones
     SET fecha_primer_ingreso = current_date, ventana_fin = now() + interval '2 days'
   WHERE id = pre;
  SELECT version, orden_version INTO v, ov FROM carnes_preliquidaciones WHERE id = pre;

  -- version vieja -> version_cambiada.
  r := carnes_preliq_fijar_corte(pre, v - 1, ov, now() + interval '1 hour', auto, now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'version vieja: %', r; END IF;
  r := carnes_preliq_fijar_corte(pre, v, ov + 1, now() + interval '1 hour', auto, now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'orden_version vieja: %', r; END IF;

  -- Pasado y tope de 7 días.
  r := carnes_preliq_fijar_corte(pre, v, ov, now() - interval '1 minute', auto, now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'corte_pasado' THEN RAISE EXCEPTION 'corte pasado: %', r; END IF;
  r := carnes_preliq_fijar_corte(pre, v, ov, auto + interval '7 days 1 minute', auto, now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'corte_excede_limite' THEN RAISE EXCEPTION 'tope: %', r; END IF;

  -- Fijar OK: guarda el corte, quién, cuándo, la ventana y sube la versión.
  r := carnes_preliq_fijar_corte(pre, v, ov, auto + interval '2 days', auto, now() + interval '5 days', 'qa@x.co');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'fijar: %', r; END IF;
  IF (SELECT corte_manual FROM carnes_preliquidaciones WHERE id = pre) <> auto + interval '2 days' THEN
    RAISE EXCEPTION 'corte_manual no se guardó';
  END IF;
  IF (SELECT corte_manual_por FROM carnes_preliquidaciones WHERE id = pre) <> 'qa@x.co' THEN
    RAISE EXCEPTION 'corte_manual_por no se guardó';
  END IF;
  IF (SELECT version FROM carnes_preliquidaciones WHERE id = pre) <> v + 1 THEN
    RAISE EXCEPTION 'debía subir la version';
  END IF;
  IF (SELECT orden_version FROM carnes_preliquidaciones WHERE id = pre) <> ov + 1 THEN
    RAISE EXCEPTION 'debía subir la orden_version';
  END IF;

  -- liquidar respeta el corte manual aunque JS mande un p_corte pasado (la base manda).
  r := carnes_preliq_liquidar(
    pre, v + 1, now() - interval '1 hour',
    '{"servicio_aplicado":"1000.00","gasto_total":"5001000.00","costo_por_animal":"500100.00","saldo_ids":[]}'::jsonb
  );
  IF r->>'resultado' <> 'antes_del_corte' THEN RAISE EXCEPTION 'liquidar debía respetar el corte manual: %', r; END IF;

  -- actualizar_servicio: ahora NO es tardío (el corte manual está en el futuro) aunque p_corte sea pasado.
  r := carnes_preliq_actualizar_servicio(pre, 800000, 'qa', current_date, now() - interval '1 hour', false);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'servicio no debía ser tardío: %', r; END IF;

  -- Restablecer: el automático (en el futuro) vuelve a regir.
  SELECT version, orden_version INTO v, ov FROM carnes_preliquidaciones WHERE id = pre;
  r := carnes_preliq_fijar_corte(pre, v, ov, NULL, auto, now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'restablecer: %', r; END IF;
  IF (SELECT corte_manual FROM carnes_preliquidaciones WHERE id = pre) IS NOT NULL THEN
    RAISE EXCEPTION 'corte_manual debía quedar NULL';
  END IF;

  -- Restablecer con el automático ya pasado -> corte_automatico_pasado.
  SELECT version, orden_version INTO v, ov FROM carnes_preliquidaciones WHERE id = pre;
  r := carnes_preliq_fijar_corte(pre, v, ov, NULL, now() - interval '1 minute', now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'corte_automatico_pasado' THEN RAISE EXCEPTION 'restablecer con automático pasado: %', r; END IF;

  -- Ya liquidada -> ya_liquidada.
  UPDATE carnes_preliquidaciones SET liquidada_at = now() WHERE id = pre;
  r := carnes_preliq_fijar_corte(pre, v, ov, now() + interval '1 hour', auto, now() + interval '2 days', 'qa');
  IF r->>'resultado' <> 'ya_liquidada' THEN RAISE EXCEPTION 'ya liquidada: %', r; END IF;

  RAISE NOTICE '042 parte 1: OK';
END $$;

ROLLBACK;

-- =============================================================================
-- PARTE 2 (dos sesiones, en QA): carrera entre la corrida y el cambio del corte
-- =============================================================================
--   Sesión A:  BEGIN; SELECT carnes_preliq_liquidar(<id>, <version>, now() - interval '1 minute', '<plan>'::jsonb);  -- sin COMMIT
--   Sesión B:  SELECT carnes_preliq_fijar_corte(<id>, <version>, <orden_version>, now() + interval '2 hours', <auto>, <ventana>, 'qa');
--              -- queda esperando el lock de la cabecera.
--   Sesión A:  COMMIT;
--   Sesión B:  debe devolver 'ya_liquidada' (ganó la liquidación) y NO cambiar corte_manual.
--   Al revés (B primero, A después): A debe devolver 'antes_del_corte' o 'version_cambiada', nunca 'ok'.
