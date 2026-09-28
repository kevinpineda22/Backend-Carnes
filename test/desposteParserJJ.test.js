import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  esFormatoJJ,
  parsearInformeDesposteJJ,
  aNumeroLatino,
} from "../src/shared/desposteParserJJ.js";
import { parsearInformeDesposte, BLOQUE_FINAS } from "../src/shared/desposteParser.js";

/**
 * Los fixtures NO son inventados: son el texto que la propia `extraerTexto()`
 * del backend saca de los 9 PDF reales que mandó Comercial de Carnes J&J
 * ("MERKAHORRO <SEDE> CANALES.pdf"), uno por sede.
 */
const leer = (nombre) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${nombre}`, import.meta.url)), "utf8");

const TEXTO_LOPEZ = leer("desposte-jj-lopez-6-1230953340.txt");
const TEXTO_RES = leer("desposte-lopez-13526305.txt"); // el formato de VisualERP, sin tocar

/**
 * Un caso por sede: cuántos productos trae la tabla de la página 1 y cuánto
 * suma el "Total" impreso — el mismo autocontrol que hace el parser.
 */
const CASOS = [
  { archivo: "desposte-jj-carnes-13-1230953340.txt", items: 13, totalKg: 1068.29 },
  { archivo: "desposte-jj-llano-8-1220948340.txt", items: 14, totalKg: 751.49 },
  { archivo: "desposte-jj-lopez-6-1230953340.txt", items: 13, totalKg: 505.94 },
  { archivo: "desposte-jj-parque-13-1220948340.txt", items: 14, totalKg: 1219.56 },
  { archivo: "desposte-jj-plaza-24-1220948340.txt", items: 15, totalKg: 2022.35 },
  { archivo: "desposte-jj-san-juan-9-1220948340.txt", items: 13, totalKg: 831.33 },
  { archivo: "desposte-jj-super-13-1230953340.txt", items: 13, totalKg: 1110.61 },
  { archivo: "desposte-jj-vegas-8-1220948340.txt", items: 13, totalKg: 812.71 },
  { archivo: "desposte-jj-villa-hermosa-13-1220948340.txt", items: 15, totalKg: 1097.0 },
];

for (const { archivo, items, totalKg } of CASOS) {
  test(`${archivo}: lee ${items} productos y el total cuadra con "Total"`, () => {
    const texto = leer(archivo);
    const r = parsearInformeDesposteJJ(texto);

    assert.equal(r.items.length, items);
    assert.equal(r.totales.kgFinas, totalKg);

    const suma = Math.round(r.items.reduce((a, i) => a + i.cantidadKg, 0) * 100) / 100;
    assert.equal(suma, totalKg);

    // No hay FINAS/SUBPRODUCTOS en este formato: todo lo que sale de bodega es
    // un corte aprovechable, así que todas las líneas van al mismo bloque que
    // el cruce ya trata como "carne que sí entra".
    assert.ok(r.items.every((i) => i.bloque === BLOQUE_FINAS));

    assert.equal(r.especie, "cerdo");
    assert.deepEqual(
      r.advertencias.filter((a) => a.codigo === "total_no_cuadra"),
      [],
    );
    assert.deepEqual(
      r.advertencias.filter((a) => a.codigo === "guia_transporte_no_cuadra"),
      [],
    );
  });
}

test("lee la cabecera de la guía real (LOPEZ)", () => {
  const r = parsearInformeDesposteJJ(TEXTO_LOPEZ);

  // `lote` es el documento de salida de bodega ("No. MQ0000xxxx"), NO la
  // columna "Lote" de la tabla (ese es el lote de PRODUCCIÓN, y se repite
  // entre sedes del mismo día — ver la nota de cabecera de desposteParserJJ.js
  // y los tests de "lotes distintos" más abajo).
  assert.equal(r.lote, "MQ00003186");
  assert.equal(r.fechaDesposte, "2026-09-23");
  assert.equal(r.cliente, "COMERCIAL DE CARNES J&J SAS");
  assert.equal(r.subcliente, "LOPEZ 6 CANALES");
  assert.equal(r.especie, "cerdo");
  assert.equal(r.formato, "jj");
  assert.equal(r.documento.salidaBodega, "MQ00003186");
  assert.equal(r.documento.guiaTransporte, "203DM-003186-26");
  assert.equal(r.documento.loteProduccion, "1230953340");
  assert.equal(r.documento.canales, 6);
});

test("los 9 documentos de salida (lote) son todos distintos", () => {
  // Esto es justamente lo que el índice único de `carnes_desposte_informes.lote`
  // exige. El lote de PRODUCCIÓN no lo cumple —López y Super comparten
  // 1230953340, y otras seis sedes comparten 1220948340 el mismo día— así que
  // si `lote` fuera ese número, la segunda sede de cada grupo rompería la
  // base de datos al adjuntar, incluso con `forzar`.
  const lotes = CASOS.map(({ archivo }) => parsearInformeDesposteJJ(leer(archivo)).lote);

  assert.equal(new Set(lotes).size, CASOS.length);
  assert.ok(
    lotes.every((l) => /^MQ\d+$/.test(l)),
    `algún lote no tiene la forma esperada: ${JSON.stringify(lotes)}`,
  );
});

test("el primer renglón trae las columnas esperadas", () => {
  // "202 CAÑON DE CERDO 1230953340 26,80 1"
  const r = parsearInformeDesposteJJ(TEXTO_LOPEZ);
  const primero = r.items[0];

  assert.deepEqual(primero, {
    bloque: BLOQUE_FINAS,
    producto: "CAÑON DE CERDO",
    cantidadKg: 26.8,
    pesajes: 1,
    rendimientoPct: null,
    promedioKg: null,
    orden: 0,
  });
});

test("un PDF sin texto avisa en vez de guardar ceros", () => {
  const r = parsearInformeDesposteJJ("");
  assert.equal(r.items.length, 0);
  const codigos = r.advertencias.map((a) => a.codigo);
  assert.ok(codigos.includes("sin_lineas"));
  assert.ok(codigos.includes("sin_subcliente"));
  assert.ok(codigos.includes("sin_lote"));
});

test("aNumeroLatino: punto de miles, coma decimal, y null cuando no hay dato", () => {
  // Formato colombiano: al revés que `aNumero()` de desposteParser.js.
  assert.equal(aNumeroLatino("2.022,35"), 2022.35);
  assert.equal(aNumeroLatino("505,94"), 505.94);
  assert.equal(aNumeroLatino("45,000"), 45);
  assert.equal(aNumeroLatino(""), null);
  assert.equal(aNumeroLatino(null), null);
  assert.equal(aNumeroLatino("no es un número"), null);
});

test("esFormatoJJ reconoce el formato nuevo y no el de VisualERP", () => {
  assert.equal(esFormatoJJ(TEXTO_LOPEZ), true);
  assert.equal(esFormatoJJ(TEXTO_RES), false);
  assert.equal(esFormatoJJ(""), false);
});

// ─── El punto de entrada: parsearInformeDesposte() ─────────────────────────
//
// Esto es lo que realmente llaman el modelo y el script de mapeo: no un import
// directo de desposteParserJJ.js. Si la detección se rompiera acá, el resto de
// los tests de este archivo no lo notaría.

test("parsearInformeDesposte() detecta la guía de J&J y delega", () => {
  const r = parsearInformeDesposte(TEXTO_LOPEZ);
  assert.equal(r.formato, "jj");
  assert.equal(r.lote, "MQ00003186");
  assert.equal(r.especie, "cerdo");
  assert.equal(r.items.length, 13);
});

test("parsearInformeDesposte() sigue leyendo el informe de VisualERP igual que antes", () => {
  const r = parsearInformeDesposte(TEXTO_RES);
  // El formato viejo no declara "formato" ni "especie": si algún día aparecen
  // acá es que este parser dejó de ser el que corre en producción.
  assert.equal(r.formato, undefined);
  assert.equal(r.especie, undefined);
  assert.equal(r.lote, "13526305");
  assert.equal(r.items.filter((i) => i.bloque === BLOQUE_FINAS).length, 34);
});
