-- =============================================================================
-- Migration 022: recibidor de proveedores (recepción de facturas de proveedor)
-- =============================================================================
--
-- Hasta hoy el recibidor solo recibe la carne de los talleres (carnes_recepciones,
-- sql/001). Esta migración agrega el segundo modo: recibir la mercancía que llega
-- con FACTURA de un proveedor externo (pollo, embutidos, etc.), con su valor, y
-- mandarla a SIESA como entrada CEA.
--
-- Las tablas son APARTE de carnes_recepciones a propósito: una recepción de
-- proveedor nunca se puede ligar a una liquidación de Talleres, y los contadores y
-- candidatos de Talleres no la ven. Nada de lo que ya existe cambia.
--
-- ─── Qué crea ────────────────────────────────────────────────────────────────
--
--   1. carnes_proveedores                 — el maestro de proveedores (NIT + sucursal).
--   2. carnes_proveedor_equivalencias     — la plantilla: qué ítems de SIESA recibe
--                                           cada proveedor y cómo los llama.
--   3. carnes_recibidores                 — quién puede firmar "recibí" (editable por
--                                           el admin) + la siembra de las 17 personas.
--   4. carnes_proveedor_recepciones       — la cabecera de cada factura recibida.
--   5. carnes_proveedor_recepcion_items   — los renglones, con cantidad y valor.
--   6. Un trigger que congela los renglones cuando la recepción sale de Borrador.
--   7. Los triggers de updated_at de las cinco tablas nuevas.
--
-- NO toca carnes_siesa_envios: el vínculo con los envíos a SIESA (tipos
-- 'entrada_proveedor' y 'nc_proveedor') va en sql/023, junto con el código que
-- lo usa.
--
-- ─── Decisiones que conviene no perder ───────────────────────────────────────
--
--   · `equivalencia` es NOT NULL DEFAULT '' (nunca NULL). '' significa "Sin
--     equivalencia". Así el UNIQUE normal de la plantilla sirve de objetivo de un
--     upsert (`onConflict`) y una re-carga del Excel cae sobre la misma fila: con
--     NULL, cada fila sería distinta y se duplicaría en cada corrida.
--
--   · La factura se guarda DOS veces: `factura` (lo que se ve) y `factura_clave`
--     (mayúsculas, solo letras y dígitos: "FE-00123" y " fe 00123 " chocan). La
--     llave única usa la clave, no el texto.
--
--   · `factura_siesa` es la referencia que va a SIESA cuando la factura no cabe en
--     los 12 caracteres de PENDIENTE (la corrige un admin DESPUÉS de firmar). La
--     llave única mira coalesce(factura_siesa_clave, factura_clave) para que la
--     referencia corregida tampoco choque con la de otra recepción.
--
--   · El valor NO se guarda derivado dos veces: no hay `valor_devuelto`. Se calcula
--     (proporcional a lo devuelto) al finalizar y al armar los documentos, así que
--     nunca queda viejo respecto de la cantidad.
--
--   · `fecha_recepcion` NO tiene DEFAULT. `current_date` en la base es UTC y
--     después de las 7 p. m. en Colombia ya es "mañana": el backend la calcula con
--     hoyBogota(). Sin default, olvidarlo falla fuerte en vez de guardar mal.
--
--   · La firma es una imagen PNG (data URL) en la misma fila que pasa a
--     Finalizada: una sola actualización condicional, sin subir nada a un bucket
--     que no se pueda deshacer junto con la fila. Las consultas de lista deben
--     nombrar columnas y NO traer `firma_data`.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/001 (función carnes_set_updated_at) y sql/007 (bodega_siesa)
--   2. sql/022_proveedores.sql   ← esta, ANTES del backend
--   3. Backend
--   4. Frontend (con la bandera VITE_CARNES_RECIBIDOR_PROVEEDORES apagada hasta el
--      último corte)
--
-- ─── Qué falla si NO se corre antes del backend ──────────────────────────────
--
--   · Los endpoints nuevos de proveedores y recibidores responden error de tabla
--     inexistente. Talleres sigue igual: no comparte nada con estas tablas.
--
-- Idempotente: se puede correr dos veces. Todo o nada.
-- =============================================================================

BEGIN;

-- 0. Precondiciones: sql/001 (función de updated_at) y sql/007 (bodega_siesa).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'carnes_set_updated_at'
  ) THEN
    RAISE EXCEPTION
      'Falta la función carnes_set_updated_at (sql/001_create_tables.sql). '
      'Correla antes de esta migración.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'carnes_sedes' AND column_name = 'bodega_siesa'
  ) THEN
    RAISE EXCEPTION
      'Falta sql/007_siesa.sql (columna carnes_sedes.bodega_siesa). '
      'Correla antes de esta migración.';
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 1. carnes_proveedores — El maestro de proveedores
-- ---------------------------------------------------------------------------
--
-- El tercero de SIESA se identifica por NIT + sucursal. El NIT llega de Excel con
-- espacios al final; el CHECK obliga a guardarlo ya recortado para que el
-- UNIQUE (nit, sucursal) sea real y no dos filas "iguales" con un espacio.
CREATE TABLE IF NOT EXISTS carnes_proveedores (
  id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  nit            VARCHAR(15)   NOT NULL,
  sucursal       VARCHAR(3)    NOT NULL DEFAULT '001',
  razon_social   VARCHAR(160)  NOT NULL,
  desc_sucursal  VARCHAR(120),
  activo         BOOLEAN       NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT carnes_proveedores_nit_limpio
    CHECK (nit = btrim(nit) AND nit <> ''),
  CONSTRAINT uq_carnes_proveedores_nit_sucursal
    UNIQUE (nit, sucursal)
);


-- ---------------------------------------------------------------------------
-- 2. carnes_proveedor_equivalencias — La plantilla de cada proveedor
-- ---------------------------------------------------------------------------
--
-- Una fila = un renglón que el recibidor ve al abrir una factura de ese
-- proveedor. Espejo del Excel "Equivalencias": Item / Desc. item / U.M. de SIESA
-- y el nombre que el proveedor le da en su factura (`equivalencia`).
--
-- `codigo_item` es el f120_id de SIESA como TEXTO (en Excel llega a veces como
-- número). No es único por proveedor: el mismo Item puede venir en KL y en UND, o
-- con dos equivalencias distintas. Por eso el UNIQUE es de las cuatro columnas.
--
-- Es un UNIQUE normal (constraint), no un índice de expresión: PostgREST solo
-- acepta columnas simples como objetivo de `onConflict`.
--
-- `equivalencia` '' = "Sin equivalencia" (Bucanero, por ejemplo, no trae esa
-- columna). Se muestra con la descripción de SIESA y una etiqueta, pero el
-- renglón SE RECIBE y SE ENVÍA a SIESA igual que los demás.
--
-- Una plantilla nunca se borra: lo que sale del Excel se desactiva (`activo`),
-- así las recepciones ya hechas siguen apuntando a su fila.
CREATE TABLE IF NOT EXISTS carnes_proveedor_equivalencias (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  proveedor_id      BIGINT        NOT NULL REFERENCES carnes_proveedores(id) ON DELETE CASCADE,
  codigo_item       VARCHAR(20)   NOT NULL,
  descripcion_item  VARCHAR(160),
  unidad            VARCHAR(4)    NOT NULL,
  equivalencia      VARCHAR(160)  NOT NULL DEFAULT '',
  orden             INTEGER       NOT NULL DEFAULT 0,
  activo            BOOLEAN       NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT uq_carnes_prov_equiv_fila
    UNIQUE (proveedor_id, codigo_item, unidad, equivalencia)
);

COMMENT ON COLUMN carnes_proveedor_equivalencias.equivalencia IS
  'Nombre del ítem en la factura del proveedor. Vacío ('''') = "Sin equivalencia": el renglón se recibe y se envía a SIESA igual, solo cambia cómo se muestra.';


-- ---------------------------------------------------------------------------
-- 3. carnes_recibidores — Quién puede firmar "recibí"
-- ---------------------------------------------------------------------------
--
-- La lista que se ofrece al finalizar. La edita el admin desde el panel, sin
-- desplegar código. Borrar = desactivar (`activo`): la recepción guarda su propia
-- copia (cédula + nombre), así que renombrar o desactivar a alguien no reescribe
-- lo que ya firmó.
--
-- La cédula es UNIQUE: es lo que identifica a la persona y lo que permite
-- re-sembrar sin duplicar.
CREATE TABLE IF NOT EXISTS carnes_recibidores (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cedula      VARCHAR(15)   NOT NULL,
  nombre      VARCHAR(120)  NOT NULL,
  activo      BOOLEAN       NOT NULL DEFAULT true,
  orden       INTEGER       NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT carnes_recibidores_cedula_limpia
    CHECK (cedula = btrim(cedula) AND cedula <> ''),
  CONSTRAINT uq_carnes_recibidores_cedula
    UNIQUE (cedula)
);

-- La siembra: las 17 personas que hoy reciben. DO NOTHING (no DO UPDATE): si el
-- admin ya editó un nombre o desactivó a alguien, volver a correr esta migración
-- no le deshace el cambio.
INSERT INTO carnes_recibidores (cedula, nombre, orden)
VALUES
  ('70139437',   'SANCHEZ AGUDELO JUAN FERNANDO',    1),
  ('39358111',   'CAVADIA PINTO ELVIA ESTHER',       2),
  ('1035869866', 'ALZATE BARRIENTOS MANUELA',        3),
  ('1035231030', 'GAVIRIA PEREZ MANUELA',            4),
  ('6477871',    'GONZALEZ BARON ARMANDO JOSE',      5),
  ('43917420',   'NARANJO ARIAS MARTHA LUCIA',       6),
  ('1035854902', 'CASTRILLON BUSTAMANTE ELIANA',     7),
  ('1202833',    'SALAZAR ZAMBRANO ELIANA MARLIN',   8),
  ('1017141958', 'LOPERA LOPERA VIVIANA MARCELA',    9),
  ('1017928298', 'SALDARRIAGA ZULETA JUAN JOSE',    10),
  ('1007633858', 'HINCAPIE MONTOYA ANDRES FELIPE',  11),
  ('1000396030', 'CHAVARRIA PEREZ EMMANUEL',        12),
  ('91160748',   'MARTINEZ ARREDONDO JUAN SEBASTIAN', 13),
  ('1193233099', 'MORENO JIMENEZ ALEJANDRA NORELA', 14),
  ('8164356',    'RODRIGUEZ IBARBO ANDRES FELIPE',  15),
  ('1039884623', 'MARIN BEDOYA CLAUDIA CENAIDA',    16),
  ('1000920513', 'MUÑOZ JARAMILLO ROBINSON FERNANDO', 17)
ON CONFLICT (cedula) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 4. carnes_proveedor_recepciones — La cabecera de cada factura recibida
-- ---------------------------------------------------------------------------
--
-- Estados:
--   · Borrador      — el recibidor está contando; se autoguarda.
--   · Finalizada    — firmada. Desde aquí los renglones son inmutables.
--   · Enviada_SIESA — la entrada CEA ya entró a SIESA.
--   · Anulada       — un admin la anuló (después de anularla en SIESA si hacía
--                     falta). Libera la llave de la factura para volver a recibirla.
--
-- Todo lo que SIESA necesita se guarda como SNAPSHOT (NIT, sucursal, razón
-- social, bodega, C.O., recibidor): si mañana se corrige el maestro, lo que ya se
-- mandó no cambia de valor. El backend refresca esos snapshots al finalizar y en
-- cada reintento mientras NO haya una entrada aceptada.
--
-- `recibido_por` es el correo de la sesión (quién tenía el teléfono);
-- `recibidor_*` es quién firma como "recibí" (puede ser otra persona, o "Otro"
-- con nombre y cédula escritos a mano).
--
-- El CHECK final garantiza que nada sale de Borrador sin recibidor y firma, así
-- un bug del backend no puede dejar una recepción "Finalizada" sin firmar.
CREATE TABLE IF NOT EXISTS carnes_proveedor_recepciones (
  id                      BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,

  proveedor_id            BIGINT        NOT NULL REFERENCES carnes_proveedores(id) ON DELETE RESTRICT,
  proveedor_nit           VARCHAR(15)   NOT NULL,
  proveedor_sucursal      VARCHAR(3)    NOT NULL,
  proveedor_razon_social  VARCHAR(160)  NOT NULL,

  factura                 VARCHAR(40)   NOT NULL,
  factura_clave           VARCHAR(40)   NOT NULL,
  -- La referencia que se manda a SIESA cuando `factura` no cabe en 12 caracteres.
  -- NULL = se usa `factura`.
  factura_siesa           VARCHAR(40),
  factura_siesa_clave     VARCHAR(40),

  sede_id                 BIGINT        NOT NULL REFERENCES carnes_sedes(id),
  bodega_siesa            VARCHAR(5),
  codigo_co               VARCHAR(10),
  fecha_recepcion         DATE          NOT NULL,

  estado                  VARCHAR(20)   NOT NULL DEFAULT 'Borrador',

  -- Trazabilidad del recibidor
  recibido_por            VARCHAR(150),              -- correo de la sesión
  abierto_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  recibidor_id            BIGINT        REFERENCES carnes_recibidores(id) ON DELETE SET NULL,
  recibidor_cedula        VARCHAR(15),
  recibidor_nombre        VARCHAR(120),
  recibidor_otro          BOOLEAN       NOT NULL DEFAULT false,
  firma_data              TEXT,                      -- PNG como data URL
  finalizado_at           TIMESTAMPTZ,
  siesa_at                TIMESTAMPTZ,

  observaciones           TEXT,

  -- Anulación (admin)
  anulado_por             VARCHAR(150),
  anulado_at              TIMESTAMPTZ,
  motivo_anulacion        TEXT,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT carnes_prov_rec_estado_check
    CHECK (estado IN ('Borrador', 'Finalizada', 'Enviada_SIESA', 'Anulada')),

  -- Una clave vacía ("---" o "  " normalizados) haría chocar entre sí a todas las
  -- facturas "sin número" de un proveedor, o peor: dejaría pasar un duplicado.
  CONSTRAINT carnes_prov_rec_factura_clave_no_vacia
    CHECK (factura_clave <> ''),
  CONSTRAINT carnes_prov_rec_factura_siesa_clave_no_vacia
    CHECK (factura_siesa_clave IS NULL OR factura_siesa_clave <> ''),

  CONSTRAINT carnes_prov_rec_firmada_check
    CHECK (
      estado = 'Borrador'
      OR (recibidor_cedula IS NOT NULL
          AND recibidor_nombre IS NOT NULL
          AND firma_data IS NOT NULL)
    )
);

-- La llave de la factura: una sola recepción viva por (proveedor, referencia).
--
--   · La referencia es la que VE SIESA: factura_siesa_clave si un admin la
--     corrigió, si no factura_clave. Con una sola llave simétrica, la referencia
--     corregida tampoco puede chocar con la factura de otra recepción.
--   · Anulada no cuenta: anular es el camino legítimo para volver a recibir la
--     misma factura.
--   · Es lo que resuelve la carrera de dos teléfonos abriendo la misma factura a
--     la vez: uno inserta, el otro recibe 23505 y el backend le contesta con el
--     mensaje de duplicado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_prov_rec_factura_vigente
  ON carnes_proveedor_recepciones
    (proveedor_id, (coalesce(factura_siesa_clave, factura_clave)))
  WHERE estado <> 'Anulada';

-- La factura ORIGINAL también sigue ocupada después de corregir la referencia.
-- La llave de arriba solo mira la referencia que ve SIESA: si un admin corrige
-- la factura "FEV-2026-000123" a "F123", la original deja de estar en esa llave
-- y el mismo papel se podría volver a recibir. Esta segunda llave lo impide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_carnes_prov_rec_factura_original
  ON carnes_proveedor_recepciones (proveedor_id, factura_clave)
  WHERE estado <> 'Anulada';

-- El listado del admin filtra por estado y ordena por fecha.
CREATE INDEX IF NOT EXISTS idx_carnes_prov_rec_estado_fecha
  ON carnes_proveedor_recepciones (estado, fecha_recepcion DESC);

COMMENT ON COLUMN carnes_proveedor_recepciones.factura_siesa IS
  'Referencia corregida por un admin para SIESA cuando la factura no cabe en los 12 caracteres de PENDIENTE. NULL = se usa `factura`. La factura original no se modifica.';
COMMENT ON COLUMN carnes_proveedor_recepciones.firma_data IS
  'Firma del recibidor como PNG en data URL. Las consultas de lista no deben traerla.';


-- ---------------------------------------------------------------------------
-- 5. carnes_proveedor_recepcion_items — Los renglones
-- ---------------------------------------------------------------------------
--
-- Un renglón por fila de la plantilla, materializado al abrir la recepción. Todo
-- lo que identifica el ítem (codigo_item, descripcion_item, unidad, equivalencia)
-- es SNAPSHOT: editar la plantilla no cambia una recepción ya abierta.
-- `equivalencia_id` solo dice de dónde salió y pasa a NULL si la fila de la
-- plantilla se borra.
--
-- UNIQUE (recepcion_id, equivalencia_id): una fila de la plantilla aparece una
-- sola vez por recepción. Permite reabrir/reanudar sin duplicar renglones (el
-- insert ignora el conflicto). Los NULL (plantilla borrada) no chocan entre sí.
--
-- ─── Dinero ──────────────────────────────────────────────────────────────────
--   · `valor_unitario` NUMERIC(16,4): hasta 4 decimales (total / cantidad).
--   · `valor_total`    NUMERIC(16,2): pesos enteros (se redondea antes de guardar).
--   · `valor_fuente`: cuál de los dos digitó la persona; el otro se deriva. Si
--     cambia la cantidad, se recalcula el lado derivado.
--   · Son valores BRUTOS, sin IVA ni descuentos.
--
-- ─── Confirmaciones (quién y cuándo, atadas al valor exacto) ─────────────────
--   · 800 KL: una cantidad en KL por encima de 800 exige confirmación.
--     `exceso_confirmado_cantidad` guarda la cantidad confirmada; solo vale si es
--     igual a la cantidad actual (confirmar 850 y luego editar a 8500 vuelve a
--     preguntar).
--   · Valor unitario implausible (fuera del rango de la regla compartida):
--     `valor_confirmado_unitario` guarda el unitario confirmado; solo vale si es
--     igual al unitario actual. Atrapa "20" digitado por "20.000": la entrada a
--     SIESA sale sola al finalizar, sin revisión del admin.
--   El autoguardado ACEPTA y guarda la fila sin confirmar (nunca se pierde lo
--   digitado); finalizar es quien la rechaza.
--
-- ─── Devolución en el mismo renglón ──────────────────────────────────────────
--   `cantidad_devuelta` <= `cantidad` y `motivo_devolucion` obligatorio si > 0 se
--   exigen al FINALIZAR, no aquí: el autoguardado puede pasar por estados
--   intermedios (devuelta escrita antes que la cantidad). No existe una columna
--   `valor_devuelto`: se calcula, así nunca queda vieja.
CREATE TABLE IF NOT EXISTS carnes_proveedor_recepcion_items (
  id                           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  recepcion_id                 BIGINT        NOT NULL REFERENCES carnes_proveedor_recepciones(id) ON DELETE CASCADE,
  equivalencia_id              BIGINT        REFERENCES carnes_proveedor_equivalencias(id) ON DELETE SET NULL,

  codigo_item                  VARCHAR(20)   NOT NULL,
  descripcion_item             VARCHAR(160),
  unidad                       VARCHAR(4)    NOT NULL,
  equivalencia                 VARCHAR(160)  NOT NULL DEFAULT '',
  orden                        INTEGER       NOT NULL DEFAULT 0,

  cantidad                     NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
  valor_unitario               NUMERIC(16,4) CHECK (valor_unitario >= 0),
  valor_total                  NUMERIC(16,2) CHECK (valor_total >= 0),
  valor_fuente                 VARCHAR(8)    CHECK (valor_fuente IN ('unitario', 'total')),

  -- Confirmación de más de 800 KL
  exceso_confirmado_cantidad   NUMERIC(12,3),
  exceso_confirmado_por        VARCHAR(150),
  exceso_confirmado_at         TIMESTAMPTZ,

  -- Confirmación de valor unitario implausible
  valor_confirmado_unitario    NUMERIC(16,4),
  valor_confirmado_por         VARCHAR(150),
  valor_confirmado_at          TIMESTAMPTZ,

  -- Devolución
  cantidad_devuelta            NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (cantidad_devuelta >= 0),
  motivo_devolucion            TEXT,

  created_at                   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT uq_carnes_prov_rec_items_equivalencia
    UNIQUE (recepcion_id, equivalencia_id)
);

CREATE INDEX IF NOT EXISTS idx_carnes_prov_rec_items_recepcion
  ON carnes_proveedor_recepcion_items (recepcion_id, orden);


-- ---------------------------------------------------------------------------
-- 6. El guardián de los renglones
-- ---------------------------------------------------------------------------
--
-- Los renglones solo se escriben mientras la cabecera está en Borrador. Que lo
-- diga el backend no alcanza: el autoguardado y el finalizar corren en peticiones
-- distintas, y una petición de autoguardado que llega DESPUÉS de firmar pisaría
-- cantidades ya firmadas y enviadas a SIESA. Esto lo impide en la misma escritura.
--
--   1. Lee y BLOQUEA la cabecera (FOR UPDATE). Finalizar hace su actualización
--      condicional sobre esa misma fila, así que las dos escrituras se
--      serializan: o el renglón entra antes de firmar, o es rechazado.
--   2. Si no está en Borrador, levanta un error con SQLSTATE propio 'PV409' (el
--      backend lo traduce a 409 "La recepción ya no está en borrador").
--   3. Toca `updated_at` de la cabecera: el finalizar compara ese valor que leyó
--      contra el actual, y así detecta que un renglón cambió mientras firmaban.
--
-- Casos en que NO debe hacer nada:
--   · UPDATE que no cambia ninguna columna (IS NOT DISTINCT FROM, que trata NULL
--     como igual a NULL): no hay escritura real, no hay por qué bloquear ni tocar
--     la cabecera.
--   · UPDATE cuyo único cambio es equivalencia_id -> NULL: es el ON DELETE SET
--     NULL de la plantilla. Borrar una fila de la plantilla no debe fallar porque
--     alguna recepción vieja ya firmada la referencie.
--
-- Orden de disparo: los triggers BEFORE corren por orden alfabético. Este
-- ('carnes_proveedor_items_guard') va antes que 'set_updated_at_*', así que ve la
-- fila tal como llega, sin el updated_at ya modificado.
CREATE OR REPLACE FUNCTION carnes_proveedor_items_guard()
RETURNS TRIGGER AS $fn$
DECLARE
  v_estado VARCHAR(20);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;

    -- Solo equivalencia_id pasó de un valor a NULL (ON DELETE SET NULL).
    IF OLD.equivalencia_id IS NOT NULL
       AND NEW.equivalencia_id IS NULL
       AND (to_jsonb(NEW) - 'equivalencia_id') = (to_jsonb(OLD) - 'equivalencia_id')
    THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT estado INTO v_estado
  FROM carnes_proveedor_recepciones
  WHERE id = NEW.recepcion_id
  FOR UPDATE;

  -- Cabecera inexistente: que lo reporte la llave foránea, con su mensaje.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_estado <> 'Borrador' THEN
    RAISE EXCEPTION 'La recepción % ya no está en borrador (estado %).',
      NEW.recepcion_id, v_estado
      USING ERRCODE = 'PV409',
            HINT = 'Los renglones solo se pueden escribir mientras la recepción está en Borrador.';
  END IF;

  UPDATE carnes_proveedor_recepciones
  SET updated_at = now()
  WHERE id = NEW.recepcion_id;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS carnes_proveedor_items_guard
  ON carnes_proveedor_recepcion_items;

CREATE TRIGGER carnes_proveedor_items_guard
  BEFORE INSERT OR UPDATE ON carnes_proveedor_recepcion_items
  FOR EACH ROW EXECUTE FUNCTION carnes_proveedor_items_guard();


-- ---------------------------------------------------------------------------
-- 7. updated_at automático en las tablas nuevas
-- ---------------------------------------------------------------------------
--
-- El loop de sql/001 solo cubre las tablas que existían entonces: las nuevas
-- necesitan su trigger explícito, si no `updated_at` se queda en el valor de la
-- creación y el chequeo optimista del finalizar no detecta cambios.
DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'carnes_proveedores',
    'carnes_proveedor_equivalencias',
    'carnes_recibidores',
    'carnes_proveedor_recepciones',
    'carnes_proveedor_recepcion_items'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'set_updated_at_' || t
        AND tgrelid = t::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION carnes_set_updated_at()',
        'set_updated_at_' || t, t
      );
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
