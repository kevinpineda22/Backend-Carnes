import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parsearInformeDesposte,
  normalizarNombre,
  aNumero,
  aFechaISO,
  BLOQUE_FINAS,
  BLOQUE_SUBPRODUCTOS,
} from "../src/shared/desposteParser.js";

/**
 * El fixture NO es inventado: es el texto que `unpdf` extrae del PDF real que
 * mandó el frigorífico —"INF DESPOSTE 380 LOTE 13526305 BARRIO LOPEZ.pdf"—,
 * salto de página y pie de página incluidos.
 *
 * Se guarda el TEXTO y no el PDF a propósito: el parser es puro y no sabe leer
 * PDFs, así que un binario en el repo no probaría nada más y sí haría lento el
 * clon. La extracción se prueba aparte, en pdf.service.
 */
const TEXTO = readFileSync(
  fileURLToPath(new URL("./fixtures/desposte-lopez-13526305.txt", import.meta.url)),
  "utf8",
);

test("lee la cabecera del informe real", () => {
  const r = parsearInformeDesposte(TEXTO);

  assert.equal(r.lote, "13526305");
  assert.equal(r.fechaDesposte, "2026-08-28");
  assert.equal(r.cliente, "380 - JULIO ARBOLEDA SIERRA");
  assert.equal(r.subcliente, "MK - 380 - BARRIO LOPEZ");
  assert.equal(r.animales, 1);
});

test("lee las 34 líneas de FINAS y las 5 de SUBPRODUCTOS", () => {
  const r = parsearInformeDesposte(TEXTO);

  const finas = r.items.filter((i) => i.bloque === BLOQUE_FINAS);
  const subproductos = r.items.filter((i) => i.bloque === BLOQUE_SUBPRODUCTOS);

  assert.equal(finas.length, 34);
  assert.equal(subproductos.length, 5);
});

test("los renglones traen las cinco columnas", () => {
  const r = parsearInformeDesposte(TEXTO);
  const primero = r.items[0];

  // `CARNE PARA MOLER 4.49 2 2.48 % 4.49`
  assert.deepEqual(primero, {
    bloque: BLOQUE_FINAS,
    producto: "CARNE PARA MOLER",
    cantidadKg: 4.49,
    pesajes: 2,
    rendimientoPct: 2.48,
    promedioKg: 4.49,
    orden: 0,
  });
});

test("un nombre con guión no se confunde con las columnas", () => {
  // "ROMPE MALAYA - RILA 0.72 1 0.40 % 0.72" es la línea que rompe cualquier
  // split por espacios: el guión del nombre parece un separador de columna.
  const r = parsearInformeDesposte(TEXTO);
  const rila = r.items.find((i) => i.producto.startsWith("ROMPE"));

  assert.equal(rila.producto, "ROMPE MALAYA - RILA");
  assert.equal(rila.cantidadKg, 0.72);
  assert.equal(rila.bloque, BLOQUE_SUBPRODUCTOS);
});

test("el salto de página no se traga renglones de SUBPRODUCTOS", () => {
  // En el PDF real, SUBPRODUCTOS está partido: CHOCOZUELA, DESPOJOS y HUESO
  // BLANCO quedan en la página 1, y entre ellos y ROMPE MALAYA se cuela el pie
  // ("Page 1 of 2Inf Rendimiento..." + la URL del servidor). Si el pie no se
  // descartara línea por línea, la sección se cortaría ahí y faltarían 9.78 kg.
  const r = parsearInformeDesposte(TEXTO);
  const nombres = r.items
    .filter((i) => i.bloque === BLOQUE_SUBPRODUCTOS)
    .map((i) => i.producto);

  assert.deepEqual(nombres, [
    "CHOCOZUELA",
    "DESPOJOS",
    "HUESO BLANCO",
    "ROMPE MALAYA - RILA",
    "SEBO",
  ]);
});

test("los totales de sección son los que trae el informe", () => {
  const r = parsearInformeDesposte(TEXTO);

  assert.equal(r.totales.kgFinas, 133.5);
  assert.equal(r.totales.kgSubproductos, 47.33);
});

test("la suma de las líneas cuadra con el total impreso", () => {
  // Éste es el autocontrol del parser. Si un día el frigorífico cambia el
  // formato del reporte y se pierde un renglón, la advertencia salta acá y no
  // seis meses después, como un faltante de carne que nadie encuentra.
  const r = parsearInformeDesposte(TEXTO);
  assert.equal(
    r.advertencias.filter((a) => a.codigo === "total_no_cuadra").length,
    0,
    JSON.stringify(r.advertencias),
  );
});

test("lee los totales del pie, incluidas las etiquetas partidas en dos líneas", () => {
  const r = parsearInformeDesposte(TEXTO);

  assert.equal(r.totales.kgPesoPie, 352.0);
  assert.equal(r.totales.kgCanalCaliente, 185.5);
  // "Total Peso Canal Fria" / "(Ingreso Desposte) 181.2" — dos líneas.
  assert.equal(r.totales.kgCanalFria, 181.2);
  assert.equal(r.totales.kgDesposte, 180.83);
  // "Total Peso Desposte" / "Aprovechable (TCA) 133.50" — empieza igual que el
  // anterior, y ese es justamente el riesgo de leerlo con una regex floja.
  assert.equal(r.totales.kgAprovechable, 133.5);
  assert.equal(r.totales.rendimientoPct, 73.68);
  assert.equal(r.totales.mermaKg, 0.37);
  assert.equal(r.totales.mermaPct, 0.2);
});

test("el informe real no genera advertencias", () => {
  const r = parsearInformeDesposte(TEXTO);
  assert.deepEqual(r.advertencias, []);
});

test("un PDF sin texto avisa en vez de guardar ceros", () => {
  // Un escaneo o una foto: `unpdf` devuelve vacío. Guardar 0 kg en silencio
  // haría que el cruce reporte que faltó TODA la carne.
  const r = parsearInformeDesposte("");

  assert.equal(r.items.length, 0);
  const codigos = r.advertencias.map((a) => a.codigo);
  assert.ok(codigos.includes("sin_lineas"));
  assert.ok(codigos.includes("sin_subcliente"));
  assert.ok(codigos.includes("sin_lote"));
});

test("detecta un renglón perdido comparando contra el total impreso", () => {
  // Se le saca a mano una línea de FINAS: es lo que pasaría si el frigorífico
  // cambiara el ancho de una columna y la regex dejara de matchear.
  const mutilado = TEXTO.split(/\r?\n/)
    .filter((l) => !l.startsWith("TABLA "))
    .join("\n");

  const r = parsearInformeDesposte(mutilado);
  const aviso = r.advertencias.find((a) => a.codigo === "total_no_cuadra");

  assert.ok(aviso, "tenía que avisar que la suma no da");
  assert.match(aviso.mensaje, /133\.5/);
});

test("no confunde 'Cliente' con 'Sub Cliente' ni con 'Documento Cliente'", () => {
  const r = parsearInformeDesposte(TEXTO);

  assert.ok(!r.cliente.includes("MK"), `cliente = ${r.cliente}`);
  assert.ok(!r.subcliente.startsWith("380"), `subcliente = ${r.subcliente}`);
  assert.match(r.lote, /^\d+$/);
});

test("aNumero: punto decimal, coma de miles, y null cuando no hay dato", () => {
  // El reporte viene en formato inglés, al revés del resto del sistema.
  assert.equal(aNumero("133.50"), 133.5);
  assert.equal(aNumero("1,234.56"), 1234.56);
  assert.equal(aNumero("0.20"), 0.2);
  // null, NO 0: "sin dato" y "cero kilos" son cosas distintas para el cruce.
  assert.equal(aNumero(""), null);
  assert.equal(aNumero(null), null);
  assert.equal(aNumero("no es un número"), null);
});

test("aFechaISO convierte el formato del reporte", () => {
  assert.equal(aFechaISO("28/08/2026"), "2026-08-28");
  assert.equal(aFechaISO("1/9/2026"), "2026-09-01");
  assert.equal(aFechaISO("2026-08-28"), null);
  assert.equal(aFechaISO(null), null);
});

test("normalizarNombre iguala acentos, mayúsculas y espacios de más", () => {
  assert.equal(normalizarNombre("Entrañitas"), "ENTRANITAS");
  assert.equal(normalizarNombre("  chata  de   solomito "), "CHATA DE SOLOMITO");
  assert.equal(normalizarNombre("ROMPE MALAYA - RILA"), "ROMPE MALAYA RILA");
  assert.equal(normalizarNombre(null), "");
});

test("normalizarNombre NO junta cortes distintos que se parecen", () => {
  // La razón por la que el cruce usa un diccionario explícito y no parecido de
  // texto: estos dos son productos diferentes y quedan a una palabra.
  assert.notEqual(normalizarNombre("PUNTA DE ANCA"), normalizarNombre("PUNTA DE FALDA"));
  assert.notEqual(normalizarNombre("SABALETA"), normalizarNombre("SABALETICA"));
});
