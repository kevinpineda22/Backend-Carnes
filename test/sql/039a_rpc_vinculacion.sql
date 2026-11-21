-- =============================================================================
-- Verificación MANUAL de sql/039 (conjunto A): crear, vincular, desvincular, novillos
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038 y 039 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-rpc.test.js).
--
-- PARTE 1 (una sola sesión, todo se deshace con ROLLBACK): códigos de resultado.
-- PARTE 2 (dos sesiones): la carrera de `orden_version` en vincular. Instrucciones al final.
--
-- Prerrequisitos en QA: al menos DOS recepciones de res (carnes_recepciones) sin
-- liquidación ni preliquidación, con novillos entero > 0, y
-- carnes_preliquidacion_config.servicio_por_animal > 0 para 'res'.
-- =============================================================================

BEGIN;

-- Datos de prueba dentro de la transacción.
UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie = 'res';

-- A-S2: crear una preliquidación y comprobar que otra sin iniciar se rechaza.
DO $$
DECLARE
  r JSONB;
BEGIN
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 5000000}'::jsonb);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'crear debía devolver ok: %', r; END IF;

  r := carnes_preliq_crear('res', '{"animales": 5, "animal_en_pie": 100}'::jsonb);
  IF r->>'resultado' <> 'abierta_en_curso' THEN
    RAISE EXCEPTION 'A-S2: la segunda abierta de la especie debía rechazarse: %', r;
  END IF;

  r := carnes_preliq_crear('res', '{"animales": 0}'::jsonb);
  -- 0 animales: o abierta_en_curso (hay otra) o datos_invalidos; nunca una excepción cruda.
  IF r->>'resultado' NOT IN ('abierta_en_curso', 'datos_invalidos') THEN
    RAISE EXCEPTION 'animales = 0 debía devolver un código: %', r;
  END IF;
END $$;

-- config_servicio_cero
DO $$
DECLARE
  r JSONB;
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 0 WHERE especie = 'cerdo';
  r := carnes_preliq_crear('cerdo', '{"animales": 10}'::jsonb);
  IF r->>'resultado' <> 'config_servicio_cero' THEN
    RAISE EXCEPTION 'config en 0 debía devolver config_servicio_cero: %', r;
  END IF;
END $$;

-- vincular: ok, ya_vinculada, oficial_legacy (si hay), version_cambiada, fuera_ventana
DO $$
DECLARE
  pre   BIGINT;
  ov    INTEGER;
  rec   BIGINT;
  fecha DATE;
  r     JSONB;
BEGIN
  SELECT id, orden_version INTO pre, ov FROM carnes_preliquidaciones WHERE especie = 'res' AND estado = 'abierta' ORDER BY id DESC LIMIT 1;
  SELECT id, fecha_ingreso INTO rec, fecha FROM carnes_recepciones
   WHERE especie = 'res' AND preliquidacion_id IS NULL AND liquidacion_id IS NULL AND novillos > 0 AND novillos = trunc(novillos)
   ORDER BY id LIMIT 1;
  IF rec IS NULL THEN RAISE NOTICE 'Sin recepción elegible: se omite vincular'; RETURN; END IF;

  -- version_cambiada: orden_version distinta a la leída.
  r := carnes_preliq_vincular(rec, pre, ov + 99, '{}'::jsonb);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'esperaba version_cambiada: %', r; END IF;

  -- Vinculación normal: la sede cabe (candidata vinculada).
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
  IF r->>'resultado' <> 'vinculada' THEN RAISE EXCEPTION 'esperaba vinculada: %', r; END IF;
  IF (SELECT orden_version FROM carnes_preliquidaciones WHERE id = pre) <> ov + 1 THEN
    RAISE EXCEPTION 'vincular debía subir orden_version';
  END IF;

  -- ya_vinculada
  r := carnes_preliq_vincular(rec, pre, ov + 1, '{}'::jsonb);
  IF r->>'resultado' <> 'ya_vinculada' THEN RAISE EXCEPTION 'esperaba ya_vinculada: %', r; END IF;

  -- B-S: un plan que reordena una sede NO vinculada se rechaza como version_cambiada.
  UPDATE carnes_preliquidacion_sedes SET estado = 'calculada' WHERE recepcion_id = rec;
  r := carnes_preliq_vincular(
    (SELECT id FROM carnes_recepciones WHERE especie = 'res' AND preliquidacion_id IS NULL AND liquidacion_id IS NULL ORDER BY id LIMIT 1),
    pre, ov + 1,
    jsonb_build_object('reordenar', jsonb_build_array(jsonb_build_object('recepcion_id', rec, 'orden', 9)))
  );
  IF r->>'resultado' NOT IN ('version_cambiada', 'sin_recepcion') THEN
    RAISE EXCEPTION 'reordenar una sede no vinculada debía rechazarse: %', r;
  END IF;
  UPDATE carnes_preliquidacion_sedes SET estado = 'vinculada' WHERE recepcion_id = rec;
END $$;

-- M4: desvincular libera una sede en desborde cuando se libera cupo.
-- Escenario: animales = 10; A(4) y B(5) vinculadas; C(3) excede. Al desvincular B,
-- C debe llegar en `liberadas` y quedar con liberada_at puesto.
-- Se arma con filas sintéticas solo si hay recepciones suficientes; ajustá los ids.
--
--   SELECT carnes_preliq_desvincular(<sede B id>, <orden_version>,
--     jsonb_build_object('liberadas', jsonb_build_array(<recepcion C id>), 'restantes', 6));
--   -- Esperado: {"resultado":"ok",...}; luego:
--   SELECT estado, motivo_bloqueo, liberada_at FROM carnes_preliquidacion_sedes WHERE recepcion_id = <C>;
--   -- Esperado: bloqueada | excede_animales | liberada_at NOT NULL
--
--   SELECT carnes_preliq_desvincular(<sede enviada id>, <orden_version>, '{}'::jsonb);
--   -- Esperado: {"resultado":"sede_enviada"}

-- novillos: códigos
DO $$
DECLARE
  rec BIGINT;
  r   JSONB;
  e   TEXT;
BEGIN
  SELECT recepcion_id INTO rec FROM carnes_preliquidacion_sedes WHERE estado = 'vinculada' LIMIT 1;
  IF rec IS NULL THEN RAISE NOTICE 'Sin sede vinculada: se omite novillos'; RETURN; END IF;

  r := carnes_preliq_actualizar_novillos(rec, 2.5, 0, '{}'::jsonb);
  IF r->>'resultado' <> 'invalido' THEN RAISE EXCEPTION 'novillos decimal debía ser invalido: %', r; END IF;

  r := carnes_preliq_actualizar_novillos(rec, 0, 0, '{}'::jsonb);
  IF r->>'resultado' <> 'invalido' THEN RAISE EXCEPTION 'novillos 0 debía ser invalido: %', r; END IF;

  r := carnes_preliq_actualizar_novillos(-1, 3, 0, '{}'::jsonb);
  IF r->>'resultado' <> 'no_vinculada' THEN RAISE EXCEPTION 'recepción inexistente: %', r; END IF;

  UPDATE carnes_preliquidacion_sedes SET estado = 'enviada' WHERE recepcion_id = rec;
  r := carnes_preliq_actualizar_novillos(rec, 3, 0, '{}'::jsonb);
  IF r->>'resultado' <> 'sede_no_editable' THEN RAISE EXCEPTION 'sede enviada debía ser sede_no_editable: %', r; END IF;
  UPDATE carnes_preliquidacion_sedes SET estado = 'vinculada' WHERE recepcion_id = rec;

  -- I3: calculada / error / simulada SÍ son editables; enviando / sin_confirmar / anulada no.
  FOREACH e IN ARRAY ARRAY['calculada', 'error', 'simulada'] LOOP
    UPDATE carnes_preliquidacion_sedes SET estado = e WHERE recepcion_id = rec;
    r := carnes_preliq_actualizar_novillos(rec, 3, (SELECT orden_version FROM carnes_preliquidaciones WHERE id = (SELECT preliquidacion_id FROM carnes_preliquidacion_sedes WHERE recepcion_id = rec)), '{}'::jsonb);
    IF r->>'resultado' = 'sede_no_editable' THEN RAISE EXCEPTION '% debía ser editable: %', e, r; END IF;
  END LOOP;
  FOREACH e IN ARRAY ARRAY['enviando', 'sin_confirmar', 'anulada'] LOOP
    UPDATE carnes_preliquidacion_sedes SET estado = e WHERE recepcion_id = rec;
    r := carnes_preliq_actualizar_novillos(rec, 3, 0, '{}'::jsonb);
    IF r->>'resultado' <> 'sede_no_editable' THEN RAISE EXCEPTION '% debía ser sede_no_editable: %', e, r; END IF;
  END LOOP;
  UPDATE carnes_preliquidacion_sedes SET estado = 'vinculada' WHERE recepcion_id = rec;

  r := carnes_preliq_actualizar_novillos(rec, 3, 999, '{}'::jsonb);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'orden_version vieja: %', r; END IF;
END $$;

ROLLBACK;

-- =============================================================================
-- PARTE 2: carrera de vincular (orden_version). DOS sesiones psql contra QA.
-- =============================================================================
--
--   Sesión 1                                    Sesión 2
--   BEGIN;
--   SELECT carnes_preliq_vincular(R1, P, OV, plan1);
--                                               SELECT carnes_preliq_vincular(R2, P, OV, plan2);
--                                               -- se BLOQUEA esperando el lock de la cabecera
--   COMMIT;
--                                               -- se desbloquea y devuelve version_cambiada
--                                               -- (orden_version ya subió a OV + 1)
--
-- Esperado: exactamente una de las dos vincula; la otra devuelve `version_cambiada`
-- y NO escribe nada. Después, JS relee y recalcula con OV + 1.
-- =============================================================================
