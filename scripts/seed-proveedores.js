/**
 * seed-proveedores.js — Carga el Excel "Equivalencias" en el recibidor de
 * proveedores (carnes_proveedores y carnes_proveedor_equivalencias).
 *
 * Uso:
 *   npm run seed:proveedores -- "C:/ruta/Equivalencias.xlsx"             → simulacro
 *   npm run seed:proveedores -- "C:/ruta/Equivalencias.xlsx" --aplicar   → escribe
 *   (opcional) --maestro "nombre de la hoja"   por defecto "proveedores mientras"
 *
 * ─── El simulacro NO toca la base ────────────────────────────────────────
 *
 * Es el modo por defecto y ni siquiera abre la conexión a Supabase: lee el
 * Excel, lo normaliza y cuenta. Sirve para revisar el archivo ANTES de escribir.
 * Solo `--aplicar` importa el cliente de Supabase.
 *
 * ─── Qué hace con --aplicar ──────────────────────────────────────────────
 *
 *   1. Hoja del maestro → upsert de los proveedores por (nit, sucursal). No toca
 *      `activo`: si el admin desactivó a alguien, re-sembrar no lo reactiva.
 *   2. Cada otra hoja se empareja con un proveedor por su razón social (el nombre
 *      de hoja puede venir cortado a 31 caracteres). Sin coincidencia, o con más
 *      de una, la hoja se reporta y se OMITE: nunca se elige una al azar.
 *   3. Las filas de la hoja se upsertean por (proveedor_id, codigo_item, unidad,
 *      equivalencia), el UNIQUE de sql/022, así que correr el script dos veces no
 *      duplica nada.
 *   4. Lo que estaba activo y ya no está en la hoja se DESACTIVA, nunca se borra
 *      (las recepciones ya hechas apuntan a esa fila). Si la hoja tuvo filas
 *      rechazadas no se desactiva nada: primero se arregla el Excel.
 *
 * Cargar los 16 proveedores del maestro es inofensivo: el selector del recibidor
 * solo lista a los que tienen plantilla activa (GET /proveedores?con_plantilla=1).
 *
 * El NIT/sucursal de cada FILA de una hoja se ignora (el de Sánchez trae dos
 * NIT distintos): manda el del maestro. Solo se reporta.
 *
 * SheetJS es devDependency a propósito: este script corre en una máquina con el
 * repo clonado, no en Vercel.
 */
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

import {
  TOPE_FILAS_EXCEL,
  armarPlanSeed,
  idsADesactivar,
} from "../src/shared/equivalenciasProveedor.js";

const args = process.argv.slice(2);
const valor = (bandera) => {
  const i = args.indexOf(bandera);
  return i >= 0 ? args[i + 1] : null;
};
const aplicar = args.includes("--aplicar");
const nombreMaestro = valor("--maestro") || "proveedores mientras";
// El archivo es el primer argumento que no es una bandera ni el valor de una.
const archivo = args.find((a, i) => !a.startsWith("--") && !["--maestro"].includes(args[i - 1]));

if (!archivo) {
  console.error(
    "Falta el Excel.\n" +
      '  npm run seed:proveedores -- "C:/ruta/Equivalencias.xlsx" [--aplicar] [--maestro "hoja"]',
  );
  process.exit(1);
}

// ─── Lectura ──────────────────────────────────────────────────────────────

// `sheetRows` es indispensable: la hoja de Nutresa reporta ~1M de filas con
// formato y sin tope SheetJS las materializa todas.
const libro = XLSX.read(readFileSync(archivo), { type: "buffer", sheetRows: TOPE_FILAS_EXCEL });
const hojas = libro.SheetNames.map((nombre) => ({
  nombre,
  filas: XLSX.utils.sheet_to_json(libro.Sheets[nombre], { header: 1, defval: null, raw: true }),
}));

const plan = armarPlanSeed({ hojas, nombreMaestro, topeFilas: TOPE_FILAS_EXCEL });
if (!plan.ok) {
  console.error(`No se pudo armar el plan:\n  - ${plan.errores.join("\n  - ")}`);
  process.exit(1);
}

// ─── Reporte ──────────────────────────────────────────────────────────────

console.log(`\nArchivo: ${archivo}`);
console.log(`Modo: ${aplicar ? "APLICAR (escribe en la base)" : "SIMULACRO (no escribe nada)"}\n`);

console.log(`Maestro "${nombreMaestro}": ${plan.proveedores.length} proveedores`);
for (const r of plan.rechazadasMaestro) console.log(`  ! fila ${r.fila} rechazada: ${r.motivo}`);
for (const a of plan.advertencias) console.log(`  ~ ${a}`);

const conPlantilla = new Set();
let hayProblemas = plan.rechazadasMaestro.length > 0;

console.log("\nHojas de equivalencias:");
for (const h of plan.hojas) {
  const etiqueta = `"${h.hoja}"`;
  if (h.estado === "vacia") {
    console.log(`  · ${etiqueta}: vacía, se omite`);
    continue;
  }
  if (h.estado === "invalida") {
    console.log(`  ! ${etiqueta}: no se pudo leer (${h.normalizada.errores.join(" ")}), se omite`);
    hayProblemas = true;
    continue;
  }
  if (h.estado === "sin_proveedor") {
    console.log(`  ! ${etiqueta}: no coincide con ningún proveedor del maestro, se omite`);
    hayProblemas = true;
    continue;
  }
  if (h.estado === "ambigua") {
    console.log(
      `  ! ${etiqueta}: coincide con varios proveedores (${h.candidatos
        .map((c) => `${c.razon_social} ${c.nit}/${c.sucursal}`)
        .join("; ")}), se omite`,
    );
    hayProblemas = true;
    continue;
  }
  if (h.estado === "repetida") {
    console.log(`  ! ${etiqueta}: ${h.advertencias.at(-1)}`);
    hayProblemas = true;
    continue;
  }

  const r = h.normalizada.resumen;
  conPlantilla.add(`${h.proveedor.nit}|${h.proveedor.sucursal}`);
  console.log(
    `  · ${etiqueta} → ${h.proveedor.razon_social} (${h.proveedor.nit}/${h.proveedor.sucursal})\n` +
      `      filas leídas: ${r.leidas} | a cargar: ${r.validas} | sin equivalencia: ${r.sin_equivalencia}` +
      ` | duplicadas: ${r.duplicadas} | unidades inválidas: ${r.unidades_invalidas}` +
      ` | rechazadas: ${r.rechazadas} | sin Item: ${r.sin_item}`,
  );
  for (const x of h.normalizada.rechazadas) {
    console.log(`      ! fila ${x.fila} (Item ${x.codigo_item || "—"}): ${x.motivo}`);
  }
  for (const a of h.advertencias) console.log(`      ~ ${a}`);
  if (h.normalizada.rechazadas.length > 0) hayProblemas = true;
}

const sinPlantilla = plan.proveedores.filter((p) => !conPlantilla.has(`${p.nit}|${p.sucursal}`));
console.log(
  `\nProveedores con plantilla (aparecen en el selector): ${conPlantilla.size} de ${plan.proveedores.length}`,
);
if (sinPlantilla.length > 0) {
  console.log(`Sin plantilla (se cargan, pero no aparecen en el selector): ${sinPlantilla.length}`);
}

if (!aplicar) {
  console.log(
    "\nSimulacro: no se escribió nada. Con --aplicar se haría upsert de " +
      `${plan.proveedores.length} proveedores y de las filas de ${conPlantilla.size} plantillas, ` +
      "y se desactivarían las filas activas que ya no estén en la hoja.\n",
  );
  process.exit(0);
}

// ─── Escritura ────────────────────────────────────────────────────────────

// Import dinámico: `config/supabase.js` termina el proceso si faltan las
// variables de entorno, y el simulacro no debería necesitarlas.
const { supabase } = await import("../src/config/supabase.js");
const { esMigracionFaltante } = await import("../src/shared/migraciones.js");

function fallar(contexto, error) {
  if (esMigracionFaltante(error)) {
    console.error(`\n${contexto}: a la base le falta sql/022_proveedores.sql. Correlo en Supabase y reintentá.`);
  } else {
    console.error(`\n${contexto}: ${error?.message || "error sin detalle"}`);
  }
  process.exit(1);
}

const LOTE = 500;

const { data: guardados, error: errorProveedores } = await supabase
  .from("carnes_proveedores")
  // `activo` no va en el payload: el upsert solo pisa las columnas que recibe.
  .upsert(plan.proveedores, { onConflict: "nit,sucursal" })
  .select("id, nit, sucursal");
if (errorProveedores) fallar("No se pudieron guardar los proveedores", errorProveedores);

const idDe = new Map(guardados.map((p) => [`${p.nit}|${p.sucursal}`, p.id]));
console.log(`\nProveedores guardados: ${guardados.length}`);

for (const h of plan.hojas) {
  if (h.estado !== "ok") continue;
  const { filas, rechazadas } = h.normalizada;
  if (filas.length === 0) {
    console.log(`  · "${h.hoja}": sin filas válidas, no se escribe ni se desactiva nada`);
    continue;
  }
  const proveedorId = idDe.get(`${h.proveedor.nit}|${h.proveedor.sucursal}`);

  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE).map((f) => ({
      proveedor_id: proveedorId,
      codigo_item: f.codigo_item,
      descripcion_item: f.descripcion_item,
      unidad: f.unidad,
      equivalencia: f.equivalencia,
      orden: f.orden,
      activo: true,
    }));
    const { error } = await supabase
      .from("carnes_proveedor_equivalencias")
      .upsert(lote, { onConflict: "proveedor_id,codigo_item,unidad,equivalencia" });
    if (error) fallar(`No se pudo guardar la plantilla de "${h.hoja}"`, error);
  }

  let desactivadas = 0;
  if (rechazadas.length > 0) {
    console.log(`  · "${h.hoja}": ${filas.length} filas guardadas; hubo filas rechazadas, no se desactiva nada`);
    continue;
  }
  const { data: existentes, error: errorLeer } = await supabase
    .from("carnes_proveedor_equivalencias")
    .select("id, codigo_item, unidad, equivalencia, activo")
    .eq("proveedor_id", proveedorId)
    .eq("activo", true);
  if (errorLeer) fallar(`No se pudo leer la plantilla de "${h.hoja}"`, errorLeer);

  const ids = idsADesactivar(existentes || [], filas);
  if (ids.length > 0) {
    const { error } = await supabase
      .from("carnes_proveedor_equivalencias")
      .update({ activo: false })
      .in("id", ids);
    if (error) fallar(`No se pudieron desactivar filas de "${h.hoja}"`, error);
    desactivadas = ids.length;
  }
  console.log(`  · "${h.hoja}": ${filas.length} filas guardadas, ${desactivadas} desactivadas`);
}

console.log(
  hayProblemas
    ? "\nListo, con observaciones: revisá las líneas marcadas con ! arriba.\n"
    : "\nListo.\n",
);
