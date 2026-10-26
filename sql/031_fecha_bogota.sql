-- =============================================================================
-- Migration 031: la fecha por defecto es la de Bogotá, no la de UTC
-- =============================================================================
--
-- El problema:
--
-- `current_date` en Postgres/Supabase es UTC. Entre las 7:00 p. m. y la
-- medianoche en Colombia (UTC-5) ya es "mañana" para la base, así que una fila
-- insertada sin fecha explícita quedaba con el día siguiente (recepciones #123 y
-- #124 de Res: cerradas el 25/10 a las 7:30 p. m., con fecha 26/10).
--
-- El backend ya manda la fecha explícita (`hoyBogota()`, src/shared/fechaBogota.js)
-- y esta migración cubre el resto: inserts manuales, scripts y cualquier camino
-- futuro que se apoye en el default.
--
-- Solo cambia el DEFAULT: NO toca filas existentes (para eso, 031b).
-- `carnes_proveedor_recepciones.fecha_recepcion` no tiene default a propósito
-- (ver 022), así que no se toca.
--
-- Idempotente: se puede correr más de una vez.
-- Orden: correr ANTES o DESPUÉS del backend da igual; el backend no depende de ella.
-- =============================================================================

ALTER TABLE carnes_recepciones
  ALTER COLUMN fecha_ingreso SET DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date);

ALTER TABLE carnes_liquidaciones
  ALTER COLUMN fecha SET DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date);
