-- =============================================================================
-- Verificación MANUAL de sql/039 (conjunto B): servicio, liquidar, congelar, transicionar
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038 y 039 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-rpc.test.js).
--
-- PARTE 1: una sesión, todo dentro de una transacción con ROLLBACK.
-- PARTE 2: carreras con DOS sesiones (liquidar vs actualizar_servicio; congelar vs vincular).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  pre BIGINT;
  r   JSONB;
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie = 'res';
  r := carnes_preliq_crear('res', '{"animales": 10, "animal_en_pie": 5000000}'::jsonb);
  pre := (r->>'preliquidacion_id')::BIGINT;
  IF pre IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de prueba: %', r; END IF;

  -- ── actualizar_servicio ──
  -- Sin primer ingreso no hay corte: el servicio es precorte.
  r := carnes_preliq_actualizar_servicio(pre, 800000, 'qa', NULL, NULL, false);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'servicio precorte debía ser ok: %', r; END IF;
  IF (SELECT servicio_precorte FROM carnes_preliquidaciones WHERE id = pre) <> 800000 THEN
    RAISE EXCEPTION 'servicio_precorte no se guardó';
  END IF;

  -- fecha_primer_ingreso distinta a la leída -> version_cambiada.
  r := carnes_preliq_actualizar_servicio(pre, 900000, 'qa', current_date, now(), false);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'fecha distinta debía ser version_cambiada: %', r; END IF;

  -- servicio negativo
  r := carnes_preliq_actualizar_servicio(pre, -1, 'qa', NULL, NULL, false);
  IF r->>'resultado' <> 'servicio_invalido' THEN RAISE EXCEPTION 'servicio negativo: %', r; END IF;

  -- M3: desbloqueo con servicio_por_animal > 0 se rechaza (no hay deadlock que destrabar).
  r := carnes_preliq_actualizar_servicio(pre, 700000, 'qa', NULL, NULL, true);
  IF r->>'resultado' <> 'version_cambiada' THEN
    RAISE EXCEPTION 'M3: con predeterminado > 0 el desbloqueo debía revalidarse como version_cambiada: %', r;
  END IF;

  -- M3: precorte = 0 con predeterminado = 0 SÍ se desbloquea (COALESCE(servicio_precorte,0) <= 0).
  UPDATE carnes_preliquidaciones SET servicio_por_animal = 0, servicio_precorte = 0 WHERE id = pre;
  r := carnes_preliq_actualizar_servicio(pre, 650000, 'qa', NULL, NULL, true);
  IF r->>'resultado' NOT IN ('ok', 'tardio') THEN RAISE EXCEPTION 'M3: precorte 0 debía desbloquearse: %', r; END IF;
  IF (SELECT servicio_precorte FROM carnes_preliquidaciones WHERE id = pre) <> 650000 THEN
    RAISE EXCEPTION 'M3: el desbloqueo debía dejar el servicio como precorte';
  END IF;
  UPDATE carnes_preliquidaciones SET servicio_por_animal = 1000 WHERE id = pre;

  -- ── liquidar ──
  -- antes_del_corte: p_corte en el futuro.
  r := carnes_preliq_liquidar(
    pre, (SELECT version FROM carnes_preliquidaciones WHERE id = pre), now() + interval '1 hour',
    '{"servicio_aplicado":"650000.00","gasto_total":"5650000.00","costo_por_animal":"565000.00","saldo_ids":[]}'::jsonb
  );
  IF r->>'resultado' <> 'antes_del_corte' THEN RAISE EXCEPTION 'esperaba antes_del_corte: %', r; END IF;

  -- version_cambiada: versión vieja.
  r := carnes_preliq_liquidar(
    pre, 9999, now() - interval '1 hour',
    '{"servicio_aplicado":"650000.00","gasto_total":"5650000.00","costo_por_animal":"565000.00","saldo_ids":[]}'::jsonb
  );
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'esperaba version_cambiada: %', r; END IF;

  -- saldo_ids distinto del conjunto pendiente -> version_cambiada.
  r := carnes_preliq_liquidar(
    pre, (SELECT version FROM carnes_preliquidaciones WHERE id = pre), now() - interval '1 hour',
    '{"servicio_aplicado":"650000.00","gasto_total":"5650000.00","costo_por_animal":"565000.00","saldo_ids":[123456789]}'::jsonb
  );
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'saldo_ids ajeno debía ser version_cambiada: %', r; END IF;

  -- ok y luego ya_liquidada.
  r := carnes_preliq_liquidar(
    pre, (SELECT version FROM carnes_preliquidaciones WHERE id = pre), now() - interval '1 hour',
    '{"servicio_aplicado":"650000.00","gasto_total":"5650000.00","costo_por_animal":"565000.00","saldo_ids":[]}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'liquidar debía ser ok: %', r; END IF;

  r := carnes_preliq_liquidar(
    pre, 0, now() - interval '1 hour',
    '{"servicio_aplicado":"1.00","gasto_total":"1.00","costo_por_animal":"1.00","saldo_ids":[]}'::jsonb
  );
  IF r->>'resultado' <> 'ya_liquidada' THEN RAISE EXCEPTION 'esperaba ya_liquidada: %', r; END IF;
  IF (SELECT gasto_total_aplicado FROM carnes_preliquidaciones WHERE id = pre) <> 5650000 THEN
    RAISE EXCEPTION 'ya_liquidada no debía sobrescribir los valores congelados';
  END IF;

  -- Tardío: tras liquidar, cualquier servicio es tardío y NO toca servicio_precorte.
  r := carnes_preliq_actualizar_servicio(pre, 777000, 'qa', NULL, NULL, false);
  -- (fecha_primer_ingreso es NULL en esta cabecera de prueba, igual que la leída)
  IF r->>'resultado' <> 'tardio' THEN RAISE EXCEPTION 'tras liquidar el servicio es tardio: %', r; END IF;
  IF (SELECT servicio_precorte FROM carnes_preliquidaciones WHERE id = pre) <> 650000 THEN
    RAISE EXCEPTION 'un servicio tardio no debe cambiar servicio_precorte';
  END IF;
END $$;

-- ── congelar_sede / transicionar_sede ──
-- Necesitan una sede vinculada de una preliquidación liquidada (ver sql/039a para armarla).
-- Verificaciones a hacer a mano con los ids reales:
--
--   -- no_liberada: sede bloqueada(excede_animales) sin liberada_at
--   SELECT carnes_preliq_congelar_sede(<sede>, <version>, <orden_version>,
--     '{"desde":"bloqueada","hacia":"lista_para_enviar"}'::jsonb);
--   -- Esperado: {"resultado":"no_liberada"}
--
--   -- Costeo normal: vinculada -> calculada guarda costeo_orden_version y costeo_animales
--   SELECT carnes_preliq_congelar_sede(<sede>, <version>, <orden_version>,
--     '{"desde":"vinculada","hacia":"calculada","gasto_sede":"1000.00","utilidad":"10.00","servicio_compra":"5.00",
--       "recepcion_costeado":true,"items":[{"id":<item>,"costo_ajustado":"1.0000","costo_total":"10.00"}]}'::jsonb);
--   SELECT estado, costeo_orden_version, costeo_animales, version FROM carnes_preliquidacion_sedes WHERE id = <sede>;
--
--   -- CAS genérico: versión vieja -> version_cambiada; versión correcta -> ok y version + 1
--   SELECT carnes_preliq_transicionar_sede(<sede>, <version_vieja>, 'calculada', 'simulada', '{}'::jsonb);
--   SELECT carnes_preliq_transicionar_sede(<sede>, <version>, 'calculada', 'simulada', '{}'::jsonb);

ROLLBACK;

-- =============================================================================
-- PARTE 2: carreras (DOS sesiones psql contra QA)
-- =============================================================================
--
-- (a) liquidar vs actualizar_servicio concurrente  [C2 / R8: sin pérdida de actualización]
--
--   Sesión 1                                          Sesión 2
--   BEGIN;
--   SELECT version FROM carnes_preliquidaciones WHERE id = P;   -- V
--                                                     BEGIN;
--                                                     SELECT carnes_preliq_actualizar_servicio(P, 900000, 'qa', F, C, false);
--                                                     COMMIT;     -- version pasa a V + 1
--   SELECT carnes_preliq_liquidar(P, V, C, plan);
--   -- Esperado: {"resultado":"version_cambiada"}  (JS relee y recalcula con V + 1)
--   COMMIT;
--
--   Variante con el lock en medio: sesión 1 lanza liquidar primero y NO hace COMMIT;
--   sesión 2 lanza actualizar_servicio -> espera el lock; tras el COMMIT de la 1, el
--   servicio queda como `tardio` (liquidada_at ya puesto) y NO modifica servicio_precorte.
--
-- (b) congelar_sede vs vincular concurrente  [orden_version]
--
--   Sesión 1: SELECT carnes_preliq_vincular(R2, P, OV, plan);   -- sin COMMIT todavía
--   Sesión 2: SELECT carnes_preliq_congelar_sede(S, SV, OV, plan); -- espera el lock de la cabecera
--   Sesión 1: COMMIT;   -- orden_version = OV + 1
--   Sesión 2: -- Esperado: {"resultado":"version_cambiada"} (el plan de costeo es obsoleto)
-- =============================================================================
