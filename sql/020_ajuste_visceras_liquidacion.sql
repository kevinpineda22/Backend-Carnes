-- =============================================================================
-- Migration 020: un solo ajuste de vísceras consolidado por liquidación
-- =============================================================================
--
-- El ajuste de vísceras (documento CEI, sql/019) dejó de ser un documento por
-- sede: el 30/09/2026 la quinta sede volvió con 400 "Item sin cantidad
-- disponible" (el CEI es una ENTRADA de inventario y el saldo de la bodega no
-- alcanzaba tras anular las cuatro anteriores). El negocio decidió UN documento
-- por liquidación, con todas las sedes, como la CEA oficial consolidada.
--
-- El envío consolidado es UNA fila de `carnes_siesa_envios` con:
--
--   tipo            'ajuste_visceras'
--   liquidacion_id  la liquidación
--   recepcion_id    NULL
--   recepcion_ids   las recepciones que iban en el documento (sql/012)
--
-- Las filas por sede de antes (recepcion_id lleno) se quedan como historial.
--
-- ─── Por qué hace falta un índice nuevo ──────────────────────────────────────
--
-- El candado de "una sola vigente" que ya hay NO cubre este envío:
--
--   · `uq_carnes_siesa_envios_vigente` (sql/010) es único sobre
--     (recepcion_id, tipo). Con `recepcion_id` NULL, Postgres trata cada NULL
--     como distinto: dos consolidados vigentes nunca chocarían ahí.
--   · `uq_carnes_siesa_envios_liquidacion_vigente` (sql/012) es parcial solo
--     para tipo = 'oficial'.
--
-- Este índice es el equivalente del de sql/012 para 'ajuste_visceras': una sola
-- fila vigente (enviando, ok o sin_confirmar) por liquidación. Un `error` o un
-- `anulado` no ocupan el lugar, así que se puede reintentar o reenviar.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/019_ajuste_visceras.sql   (ya corrida en producción)
--   2. sql/020_ajuste_visceras_liquidacion.sql   ← esta, ANTES del backend
--   3. Backend
--   4. Frontend (el backend nuevo cambia la forma de la respuesta del ajuste:
--      el front anterior no la entiende)
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
-- Nada revienta, y eso es lo peligroso: sin el índice la reserva del envío
-- entra igual y NO hay candado en la base. Dos clics casi simultáneos (o dos
-- pestañas) mandarían dos documentos CONTABILIZADOS a SIESA. El backend solo
-- pregunta "¿ya hay uno vigente?" antes de reservar, y entre esa pregunta y el
-- insert cabe otro pedido: por eso el candado tiene que estar en la base.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

BEGIN;

-- 1. sql/019 tiene que estar: sin él 'ajuste_visceras' ni siquiera cabe en `tipo`.
DO $$
DECLARE
  largo INTEGER;
BEGIN
  SELECT character_maximum_length INTO largo
  FROM information_schema.columns
  WHERE table_name = 'carnes_siesa_envios' AND column_name = 'tipo';

  IF largo IS NULL OR largo < 15 THEN
    RAISE EXCEPTION
      'Falta sql/019_ajuste_visceras.sql: la columna tipo mide % y ''ajuste_visceras'' tiene 15. '
      'Correla antes de esta migración.', largo;
  END IF;
END $$;

-- 2. El candado: una sola vigente por liquidación para el ajuste consolidado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_siesa_envios_ajuste_liquidacion_vigente
  ON carnes_siesa_envios (liquidacion_id)
  WHERE recepcion_id IS NULL
    AND tipo = 'ajuste_visceras'
    AND estado IN ('enviando', 'ok', 'sin_confirmar');

COMMIT;
