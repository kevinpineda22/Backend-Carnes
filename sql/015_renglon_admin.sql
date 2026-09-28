-- =============================================================================
-- Migration 015: renglones que el admin agrega después del cierre
-- =============================================================================
--
-- Hasta ahora un corte "fuera de plantilla" solo podía entrar por el recibidor
-- (`agregarAdicional`, con la recepción en Borrador). El admin necesita poder
-- agregar un corte que se le pasó al recibidor, pero DESPUÉS de que la
-- recepción ya cerró (Recibido/Aprobado) — ver `agregarRenglonAdmin` en
-- `src/models/Recepcion.model.js`.
--
-- Esas filas quedan marcadas con `agregado_por` y `agregado_at`, igual que
-- `editado_por`/`editado_at` de la migración 006 marcan una corrección. Acá la
-- distinción importa además para permisos: el nuevo DELETE
-- (`/recepciones/:id/items/:itemId/admin`) solo puede borrar un renglón que
-- tenga alguna de las dos columnas cargada — así el admin deshace lo que él
-- mismo agregó, y nunca un renglón del recibidor o de la plantilla.
--
-- Las dos columnas son NULLABLE y ningún INSERT/UPDATE existente las toca:
-- `agregarAdicional` (recibidor), `guardarBorrador`, `editarItem`,
-- `homologarAdicional` y el costeo siguen escribiendo exactamente las mismas
-- columnas que hoy. Si el backend con este código llegara a desplegarse ANTES
-- de correr esta migración en Supabase, lo único que falla es el endpoint
-- nuevo (`agregarRenglonAdmin` intentaría escribir una columna inexistente y
-- Postgres lo rechazaría con 42703/PGRST204) — el resto del flujo de
-- recepciones, costeo y SIESA sigue funcionando igual que antes de este
-- cambio.
-- =============================================================================

ALTER TABLE carnes_recepcion_items
  ADD COLUMN IF NOT EXISTS agregado_por VARCHAR(150),
  ADD COLUMN IF NOT EXISTS agregado_at  TIMESTAMPTZ;

COMMENT ON COLUMN carnes_recepcion_items.agregado_por IS
  'Correo del admin que agregó este renglón después del cierre (fuera de plantilla). NULL = lo agregó el recibidor o es de plantilla.';
COMMENT ON COLUMN carnes_recepcion_items.agregado_at IS
  'Cuándo lo agregó el admin. NULL = lo agregó el recibidor o es de plantilla.';
