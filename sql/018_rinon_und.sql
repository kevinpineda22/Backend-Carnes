-- =============================================================================
-- Migration 018: el Riñón (15188) entra a SIESA en UND, no en KL
-- =============================================================================
--
-- ─── Por qué ────────────────────────────────────────────────────────────────
--
-- El 29/09/2026 la oficial de la liquidación #10 (TC OFI L10) volvió con HTTP
-- 400: "Movto Inventario: La unidad de medida en el registro no existe", valor
-- "KL", en 9 líneas del plano. Cada una cae dos líneas después de un renglón
-- del ítem 15188 (las dos de encabezado del plano): en SIESA el Riñón está
-- creado en UND. Con un 400 SIESA rechaza el plano entero, así que no entró
-- nada y el envío quedó en 'error', que no bloquea el reenvío.
--
-- El encargado confirmó: UND, con decimales. La cantidad sigue siendo
-- factor_novillo × novillos (1,33333 × novillos) y el precio el del catálogo;
-- solo cambia la unidad. El valor del renglón no se mueve.
--
-- ─── Qué actualiza ──────────────────────────────────────────────────────────
--
-- 1. El catálogo de res: `unidad = 'UND'` para Riñon. Es lo que copian las
--    recepciones que se abran de acá en adelante.
-- 2. Los renglones YA CREADOS del Riñón (snapshot de la 016), en recepciones que
--    todavía no subieron su oficial: Borrador, Recibido, Aprobado y también
--    Costeado, porque la liquidación #10 está costeada esperando reenviar. Solo
--    la columna `unidad`: cantidad, costo base y costo ajustado quedan igual,
--    así que el costeo no hay que repetirlo. Enviado_SIESA no se toca: esos
--    documentos ya existen en el ERP con lo que tenían.
--
-- No hace falta desplegar código: `armarEntradaDirecta` ya manda
-- `UNIDAD_MEDIDA` por renglón desde `carnes_recepcion_items.unidad`.
--
-- Idempotente y en una transacción.
-- =============================================================================

BEGIN;

UPDATE carnes_viceras_items
   SET unidad = 'UND'
 WHERE especie = 'res' AND nombre = 'Riñon' AND unidad <> 'UND';

UPDATE carnes_recepcion_items ri
   SET unidad = 'UND'
  FROM carnes_viceras_items v, carnes_recepciones r
 WHERE ri.vicera_item_id = v.id
   AND v.especie = 'res' AND v.nombre = 'Riñon'
   AND ri.recepcion_id = r.id
   AND r.estado IN ('Borrador', 'Recibido', 'Aprobado', 'Costeado')
   AND ri.unidad <> 'UND';

COMMIT;

-- Verificación: tiene que devolver una fila por recepción abierta o costeada
-- con el Riñón en UND, y ninguna en KL.
-- SELECT r.id, r.estado, ri.descripcion, ri.unidad, ri.cantidad
--   FROM carnes_recepcion_items ri
--   JOIN carnes_recepciones r ON r.id = ri.recepcion_id
--  WHERE ri.descripcion = 'Riñon' AND r.estado <> 'Enviado_SIESA'
--  ORDER BY r.id;
