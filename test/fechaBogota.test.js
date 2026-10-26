import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { hoyBogota } from "../src/shared/fechaBogota.js";
import { hoyBogota as desdeProveedorValores } from "../src/shared/proveedorValores.js";

test("hoyBogota: de 7:00 p. m. a 11:59 p. m. de Bogotá sigue siendo el mismo día", () => {
  // 19:00, 19:34 y 23:59 del 25/10/2026 en Bogotá = 00:00, 00:34 y 04:59 UTC del 26.
  assert.equal(hoyBogota(new Date("2026-10-26T00:00:00Z")), "2026-10-25");
  assert.equal(hoyBogota(new Date("2026-10-26T00:34:00Z")), "2026-10-25");
  assert.equal(hoyBogota(new Date("2026-10-26T04:59:59Z")), "2026-10-25");
});

test("hoyBogota: el caso de la recepción #124 (cerrada 7:34 p. m. del 25/10)", () => {
  const instante = new Date("2026-10-25T19:34:00-05:00");
  assert.equal(instante.toISOString().slice(0, 10), "2026-10-26"); // lo que hacía el bug
  assert.equal(hoyBogota(instante), "2026-10-25");
});

test("hoyBogota: a medianoche de Bogotá cambia el día, y antes de las 7 p. m. coincide con UTC", () => {
  assert.equal(hoyBogota(new Date("2026-10-26T05:00:00Z")), "2026-10-26");
  assert.equal(hoyBogota(new Date("2026-10-25T18:59:59-05:00")), "2026-10-25");
  assert.equal(hoyBogota(new Date("2026-10-25T12:00:00Z")), "2026-10-25");
});

test("hoyBogota: fin de año", () => {
  assert.equal(hoyBogota(new Date("2027-01-01T04:59:59Z")), "2026-12-31");
  assert.equal(hoyBogota(new Date("2027-01-01T05:00:00Z")), "2027-01-01");
});

test("proveedorValores reexporta el mismo helper", () => {
  assert.equal(desdeProveedorValores, hoyBogota);
});

test("ningún módulo de src deriva 'hoy' con toISOString().slice(0, 10)", () => {
  // Excepciones: aritmética sobre fechas YYYY-MM-DD ya dadas (T00:00:00Z), no 'hoy'.
  const PERMITIDOS = new Set(["historialRecibidor.js", "sedesFaltantes.js", "transformacionesFiltros.js", "Desposte.model.js"]);
  const archivos = [];
  const recorrer = (dir) => {
    for (const nombre of readdirSync(dir)) {
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (ruta.endsWith(".js")) archivos.push(ruta);
    }
  };
  recorrer(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const culpables = archivos.filter((ruta) => {
    if (PERMITIDOS.has(ruta.split(/[\/]/).pop())) return false;
    return /new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(readFileSync(ruta, "utf8"));
  });
  assert.deepEqual(culpables, []);
});
