-- =============================================================================
-- Migration 036: foto de la factura en las recepciones de proveedor
-- =============================================================================
--
-- El recibidor adjunta la foto (o PDF) de la factura antes de firmar. Son de 1 a 5
-- archivos de hasta 10 MB; sin al menos uno vinculado el backend no deja finalizar.
--
--   factura_archivos  jsonb NOT NULL DEFAULT '[]'. Arreglo de objetos:
--                       { path, nombre, tipo, tamano, subido_at, subido_por }
--                     `path` es la ruta dentro del bucket privado
--                     `carnes-facturas-proveedor`: `recepcion-<id>/<timestamp>-<n>.<ext>`.
--
-- Las recepciones que ya existen quedan con '[]' (sin factura): los listados las
-- muestran como "Sin factura" y NO se bloquea nada sobre ellas. La exigencia aplica
-- solo al finalizar un borrador.
--
-- Bucket: PRIVADO, 10 MB por archivo, solo imágenes y PDF. Los archivos se suben
-- DIRECTO desde el navegador con URLs firmadas que genera el backend (Vercel no deja
-- pasar 10 MB por una función) y se leen con URLs firmadas de 10 minutos.
--
-- Idempotente: se puede correr más de una vez. Si el bucket ya existe, se
-- actualizan su límite y sus tipos permitidos.
-- ORDEN: correr ANTES de desplegar el backend. El listado, el detalle y el borrador
-- ahora piden `factura_archivos`; sin la columna responden 503 "A la base le falta
-- sql/036_...". Y desplegar el backend ANTES del front (el front nuevo llama a
-- endpoints que un backend viejo no tiene).
-- =============================================================================

-- 1. Columna de metadatos ---------------------------------------------------

ALTER TABLE carnes_proveedor_recepciones
  ADD COLUMN IF NOT EXISTS factura_archivos jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN carnes_proveedor_recepciones.factura_archivos IS
  'Archivos de la foto de la factura (1 a 5): [{path, nombre, tipo, tamano, subido_at, subido_por}]. path = ruta en el bucket carnes-facturas-proveedor. [] = sin factura (recepciones anteriores a sql/036).';

-- Debe ser un arreglo con a lo sumo 5 elementos (el backend también lo valida).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'carnes_prov_rec_factura_archivos_check'
  ) THEN
    ALTER TABLE carnes_proveedor_recepciones
      ADD CONSTRAINT carnes_prov_rec_factura_archivos_check
      CHECK (jsonb_typeof(factura_archivos) = 'array' AND jsonb_array_length(factura_archivos) <= 5);
  END IF;
END $$;

-- 2. Bucket privado ----------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'carnes-facturas-proveedor',
  'carnes-facturas-proveedor',
  false,
  10485760,  -- 10 MB
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public             = false,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- No se crean políticas sobre storage.objects: el bucket es privado y TODO acceso
-- pasa por el backend (service role): URLs firmadas de subida y de lectura.

-- 3. Verificación (solo lectura) ---------------------------------------------

-- Debe salir la columna jsonb con default '[]'.
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'carnes_proveedor_recepciones'
  AND column_name = 'factura_archivos';

-- Debe salir el bucket con public = false, 10485760 y los 6 tipos.
SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'carnes-facturas-proveedor';

-- Debe dar 0: ninguna recepción con algo que no sea un arreglo.
SELECT count(*) AS filas_invalidas
FROM carnes_proveedor_recepciones
WHERE jsonb_typeof(factura_archivos) <> 'array';
