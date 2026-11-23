// Cobertura de la spec (2.19 y 3.9): cada escenario D-S1..D-S11, B-S4, B-S5, A-S4, A-S6, E-S1..E-S7 y F-S1..F-S5 tiene al menos
// un test con su identificador en el título, en el archivo esperado. Es una prueba estática:
// solo lee archivos de test, no ejecuta nada.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const leer = (archivo) => readFileSync(new URL(`./${archivo}`, import.meta.url), "utf8");

/** Escenario -> archivos donde debe haber un `test("<ID> ...")`. */
const COBERTURA = {
  "D-S1": ["preliquidacion-procesar.test.js"],
  "D-S2": ["preliquidacion-procesar.test.js"],
  "D-S3": ["preliquidacion-procesar.test.js", "preliquidacion-cron-servicio.test.js"],
  "D-S4": ["preliquidacion-procesar.test.js"],
  "D-S5": ["preliquidacion-procesar-sede.test.js"],
  "D-S6": ["preliquidacion-inmediato.test.js"],
  "D-S7": ["preliquidacion-inmediato.test.js"],
  "D-S8": ["cron-preliquidaciones.test.js"],
  "D-S9": ["preliquidacion-procesar.test.js"],
  "D-S10": ["preliquidacion-procesar.test.js"],
  "D-S11": ["preliquidacion-procesar.test.js"],
  "B-S4": ["preliquidacion-vinculacion.test.js"],
  "B-S5": ["preliquidacion-vinculacion.test.js"],
  "A-S4": ["preliquidacion-vigilancia.test.js"],
  "A-S6": ["preliquidacion-inmediato.test.js", "preliquidacion-routes.test.js"],
  // Slice 3 (3.9): servicio tardío, alterna, saldo pendiente y correcciones.
  "E-S1": ["preliquidacion-alterna.test.js", "preliquidacion-tardio.test.js"],
  "E-S2": ["preliquidacion-alterna.test.js", "preliquidacion-costeo.test.js", "preliquidacion-saldo.test.js", "preliquidacion-tardio.test.js"],
  "E-S3": ["preliquidacion-costeo.test.js", "preliquidacion-saldos-routes.test.js"],
  "E-S4": ["preliquidacion-saldos-routes.test.js"],
  "E-S5": ["preliquidacion-saldos-routes.test.js"],
  "E-S6": ["preliquidacion-saldos-routes.test.js", "preliquidacion-rpc-correcciones.test.js"],
  "E-S7": ["preliquidacion-alterna.test.js", "preliquidacion-tardio.test.js"],
  "F-S1": ["preliquidacion-recalcular.test.js"],
  "F-S2": ["preliquidacion-correcciones.test.js"],
  "F-S3": ["preliquidacion-correcciones.test.js"],
  "F-S4": ["preliquidacion-correcciones.test.js", "preliquidacion-routes.test.js"],
  "F-S5": ["preliquidacion-recalcular.test.js"],
};

const titulos = (texto) => [...texto.matchAll(/\btest\(\s*[`"']([^`"']+)[`"']/g)].map((m) => m[1]);

for (const [escenario, archivos] of Object.entries(COBERTURA)) {
  test(`${escenario} tiene un test nombrado en ${archivos.join(" y ")}`, () => {
    const patron = new RegExp(`(^|[^A-Za-z0-9-])${escenario}(?![0-9])`);
    for (const archivo of archivos) {
      const nombres = titulos(leer(archivo));
      assert.ok(nombres.some((n) => patron.test(n)), `${archivo} no tiene un test cuyo título mencione ${escenario}`);
    }
  });
}
