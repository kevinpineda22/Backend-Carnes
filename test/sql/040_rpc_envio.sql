-- =============================================================================
-- Verificación MANUAL de sql/040: reclamar_sede, cerrar_envio, sincronizar_envio, cerrar,
-- y la transicionar_sede ampliada (M1/M2)
-- =============================================================================
--
-- SOLO en el proyecto Supabase de QA, con 038, 039 y 040 aplicadas. NUNCA en producción.
-- No forma parte de `npm test` (la prueba estática es test/preliquidacion-rpc-envio.test.js).
-- No llama a SIESA: solo ejercita las funciones SQL.
--
-- PARTE 1: una sesión, todo dentro de una transacción con ROLLBACK.
-- PARTE 2: carreras con DOS sesiones (D-S5: dos reclamos concurrentes, solo uno gana).
--
-- La PARTE 1 necesita una recepción de res sin vincular que tenga un envío INICIAL `ok`
-- (para la compuerta C4). Si no existe, el bloque lo avisa y se omite.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  pre    BIGINT;
  rec    BIGINT;
  fecha  DATE;
  sede   BIGINT;
  ver    INTEGER;
  ov     INTEGER;
  tok    UUID := gen_random_uuid();
  r      JSONB;
BEGIN
  UPDATE carnes_preliquidacion_config SET servicio_por_animal = 1000 WHERE especie = 'res';
  r := carnes_preliq_crear('res', '{"animales": 50, "animal_en_pie": 5000000}'::jsonb);
  pre := (r->>'preliquidacion_id')::BIGINT;
  IF pre IS NULL THEN RAISE EXCEPTION 'No se pudo crear la preliquidación de prueba: %', r; END IF;

  SELECT r2.id, r2.fecha_ingreso INTO rec, fecha
    FROM carnes_recepciones r2
   WHERE r2.especie = 'res' AND r2.preliquidacion_id IS NULL AND r2.liquidacion_id IS NULL
     AND r2.novillos > 0 AND r2.novillos = trunc(r2.novillos)
     AND EXISTS (SELECT 1 FROM carnes_siesa_envios e WHERE e.recepcion_id = r2.id AND e.tipo = 'inicial' AND e.estado = 'ok')
   ORDER BY r2.id LIMIT 1;
  IF rec IS NULL THEN
    RAISE NOTICE 'Sin recepción de res con inicial ok: se omite la PARTE 1';
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

  -- Costeo vigente de mentira: la sede queda calculada y con montos al día.
  UPDATE carnes_preliquidaciones SET liquidada_at = now() WHERE id = pre;
  SELECT orden_version INTO ov FROM carnes_preliquidaciones WHERE id = pre;
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_congelar_sede(
    sede, ver, ov,
    '{"desde":"vinculada","hacia":"calculada","gasto_sede":"1000.00","utilidad":"10.00","servicio_compra":"5.00"}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'congelar debía ser ok: %', r; END IF;
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;

  -- ── reclamar_sede ──
  -- corrida_requerida: p_corrida_id NULL
  r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', tok, NULL, 'schedule', false);
  IF r->>'resultado' <> 'corrida_requerida' THEN RAISE EXCEPTION 'esperaba corrida_requerida: %', r; END IF;

  -- origen y desde inválidos
  r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', tok, 1, 'otro', false);
  IF r->>'resultado' <> 'origen_invalido' THEN RAISE EXCEPTION 'esperaba origen_invalido: %', r; END IF;
  r := carnes_preliq_reclamar_sede(sede, ver, 'bloqueada', tok, 1, 'schedule', false);
  IF r->>'resultado' <> 'desde_invalido' THEN RAISE EXCEPTION 'esperaba desde_invalido: %', r; END IF;

  -- no_encontrada
  r := carnes_preliq_reclamar_sede(-1, 0, 'calculada', tok, 1, 'schedule', false);
  IF r->>'resultado' <> 'no_encontrada' THEN RAISE EXCEPTION 'esperaba no_encontrada: %', r; END IF;

  -- no_reclamada: versión vieja
  INSERT INTO carnes_preliquidacion_corridas (origen) VALUES ('schedule');
  r := carnes_preliq_reclamar_sede(sede, ver - 1, 'calculada', tok, (SELECT max(id) FROM carnes_preliquidacion_corridas), 'schedule', false);
  IF r->>'resultado' <> 'no_reclamada' THEN RAISE EXCEPTION 'versión vieja debía ser no_reclamada: %', r; END IF;

  -- costeo_desactualizado: orden_version de la cabecera avanzó desde el costeo
  UPDATE carnes_preliquidaciones SET orden_version = orden_version + 1 WHERE id = pre;
  r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', tok, (SELECT max(id) FROM carnes_preliquidacion_corridas), 'admin', false);
  IF r->>'resultado' <> 'costeo_desactualizado' THEN RAISE EXCEPTION 'esperaba costeo_desactualizado (admin incluido): %', r; END IF;
  IF (SELECT version FROM carnes_preliquidacion_sedes WHERE id = sede) <> ver THEN
    RAISE EXCEPTION 'costeo_desactualizado no debía escribir';
  END IF;
  UPDATE carnes_preliquidaciones SET orden_version = orden_version - 1 WHERE id = pre;

  -- inicial_pendiente: sin inicial ok. Se simula quitando el envío del conjunto visible con otro tipo de recepción.
  -- (Se prueba con la guarda del hueco: sede de una recepción SIN inicial ok; ver comentario al final.)

  -- ok: reclamo exitoso
  r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', tok, (SELECT max(id) FROM carnes_preliquidacion_corridas), 'schedule', false);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'reclamo debía ser ok: %', r; END IF;
  IF (SELECT estado FROM carnes_preliquidacion_sedes WHERE id = sede) <> 'enviando' THEN RAISE EXCEPTION 'debía quedar enviando'; END IF;
  IF (SELECT claim_costeo_orden_version FROM carnes_preliquidacion_sedes WHERE id = sede) <> ov THEN
    RAISE EXCEPTION 'M2: claim_costeo_orden_version debía guardar costeo_orden_version';
  END IF;
  IF (SELECT intentos FROM carnes_preliquidacion_sedes WHERE id = sede) <> 1 THEN RAISE EXCEPTION 'intentos debía ser 1'; END IF;

  -- Segundo reclamo con la foto vieja: pierde (D-S5 en una sola sesión).
  r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', gen_random_uuid(), (SELECT max(id) FROM carnes_preliquidacion_corridas), 'sweep', false);
  IF r->>'resultado' <> 'no_reclamada' THEN RAISE EXCEPTION 'segundo reclamo debía perder: %', r; END IF;

  -- ── cerrar_envio ──
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_cerrar_envio(sede, gen_random_uuid(), '{"hacia":"enviada"}'::jsonb);
  IF r->>'resultado' <> 'token_invalido' THEN RAISE EXCEPTION 'token ajeno debía ser token_invalido: %', r; END IF;
  r := carnes_preliq_cerrar_envio(sede, tok, '{"hacia":"calculada"}'::jsonb);
  IF r->>'resultado' <> 'hacia_invalido' THEN RAISE EXCEPTION 'hacia fuera de la lista debía ser hacia_invalido: %', r; END IF;
  r := carnes_preliq_cerrar_envio(sede, tok, '{"hacia":"enviada","recepcion_estado":"Aprobado"}'::jsonb);
  IF r->>'resultado' <> 'recepcion_estado_invalido' THEN RAISE EXCEPTION 'recepcion_estado_invalido: %', r; END IF;

  -- M2 (carrera): un "recalcular no enviadas" levantó el aviso MIENTRAS viajaba el envío. JS calculó el
  -- cierre con lo que vio antes (sin aviso, esperada = NULL): la RPC no debe pisar el aviso nuevo.
  UPDATE carnes_preliquidacion_sedes SET requiere_correccion = true, correccion_orden_version = 9 WHERE id = sede;
  r := carnes_preliq_cerrar_envio(
    sede, tok,
    '{"hacia":"enviada","campos":{"requiere_correccion":false},"recepcion_estado":"Enviado_SIESA","correccion_orden_version_esperada":null}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'cerrar_envio debía ser ok: %', r; END IF;
  IF NOT (SELECT requiere_correccion FROM carnes_preliquidacion_sedes WHERE id = sede)
     OR (SELECT correccion_orden_version FROM carnes_preliquidacion_sedes WHERE id = sede) <> 9 THEN
    RAISE EXCEPTION 'M2: cerrar_envio pisó un aviso levantado durante el envío';
  END IF;
  IF (SELECT claim_token FROM carnes_preliquidacion_sedes WHERE id = sede) IS NOT NULL THEN
    RAISE EXCEPTION 'cerrar_envio debía liberar claim_token';
  END IF;
  -- Reutilizar el token ya cerrado falla.
  r := carnes_preliq_cerrar_envio(sede, tok, '{"hacia":"enviada"}'::jsonb);
  IF r->>'resultado' <> 'token_invalido' THEN RAISE EXCEPTION 'token reutilizado debía ser token_invalido: %', r; END IF;

  -- ── transicionar_sede ampliada (M1/M2) ──
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_transicionar_sede(
    sede, ver, 'enviada', 'enviada',
    '{"requiere_correccion":true,"correccion_orden_version":7,"claim_costeo_orden_version":6}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'transicionar_sede (M2) debía ser ok: %', r; END IF;
  IF (SELECT correccion_orden_version FROM carnes_preliquidacion_sedes WHERE id = sede) <> 7 THEN
    RAISE EXCEPTION 'M2: correccion_orden_version no se persistió (whitelist de 040)';
  END IF;
  IF (SELECT claim_costeo_orden_version FROM carnes_preliquidacion_sedes WHERE id = sede) <> 6 THEN
    RAISE EXCEPTION 'M2: claim_costeo_orden_version no se persistió';
  END IF;

  -- El aviso requiere_correccion sin enviar sobrevive a una transición mientras el flag siga activo.
  INSERT INTO carnes_preliquidacion_alertas (evento, preliquidacion_id, sede_id, ocurrencia)
  VALUES ('requiere_correccion', pre, sede, 0), ('envio_error', pre, sede, 0);
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_transicionar_sede(sede, ver, 'enviada', 'enviada', '{}'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM carnes_preliquidacion_alertas WHERE sede_id = sede AND evento = 'requiere_correccion') THEN
    RAISE EXCEPTION 'M2: el aviso requiere_correccion debía conservarse con el flag activo';
  END IF;
  IF EXISTS (SELECT 1 FROM carnes_preliquidacion_alertas WHERE sede_id = sede AND evento = 'envio_error') THEN
    RAISE EXCEPTION 'los avisos de otras versiones debían borrarse';
  END IF;

  -- M1: liberar el reclamo (claim_token / claimed_at a NULL) de un enviando abandonado.
  UPDATE carnes_preliquidacion_sedes SET estado = 'enviando', claim_token = tok, claimed_at = now(), envio_id = NULL WHERE id = sede;
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_transicionar_sede(sede, ver, 'enviando', 'calculada', '{"claim_token":null,"claimed_at":null}'::jsonb);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'M1: liberar reclamo debía ser ok: %', r; END IF;
  IF (SELECT claim_token FROM carnes_preliquidacion_sedes WHERE id = sede) IS NOT NULL THEN
    RAISE EXCEPTION 'M1: claim_token debía quedar NULL';
  END IF;

  -- ── sincronizar_envio ──
  r := carnes_preliq_sincronizar_envio(-1, 0, 'enviando', 'enviada', '{}'::jsonb);
  IF r->>'resultado' <> 'sin_sede' THEN RAISE EXCEPTION 'envío sin sede debía ser sin_sede: %', r; END IF;
  UPDATE carnes_preliquidacion_sedes
     SET envio_id = (SELECT id FROM carnes_siesa_envios WHERE recepcion_id = rec AND tipo = 'inicial' AND estado = 'ok' LIMIT 1),
         estado = 'sin_confirmar'
   WHERE id = sede;
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_sincronizar_envio(
    (SELECT envio_id FROM carnes_preliquidacion_sedes WHERE id = sede), ver, 'sin_confirmar', 'enviada', '{}'::jsonb
  );
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'sincronizar_envio debía ser ok: %', r; END IF;
  r := carnes_preliq_sincronizar_envio(
    (SELECT envio_id FROM carnes_preliquidacion_sedes WHERE id = sede), ver, 'sin_confirmar', 'enviada', '{}'::jsonb
  );
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'CAS repetido debía ser version_cambiada: %', r; END IF;

  -- ── cerrar ──
  SELECT orden_version INTO ov FROM carnes_preliquidaciones WHERE id = pre;
  r := carnes_preliq_cerrar(pre, ov, NULL);
  IF r->>'resultado' <> 'monto_invalido' THEN RAISE EXCEPTION 'monto NULL: %', r; END IF;
  r := carnes_preliq_cerrar(-1, ov, 0);
  IF r->>'resultado' <> 'no_encontrada' THEN RAISE EXCEPTION 'cerrar inexistente: %', r; END IF;
  r := carnes_preliq_cerrar(pre, ov + 5, 0);
  IF r->>'resultado' <> 'version_cambiada' THEN RAISE EXCEPTION 'orden_version distinta debía ser version_cambiada: %', r; END IF;
  -- JD S2: una sede en vuelo o pendiente impide cerrar (revalidación bajo el lock).
  UPDATE carnes_preliquidacion_sedes SET estado = 'enviando' WHERE id = sede;
  r := carnes_preliq_cerrar(pre, ov, 0);
  IF r->>'resultado' <> 'no_cerrable' THEN RAISE EXCEPTION 'sede enviando debía ser no_cerrable: %', r; END IF;
  UPDATE carnes_preliquidacion_sedes SET estado = 'enviada' WHERE id = sede;
  r := carnes_preliq_cerrar(pre, ov, 123.45);
  IF r->>'resultado' <> 'ok' THEN RAISE EXCEPTION 'cerrar debía ser ok: %', r; END IF;
  IF (SELECT monto_no_asignado FROM carnes_preliquidaciones WHERE id = pre) <> 123.45 THEN
    RAISE EXCEPTION 'monto_no_asignado no se guardó';
  END IF;
  r := carnes_preliq_cerrar(pre, ov, 0);
  IF r->>'resultado' <> 'no_abierta' THEN RAISE EXCEPTION 'cerrar dos veces: %', r; END IF;

  -- JD S2: con la cabecera cerrada ya no se reclama ninguna sede.
  SELECT version INTO ver FROM carnes_preliquidacion_sedes WHERE id = sede;
  r := carnes_preliq_reclamar_sede(sede, ver, 'calculada', gen_random_uuid(), (SELECT max(id) FROM carnes_preliquidacion_corridas), 'schedule', false);
  IF r->>'resultado' <> 'no_abierta' THEN RAISE EXCEPTION 'reclamo con cabecera cerrada debía ser no_abierta: %', r; END IF;
END $$;

-- inicial_pendiente (verificación a mano): con una sede `calculada` de una recepción SIN envío
-- INICIAL ok y costeo vigente:
--
--   SELECT carnes_preliq_reclamar_sede(<sede>, <version>, 'calculada', gen_random_uuid(), <corrida>, 'schedule', false);
--   -- Esperado: {"resultado":"inicial_pendiente"}; motivo_pendiente = 'inicial_pendiente'; version + 1
--   SELECT carnes_preliq_reclamar_sede(<sede>, <version + 1>, 'calculada', gen_random_uuid(), <corrida>, 'schedule', false);
--   -- Esperado: igual resultado y la versión NO cambia (el fallo repetido es un no-op)

ROLLBACK;

-- =============================================================================
-- PARTE 2: carrera de dos reclamos (DOS sesiones psql contra QA)  [D-S5]
-- =============================================================================
--
-- Con una sede `calculada` y costeo vigente (SEDE, VERSION, CORRIDA):
--
--   Sesión 1                                          Sesión 2
--   BEGIN;
--   SELECT carnes_preliq_reclamar_sede(SEDE, VERSION, 'calculada', gen_random_uuid(), CORRIDA, 'schedule', false);
--   -- {"resultado":"ok"}   (sin COMMIT todavía)
--                                                     BEGIN;
--                                                     SELECT carnes_preliq_reclamar_sede(SEDE, VERSION, 'calculada', gen_random_uuid(), CORRIDA, 'sweep', false);
--                                                     -- se bloquea esperando el FOR UPDATE de la sede
--   COMMIT;
--                                                     -- {"resultado":"no_reclamada"}  (estado ya es enviando)
--                                                     ROLLBACK;
--
--   Esperado: exactamente UN reclamo gana y la sede queda con un solo claim_token.
--
-- (b) reclamar vs vincular concurrente  [guarda de costeo obsoleto]
--
--   Sesión 1: BEGIN; SELECT carnes_preliq_vincular(...);   -- toma FOR UPDATE de la cabecera, sube orden_version
--   Sesión 2: SELECT carnes_preliq_reclamar_sede(SEDE, VERSION, 'calculada', ...);  -- espera FOR SHARE
--   Sesión 1: COMMIT;
--   Sesión 2: {"resultado":"costeo_desactualizado"}  (el costeo ya no es de la orden_version vigente)
