import test from "node:test";
import assert from "node:assert/strict";

import {
  TOPE_FILAS_EXCEL,
  normalizarHojaEquivalencias,
  normalizarHojaProveedores,
  normalizarNombre,
  buscarProveedorDeHoja,
  claveFila,
  idsADesactivar,
  armarPlanSeed,
  formatearProveedores,
} from "../src/shared/equivalenciasProveedor.js";
import { validators } from "../src/middleware/validators.js";

// Encabezado y relleno tal cual salen del Excel real (celdas con espacios de
// ancho fijo, Item numérico, NIT con espacios al final).
const ENC = ["Item", "Desc. item", "U.M.", "Equivalencia", "Proveedor", "Razón social proveedor", "Sucursal", "Desc. sucursal"];
const fila = (item, desc, um, eq, nit = "902004611      ", razon = "NUTRESA", suc = "001") => [
  item,
  desc,
  um,
  eq,
  nit,
  razon,
  suc,
  razon,
];

// Los 36 renglones reales de la hoja de Nutresa: [Item, equivalencia|null].
const NUTRESA = [
  [15171, "1050799 MORRILLO RES E.V."],
  [15141, "1050748 CHATA RES E.V."],
  [15150, "1038586 COSTILLA CERDO BABY BACK CONGELADO E.V."],
  [15140, "1050744 CASCARA RES E.V."],
  [15195, "1050779 EXTRANJERO SIN COLA RES E.V."],
  [15162, "1050791 HUEVO SOLOMO RES E.V."],
  [15187, "1050783 FALDA RES E.V."],
  [15152, "1050769 ENTREPECHO RES E.V."],
  [15145, "1050757 COLA RES CONGELADO E.V."],
  [15147, "1050761 COPETE RES E.V."],
  [15280, "1079646 COSTICHI CERDO CONGEL. E.V"],
  [15197, "1050856 TABLA RES E.V."],
  [15202, "1016103 TOCINO CARNE CERDO E.V."],
  [18025, "1076490 PUNTA ANCA CERDO E.V."],
  [15196, "1050849 SOLOMO RES E.V"],
  [15161, "1050787 HUEVO ALDANA RES E.V."],
  [15185, "1050813 POSTA RES E.V."],
  [18038, "1079646 COSTICHI CERDO CONGEL. E.V"], // misma equivalencia, OTRO Item: no es duplicada
  [15186, "1050817 PUNTA DE ANCA RES E.V"],
  [15172, "1050803 MUCHACHO RES E.V."],
  [15139, "1044400 CAÑON CERDO COMMODITY"],
  [15176, "1050807 PALETERO RES E.V."],
  [18033, "1065426 ASADO TIRA RES CONGELADO E.V."],
  [15154, "1000319 ESPINAZO CERDO"],
  [15189, "1050827 SABALETA RES E.V."],
  [15143, "1078405 CHULETA CROCANTE CERDO CONGEL. E. V."],
  [15182, "1016091 PATICAS CERDO"],
  [15193, "1050833 SOBREBARRIGA DELGADA RES E.V."],
  [18024, "1000129 CABEZA CAÑON CERDO E.V."],
  [15153, "1050773 ENTRETABLA RES E.V."],
  [15151, null],
  [15183, null],
  [15194, "1050841 SOLOMITO RES E.V."],
  [15277, "1050795 LAGARTO RES E.V."],
  [15160, null],
  [15166, "1000105 BRAZUELO CERDO E.V."],
];

const hojaNutresa = () => [
  ENC,
  ...NUTRESA.map(([item, eq]) => fila(item, `ITEM ${item} KILO                    `, "KL  ", eq)),
  // Lo que deja el Excel: filas "con formato" sin datos hasta el tope de lectura.
  ...Array.from({ length: 11 }, () => [null, null, null, null, null]),
];

// ─── normalizarHojaEquivalencias ───────────────────────────────────────────

test("hoja de Nutresa: 36 renglones reales, 3 sin equivalencia, nada rechazado", () => {
  const r = normalizarHojaEquivalencias(hojaNutresa(), { topeFilas: TOPE_FILAS_EXCEL });
  assert.equal(r.ok, true);
  assert.equal(r.filas.length, 36);
  assert.equal(r.resumen.leidas, 36);
  assert.equal(r.resumen.validas, 36);
  assert.equal(r.resumen.sin_equivalencia, 3);
  assert.equal(r.resumen.duplicadas, 0);
  assert.equal(r.rechazadas.length, 0);
  assert.deepEqual(r.advertencias, []);
});

test("Item numérico pasa a texto, y se recorta U.M., descripción y NIT", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(15134, "BOFEE KILO                              ", "KL  ", "07 BOFE", "1035425098     "),
  ]);
  assert.deepEqual(r.filas[0], {
    codigo_item: "15134",
    descripcion_item: "BOFEE KILO",
    unidad: "KL",
    equivalencia: "07 BOFE",
    orden: 1,
  });
  assert.deepEqual(r.terceros, [{ nit: "1035425098", sucursal: "001" }]);
});

test("equivalencia vacía o ausente se guarda como '' (Sin equivalencia), nunca null", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(15181, "PECHUGA CAMPO KILO", "KL  ", null),
    fila(15240, "PERNIL DE CAMPO KILO", "KL  ", "   "),
  ]);
  assert.deepEqual(r.filas.map((f) => f.equivalencia), ["", ""]);
  assert.equal(r.resumen.sin_equivalencia, 2);
});

test("hoja de Bucanero: sin columna Equivalencia y con U.M. al final (columnas por NOMBRE)", () => {
  const nit = "800197463      ";
  const r = normalizarHojaEquivalencias([
    ["Item", "Desc. item", "", "Proveedor", "Razón social proveedor", "Sucursal", "Desc. sucursal", "U.M."],
    [15173, "MUSLO CAMPO KILO                        ", null, nit, "POLLOS EL BUCANERO SA", "001", "POLLOS EL BUCANERO S.A", "KL  "],
    [15181, "PECHUGA CAMPO KILO                      ", null, nit, "POLLOS EL BUCANERO SA", "001", "POLLOS EL BUCANERO S.A", "KL  "],
    [15146, "CONTRAMUSLOS CAMPO KILO                 ", null, nit, "POLLOS EL BUCANERO SA", "001", "POLLOS EL BUCANERO S.A", "KL  "],
    [15130, "ALAS CAMPO KILO                         ", null, nit, "POLLOS EL BUCANERO SA", "001", "POLLOS EL BUCANERO S.A", "KL  "],
    [15240, "PERNIL DE CAMPO KILO                    ", null, nit, "POLLOS EL BUCANERO SA", "001", "POLLOS EL BUCANERO S.A", "KL  "],
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.filas.length, 5);
  assert.ok(r.filas.every((f) => f.unidad === "KL" && f.equivalencia === ""));
  assert.equal(r.resumen.sin_equivalencia, 5);
  assert.deepEqual(r.terceros, [{ nit: "800197463", sucursal: "001" }]);
});

test("filas en blanco intercaladas y al final no cuentan; las filas van en orden 1..n", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(1, "A", "KL", "a"),
    [null, null, null, null],
    ["", "   ", null],
    fila(2, "B", "UND", "b"),
    [null, null],
  ]);
  assert.deepEqual(r.filas.map((f) => [f.codigo_item, f.orden]), [["1", 1], ["2", 2]]);
  assert.equal(r.resumen.sin_item, 0);
});

test("una fila con datos pero sin Item se cuenta aparte y no entra", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(1, "A", "KL", "a"),
    [null, "DESCRIPCION SUELTA", "KL", "algo", null],
  ]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.resumen.sin_item, 1);
  assert.equal(r.resumen.rechazadas, 0);
});

test("filas repetidas (mismo Item, unidad y equivalencia) se deduplican y se conserva la primera", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(15150, "COSTILLA CERDO", "KL", "1038586 COSTILLA"),
    fila(15150, "COSTILLA CERDO (repetida)", "KL  ", "1038586 COSTILLA  "),
    fila(15150, "COSTILLA CERDO", "KG", "1038586 COSTILLA"), // KG → KL: misma llave
  ]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.filas[0].descripcion_item, "COSTILLA CERDO");
  assert.equal(r.resumen.duplicadas, 2);
  assert.equal(r.resumen.leidas, 3);
});

test("el mismo Item con otra equivalencia o con otra unidad NO es duplicado", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(15150, "X", "KL", "uno"),
    fila(15150, "X", "KL", "dos"),
    fila(15150, "X", "UND", "uno"),
  ]);
  assert.equal(r.filas.length, 3);
  assert.equal(r.resumen.duplicadas, 0);
});

test("KG se homologa a KL (y KGS/KILO); UN a UND", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(1, "A", "KG", "a"),
    fila(2, "B", "kgs", "b"),
    fila(3, "C", "KILO", "c"),
    fila(4, "D", "un", "d"),
  ]);
  assert.deepEqual(r.filas.map((f) => f.unidad), ["KL", "KL", "KL", "UND"]);
  assert.equal(r.rechazadas.length, 0);
});

test("unidades fuera de KL/UND se rechazan con la fila y el motivo (no se adivinan)", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(1, "A", "KL", "a"),
    fila(2, "B", "LB", "b"),
    fila(3, "C", "CAJA", "c"),
    fila(4, "D", "PAQUETE", "d"), // más de 4 caracteres: no cabe en VARCHAR(4)
    fila(5, "E", null, "e"),
  ]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.resumen.unidades_invalidas, 4);
  assert.deepEqual(r.rechazadas.map((x) => [x.fila, x.codigo_item]), [[3, "2"], [4, "3"], [5, "4"], [6, "5"]]);
  assert.match(r.rechazadas[0].motivo, /LB/);
  assert.match(r.rechazadas[2].motivo, /demasiado larga/);
  assert.match(r.rechazadas[3].motivo, /Falta la unidad/);
});

test("Item con decimales o con espacios se rechaza, no se trunca", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(15134.5, "A", "KL", "a"),
    fila("15 134", "B", "KL", "b"),
    fila("X".repeat(21), "C", "KL", "c"),
    fila("15134", "D", "KL", "d"),
  ]);
  assert.deepEqual(r.filas.map((f) => f.codigo_item), ["15134"]);
  assert.equal(r.rechazadas.length, 3);
});

test("textos más largos que la columna se rechazan (un INSERT truncado rompería la hoja entera)", () => {
  const r = normalizarHojaEquivalencias([
    ENC,
    fila(1, "D".repeat(161), "KL", "a"),
    fila(2, "D", "KL", "E".repeat(161)),
    fila(3, "D".repeat(160), "KL", "E".repeat(160)),
  ]);
  assert.deepEqual(r.filas.map((f) => f.codigo_item), ["3"]);
  assert.equal(r.rechazadas.length, 2);
});

test("Item como texto con el NBSP de Excel se recorta", () => {
  const r = normalizarHojaEquivalencias([ENC, fila(" 15134 ", "A", "KL", "a")]);
  assert.equal(r.filas[0].codigo_item, "15134");
});

test("hoja vacía o sin encabezado reconocible: ok false con el motivo", () => {
  assert.equal(normalizarHojaEquivalencias([]).ok, false);
  assert.match(normalizarHojaEquivalencias([[null, null], []]).errores[0], /vacía/);
  const sinItem = normalizarHojaEquivalencias([["Nombre", "Precio"], ["a", 1]]);
  assert.equal(sinItem.ok, false);
  assert.match(sinItem.errores[0], /Item/);
  assert.equal(normalizarHojaEquivalencias(null).ok, false);
});

test("sin 'Desc. item' se avisa pero la hoja carga", () => {
  const r = normalizarHojaEquivalencias([["Item", "U.M."], [1, "KL"]]);
  assert.equal(r.ok, true);
  assert.equal(r.filas[0].descripcion_item, null);
  assert.equal(r.advertencias.length, 1);
});

test("datos pegados al tope de lectura avisan que la hoja pudo quedar cortada", () => {
  const filas = [ENC, ...Array.from({ length: 9 }, (_, i) => fila(i + 1, "A", "KL", `e${i}`))];
  assert.equal(normalizarHojaEquivalencias(filas, { topeFilas: 10 }).advertencias.length, 1);
  assert.equal(normalizarHojaEquivalencias(filas, { topeFilas: 11 }).advertencias.length, 0);
  assert.equal(normalizarHojaEquivalencias(filas).advertencias.length, 0);
});

test("el encabezado puede no estar en la primera fila", () => {
  const r = normalizarHojaEquivalencias([["Equivalencias de Sánchez"], [], ENC, fila(1, "A", "KL", "a")]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.rechazadas.length, 0);
});

// ─── normalizarHojaProveedores ─────────────────────────────────────────────

const ENC_MAESTRO = ["Proveedor", "Razón social proveedor", "Sucursal", "Desc. sucursal"];

test("maestro: recorta el NIT, rellena la sucursal a 3 dígitos y deja desc vacía en null", () => {
  const r = normalizarHojaProveedores([
    ENC_MAESTRO,
    ["901192535      ", " MARKET CERDO SAS ", "001", "MARKET CERDO S.A.S"],
    [1026141108, "HOYOS ZAPATA YENNY TATIANA", 2, null],
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.proveedores, [
    { nit: "901192535", sucursal: "001", razon_social: "MARKET CERDO SAS", desc_sucursal: "MARKET CERDO S.A.S" },
    { nit: "1026141108", sucursal: "002", razon_social: "HOYOS ZAPATA YENNY TATIANA", desc_sucursal: null },
  ]);
});

test("maestro: rechaza NIT vacío / razón vacía y deduplica (nit, sucursal)", () => {
  const r = normalizarHojaProveedores([
    ENC_MAESTRO,
    ["", "SIN NIT", "001", ""],
    ["900000001", "", "001", ""],
    ["900000002", "UNO", "001", ""],
    ["900000002", "UNO REPETIDO", "001", ""],
    ["900000002", "UNO SUC 2", "002", ""],
  ]);
  assert.deepEqual(r.proveedores.map((p) => [p.nit, p.sucursal]), [["900000002", "001"], ["900000002", "002"]]);
  assert.equal(r.rechazadas.length, 2);
  assert.equal(r.advertencias.length, 1);
});

test("maestro: hoja sin encabezado o vacía no es ok", () => {
  assert.equal(normalizarHojaProveedores([]).ok, false);
  assert.equal(normalizarHojaProveedores([["Item", "U.M."]]).ok, false);
});

// ─── Hoja ↔ proveedor ──────────────────────────────────────────────────────

const PROVEEDORES = [
  { nit: "902004611", sucursal: "001", razon_social: "COMERCIALIZADORA DE REFRIGERADOS NUTRESA SAS" },
  { nit: "1035425098", sucursal: "001", razon_social: "SANCHEZ MARTINEZ JOSE OCTAVIO" },
  { nit: "901261672", sucursal: "001", razon_social: "PRODUCTOS SASONI S.A.S" },
  { nit: "800197463", sucursal: "001", razon_social: "POLLOS EL BUCANERO SA" },
  { nit: "902001513", sucursal: "001", razon_social: "MI SEÑOR S.A.S" },
];

test("normalizarNombre: mayúsculas, sin acentos, puntuación como espacio", () => {
  assert.equal(normalizarNombre("  Mi  Señor S.A.S. "), "MI SENOR S A S");
  assert.equal(normalizarNombre(null), "");
});

test("la hoja se empareja por nombre exacto o por prefijo (Excel corta a 31 caracteres)", () => {
  const cortada = "COMERCIALIZADORA DE REFRIGERADO";
  assert.equal(cortada.length, 31);
  assert.equal(buscarProveedorDeHoja(cortada, PROVEEDORES).proveedor.nit, "902004611");
  assert.equal(buscarProveedorDeHoja("PRODUCTOS SASONI S.A.S", PROVEEDORES).proveedor.nit, "901261672");
  assert.equal(buscarProveedorDeHoja("pollos el bucanero sa", PROVEEDORES).proveedor.nit, "800197463");
  assert.equal(buscarProveedorDeHoja("MI SENOR S.A.S", PROVEEDORES).proveedor.nit, "902001513");
});

test("sin coincidencia y nombres demasiado cortos no emparejan", () => {
  assert.equal(buscarProveedorDeHoja("Hoja5", PROVEEDORES).estado, "sin_proveedor");
  assert.equal(buscarProveedorDeHoja("", PROVEEDORES).estado, "sin_proveedor");
  assert.equal(buscarProveedorDeHoja("PRO", PROVEEDORES).estado, "sin_proveedor");
});

test("dos candidatos son ambigüedad, no se elige uno", () => {
  const dos = [
    { nit: "1", sucursal: "001", razon_social: "CARNES DEL NORTE SAS" },
    { nit: "2", sucursal: "001", razon_social: "CARNES DEL NORTE LTDA" },
  ];
  const r = buscarProveedorDeHoja("CARNES DEL NORTE", dos);
  assert.equal(r.estado, "ambigua");
  assert.equal(r.candidatos.length, 2);
  const mismaRazon = [
    { nit: "1", sucursal: "001", razon_social: "IGUAL SAS" },
    { nit: "1", sucursal: "002", razon_social: "IGUAL SAS" },
  ];
  assert.equal(buscarProveedorDeHoja("IGUAL SAS", mismaRazon).estado, "ambigua");
});

test("un nombre exacto gana sobre el prefijo de otro proveedor", () => {
  const dos = [
    { nit: "1", sucursal: "001", razon_social: "COLANTA" },
    { nit: "2", sucursal: "001", razon_social: "COLANTA CARNES SAS" },
  ];
  assert.equal(buscarProveedorDeHoja("COLANTA", dos).proveedor.nit, "1");
});

// ─── Llaves y desactivación ────────────────────────────────────────────────

test("claveFila trata equivalencia ausente como ''", () => {
  assert.equal(
    claveFila({ codigo_item: 15134, unidad: "KL", equivalencia: undefined }),
    claveFila({ codigo_item: "15134", unidad: "KL", equivalencia: "" }),
  );
  assert.notEqual(
    claveFila({ codigo_item: "1", unidad: "KL", equivalencia: "a" }),
    claveFila({ codigo_item: "1", unidad: "KL", equivalencia: "b" }),
  );
});

test("idsADesactivar: solo las activas que ya no están en la hoja", () => {
  const existentes = [
    { id: 1, codigo_item: "1", unidad: "KL", equivalencia: "a", activo: true },
    { id: 2, codigo_item: "2", unidad: "KL", equivalencia: "", activo: true },
    { id: 3, codigo_item: "3", unidad: "KL", equivalencia: "c", activo: true },
    { id: 4, codigo_item: "4", unidad: "KL", equivalencia: "d", activo: false },
  ];
  const filas = [
    { codigo_item: "1", unidad: "KL", equivalencia: "a", orden: 1 },
    { codigo_item: "2", unidad: "KL", equivalencia: "", orden: 2 },
  ];
  assert.deepEqual(idsADesactivar(existentes, filas), [3]);
  assert.deepEqual(idsADesactivar([], filas), []);
  assert.deepEqual(idsADesactivar(existentes, []), [1, 2, 3]);
});

// ─── armarPlanSeed ─────────────────────────────────────────────────────────

const libro = () => [
  {
    nombre: "proveedores mientras",
    filas: [
      ENC_MAESTRO,
      ["902004611      ", "COMERCIALIZADORA DE REFRIGERADOS NUTRESA SAS", "001", "NUTRESA"],
      ["1035425098     ", "SANCHEZ MARTINEZ JOSE OCTAVIO", "001", "SANCHEZ"],
      ["800197463      ", "POLLOS EL BUCANERO SA", "001", "BUCANERO"],
      ["890904478      ", "COOPERATIVA COLANTA", "001", "COLANTA"],
    ],
  },
  { nombre: "COMERCIALIZADORA DE REFRIGERADO", filas: hojaNutresa() },
  {
    nombre: "SANCHEZ MARTINEZ JOSE OCTAVIO",
    filas: [
      ENC,
      fila(15134, "BOFEE KILO", "KL  ", "07 BOFE", "1035425098     ", "SANCHEZ"),
      fila(15146, "CONTRAMUSLOS CAMPO KILO", "KL  ", null, "1035425099", "SANCHEZ", "003"),
    ],
  },
  { nombre: "POLLOS EL BUCANERO SA", filas: [["Item", "Desc. item", "U.M."], [15173, "MUSLO", "LB"]] },
  { nombre: "Hoja5", filas: [] },
  { nombre: "HOJA DESCONOCIDA", filas: [ENC, fila(1, "A", "KL", "a")] },
];

test("plan: empareja hojas con el maestro, reporta vacías, ignoradas y NIT distintos", () => {
  const plan = armarPlanSeed({ hojas: libro(), topeFilas: TOPE_FILAS_EXCEL });
  assert.equal(plan.ok, true);
  assert.equal(plan.proveedores.length, 4);

  const porHoja = Object.fromEntries(plan.hojas.map((h) => [h.hoja, h]));
  assert.equal(Object.keys(porHoja).length, 5, "la hoja del maestro no es una plantilla");

  const nutresa = porHoja["COMERCIALIZADORA DE REFRIGERADO"];
  assert.equal(nutresa.estado, "ok");
  assert.equal(nutresa.proveedor.nit, "902004611");
  assert.equal(nutresa.normalizada.filas.length, 36);
  assert.deepEqual(nutresa.advertencias, []);

  const sanchez = porHoja["SANCHEZ MARTINEZ JOSE OCTAVIO"];
  assert.equal(sanchez.estado, "ok");
  assert.equal(sanchez.proveedor.nit, "1035425098");
  assert.equal(sanchez.normalizada.filas.length, 2, "el NIT raro no descarta filas");
  assert.match(sanchez.advertencias[0], /1035425099\/003/);

  const bucanero = porHoja["POLLOS EL BUCANERO SA"];
  assert.equal(bucanero.estado, "ok");
  assert.equal(bucanero.normalizada.filas.length, 0);
  assert.equal(bucanero.normalizada.resumen.unidades_invalidas, 1);

  assert.equal(porHoja["Hoja5"].estado, "vacia");
  assert.equal(porHoja["HOJA DESCONOCIDA"].estado, "sin_proveedor");
});

test("plan: una hoja con datos pero sin columnas obligatorias es 'invalida', no 'vacia'", () => {
  const plan = armarPlanSeed({
    hojas: [libro()[0], { nombre: "NOTAS", filas: [["algo"], ["otra cosa"]] }],
  });
  assert.equal(plan.hojas[0].estado, "invalida");
});

test("plan: dos hojas del mismo proveedor, la segunda se omite", () => {
  const base = libro();
  const plan = armarPlanSeed({
    hojas: [base[0], base[2], { ...base[2], nombre: "SANCHEZ MARTINEZ JOSE OCTAVIO (2)" }],
  });
  assert.equal(plan.hojas[0].estado, "ok");
  assert.equal(plan.hojas[1].estado, "sin_proveedor", "el sufijo '(2)' ya no es prefijo de la razón");
  const plan2 = armarPlanSeed({
    hojas: [base[0], base[2], { ...base[2], nombre: "SANCHEZ MARTINEZ JOSE" }],
  });
  assert.equal(plan2.hojas[1].estado, "repetida");
});

test("plan: sin hoja de maestro o con maestro ilegible no hay plan", () => {
  assert.equal(armarPlanSeed({ hojas: [libro()[1]] }).ok, false);
  const ilegible = armarPlanSeed({ hojas: [{ nombre: "proveedores mientras", filas: [["x"]] }] });
  assert.equal(ilegible.ok, false);
  assert.ok(ilegible.errores.length > 0);
  assert.equal(armarPlanSeed().ok, false);
});

// ─── Respuesta del catálogo y validación de la URL ─────────────────────────

test("formatearProveedores aplana el conteo embebido y cubre el caso sin filas", () => {
  const r = formatearProveedores([
    { id: 1, nit: "902004611", sucursal: "001", razon_social: "NUTRESA", carnes_proveedor_equivalencias: [{ count: 36 }] },
    { id: 2, nit: "890904478", sucursal: "001", razon_social: "COLANTA", carnes_proveedor_equivalencias: [] },
    { id: 3, nit: "1", sucursal: "001", razon_social: "SIN RELACION" },
  ]);
  assert.deepEqual(r.map((p) => p.equivalencias_activas), [36, 0, 0]);
  assert.deepEqual(Object.keys(r[0]), ["id", "nit", "sucursal", "razon_social", "equivalencias_activas"]);
  assert.deepEqual(formatearProveedores(), []);
});

/** Corre un middleware de validators.js y devuelve { error, req }. */
function correr(middleware, req) {
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, req };
}

test("validators.idParam: acepta ids enteros positivos, rechaza el resto con 400", () => {
  const ok = correr(validators.idParam, { params: { id: "12" } });
  assert.equal(ok.error, undefined);
  assert.equal(ok.req.datosValidados.id, 12);

  for (const malo of ["abc", "0", "-3", "1.5", "", "99999999999999999999"]) {
    const { error } = correr(validators.idParam, { params: { id: malo } });
    assert.equal(error?.statusCode, 400, `id "${malo}"`);
    assert.match(error.message, /id no es válido/);
  }
});

test("validators.listarProveedores: con_plantilla opcional, 1/true/0/false; otra cosa es 400", () => {
  assert.equal(correr(validators.listarProveedores, { query: {} }).error, undefined);
  for (const v of ["1", "true", "0", "false"]) {
    const r = correr(validators.listarProveedores, { query: { con_plantilla: v } });
    assert.equal(r.error, undefined);
    assert.equal(r.req.datosValidados.con_plantilla, v);
  }
  const { error } = correr(validators.listarProveedores, { query: { con_plantilla: "si" } });
  assert.equal(error.statusCode, 400);
  assert.match(error.message, /con_plantilla/);
});
