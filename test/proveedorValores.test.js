/**
 * Tests de las reglas puras del Recibidor de Proveedores.
 *
 * GEMELO: Pagina-web_React/src/pages/Carnes/utils/valoresProveedor.test.js
 * (el frontend, repo aparte). El arreglo `CASOS` de abajo es IDÉNTICO en los dos
 * archivos — se copia tal cual, junto con `BASE`, `FUNCIONES` y el ciclo que lo
 * ejecuta. Si una regla cambia, se cambia en los dos módulos y en los dos
 * arreglos: así la vista previa del navegador no puede discrepar del backend sin
 * que un test lo grite.
 *
 * Los tests de la sección "Solo backend" (fecha de Bogotá y cantidad guardada)
 * NO tienen gemelo: dependen de `visceras.js` y de `Intl` en Node.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  UMBRAL_KL,
  LARGO_FACTURA_SIESA,
  UNIDADES_VALIDAS,
  VALOR_UNITARIO_MIN,
  VALOR_UNITARIO_MAX,
  normalizarUnidad,
  unidadValida,
  hoyBogota,
  cantidadAlmacenada,
  normalizarFactura,
  facturaCabeEnSiesa,
  parsearPesos,
  formatearPesos,
  esEntradaPesos,
  calcularValores,
  valorPlausible,
  valorConfirmado,
  excedeUmbral,
  excesoConfirmado,
  confirmacionesPendientes,
  valorDevuelto,
  validarRenglon,
  validarRecepcion,
  resumenRecepcion,
} from "../src/shared/proveedorValores.js";

// ─── Arreglo compartido con el gemelo del frontend ─────────────────────────

/** Renglón válido de referencia: 10 KL a $20.000 (fuente unitario) = $200.000. */
const BASE = {
  id: 1,
  codigo_item: "1234",
  unidad: "KL",
  cantidad: 10,
  valor_fuente: "unitario",
  valor_unitario: 20000,
  valor_total: 200000,
  cantidad_devuelta: 0,
  motivo_devolucion: null,
};

/** Renglón sin recibir: cantidad 0 y sin valores. */
const VACIO = {
  ...BASE,
  id: 2,
  cantidad: 0,
  valor_fuente: null,
  valor_unitario: null,
  valor_total: null,
};

const MSG_EXCESO = "Más de 800 KL: falta la confirmación";
const MSG_VALOR_20 =
  "El valor unitario ($ 20) está fuera del rango esperado ($ 1.000 a $ 150.000 por KL); hay que confirmarlo";
const MSG_SIN_RENGLONES = "Tiene que haber al menos un renglón con cantidad mayor a 0";

const CASOS = [
  // parsearPesos: "." solo miles, "," solo decimales ([J9])
  { fn: "parsearPesos", nombre: "miles con punto", entrada: ["20.000"], esperado: 20000 },
  { fn: "parsearPesos", nombre: "miles y decimales", entrada: ["20.000,50"], esperado: 20000.5 },
  { fn: "parsearPesos", nombre: "1.500 son mil quinientos", entrada: ["1.500"], esperado: 1500 },
  { fn: "parsearPesos", nombre: "dos grupos de miles", entrada: ["12.345.678"], esperado: 12345678 },
  { fn: "parsearPesos", nombre: "miles y decimales grandes", entrada: ["1.234.567,89"], esperado: 1234567.89 },
  { fn: "parsearPesos", nombre: "sin separadores", entrada: ["20000"], esperado: 20000 },
  { fn: "parsearPesos", nombre: "coma decimal", entrada: ["12,5"], esperado: 12.5 },
  { fn: "parsearPesos", nombre: "cero con decimales", entrada: ["0,5"], esperado: 0.5 },
  { fn: "parsearPesos", nombre: "recorta espacios de los bordes", entrada: [" 20.000 "], esperado: 20000 },
  { fn: "parsearPesos", nombre: "1.5 es ambiguo", entrada: ["1.5"], esperado: null },
  { fn: "parsearPesos", nombre: "20.00 es ambiguo", entrada: ["20.00"], esperado: null },
  { fn: "parsearPesos", nombre: "formato gringo", entrada: ["1,500.00"], esperado: null },
  { fn: "parsearPesos", nombre: "primer grupo de 4 dígitos", entrada: ["1234.567"], esperado: null },
  { fn: "parsearPesos", nombre: "miles con cero a la izquierda", entrada: ["0.500"], esperado: null },
  { fn: "parsearPesos", nombre: "entero con cero a la izquierda", entrada: ["007"], esperado: null },
  { fn: "parsearPesos", nombre: "cero solo", entrada: ["0"], esperado: 0 },
  { fn: "parsearPesos", nombre: "más de una coma", entrada: ["1,2,3"], esperado: null },
  { fn: "parsearPesos", nombre: "espacio adentro", entrada: ["20 000"], esperado: null },
  { fn: "parsearPesos", nombre: "signo", entrada: ["-5"], esperado: null },
  { fn: "parsearPesos", nombre: "letras", entrada: ["abc"], esperado: null },
  { fn: "parsearPesos", nombre: "vacío", entrada: [""], esperado: null },
  { fn: "parsearPesos", nombre: "coma sin decimales", entrada: ["20.000,"], esperado: null },
  { fn: "parsearPesos", nombre: "más decimales que los permitidos (2)", entrada: ["20,123"], esperado: null },
  { fn: "parsearPesos", nombre: "unitario admite 4 decimales", entrada: ["12,3456", { decimales: 4 }], esperado: 12.3456 },
  { fn: "parsearPesos", nombre: "unitario rechaza 5 decimales", entrada: ["12,34567", { decimales: 4 }], esperado: null },
  { fn: "parsearPesos", nombre: "un número no es texto de plata", entrada: [20000], esperado: null },

  // formatearPesos
  { fn: "formatearPesos", nombre: "miles", entrada: [20000], esperado: "$ 20.000" },
  { fn: "formatearPesos", nombre: "cuatro cifras se agrupan", entrada: [1234], esperado: "$ 1.234" },
  { fn: "formatearPesos", nombre: "millones", entrada: [1234567], esperado: "$ 1.234.567" },
  { fn: "formatearPesos", nombre: "tres cifras", entrada: [999], esperado: "$ 999" },
  { fn: "formatearPesos", nombre: "cero", entrada: [0], esperado: "$ 0" },
  { fn: "formatearPesos", nombre: "decimales con coma", entrada: [20000.5], esperado: "$ 20.000,5" },
  { fn: "formatearPesos", nombre: "null es vacío", entrada: [null], esperado: "" },
  { fn: "formatearPesos", nombre: "negativo es vacío", entrada: [-1], esperado: "" },
  { fn: "formatearPesos", nombre: "texto es vacío", entrada: ["abc"], esperado: "" },

  // esEntradaPesos: filtro de teclado, deja pasar lo parcial
  { fn: "esEntradaPesos", nombre: "vacío", entrada: [""], esperado: true },
  { fn: "esEntradaPesos", nombre: "solo dígitos", entrada: ["20"], esperado: true },
  { fn: "esEntradaPesos", nombre: "punto recién escrito", entrada: ["20."], esperado: true },
  { fn: "esEntradaPesos", nombre: "grupo de miles incompleto", entrada: ["20.0"], esperado: true },
  { fn: "esEntradaPesos", nombre: "grupo de miles completo", entrada: ["20.000"], esperado: true },
  { fn: "esEntradaPesos", nombre: "dos grupos", entrada: ["20.000.000"], esperado: true },
  { fn: "esEntradaPesos", nombre: "coma recién escrita", entrada: ["20.000,"], esperado: true },
  { fn: "esEntradaPesos", nombre: "decimales", entrada: ["20.000,5"], esperado: true },
  { fn: "esEntradaPesos", nombre: "coma sin miles", entrada: ["20,5"], esperado: true },
  { fn: "esEntradaPesos", nombre: "dos puntos seguidos", entrada: ["1.."], esperado: false },
  { fn: "esEntradaPesos", nombre: "grupo de 4 dígitos", entrada: ["20.0000"], esperado: false },
  { fn: "esEntradaPesos", nombre: "dos comas", entrada: ["20,5,5"], esperado: false },
  { fn: "esEntradaPesos", nombre: "empieza con coma", entrada: [",5"], esperado: false },
  { fn: "esEntradaPesos", nombre: "signo", entrada: ["-1"], esperado: false },
  { fn: "esEntradaPesos", nombre: "letras", entrada: ["abc"], esperado: false },

  // calcularValores
  {
    fn: "calcularValores",
    nombre: "valor en blanco es vacío, no cero",
    entrada: [{ cantidad: 10, valor: "  ", fuente: "unitario" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: null },
  },
  {
    fn: "calcularValores",
    nombre: "10,5 × 12345,67 unitario → total 129630",
    entrada: [{ cantidad: 10.5, valor: 12345.67, fuente: "unitario" }],
    esperado: { valor_unitario: 12345.67, valor_total: 129630, valor_fuente: "unitario", error: null },
  },
  {
    fn: "calcularValores",
    nombre: "10,5 × 20000 unitario → total 210000",
    entrada: [{ cantidad: 10.5, valor: 20000, fuente: "unitario" }],
    esperado: { valor_unitario: 20000, valor_total: 210000, valor_fuente: "unitario", error: null },
  },
  {
    fn: "calcularValores",
    nombre: "total 100000 ÷ 3 → unitario 33333.3333, el total no cambia",
    entrada: [{ cantidad: 3, valor: 100000, fuente: "total" }],
    esperado: { valor_unitario: 33333.3333, valor_total: 100000, valor_fuente: "total", error: null },
  },
  {
    fn: "calcularValores",
    nombre: "total con decimales se redondea a pesos",
    entrada: [{ cantidad: 4, valor: 100000.6, fuente: "total" }],
    esperado: { valor_unitario: 25000.25, valor_total: 100001, valor_fuente: "total", error: null },
  },
  {
    fn: "calcularValores",
    nombre: "cantidad 0 con total: no deriva unitario (sin dividir por 0)",
    entrada: [{ cantidad: 0, valor: 100000, fuente: "total" }],
    esperado: { valor_unitario: null, valor_total: 100000, valor_fuente: "total", error: null },
  },
  {
    fn: "calcularValores",
    nombre: "cantidad 0 con unitario: total 0",
    entrada: [{ cantidad: 0, valor: 5000, fuente: "unitario" }],
    esperado: { valor_unitario: 5000, valor_total: 0, valor_fuente: "unitario", error: null },
  },
  {
    fn: "calcularValores",
    nombre: "sin valor no hay nada que calcular",
    entrada: [{ cantidad: 10, valor: null, fuente: "unitario" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: null },
  },
  {
    fn: "calcularValores",
    nombre: "valor negativo",
    entrada: [{ cantidad: 10, valor: -5, fuente: "unitario" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: "El valor no es válido" },
  },
  {
    fn: "calcularValores",
    nombre: "valor no numérico",
    entrada: [{ cantidad: 10, valor: "abc", fuente: "total" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: "El valor no es válido" },
  },
  {
    fn: "calcularValores",
    nombre: "cantidad negativa",
    entrada: [{ cantidad: -1, valor: 100, fuente: "unitario" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: "La cantidad no es válida" },
  },
  {
    fn: "calcularValores",
    nombre: "fuente desconocida",
    entrada: [{ cantidad: 1, valor: 100, fuente: "otra" }],
    esperado: {
      valor_unitario: null,
      valor_total: null,
      valor_fuente: null,
      error: "Falta indicar si el valor es unitario o total",
    },
  },
  {
    fn: "calcularValores",
    nombre: "[J14] unitario válido × cantidad grande desborda el total",
    entrada: [{ cantidad: 999999999, valor: 999999999, fuente: "unitario" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: "El valor es demasiado grande" },
  },
  {
    fn: "calcularValores",
    nombre: "[J14] unitario digitado no cabe en NUMERIC(16,4)",
    entrada: [{ cantidad: 1, valor: 1000000000000, fuente: "unitario" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: "El valor es demasiado grande" },
  },
  {
    fn: "calcularValores",
    nombre: "[J14] total digitado no cabe en NUMERIC(16,2)",
    entrada: [{ cantidad: 1, valor: 100000000000000, fuente: "total" }],
    esperado: { valor_unitario: null, valor_total: null, valor_fuente: null, error: "El valor es demasiado grande" },
  },
  {
    fn: "calcularValores",
    nombre: "[J14] total derivado que sí cabe, en el borde",
    entrada: [{ cantidad: 1000, valor: 99999999999999, fuente: "total" }],
    esperado: { valor_unitario: 99999999999.999, valor_total: 99999999999999, valor_fuente: "total", error: null },
  },

  // valorPlausible (rango 1.000 a 150.000, obs 405)
  { fn: "valorPlausible", nombre: "dentro del rango", entrada: [{ unitario: 20000, unidad: "KL" }], esperado: { plausible: true, aviso: null } },
  { fn: "valorPlausible", nombre: "mínimo exacto", entrada: [{ unitario: 1000, unidad: "KL" }], esperado: { plausible: true, aviso: null } },
  { fn: "valorPlausible", nombre: "máximo exacto", entrada: [{ unitario: 150000, unidad: "KL" }], esperado: { plausible: true, aviso: null } },
  { fn: "valorPlausible", nombre: "sin unitario no hay qué juzgar", entrada: [{ unitario: null, unidad: "KL" }], esperado: { plausible: true, aviso: null } },
  {
    fn: "valorPlausible",
    nombre: "20 digitado por 20.000",
    entrada: [{ unitario: 20, unidad: "KL" }],
    esperado: { plausible: false, aviso: MSG_VALOR_20 },
  },
  {
    fn: "valorPlausible",
    nombre: "ceros de más, en UND",
    entrada: [{ unitario: 200000, unidad: "UND" }],
    esperado: {
      plausible: false,
      aviso:
        "El valor unitario ($ 200.000) está fuera del rango esperado ($ 1.000 a $ 150.000 por UND); hay que confirmarlo",
    },
  },
  { fn: "valorPlausible", nombre: "justo debajo del mínimo", entrada: [{ unitario: 999.9999, unidad: "KL" }], esperado: { plausible: false, aviso: "El valor unitario ($ 999,9999) está fuera del rango esperado ($ 1.000 a $ 150.000 por KL); hay que confirmarlo" } },
  { fn: "valorPlausible", nombre: "justo encima del máximo", entrada: [{ unitario: 150000.0001, unidad: "kg" }], esperado: { plausible: false, aviso: "El valor unitario ($ 150.000,0001) está fuera del rango esperado ($ 1.000 a $ 150.000 por KL); hay que confirmarlo" } },

  // valorConfirmado: solo vale si es igual al unitario ACTUAL
  { fn: "valorConfirmado", nombre: "igual al actual", entrada: [{ valor_unitario: 20, valor_confirmado_unitario: 20 }], esperado: true },
  { fn: "valorConfirmado", nombre: "distinto al actual", entrada: [{ valor_unitario: 30, valor_confirmado_unitario: 20 }], esperado: false },
  { fn: "valorConfirmado", nombre: "sin confirmación", entrada: [{ valor_unitario: 20, valor_confirmado_unitario: null }], esperado: false },
  { fn: "valorConfirmado", nombre: "sin unitario", entrada: [{ valor_unitario: null, valor_confirmado_unitario: 20 }], esperado: false },
  { fn: "valorConfirmado", nombre: "NUMERIC llega como texto", entrada: [{ valor_unitario: 33333.3333, valor_confirmado_unitario: "33333.3333" }], esperado: true },

  // 800 KL
  { fn: "excedeUmbral", nombre: "800 justos no exceden", entrada: [{ cantidad: 800, unidad: "KL" }], esperado: false },
  { fn: "excedeUmbral", nombre: "800,001 excede", entrada: [{ cantidad: 800.001, unidad: "KL" }], esperado: true },
  { fn: "excedeUmbral", nombre: "801 excede", entrada: [{ cantidad: 801, unidad: "KL" }], esperado: true },
  { fn: "excedeUmbral", nombre: "UND queda exento", entrada: [{ cantidad: 5000, unidad: "UND" }], esperado: false },
  { fn: "excedeUmbral", nombre: "KG cuenta como KL", entrada: [{ cantidad: 900, unidad: "kg" }], esperado: true },
  { fn: "excedeUmbral", nombre: "cantidad 0", entrada: [{ cantidad: 0, unidad: "KL" }], esperado: false },

  // excesoConfirmado: solo vale si es igual a la cantidad ACTUAL
  { fn: "excesoConfirmado", nombre: "confirmó 850 y sigue en 850", entrada: [{ cantidad: 850, exceso_confirmado_cantidad: 850 }], esperado: true },
  { fn: "excesoConfirmado", nombre: "confirmó 850 y quedó en 851", entrada: [{ cantidad: 851, exceso_confirmado_cantidad: 850 }], esperado: false },
  { fn: "excesoConfirmado", nombre: "confirmó 850 y quedó en 8500", entrada: [{ cantidad: 8500, exceso_confirmado_cantidad: 850 }], esperado: false },
  { fn: "excesoConfirmado", nombre: "sin confirmación", entrada: [{ cantidad: 900, exceso_confirmado_cantidad: null }], esperado: false },
  { fn: "excesoConfirmado", nombre: "NUMERIC llega como texto", entrada: [{ cantidad: 850, exceso_confirmado_cantidad: "850.000" }], esperado: true },

  // confirmacionesPendientes
  { fn: "confirmacionesPendientes", nombre: "renglón normal", entrada: [BASE], esperado: [] },
  {
    fn: "confirmacionesPendientes",
    nombre: "KL 900 sin confirmar",
    entrada: [{ ...BASE, cantidad: 900, valor_total: 18000000 }],
    esperado: [{ tipo: "exceso", mensaje: MSG_EXCESO }],
  },
  {
    fn: "confirmacionesPendientes",
    nombre: "renglón sin recibir no pide nada aunque el unitario sea raro",
    entrada: [{ ...VACIO, valor_unitario: 20 }],
    esperado: [],
  },
  {
    fn: "confirmacionesPendientes",
    nombre: "valor en 0 no es implausible, es faltante (no pide confirmación)",
    entrada: [{ ...BASE, valor_unitario: 0, valor_total: 0 }],
    esperado: [],
  },
  {
    fn: "confirmacionesPendientes",
    nombre: "exceso y valor a la vez, en ese orden",
    entrada: [{ ...BASE, cantidad: 900, valor_unitario: 20, valor_total: 18000 }],
    esperado: [
      { tipo: "exceso", mensaje: MSG_EXCESO },
      { tipo: "valor", mensaje: "El valor unitario ($ 20) está fuera del rango esperado ($ 1.000 a $ 150.000 por KL); hay que confirmarlo" },
    ],
  },

  // valorDevuelto: proporcional, calculado, nunca divide por 0
  { fn: "valorDevuelto", nombre: "10 de 100 sobre $1.000.000", entrada: [{ cantidad: 100, valor_total: 1000000, cantidad_devuelta: 10 }], esperado: 100000 },
  { fn: "valorDevuelto", nombre: "cantidad 0 da 0", entrada: [{ cantidad: 0, valor_total: 1000000, cantidad_devuelta: 10 }], esperado: 0 },
  { fn: "valorDevuelto", nombre: "sin devolución", entrada: [{ cantidad: 100, valor_total: 1000000, cantidad_devuelta: 0 }], esperado: 0 },
  { fn: "valorDevuelto", nombre: "sin total", entrada: [{ cantidad: 100, valor_total: null, cantidad_devuelta: 10 }], esperado: 0 },
  { fn: "valorDevuelto", nombre: "redondea a pesos (33333,33)", entrada: [{ cantidad: 3, valor_total: 100000, cantidad_devuelta: 1 }], esperado: 33333 },
  { fn: "valorDevuelto", nombre: "redondea a pesos (42,86)", entrada: [{ cantidad: 7, valor_total: 100, cantidad_devuelta: 3 }], esperado: 43 },
  { fn: "valorDevuelto", nombre: "nunca supera el total del renglón", entrada: [{ cantidad: 3, valor_total: 100, cantidad_devuelta: 5 }], esperado: 100 },

  // unidades
  { fn: "normalizarUnidad", nombre: "kg → KL", entrada: ["kg"], esperado: "KL" },
  { fn: "normalizarUnidad", nombre: "KGS con espacios → KL", entrada: [" KGS "], esperado: "KL" },
  { fn: "normalizarUnidad", nombre: "kilo → KL", entrada: ["kilo"], esperado: "KL" },
  { fn: "normalizarUnidad", nombre: "KL igual", entrada: ["KL"], esperado: "KL" },
  { fn: "normalizarUnidad", nombre: "un → UND", entrada: ["un"], esperado: "UND" },
  { fn: "normalizarUnidad", nombre: "Unidad → UND", entrada: ["Unidad"], esperado: "UND" },
  { fn: "normalizarUnidad", nombre: "UND igual", entrada: ["UND"], esperado: "UND" },
  { fn: "normalizarUnidad", nombre: "desconocida vuelve tal cual", entrada: ["lb"], esperado: "LB" },
  { fn: "normalizarUnidad", nombre: "null es vacío", entrada: [null], esperado: "" },
  { fn: "unidadValida", nombre: "kg es válida", entrada: ["kg"], esperado: true },
  { fn: "unidadValida", nombre: "UND es válida", entrada: ["UND"], esperado: true },
  { fn: "unidadValida", nombre: "LB no", entrada: ["LB"], esperado: false },
  { fn: "unidadValida", nombre: "vacía no", entrada: [""], esperado: false },

  // factura
  { fn: "normalizarFactura", nombre: "recorta y pasa a mayúsculas", entrada: [" fe-00123 "], esperado: { factura: "FE-00123", clave: "FE00123" } },
  { fn: "normalizarFactura", nombre: "colapsa espacios", entrada: ["fe   00  123"], esperado: { factura: "FE 00 123", clave: "FE00123" } },
  { fn: "normalizarFactura", nombre: "la clave solo guarda letras y números", entrada: ["a/b.c"], esperado: { factura: "A/B.C", clave: "ABC" } },
  { fn: "normalizarFactura", nombre: "conserva ceros a la izquierda", entrada: ["FE-0012"], esperado: { factura: "FE-0012", clave: "FE0012" } },
  { fn: "normalizarFactura", nombre: "FE12 es otra factura", entrada: ["FE12"], esperado: { factura: "FE12", clave: "FE12" } },
  { fn: "normalizarFactura", nombre: "null", entrada: [null], esperado: { factura: "", clave: "" } },
  { fn: "facturaCabeEnSiesa", nombre: "8 caracteres", entrada: ["FE-00123"], esperado: true },
  { fn: "facturaCabeEnSiesa", nombre: "12 caracteres justos", entrada: ["123456789012"], esperado: true },
  { fn: "facturaCabeEnSiesa", nombre: "13 caracteres no caben", entrada: ["1234567890123"], esperado: false },
  { fn: "facturaCabeEnSiesa", nombre: "16 caracteres no caben", entrada: ["FACT-2026-000123"], esperado: false },
  { fn: "facturaCabeEnSiesa", nombre: "vacía no", entrada: [""], esperado: false },
  { fn: "facturaCabeEnSiesa", nombre: "solo espacios no", entrada: ["   "], esperado: false },
  { fn: "facturaCabeEnSiesa", nombre: "null no", entrada: [null], esperado: false },

  // validarRenglon
  { fn: "validarRenglon", nombre: "renglón válido", entrada: [BASE], esperado: [] },
  { fn: "validarRenglon", nombre: "[J3] sin recibir es válido", entrada: [VACIO], esperado: [] },
  {
    fn: "validarRenglon",
    nombre: "[J3] sin recibir ignora unidad rara e item faltante",
    entrada: [{ ...VACIO, unidad: "LB", codigo_item: "" }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "valor con cantidad 0",
    entrada: [{ ...VACIO, valor_total: 5000 }],
    esperado: ["Tiene valor pero la cantidad es 0"],
  },
  {
    fn: "validarRenglon",
    nombre: "[J3] unidad fuera de KL/UND con cantidad",
    entrada: [{ ...BASE, unidad: "LB" }],
    esperado: ['La unidad "LB" no es válida (solo KL o UND)'],
  },
  { fn: "validarRenglon", nombre: "[J3] KG se acepta como KL", entrada: [{ ...BASE, unidad: "kg" }], esperado: [] },
  {
    fn: "validarRenglon",
    nombre: "total sin fuente no pasa (no hay contra qué recalcular)",
    entrada: [{ ...BASE, valor_fuente: null, valor_unitario: 20000, valor_total: 1 }],
    esperado: ["Falta indicar si el valor es unitario o total"],
  },
  {
    fn: "validarRenglon",
    nombre: "UND con 3 decimales no cuadra con lo que llega a SIESA",
    entrada: [{ ...BASE, unidad: "UND", cantidad: 2.667, valor_unitario: 20000, valor_total: 53340 }],
    esperado: ["La cantidad tiene más decimales de los que admite la unidad; guardá el renglón de nuevo"],
  },
  {
    fn: "validarRenglon",
    nombre: "UND con 2 decimales es válido",
    entrada: [{ ...BASE, unidad: "UND", cantidad: 2.66, valor_unitario: 20000, valor_total: 53200 }],
    esperado: [],
  },
  { fn: "validarRenglon", nombre: "null no revienta", entrada: [null], esperado: [] },
  {
    fn: "validarRenglon",
    nombre: "unidad vacía con cantidad",
    entrada: [{ ...BASE, unidad: "" }],
    esperado: ['La unidad "(vacía)" no es válida (solo KL o UND)'],
  },
  {
    fn: "validarRenglon",
    nombre: "falta el código de item",
    entrada: [{ ...BASE, codigo_item: "  " }],
    esperado: ["Falta el código de item de SIESA"],
  },
  {
    fn: "validarRenglon",
    nombre: "cantidad sin valor",
    entrada: [{ ...BASE, valor_fuente: null, valor_unitario: null, valor_total: null }],
    esperado: ["Falta el valor del renglón"],
  },
  {
    fn: "validarRenglon",
    nombre: "cantidad con total 0",
    entrada: [{ ...BASE, valor_unitario: 0, valor_total: 0 }],
    esperado: ["Falta el valor del renglón"],
  },
  {
    fn: "validarRenglon",
    nombre: "total que no sale de cantidad × unitario",
    entrada: [{ ...BASE, valor_total: 199999 }],
    esperado: ["Los valores no coinciden con la cantidad; guardá el renglón de nuevo"],
  },
  {
    fn: "validarRenglon",
    nombre: "fuente total coherente",
    entrada: [{ ...BASE, cantidad: 3, valor_fuente: "total", valor_unitario: 33333.3333, valor_total: 100000 }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "fuente total con unitario viejo",
    entrada: [{ ...BASE, cantidad: 3, valor_fuente: "total", valor_unitario: 33333, valor_total: 100000 }],
    esperado: ["Los valores no coinciden con la cantidad; guardá el renglón de nuevo"],
  },
  { fn: "validarRenglon", nombre: "cantidad negativa", entrada: [{ ...BASE, cantidad: -1 }], esperado: ["La cantidad no es válida"] },
  {
    fn: "validarRenglon",
    nombre: "[J14] cantidad no cabe en NUMERIC(12,3)",
    entrada: [{ ...BASE, cantidad: 1000000000, unidad: "UND", valor_unitario: 1000, valor_total: 1000000000000 }],
    esperado: ["La cantidad es demasiado grande"],
  },
  {
    fn: "validarRenglon",
    nombre: "[J14] total no cabe en NUMERIC(16,2)",
    entrada: [{ ...BASE, cantidad: 1, unidad: "UND", valor_unitario: 1000, valor_total: 100000000000000 }],
    esperado: ["El valor es demasiado grande"],
  },
  {
    fn: "validarRenglon",
    nombre: "valor negativo",
    entrada: [{ ...BASE, valor_total: -5 }],
    esperado: ["El valor no es válido"],
  },
  {
    fn: "validarRenglon",
    nombre: "valor no numérico",
    entrada: [{ ...BASE, valor_total: "abc" }],
    esperado: ["El valor no es válido"],
  },
  {
    fn: "validarRenglon",
    nombre: "KL 900 sin confirmar",
    entrada: [{ ...BASE, cantidad: 900, valor_total: 18000000 }],
    esperado: [MSG_EXCESO],
  },
  {
    fn: "validarRenglon",
    nombre: "KL 900 confirmado",
    entrada: [{ ...BASE, cantidad: 900, valor_total: 18000000, exceso_confirmado_cantidad: 900 }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "confirmó 850 y quedó en 851",
    entrada: [{ ...BASE, cantidad: 851, valor_total: 17020000, exceso_confirmado_cantidad: 850 }],
    esperado: [MSG_EXCESO],
  },
  {
    fn: "validarRenglon",
    nombre: "800 justos no piden confirmación",
    entrada: [{ ...BASE, cantidad: 800, valor_total: 16000000 }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "UND 5000 exento",
    entrada: [{ ...BASE, unidad: "UND", cantidad: 5000, valor_total: 100000000 }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "unitario implausible sin confirmar",
    entrada: [{ ...BASE, valor_unitario: 20, valor_total: 200 }],
    esperado: [MSG_VALOR_20],
  },
  {
    fn: "validarRenglon",
    nombre: "unitario implausible confirmado",
    entrada: [{ ...BASE, valor_unitario: 20, valor_total: 200, valor_confirmado_unitario: 20 }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "confirmó $20 y el unitario pasó a $30",
    entrada: [{ ...BASE, valor_unitario: 30, valor_total: 300, valor_confirmado_unitario: 20 }],
    esperado: [
      "El valor unitario ($ 30) está fuera del rango esperado ($ 1.000 a $ 150.000 por KL); hay que confirmarlo",
    ],
  },
  {
    fn: "validarRenglon",
    nombre: "devolución válida",
    entrada: [{ ...BASE, cantidad_devuelta: 10, motivo_devolucion: "Mal estado" }],
    esperado: [],
  },
  {
    fn: "validarRenglon",
    nombre: "devolución mayor que lo recibido",
    entrada: [{ ...BASE, cantidad_devuelta: 11, motivo_devolucion: "Mal estado" }],
    esperado: ["La cantidad devuelta no puede superar lo recibido"],
  },
  {
    fn: "validarRenglon",
    nombre: "devolución sin motivo",
    entrada: [{ ...BASE, cantidad_devuelta: 5, motivo_devolucion: null }],
    esperado: ["Falta el motivo de la devolución"],
  },
  {
    fn: "validarRenglon",
    nombre: "devolución con motivo en blanco",
    entrada: [{ ...BASE, cantidad_devuelta: 5, motivo_devolucion: "   " }],
    esperado: ["Falta el motivo de la devolución"],
  },
  {
    fn: "validarRenglon",
    nombre: "devolución negativa",
    entrada: [{ ...BASE, cantidad_devuelta: -1 }],
    esperado: ["La cantidad devuelta no es válida"],
  },
  {
    fn: "validarRenglon",
    nombre: "devolución en un renglón sin recibir",
    entrada: [{ ...VACIO, cantidad_devuelta: 1, motivo_devolucion: "Mal estado" }],
    esperado: ["La cantidad devuelta no puede superar lo recibido"],
  },

  // validarRecepcion
  {
    fn: "validarRecepcion",
    nombre: "sin renglones",
    entrada: [[]],
    esperado: { ok: false, errores: [], generales: [MSG_SIN_RENGLONES], renglones_con_cantidad: 0 },
  },
  {
    fn: "validarRecepcion",
    nombre: "todos en 0",
    entrada: [[VACIO, { ...VACIO, id: 3 }]],
    esperado: { ok: false, errores: [], generales: [MSG_SIN_RENGLONES], renglones_con_cantidad: 0 },
  },
  {
    fn: "validarRecepcion",
    nombre: "un renglón recibido",
    entrada: [[BASE]],
    esperado: { ok: true, errores: [], generales: [], renglones_con_cantidad: 1 },
  },
  {
    fn: "validarRecepcion",
    nombre: "[J3] los renglones sin recibir no bloquean aunque tengan unidad rara",
    entrada: [[BASE, { ...VACIO, unidad: "LB" }]],
    esperado: { ok: true, errores: [], generales: [], renglones_con_cantidad: 1 },
  },
  {
    fn: "validarRecepcion",
    nombre: "error por renglón con su id",
    entrada: [[BASE, { ...BASE, id: 7, cantidad: 900, valor_total: 18000000 }]],
    esperado: {
      ok: false,
      errores: [{ item_id: 7, mensajes: [MSG_EXCESO] }],
      generales: [],
      renglones_con_cantidad: 2,
    },
  },

  // resumenRecepcion
  {
    fn: "resumenRecepcion",
    nombre: "suma lo recibido; la devolución no se resta del total",
    entrada: [
      [
        BASE,
        { ...BASE, id: 3, cantidad: 100, unidad: "UND", valor_unitario: 10000, valor_total: 1000000, cantidad_devuelta: 10, motivo_devolucion: "Mal estado" },
        VACIO,
      ],
    ],
    esperado: { renglones: 2, total: 1200000, total_devuelto: 100000, renglones_con_devolucion: 1 },
  },
  {
    fn: "resumenRecepcion",
    nombre: "sin renglones",
    entrada: [[]],
    esperado: { renglones: 0, total: 0, total_devuelto: 0, renglones_con_devolucion: 0 },
  },
];

const FUNCIONES = {
  parsearPesos,
  formatearPesos,
  esEntradaPesos,
  calcularValores,
  valorPlausible,
  valorConfirmado,
  excedeUmbral,
  excesoConfirmado,
  confirmacionesPendientes,
  valorDevuelto,
  normalizarUnidad,
  unidadValida,
  normalizarFactura,
  facturaCabeEnSiesa,
  validarRenglon,
  validarRecepcion,
  resumenRecepcion,
};

for (const caso of CASOS) {
  test(`${caso.fn}: ${caso.nombre}`, () => {
    assert.ok(FUNCIONES[caso.fn], `CASOS nombra una función que no existe: ${caso.fn}`);
    assert.deepEqual(FUNCIONES[caso.fn](...caso.entrada), caso.esperado);
  });
}

// ─── Solo backend (sin gemelo en el frontend) ──────────────────────────────

test("las constantes son las que dicen las decisiones del negocio", () => {
  assert.equal(UMBRAL_KL, 800);
  assert.equal(LARGO_FACTURA_SIESA, 12);
  assert.deepEqual(UNIDADES_VALIDAS, ["KL", "UND"]);
  assert.equal(VALOR_UNITARIO_MIN, 1000);
  assert.equal(VALOR_UNITARIO_MAX, 150000);
});

test("hoyBogota: la fecha es la de Bogotá, no la de UTC", () => {
  // 23:59:59 en Bogotá (UTC-5) todavía es el día 29 aunque en UTC ya sea el 30.
  assert.equal(hoyBogota(new Date("2026-09-30T04:59:59Z")), "2026-09-29");
  assert.equal(hoyBogota(new Date("2026-09-30T05:00:00Z")), "2026-09-30");
  assert.equal(hoyBogota(new Date("2026-09-30T23:30:00Z")), "2026-09-30");
});

test("hoyBogota: donde toISOString().slice(0,10) se equivoca", () => {
  // 9 p. m. del 30 en Bogotá: UTC ya marca octubre. Este era el bug de Talleres.
  const fecha = new Date("2026-10-01T02:00:00Z");
  assert.equal(fecha.toISOString().slice(0, 10), "2026-10-01");
  assert.equal(hoyBogota(fecha), "2026-09-30");
});

test("hoyBogota: sin argumento devuelve YYYY-MM-DD", () => {
  assert.match(hoyBogota(), /^\d{4}-\d{2}-\d{2}$/);
});

test("cantidadAlmacenada: lo guardado es lo que manda el builder (UND trunca a 2)", () => {
  assert.equal(cantidadAlmacenada(2.667, "UND"), 2.66);
  assert.equal(cantidadAlmacenada(14.667, "UND"), 14.66);
  assert.equal(cantidadAlmacenada(5.3339, "UND"), 5.33);
  assert.equal(cantidadAlmacenada(2.6666, "KL"), 2.667);
  assert.equal(cantidadAlmacenada(10.5, "kg"), 10.5);
});
