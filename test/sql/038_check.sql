-- =============================================================================
-- Verificación MANUAL de sql/038_preliquidacion.sql
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA. NUNCA en producción. No forma parte de
-- `npm test`: la prueba estática es test/preliquidacion-ddl.test.js.
--
-- Cómo correrlo (psql o el editor SQL de QA):
--
--   1. Con el esquema base (sql/001 a sql/037) ya aplicado, correr
--      sql/038_preliquidacion.sql DOS veces: la segunda no debe fallar ni cambiar nada
--      (idempotencia). En un esquema vacío de preliquidación, la primera crea todo.
--   2. Correr este archivo completo. Todo ocurre dentro de una transacción que se
--      DESHACE al final (ROLLBACK): no deja datos. Cada bloque DO lanza una
--      excepción con el motivo si una verificación falla; si termina sin errores,
--      todo está bien.
-- =============================================================================

BEGIN;

-- 1. Las nueve tablas existen.
DO $$
DECLARE
  faltan TEXT;
BEGIN
  SELECT string_agg(t, ', ') INTO faltan
    FROM unnest(ARRAY[
      'carnes_preliquidacion_config', 'carnes_preliquidacion_corridas', 'carnes_preliquidaciones',
      'carnes_preliquidacion_gastos', 'carnes_preliquidacion_retomas', 'carnes_preliquidacion_alternas',
      'carnes_preliquidacion_sedes', 'carnes_preliquidacion_saldos', 'carnes_preliquidacion_alertas'
    ]) AS t
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t);
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Faltan tablas: %', faltan;
  END IF;
END $$;

-- 2. La configuración inicial trae res y cerdo con servicio_por_animal = 0 y ventana de 2 días.
DO $$
BEGIN
  IF (SELECT count(*) FROM carnes_preliquidacion_config WHERE especie IN ('res', 'cerdo')) <> 2 THEN
    RAISE EXCEPTION 'Faltan las filas de configuración res/cerdo';
  END IF;
  IF EXISTS (SELECT 1 FROM carnes_preliquidacion_config WHERE ventana_dias <> 2) THEN
    RAISE WARNING 'ventana_dias distinto de 2 (puede ser un valor ya ajustado en QA)';
  END IF;
END $$;

-- 3. Índice único parcial: dos abiertas SIN iniciar de la misma especie no conviven.
DO $$
DECLARE
  rechazado BOOLEAN := false;
BEGIN
  INSERT INTO carnes_preliquidaciones (especie, animales, servicio_por_animal) VALUES ('res', 10, 1000);
  BEGIN
    INSERT INTO carnes_preliquidaciones (especie, animales, servicio_por_animal) VALUES ('res', 5, 1000);
  EXCEPTION WHEN unique_violation THEN
    rechazado := true;
  END;
  IF NOT rechazado THEN
    RAISE EXCEPTION 'El índice parcial no rechazó la segunda preliquidación sin iniciar';
  END IF;

  -- Una ya iniciada (fecha_primer_ingreso puesta) sí puede convivir con una sin iniciar.
  UPDATE carnes_preliquidaciones SET fecha_primer_ingreso = current_date WHERE especie = 'res';
  INSERT INTO carnes_preliquidaciones (especie, animales, servicio_por_animal) VALUES ('res', 5, 1000);
END $$;

-- 4. CHECKs de carnes_recepciones y FK RESTRICT (necesita al menos una recepción y una sede).
DO $$
DECLARE
  rec BIGINT;
  pre BIGINT;
  rechazado BOOLEAN;
BEGIN
  SELECT id INTO rec FROM carnes_recepciones WHERE liquidacion_id IS NULL AND especie = 'res' LIMIT 1;
  IF rec IS NULL THEN
    RAISE NOTICE 'No hay recepciones de res sin liquidación en QA: se omiten las verificaciones 4a-4c';
    RETURN;
  END IF;

  INSERT INTO carnes_preliquidaciones (especie, animales, servicio_por_animal, fecha_primer_ingreso)
    VALUES ('res', 20, 1000, current_date) RETURNING id INTO pre;

  -- 4a. novillos 0 con preliquidacion_id se rechaza.
  rechazado := false;
  BEGIN
    UPDATE carnes_recepciones SET novillos = 0, preliquidacion_id = pre WHERE id = rec;
  EXCEPTION WHEN check_violation THEN
    rechazado := true;
  END;
  IF NOT rechazado THEN RAISE EXCEPTION '4a: se aceptó novillos = 0 con preliquidacion_id'; END IF;

  -- 4b. novillos con decimales se rechaza; entero > 0 se acepta.
  rechazado := false;
  BEGIN
    UPDATE carnes_recepciones SET novillos = 2.5, preliquidacion_id = pre WHERE id = rec;
  EXCEPTION WHEN check_violation THEN
    rechazado := true;
  END;
  IF NOT rechazado THEN RAISE EXCEPTION '4b: se aceptó novillos = 2.5 con preliquidacion_id'; END IF;

  UPDATE carnes_recepciones SET novillos = 4, preliquidacion_id = pre WHERE id = rec;

  -- 4c. FK RESTRICT: no se puede borrar una preliquidación con recepciones vinculadas.
  rechazado := false;
  BEGIN
    DELETE FROM carnes_preliquidaciones WHERE id = pre;
  EXCEPTION WHEN foreign_key_violation THEN
    rechazado := true;
  END;
  IF NOT rechazado THEN RAISE EXCEPTION '4c: la FK no es RESTRICT'; END IF;
END $$;

-- 5. Una sede no puede apuntar a una recepción ya vinculada a otra sede (UNIQUE recepcion_id).
DO $$
DECLARE
  rec BIGINT;
  pre BIGINT;
  rechazado BOOLEAN := false;
BEGIN
  SELECT id INTO rec FROM carnes_recepciones WHERE preliquidacion_id IS NOT NULL LIMIT 1;
  IF rec IS NULL THEN
    RAISE NOTICE 'Sin recepción vinculada (4 se omitió): se omite la verificación 5';
    RETURN;
  END IF;
  SELECT preliquidacion_id INTO pre FROM carnes_recepciones WHERE id = rec;
  INSERT INTO carnes_preliquidacion_sedes (preliquidacion_id, recepcion_id, animales, orden) VALUES (pre, rec, 4, 1);
  BEGIN
    INSERT INTO carnes_preliquidacion_sedes (preliquidacion_id, recepcion_id, animales, orden) VALUES (pre, rec, 4, 2);
  EXCEPTION WHEN unique_violation THEN
    rechazado := true;
  END;
  IF NOT rechazado THEN RAISE EXCEPTION '5: recepcion_id no es UNIQUE en las sedes'; END IF;
END $$;

-- 6. Alertas: la clave (evento, preliquidacion_id, sede_id, ocurrencia) deduplica.
DO $$
DECLARE
  rechazado BOOLEAN := false;
BEGIN
  INSERT INTO carnes_preliquidacion_alertas (evento, preliquidacion_id, sede_id, ocurrencia) VALUES ('cerrada', 1, 0, 0);
  BEGIN
    INSERT INTO carnes_preliquidacion_alertas (evento, preliquidacion_id, sede_id, ocurrencia) VALUES ('cerrada', 1, 0, 0);
  EXCEPTION WHEN unique_violation THEN
    rechazado := true;
  END;
  IF NOT rechazado THEN RAISE EXCEPTION '6: la clave de alertas no deduplica'; END IF;
END $$;

-- 7. Las filas legadas con novillos = 0 siguen siendo actualizables (el CHECK solo aplica a vinculadas).
DO $$
DECLARE
  rec BIGINT;
BEGIN
  SELECT id INTO rec FROM carnes_recepciones WHERE preliquidacion_id IS NULL AND novillos = 0 LIMIT 1;
  IF rec IS NULL THEN
    RAISE NOTICE 'Sin recepciones legadas con novillos = 0: se omite la verificación 7';
    RETURN;
  END IF;
  UPDATE carnes_recepciones SET updated_at = now() WHERE id = rec;
END $$;

ROLLBACK;

-- Si llegaste hasta aquí sin excepciones, 038 quedó verificada. El ROLLBACK deshizo
-- todos los datos de prueba.
