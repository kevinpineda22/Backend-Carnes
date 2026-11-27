-- =============================================================================
-- Migration 042: corte manual de la preliquidación de talleres
-- =============================================================================
--
-- Un admin puede fijar a mano la fecha y hora del corte (cierre) de una preliquidación
-- mientras siga abierta y sin liquidar. Sin corte manual rige la regla automática
-- (21:30 America/Bogota del día de `fecha_primer_ingreso`, calculada en JS).
--
-- Qué hace:
--   1. Columnas nuevas en carnes_preliquidaciones (todas NULL por defecto = regla automática):
--        corte_manual       TIMESTAMPTZ   instante absoluto del corte fijado a mano
--        corte_manual_por   VARCHAR(120)  quién lo fijó
--        corte_manual_at    TIMESTAMPTZ   cuándo se fijó
--   2. carnes_preliq_fijar_corte(...)  fija o restablece el corte bajo el lock de la cabecera.
--   3. carnes_preliq_actualizar_servicio y carnes_preliq_liquidar (de 039) se redefinen con UN
--      cambio: si la cabecera tiene `corte_manual`, ESE es el corte y se ignora `p_corte` (el que
--      calculó JS con lo que leyó). Así una corrida que leyó el corte viejo no puede liquidar con él
--      después de que el admin lo movió: la base manda, bajo el lock de la cabecera.
--
-- Igual que 039-041, la RPC nueva NO decide reglas de negocio nuevas: JS valida con funciones
-- puras (src/shared/preliquidacionCorte.js) y la función solo revalida bajo lock lo que depende
-- del estado y del reloj de la base (abierta, no liquidada, versiones, futuro, tope).
--
-- Contrato de retorno: JSONB `{resultado: ...}`. SECURITY INVOKER (por defecto).
-- Idempotente: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE. Todo o nada.
--
-- Precondición: 038 y 039 aplicadas.
-- Orden de despliegue: 038 -> 039 -> 040 -> 041 -> 042 -> backend con el endpoint nuevo.
-- Reversión: sql/042_rollback.sql.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'carnes_preliq_liquidar'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'carnes_preliq_actualizar_servicio'
  ) THEN
    RAISE EXCEPTION
      'Faltan carnes_preliq_liquidar / carnes_preliq_actualizar_servicio. Corra sql/039_preliquidacion_rpc.sql antes de esta migración.';
  END IF;
END $$;

ALTER TABLE carnes_preliquidaciones
  ADD COLUMN IF NOT EXISTS corte_manual     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS corte_manual_por VARCHAR(120),
  ADD COLUMN IF NOT EXISTS corte_manual_at  TIMESTAMPTZ;

COMMENT ON COLUMN carnes_preliquidaciones.corte_manual IS
  'Corte fijado a mano por un admin (instante absoluto). NULL = regla automática: 21:30 Bogotá del día de fecha_primer_ingreso.';


-- -----------------------------------------------------------------------------
-- carnes_preliq_fijar_corte(p_id, p_version, p_orden_version, p_corte,
--                           p_corte_automatico, p_ventana_fin, p_por)
--
-- Fija (`p_corte` con valor) o restablece (`p_corte` NULL) el corte manual.
--
-- JS calcula y valida con la cabecera leída; aquí se revalida bajo el lock de la cabecera:
--   * estado 'abierta' y `liquidada_at` NULL (la corrida programada y esta función toman el
--     mismo lock: o gana la liquidación y esto devuelve `ya_liquidada`, o gana esto y la
--     liquidación ve el corte nuevo y la versión nueva);
--   * `version` y `orden_version` iguales a las leídas (un vincular/desvincular concurrente
--     invalida el plan de ventana y de sedes);
--   * hay primer ingreso (si no, no existe corte automático sobre el cual acotar);
--   * el corte nuevo está en el futuro según el reloj de la base y no pasa de 7 días después
--     del corte automático (`p_corte_automatico`);
--   * para restablecer, el corte automático todavía no pasó (si no, la próxima corrida
--     liquidaría de inmediato por un clic: se pide una fecha futura explícita).
--
-- `p_ventana_fin` es la ventana ya calculada por JS (la mayor entre la de 2 días calendario y
-- el fin del día del corte manual); se escribe tal cual.
--
-- Un servicio cargado entre el corte anterior y el nuevo era tardío y pasa a ser precorte:
-- `servicio_precorte` toma su valor (la primera liquidación lo aplica).
--
-- Sube `version`: una `carnes_preliq_liquidar` que ya leyó la cabecera recibe `version_cambiada`.
-- Sube también `orden_version`: la ventana cambió, así que un vincular/desvincular/congelar_sede
-- que ya leyó la cabecera (y planificó con la ventana anterior) recibe `version_cambiada`.
-- Borra las alertas `corrida_perdida` sin enviar: el corte se movió y dejaron de aplicar.
--
-- Resultados: ok | no_encontrada | no_abierta | ya_liquidada | version_cambiada |
--             corte_sin_primer_ingreso | corte_pasado | corte_excede_limite |
--             corte_automatico_pasado | datos_invalidos
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION carnes_preliq_fijar_corte(
  p_id                BIGINT,
  p_version           INTEGER,
  p_orden_version     INTEGER,
  p_corte             TIMESTAMPTZ,
  p_corte_automatico  TIMESTAMPTZ,
  p_ventana_fin       TIMESTAMPTZ,
  p_por               TEXT
) RETURNS JSONB AS $fn$
DECLARE
  v_header   carnes_preliquidaciones%ROWTYPE;
  v_anterior TIMESTAMPTZ;
  v_nuevo    TIMESTAMPTZ;
BEGIN
  IF p_corte_automatico IS NULL OR p_ventana_fin IS NULL THEN
    RETURN jsonb_build_object('resultado', 'datos_invalidos');
  END IF;

  SELECT * INTO v_header FROM carnes_preliquidaciones WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_header.estado = 'anulada' THEN
    RETURN jsonb_build_object('resultado', 'no_encontrada');
  END IF;
  IF v_header.estado <> 'abierta' THEN
    RETURN jsonb_build_object('resultado', 'no_abierta');
  END IF;
  IF v_header.liquidada_at IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'ya_liquidada');
  END IF;

  IF v_header.version <> p_version OR v_header.orden_version <> p_orden_version THEN
    RETURN jsonb_build_object('resultado', 'version_cambiada');
  END IF;

  IF v_header.fecha_primer_ingreso IS NULL THEN
    RETURN jsonb_build_object('resultado', 'corte_sin_primer_ingreso');
  END IF;

  IF p_corte IS NOT NULL THEN
    IF p_corte <= now() THEN
      RETURN jsonb_build_object('resultado', 'corte_pasado');
    END IF;
    IF p_corte > p_corte_automatico + interval '7 days' THEN
      RETURN jsonb_build_object('resultado', 'corte_excede_limite');
    END IF;
  ELSIF p_corte_automatico <= now() THEN
    RETURN jsonb_build_object('resultado', 'corte_automatico_pasado');
  END IF;

  v_anterior := COALESCE(v_header.corte_manual, p_corte_automatico);
  v_nuevo := COALESCE(p_corte, p_corte_automatico);

  UPDATE carnes_preliquidaciones
     SET corte_manual = p_corte,
         corte_manual_por = CASE WHEN p_corte IS NULL THEN NULL ELSE NULLIF(p_por, '') END,
         corte_manual_at = CASE WHEN p_corte IS NULL THEN NULL ELSE now() END,
         ventana_fin = p_ventana_fin,
         servicio_precorte = CASE
           WHEN servicio IS NOT NULL AND servicio_at > v_anterior AND servicio_at <= v_nuevo THEN servicio
           ELSE servicio_precorte
         END,
         servicio_precorte_at = CASE
           WHEN servicio IS NOT NULL AND servicio_at > v_anterior AND servicio_at <= v_nuevo THEN servicio_at
           ELSE servicio_precorte_at
         END,
         version = version + 1,
         orden_version = orden_version + 1
   WHERE id = p_id;

  DELETE FROM carnes_preliquidacion_alertas
   WHERE preliquidacion_id = p_id
     AND enviado_ok = false
     AND evento = 'corrida_perdida';

  RETURN jsonb_build_object(
    'resultado', 'ok',
    'corte_manual', p_corte,
    'ventana_fin', p_ventana_fin
  );
END;
$fn$ LANGUAGE plpgsql;


-- -----------------------------------------------------------------------------
-- carnes_preliq_actualizar_servicio: igual que en 039; el ÚNICO cambio es que, si la cabecera
-- tiene corte manual, ese es el corte y `p_corte` (el de JS) se ignora.
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
  v_corte   TIMESTAMPTZ;
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

  v_corte := COALESCE(v_header.corte_manual, p_corte);
  v_tardio := v_header.liquidada_at IS NOT NULL OR (v_corte IS NOT NULL AND now() > v_corte);

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
-- carnes_preliq_liquidar: igual que en 039; el ÚNICO cambio es que, si la cabecera tiene corte
-- manual, ese es el corte y `p_corte` (el de JS) se ignora. Ver el comentario de 039 para el contrato.
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
  v_corte    TIMESTAMPTZ;
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

  v_corte := COALESCE(v_header.corte_manual, p_corte);
  IF v_corte IS NULL OR now() < v_corte THEN
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

COMMIT;

-- Verificación: deben aparecer las tres columnas y las tres funciones.
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'carnes_preliquidaciones'
   AND column_name IN ('corte_manual', 'corte_manual_por', 'corte_manual_at')
 ORDER BY column_name;

SELECT proname
  FROM pg_proc
 WHERE proname IN ('carnes_preliq_fijar_corte', 'carnes_preliq_actualizar_servicio', 'carnes_preliq_liquidar')
 ORDER BY proname;
