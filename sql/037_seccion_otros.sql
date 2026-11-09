-- =============================================================================
-- Migration 037: tercera sección "Otros" en los renglones de proveedor
-- =============================================================================
--
-- Los proveedores con `secciones_despresado` (Bucanero) ven su plantilla en
-- secciones: "Con alas" (llave `despresado`), "Sin alas" (llave `sin_despresar`) y
-- ahora "Otros" (llave `otros`). Las llaves de las dos primeras NO cambian: solo
-- cambió la etiqueta que se muestra (la hace el código, no la base).
--
-- "Otros" contiene únicamente las filas de la plantilla cuyo nombre contiene
-- "PECHUGA" (regla `esRenglonSeccionOtros` en shared/aperturaProveedor.js).
--
--   carnes_proveedor_recepcion_items
--     · ck_carnes_prov_rec_items_seccion pasa a aceptar también 'otros':
--       CHECK (seccion IN ('', 'despresado', 'sin_despresar', 'otros'))
--
-- La llave única (recepcion_id, equivalencia_id, seccion) de sql/028 ya incluye
-- `seccion`, así que una misma fila de la plantilla puede estar en las tres
-- secciones sin cambios.
--
-- BORRADORES YA ABIERTOS: los renglones se crean al abrir la recepción, así que los
-- borradores que existen hoy NO reciben renglones de "Otros". Solo se re-crean si
-- un borrador queda SIN renglones (falló una apertura) y se reanuda: ahí se usa la
-- misma función y sí incluye "Otros". Nada se re-materializa en borradores con
-- renglones; si hace falta, descartar el borrador y abrir la factura de nuevo.
--
-- Orden de despliegue:
--
--   1. sql/037_seccion_otros.sql   ← esta, ANTES del backend (sin ella, abrir una
--                                    factura de Bucanero con pechuga falla por el CHECK)
--   2. Backend
--   3. Frontend
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

ALTER TABLE carnes_proveedor_recepcion_items
  DROP CONSTRAINT IF EXISTS ck_carnes_prov_rec_items_seccion;

ALTER TABLE carnes_proveedor_recepcion_items
  ADD CONSTRAINT ck_carnes_prov_rec_items_seccion
  CHECK (seccion IN ('', 'despresado', 'sin_despresar', 'otros'));

-- Verificación: debe listar la definición con las cuatro llaves.
SELECT conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE conname = 'ck_carnes_prov_rec_items_seccion';
