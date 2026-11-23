-- =============================================================================
-- ROLLBACK de sql/039_preliquidacion_rpc.sql y sql/038_preliquidacion.sql
-- =============================================================================
--
-- NO es una migración del despliegue normal. Correrla SOLO si hay que revertir la
-- migración de producción del lunes 2026-11-23 (038 + 039).
--
-- ADVERTENCIA: borra TODOS los datos de preliquidación (cabeceras, sedes, gastos,
-- retomas, alternas, saldos, alertas, corridas y la configuración por especie). No
-- hay copia: si se necesita conservarlos, exportar las tablas `carnes_preliquidacion*`
-- ANTES de correr este archivo.
--
-- Orden inverso de dependencias:
--   1. (guarda) aborta si alguna sede ya se envió a SIESA, está en vuelo o anulada, si su
--      envío (carnes_siesa_envios) está ok/enviando/sin_confirmar, o si alguna recepción
--      vinculada ya está Enviado_SIESA (misma guarda que `carnes_preliq_desvincular`).
--   2. las recepciones vinculadas que NO se enviaron vuelven al flujo legado, igual
--      que `carnes_preliq_desvincular`: costos limpios, Costeado -> Aprobado.
--   3. funciones de 040 (si existen) y de 039 (firmas exactas).
--   4. índice, CHECKs y columna `preliquidacion_id` de carnes_recepciones.
--   5. tablas de 038, de las hojas a las raíces.
--
-- NO toca nada previo a 038: ni `carnes_set_updated_at()` ni las tablas legadas.
-- Idempotente (IF EXISTS) y todo o nada (una sola transacción).
--
-- lock_timeout de 5s: si otra sesión retiene un lock sobre las tablas afectadas, TODO el
-- script aborta limpio (nada se aplica). Reintentar cuando la tabla esté libre.
--
-- Antes de correrla: apagar CARNES_PRELIQUIDACION y deshabilitar el workflow del
-- cron, para que nadie escriba mientras se revierte.
--
-- Después de correrla: el backend con las guardas sigue funcionando (leen la
-- columna aparte y, si no existe, responden "sin vínculo"), pero conviene volver
-- al despliegue anterior.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Guarda: una CEA enviada (o en vuelo) existe en SIESA. Revertir borraría el único
--    vínculo entre esa CEA y su sede. Si el cambio es inevitable, resolver primero
--    cada sede (anular en SIESA) y recién entonces correr el rollback.
DO $$
DECLARE
  v_sedes BIGINT := 0;
  v_recepciones BIGINT := 0;
BEGIN
  IF to_regclass('carnes_preliquidacion_sedes') IS NOT NULL THEN
    IF to_regclass('carnes_siesa_envios') IS NOT NULL THEN
      EXECUTE $q$
        SELECT count(*) FROM carnes_preliquidacion_sedes s
         WHERE s.estado IN ('enviando', 'enviada', 'sin_confirmar', 'anulada')
            OR (
              s.envio_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM carnes_siesa_envios e
                 WHERE e.id = s.envio_id AND e.estado IN ('ok', 'enviando', 'sin_confirmar')
              )
            )
      $q$ INTO v_sedes;
    ELSE
      EXECUTE $q$
        SELECT count(*) FROM carnes_preliquidacion_sedes s
         WHERE s.estado IN ('enviando', 'enviada', 'sin_confirmar', 'anulada')
      $q$ INTO v_sedes;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'carnes_recepciones' AND column_name = 'preliquidacion_id'
  ) THEN
    EXECUTE $q$
      SELECT count(*) FROM carnes_recepciones
       WHERE preliquidacion_id IS NOT NULL AND estado = 'Enviado_SIESA'
    $q$ INTO v_recepciones;
  END IF;

  IF v_sedes > 0 OR v_recepciones > 0 THEN
    RAISE EXCEPTION
      'Rollback abortado: % sede(s) de preliquidación enviadas, en vuelo o anuladas en SIESA y % recepción(es) vinculada(s) en Enviado_SIESA. Anule esos documentos en SIESA y resuelva las sedes antes de revertir.',
      v_sedes, v_recepciones;
  END IF;
END $$;

-- 2. Las recepciones vinculadas (ninguna enviada, por la guarda) vuelven al flujo legado.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'carnes_recepciones' AND column_name = 'preliquidacion_id'
  ) THEN
    EXECUTE $q$
      UPDATE carnes_recepcion_items
         SET costo_ajustado = NULL, costo_total = NULL
       WHERE recepcion_id IN (
         SELECT id FROM carnes_recepciones
          WHERE preliquidacion_id IS NOT NULL AND estado = 'Costeado'
       )
    $q$;
    EXECUTE $q$
      UPDATE carnes_recepciones
         SET estado = 'Aprobado', costeado_at = NULL
       WHERE preliquidacion_id IS NOT NULL AND estado = 'Costeado'
    $q$;
  END IF;
END $$;

-- 3a0. Funciones de sql/041 (alterna, saldos y correcciones), si esa migración se aplicó. Lo
--      normal es correr antes sql/041_rollback.sql. Con IF EXISTS es inocuo si 041 no se aplicó.
DROP FUNCTION IF EXISTS carnes_preliq_anular(BIGINT, INTEGER, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_recalcular_no_enviadas(BIGINT, INTEGER, JSONB, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_saldo_mover(BIGINT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_saldo_descartar(BIGINT, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_saldo_editar(BIGINT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS carnes_preliq_registrar_alterna(BIGINT, NUMERIC, TIMESTAMPTZ, JSONB, NUMERIC, JSONB);

-- 3a. Funciones de sql/040 (envío a SIESA), si esa migración se aplicó. Sin dependencias
--     declaradas, quedarían huérfanas al borrar las tablas. Con IF EXISTS es inocuo si 040 no
--     se aplicó. Lo normal es correr antes sql/040_rollback.sql.
DROP FUNCTION IF EXISTS carnes_preliq_cerrar(BIGINT, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS carnes_preliq_sincronizar_envio(BIGINT, INTEGER, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_cerrar_envio(BIGINT, UUID, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_reclamar_sede(BIGINT, INTEGER, TEXT, UUID, BIGINT, TEXT, BOOLEAN);

-- 3b. Funciones de sql/039 (las dos auxiliares y las ocho de negocio), con sus firmas exactas.
DROP FUNCTION IF EXISTS carnes_preliq_transicionar_sede(BIGINT, INTEGER, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_congelar_sede(BIGINT, INTEGER, INTEGER, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_liquidar(BIGINT, INTEGER, TIMESTAMPTZ, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_actualizar_servicio(BIGINT, NUMERIC, TEXT, DATE, TIMESTAMPTZ, BOOLEAN);
DROP FUNCTION IF EXISTS carnes_preliq_actualizar_novillos(BIGINT, NUMERIC, INTEGER, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_desvincular(BIGINT, INTEGER, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_vincular(BIGINT, BIGINT, INTEGER, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_crear(TEXT, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_aplicar_plan_sedes(BIGINT, JSONB);
DROP FUNCTION IF EXISTS carnes_preliq_validar_plan_sedes(BIGINT, JSONB);

-- 4. carnes_recepciones: CHECKs, índice y columna (la FK cae con la columna).
ALTER TABLE carnes_recepciones DROP CONSTRAINT IF EXISTS ck_carnes_recepciones_preliq_novillos;
ALTER TABLE carnes_recepciones DROP CONSTRAINT IF EXISTS ck_carnes_recepciones_liq_xor_preliq;
DROP INDEX IF EXISTS idx_carnes_recepciones_preliquidacion;
ALTER TABLE carnes_recepciones DROP COLUMN IF EXISTS preliquidacion_id;

-- 5. Tablas de sql/038, de las hojas a las raíces (los triggers caen con su tabla).
DROP TABLE IF EXISTS carnes_preliquidacion_alertas;
DROP TABLE IF EXISTS carnes_preliquidacion_saldos;
DROP TABLE IF EXISTS carnes_preliquidacion_sedes;
DROP TABLE IF EXISTS carnes_preliquidacion_alternas;
DROP TABLE IF EXISTS carnes_preliquidacion_retomas;
DROP TABLE IF EXISTS carnes_preliquidacion_gastos;
DROP TABLE IF EXISTS carnes_preliquidaciones;
DROP TABLE IF EXISTS carnes_preliquidacion_corridas;
DROP TABLE IF EXISTS carnes_preliquidacion_config;

COMMIT;

-- Verificación: ambas consultas deben devolver 0 filas.
SELECT table_name
  FROM information_schema.tables
 WHERE table_name LIKE 'carnes_preliquidacion%' OR table_name = 'carnes_preliquidaciones';

SELECT proname FROM pg_proc WHERE proname LIKE 'carnes_preliq_%';
