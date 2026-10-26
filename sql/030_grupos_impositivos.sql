-- =============================================================================
-- Migration 030: grupos impositivos de SIESA e IVA por renglón (proveedores)
-- =============================================================================
--
-- El recibidor digita el valor de cada renglón ANTES de IVA. Para mostrar cuánto
-- se le debe al proveedor (subtotal - descuento + IVA) hace falta el IVA de cada
-- ítem, y ese vive en SIESA: cada ítem pertenece a un "grupo impositivo" y cada
-- grupo trae su tarifa de IVA.
--
-- ─── Qué crea ────────────────────────────────────────────────────────────────
--
--   carnes_grupos_impositivos       Los grupos de SIESA con sus tarifas (semilla de
--                                   abajo, sacada de "Grupos impositivos.xlsx").
--                                   Guarda también las banderas IPCU / ICO / IBUA.
--                                   HOY solo se usa el IVA; las banderas se guardan
--                                   para cuando se calculen esos impuestos.
--
--   carnes_items_grupo_impositivo   Ítem -> grupo, copiado de la consulta de Connekta
--                                   `merkahorro_items_dev_recibo_machado`. La llena
--                                   la sincronización (POST /api/proveedores/
--                                   grupos-impositivos/sincronizar). `actualizado_at`
--                                   es la hora del último upsert de la fila: el
--                                   MAX de la tabla es "la última sincronización".
--
--   carnes_proveedor_recepcion_items
--     · grupo_impositivo   código del grupo del ítem AL ABRIR (snapshot, 4 caracteres)
--     · iva_pct            tarifa de IVA de ese grupo al abrir (snapshot)
--
--   Los renglones se abren (plantilla y cortes adicionales) con estos dos campos
--   copiados: cambiar después la tarifa del grupo no altera recepciones ya abiertas.
--   NULL = sin dato (renglones históricos, o ítem que no está en la sincronización):
--   el sistema lo muestra como "sin dato" y NO bloquea finalizar.
--
-- `valor_total` de los renglones sigue siendo BRUTO y antes de IVA, y lo que se manda
-- a SIESA no cambia: SIESA calcula los impuestos desde el ítem. El IVA de acá es solo
-- para mostrar y validar el total de la factura.
--
-- ─── Orden de despliegue ─────────────────────────────────────────────────────
--
--   1. sql/030_grupos_impositivos.sql   ← esta, ANTES del backend (el backend nuevo
--                                         lee y escribe las columnas nuevas)
--   2. Backend
--   3. Frontend
--   4. Sincronizar una vez (botón en el admin de proveedores) para llenar
--      carnes_items_grupo_impositivo. Sin ese paso todos los renglones nuevos salen
--      "Sin grupo impositivo".
--
-- Es ADITIVA e idempotente: tablas nuevas, dos columnas nulas y una semilla con
-- upsert. Se puede correr más de una vez (la semilla vuelve a dejar las tarifas
-- como están en este archivo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS carnes_grupos_impositivos (
  codigo       VARCHAR(4)    PRIMARY KEY,
  descripcion  VARCHAR(160)  NOT NULL,
  iva_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (iva_pct >= 0 AND iva_pct < 100),
  -- Banderas de los otros impuestos del grupo (columnas IPCU / ICO / IBUA del Excel).
  tiene_ipcu   BOOLEAN       NOT NULL DEFAULT false,
  tiene_ico    BOOLEAN       NOT NULL DEFAULT false,
  tiene_ibua   BOOLEAN       NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carnes_items_grupo_impositivo (
  codigo_item       VARCHAR(20)   PRIMARY KEY,
  -- Sin FK a propósito: un grupo nuevo en SIESA que todavía no está en la tabla de
  -- arriba no debe tumbar la sincronización completa. Se reporta como desconocido.
  grupo_impositivo  VARCHAR(4),
  descripcion_item  VARCHAR(160),
  actualizado_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carnes_items_grupo_imp_grupo
  ON carnes_items_grupo_impositivo (grupo_impositivo);

ALTER TABLE carnes_proveedor_recepcion_items
  ADD COLUMN IF NOT EXISTS grupo_impositivo VARCHAR(4),
  ADD COLUMN IF NOT EXISTS iva_pct NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_carnes_prov_rec_items_iva_pct'
  ) THEN
    ALTER TABLE carnes_proveedor_recepcion_items
      ADD CONSTRAINT ck_carnes_prov_rec_items_iva_pct
      CHECK (iva_pct IS NULL OR (iva_pct >= 0 AND iva_pct < 100));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Semilla: grupos impositivos (Excel "Grupos impositivos.xlsx", Hoja 1)
-- -----------------------------------------------------------------------------
--
-- El código '007 ' del Excel (con espacio) se normalizó a '0007'.
-- Las columnas ICO / IPCU / IBUA del Excel ('SI' o vacío) pasaron a booleanos.
--
-- PARA CONFIRMAR: el grupo 1914 dice "IVA 5% ..." en la descripción pero su columna
-- IVA del Excel trae 19. Se dejó 19, tal como viene en la columna. Si es 5, corregir
-- el valor en la fila de abajo y volver a correr este archivo.
INSERT INTO carnes_grupos_impositivos (codigo, descripcion, iva_pct, tiene_ipcu, tiene_ico, tiene_ibua)
VALUES
  ('0000', 'SIN IVA SIN RETENCION', 0, false, false, false),
  ('0001', 'SIN IVA RF 2.5/3.5 COMPRAS R/ICA', 0, false, false, false),
  ('0002', 'SIN IVA RF 1% SERVICIO DE CARGA', 0, false, false, false),
  ('0003', 'SIN IVA RF 4/6% SERVICIOS GENERALES', 0, false, false, false),
  ('0004', 'SIN IVA RF 2% CONTRATOS DE CONSTRUCCION', 0, false, false, false),
  ('0005', 'SIN IVA RF 1% SERVICIOS TEMPORALES', 0, false, false, false),
  ('0006', 'SIN IVA RF 2% ASEO Y VIGILANCIA', 0, false, false, false),
  ('0008', 'SIN IVA RF 3.5% HOTELES Y RESTAURANTE', 0, false, false, false),
  ('0009', 'SIN IVA RF 1.5% BIENES AGRICOLAS', 0, false, false, false),
  ('0010', 'SIN IVA RF 1.5% BIENES AGRICOLA Y FEDEPA', 0, false, false, false),
  ('0011', 'SIN IVA RF 1.5% BIENES AGRICOLA FENALCE', 0, false, false, false),
  ('0012', 'SIN IVA RF 1.5% BIENES AGRIC HORTIFRUTIC', 0, false, false, false),
  ('0013', 'SIN IVA RF 2.5/3.5 SUMINISTROS', 0, false, false, false),
  ('0014', 'SIN IVA RF 1.5% BIENES AGRI. FENALCE .75', 0, false, false, false),
  ('0007', 'SIN IVA RF 0.1% COMBUSTIBLE', 0, false, false, false),
  ('0100', 'IVA 0% RF 2.5/3.5 COMPRAS R/ICA', 0, false, false, false),
  ('0101', 'IVA 0% RF 1.5% BIENES AGRICOLAS', 0, false, false, false),
  ('0102', 'IVA 0 RTEFTE DE 3.5% LICENCIAS', 0, false, false, false),
  ('0103', 'IVA 0 RTEFTE DE 3.5% ARRENDAMIENTO BIM', 0, false, false, false),
  ('0500', 'IVA 5% SIN RETENCION BIENES', 5, false, false, false),
  ('0501', 'IVA 5% RF 2.5/3.5% COMPRAS R/ICA', 5, false, false, false),
  ('0502', 'IVA 5% RF 2.5/3.5% GASTOS', 5, false, false, false),
  ('0503', 'IVA 5% RF 4%/6% BIENES', 5, false, false, false),
  ('0504', 'IVA 5% RF 1% SERVICIOS TEMPORALES', 5, false, false, false),
  ('0505', 'IVA 5% RF 2% ASEO Y VIGILANCIA', 5, false, false, false),
  ('0506', 'IVA 5% RF 2.5/3.5% SUM', 5, false, false, false),
  ('1900', 'IVA 19% SIN RETENCION', 19, false, false, false),
  ('1901', 'IVA 19% RF 2.5/3.5% BIENES', 19, false, false, false),
  ('1902', 'IVA 19% RF 10/11% HONORARIOS', 19, false, false, false),
  ('1903', 'IVA 19% RF 10%/11% COMISION', 19, false, false, false),
  ('1904', 'IVA 19% RF 2% CONTRATO DE CONSTRUCCION', 19, false, false, false),
  ('1905', 'IVA 19% RF 2% SERVICIOS DE SALUD', 19, false, false, false),
  ('1906', 'IVA 19% RF 3.5% HOTELES Y RESTAURANTES', 19, false, false, false),
  ('1907', 'IVA 19% RF 4%/6% SERVICIOS GENERALES', 19, false, false, false),
  ('1908', 'IVA 19% RF 3.5% ARRENDAMIENTOS INMUEBLES', 19, false, false, false),
  ('1909', 'IVA 19% RF 4% BIENES MUEBLES', 19, false, false, false),
  ('1910', 'IVA 19% RF 3.5% ARRENDAMIENTO SOFTWARE', 19, false, false, false),
  ('1911', 'IVA 19% RF 2% SERVICIOS DE ASEO Y VIGILA', 19, false, false, false),
  ('1912', 'IVA 19% RF 2.5% 3.5% GASTOS', 19, false, false, false),
  ('1913', 'IVA 19% RF 2.5/3.5% BIENES IMPOCONSUMO', 19, false, true, false),
  ('1914', 'IVA 5% RF 2.5/3.5% BIENES IMPOCONSUMO', 19, false, true, false), -- OJO: la descripción dice IVA 5 % pero la columna IVA del Excel dice 19. Se dejó 19; CONFIRMAR.
  ('1915', 'IVA 19% RF 2.5/3.5% GASEOSA', 19, false, false, true),
  ('1916', 'IVA 19% RF 2.5/3.5% CERVEZA IMPOCONSUMO', 19, false, false, false),
  ('1917', 'IVA 19% RF 1% TRANPORTE FLETES Y ACARREO', 19, false, false, false),
  ('1918', 'IVA M-VALOR 19%- RF COMPRA 2,5%-3,5%', 19, false, false, false),
  ('1919', 'IVA 19% RTEIVA DEL 15% RS DE TRIBUTACION', 19, false, false, false),
  ('1920', 'IVA 19% RF 2.5/3.5% IBUA', 19, false, false, true),
  ('1921', 'IVA 5% RF 2.5/3.5% IBUA', 5, false, false, true),
  ('1922', 'IVA 19% RF 2.5/3.5% IPCU', 19, true, false, false),
  ('1923', 'IVA 5% RF 2.5/3.5% IPCU', 5, true, false, false),
  ('1924', 'IVA 19% RF 2.5/3.5% GASEOSA-IBUA', 19, false, false, true),
  ('1925', 'SIN IVA RF 2.5/3.5 COMPRAS R/ICA IPCU', 0, true, false, false),
  ('1926', 'IVA 19% RF 2.5% 3.5% SUM', 19, false, false, false)
ON CONFLICT (codigo) DO UPDATE
   SET descripcion = EXCLUDED.descripcion,
       iva_pct     = EXCLUDED.iva_pct,
       tiene_ipcu  = EXCLUDED.tiene_ipcu,
       tiene_ico   = EXCLUDED.tiene_ico,
       tiene_ibua  = EXCLUDED.tiene_ibua,
       updated_at  = now();
