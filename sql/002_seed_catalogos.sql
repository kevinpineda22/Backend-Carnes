-- =============================================================================
-- Migration 002: Semilla de catálogos (sedes, ítems, vísceras, conceptos)
-- =============================================================================
--
-- GENERADO desde los Excel que usa el admin hoy — no transcrito a mano:
--   · "01 Septiembre 2026.xlsx"  → res
--   · "1. Principal.xlsm"        → cerdo
--
-- Es idempotente: se puede correr de nuevo sin duplicar nada.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Sedes
-- ---------------------------------------------------------------------------
--
-- `codigo_co` sale de la hoja `Lista` del archivo de cerdo, que es el ÚNICO
-- lugar donde está el mapeo sede → Centro de Operación de SIESA. El archivo de
-- res no lo tiene, y sin él no hay forma de armar el documento para SIESA.
--
-- 'Carnes Barbosa' va corregido: la hoja `Lista` dice "CARNES BABROSA". Es un
-- error de tipeo en el origen (el archivo de res la llama "Carnes Barbosa"), y
-- el nombre de la sede lo lee un humano en pantalla.
--
-- OJO con López: aparece como novena columna en `Datos ` (res) pero NO está en
-- la hoja `Sedes` ni en `Lista`, así que se queda sin C.O. Hay que conseguirlo
-- antes de que esa sede pueda subir a SIESA.
INSERT INTO carnes_sedes (codigo_co, nombre) VALUES
  ('01', 'Copacabana Principal'),
  ('02', 'Villa Hermosa'),
  ('03', 'Girardota Parque'),
  ('04', 'Girardota Llano'),
  ('05', 'Carnes Barbosa'),
  ('06', 'Las Vegas'),
  ('07', 'Supermercado Barbosa'),
  ('08', 'San Juan'),
  (NULL, 'Lopez')
ON CONFLICT (lower(nombre)) DO NOTHING;


-- ---------------------------------------------------------------------------
-- Ítems de plantilla — RES (hoja `Datos `, filas 3..40)
-- ---------------------------------------------------------------------------
--
-- `orden` = `codigo_tabla`: el Excel ya los tiene en el orden en que el admin
-- los quiere ver, y ese orden es el que va a ver el recibidor.
--
-- CHULETA DE RES (código de tabla 38) se incluye acá aunque en el Excel esté
-- MUERTA: los VLOOKUP de las hojas de sede buscan en `$B$3:$D$39` y ese ítem
-- vive en la fila 40, así que hoy nunca llega a SIESA. En la base no hay rangos,
-- hay filas, y el bug desaparece solo.
INSERT INTO carnes_plantilla_items (especie, codigo_tabla, codigo_item, descripcion, costo_base, orden) VALUES
  ('res', 1, '15167', 'CARNE PARA MOLER', 23000, 1),
  ('res', 2, '15140', 'CASCARA DE FREIR', 26215, 2),
  ('res', 3, '15141', 'CHATA DE SOLOMITO', 46149, 3),
  ('res', 4, '15167', 'COGOTE', 23000, 4),
  ('res', 5, '15145', 'COLA DE RES', 19240, 5),
  ('res', 6, '15195', 'COLITA DE EXTRANJERO', 31556, 6),
  ('res', 7, '15147', 'COPETE', 26244, 7),
  ('res', 8, '15151', 'COSTILLA DE RES', 19459, 8),
  ('res', 9, '15218', 'COSTILLA CORRIENTE', 6000, 9),
  ('res', 10, '15187', 'ENTRAÑITAS', 26500, 10),
  ('res', 11, '15187', 'FALDITA', 26500, 11),
  ('res', 12, '15161', 'HUEVO DE ALDANA', 31556, 12),
  ('res', 13, '15162', 'HUEVO DE SOLOMO', 26377, 13),
  ('res', 14, '15277', 'LAGARTO DELANTERO', 26124, 14),
  ('res', 15, '15171', 'MORRILLO', 26377, 15),
  ('res', 16, '15172', 'MUCHACHO', 29685, 16),
  ('res', 17, '15176', 'PALETERITO', 27193, 17),
  ('res', 18, '15176', 'PALETERO', 27193, 18),
  ('res', 19, '15152', 'PECHO', 26377, 19),
  ('res', 20, '15185', 'POSTA', 29685, 20),
  ('res', 21, '15186', 'PUNTA DE ANCA', 52500, 21),
  ('res', 22, '15187', 'PUNTA DE FALDA', 26500, 22),
  ('res', 23, '15196', 'PUNTA DE SOLOMO', 44450, 23),
  ('res', 24, '15187', 'PUNTA ESPALDILLA', 27800, 24),
  ('res', 25, '15216', 'REPELE INDUSTRIAL', 16000, 25),
  ('res', 26, '15189', 'SABALETA', 27192, 26),
  ('res', 27, '15189', 'SABALETICA', 27192, 27),
  ('res', 28, '15193', 'SOBREBARRIGA', 27192, 28),
  ('res', 29, '15194', 'SOLOMITO', 61000, 29),
  ('res', 30, '15195', 'SOLOMO EXTRANJERO', 31556, 30),
  ('res', 31, '15197', 'TABLA', 31556, 31),
  ('res', 32, '15277', 'TABLEADO TRASERO', 26124, 32),
  ('res', 33, '15176', 'TABLON', 26124, 33),
  ('res', 34, '15277', 'TORTUGA', 26124, 34),
  ('res', 35, '15203', 'TRES TELAS', 20361, 35),
  ('res', 36, '18015', 'CHOCOZUELA *KL', 2700, 36),
  ('res', 37, '18014', 'ROMPE KILO', 3400, 37),
  ('res', 38, '15178', 'CHULETA DE RES', 24500, 38)
ON CONFLICT (especie, codigo_tabla) DO NOTHING;


-- ---------------------------------------------------------------------------
-- Ítems de plantilla — CERDO (hoja `ITEMS`, filas 2..12)
-- ---------------------------------------------------------------------------
INSERT INTO carnes_plantilla_items (especie, codigo_tabla, codigo_item, descripcion, costo_base, orden) VALUES
  ('cerdo', 1, '15139', 'Cañon de Cerdo', 16800, 1),
  ('cerdo', 2, '15150', 'Costilla de Cerdo', 16500, 2),
  ('cerdo', 3, '15202', 'Tocino Carnudo', 18000, 3),
  ('cerdo', 4, '15154', 'Espinazo', 5500, 4),
  ('cerdo', 5, '15174', 'Ossobuco', 6500, 5),
  ('cerdo', 6, '15182', 'Pezuña', 5500, 6),
  ('cerdo', 7, '15183', 'Pierna De Cerdo', 14000, 7),
  ('cerdo', 8, '18041', 'Empella', 4500, 8),
  ('cerdo', 9, '15166', 'Brazuelo', 13500, 9),
  ('cerdo', 10, '18024', 'Cabeza De Cañon', 14000, 10),
  ('cerdo', 11, '15177', 'Papada', 13000, 11)
ON CONFLICT (especie, codigo_tabla) DO NOTHING;


-- ---------------------------------------------------------------------------
-- Vísceras — RES
-- ---------------------------------------------------------------------------
--
-- Bloque 'bonificacion' (`Datos `!C44:D48): se valoriza y se RESTA del costo
-- real de la sede, pero solo cuando el toggle de la liquidación está encendido.
--
-- Bloque 'informativo' (`Datos `!B52:D57): el Excel lo calcula por novillo y no
-- lo suma a ningún total. Se guarda porque el admin lo consulta, pero NO entra
-- en el costeo. El precio va en la columna B de esas filas, no en la D.
INSERT INTO carnes_viceras_items (especie, bloque, nombre, precio, orden) VALUES
  ('res', 'bonificacion', 'Viceras', 17000, 1),
  ('res', 'bonificacion', 'Mondongo', 18000, 2),
  ('res', 'bonificacion', 'Lengua', 20000, 3),
  ('res', 'bonificacion', 'Chunchulla', 6500, 4),
  ('res', 'bonificacion', 'Entrañita', 24000, 5),
  ('res', 'informativo', 'Higado', 18000, 1),
  ('res', 'informativo', 'Riñon', 11000, 2),
  ('res', 'informativo', 'Corazon', 9000, 3),
  ('res', 'informativo', 'Bofe', 11000, 4),
  ('res', 'informativo', 'Pajarilla', 11000, 5),
  ('res', 'informativo', 'Punta de falda', 27500, 6);


-- ---------------------------------------------------------------------------
-- Conceptos de gasto
-- ---------------------------------------------------------------------------
--
-- RES (`Datos `!O5:O15): el total del Excel es `SUM(P5:P15)` — TODOS suman,
-- incluidas las dos retomas. Se replica tal cual (`signo = 1`) para no cambiar
-- el número que el admin ve hoy: si las retomas tienen que restar, el admin las
-- carga en negativo, que es lo que viene haciendo. Cuando se confirme, es un
-- UPDATE de una línea sobre estas dos filas.
--
-- Los tres renglones de ganado del Excel (O5:O7) se llaman "Ganado Jaime",
-- "Ganado " y "Ganado" — dos idénticos. Acá van numerados porque el admin los
-- elige de una lista: dos opciones con el mismo texto no se pueden distinguir, y
-- la plata terminaría cargada en el renglón equivocado.
--
-- CERDO (`Plantilla`!F6:F9): la fórmula es `SUM(G6:G8) - G9`, así que ahí las
-- retomas SÍ restan y van con `signo = -1`.
INSERT INTO carnes_conceptos_gasto (especie, nombre, signo, orden) VALUES
  ('res', 'Ganado Jaime', 1, 1),
  ('res', 'Ganado 2', 1, 2),
  ('res', 'Ganado 3', 1, 3),
  ('res', 'Fletes', 1, 4),
  ('res', 'Interes mk', 1, 5),
  ('res', 'Sacrificio', 1, 6),
  ('res', 'Retomas Sacrificio', 1, 7),
  ('res', 'Desposte y Empacado', 1, 8),
  ('res', 'Retomas Desposte', 1, 9),
  ('res', 'Servicio de compra', 1, 10),
  ('cerdo', 'Valor de la carne', 1, 1),
  ('cerdo', 'Valor Servicios', 1, 2),
  ('cerdo', 'Transporte', 1, 3),
  ('cerdo', 'Retomas', -1, 4);
