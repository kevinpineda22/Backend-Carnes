/**
 * mapear-desposte.js — Llena el diccionario PDF ↔ plantilla.
 *
 * Uso:
 *   npm run mapear -- --archivo "ruta/al/informe.pdf"          → simulacro
 *   npm run mapear -- --archivo "..." --especie res --aplicar  → escribe
 *
 * Lee un informe del frigorífico, y para cada producto busca en la plantilla un
 * ítem cuya `descripcion` sea IGUAL al nombre del PDF (ignorando acentos,
 * mayúsculas y espacios de más). Cuando lo encuentra, le guarda ese nombre en
 * `nombre_desposte`, que es lo que habilita el cruce producto por producto.
 *
 * ─── Solo coincidencia EXACTA. Nunca parecido. ───────────────────────────
 *
 * Y no es una precaución teórica: en la plantilla de res, el `COSTILLA` del
 * informe tiene DOS candidatos —"COSTILLA DE RES" y "COSTILLA CORRIENTE"— y son
 * dos productos con códigos de SIESA distintos. Cualquier heurística de
 * similitud elige uno de los dos y acierta la mitad de las veces; el error queda
 * invisible, porque los kilos cuadran igual.
 *
 * Por eso este script hace SOLO lo que no puede equivocarse, y deja lo demás
 * listado para que lo resuelva quien conoce el negocio, en la grilla de
 * Plantilla. Un diccionario incompleto no rompe nada: el cruce por kilos
 * funciona igual y los productos sin mapear salen marcados como tales.
 *
 * ─── Es idempotente ──────────────────────────────────────────────────────
 *
 * Nunca pisa un `nombre_desposte` que ya tenga valor. Si alguien resolvió
 * COSTILLA a mano, volver a correr el script no le deshace el trabajo.
 */
import { readFileSync } from "node:fs";
import "dotenv/config";

import { supabase } from "../src/config/supabase.js";
import { extraerTexto } from "../src/services/pdf.service.js";
import { parsearInformeDesposte, normalizarNombre } from "../src/shared/desposteParser.js";

const args = process.argv.slice(2);
const valor = (bandera) => {
  const i = args.indexOf(bandera);
  return i >= 0 ? args[i + 1] : null;
};

const archivo = valor("--archivo");
const especie = valor("--especie") || "res";
const aplicar = args.includes("--aplicar");

if (!archivo) {
  console.error(
    "Falta el informe.\n" +
      '  npm run mapear -- --archivo "C:/ruta/informe.pdf" [--especie res|cerdo] [--aplicar]',
  );
  process.exit(1);
}

const { texto } = await extraerTexto(readFileSync(archivo));
const informe = parsearInformeDesposte(texto);

if (informe.items.length === 0) {
  console.error("No se pudo leer ningún producto del PDF.");
  process.exit(1);
}

const { data: plantilla, error } = await supabase
  .from("carnes_plantilla_items")
  .select("id, codigo_item, descripcion, nombre_desposte")
  .eq("especie", especie)
  .eq("activo", true);

if (error) {
  console.error(`No se pudo leer la plantilla: ${error.message}`);
  process.exit(1);
}

// Un nombre normalizado puede corresponder a varios ítems. Se guardan TODOS:
// dos candidatos no son una coincidencia, son una ambigüedad, y hay que verla.
const porDescripcion = new Map();
for (const item of plantilla) {
  const clave = normalizarNombre(item.descripcion);
  porDescripcion.set(clave, [...(porDescripcion.get(clave) || []), item]);
}

const aEscribir = [];
const yaEstaban = [];
const sinCandidato = [];
const ambiguos = [];

for (const linea of informe.items) {
  const candidatos = porDescripcion.get(normalizarNombre(linea.producto)) || [];

  if (candidatos.length === 0) {
    sinCandidato.push(linea);
  } else if (candidatos.length > 1) {
    ambiguos.push({ linea, candidatos });
  } else if (candidatos[0].nombre_desposte) {
    yaEstaban.push({ linea, item: candidatos[0] });
  } else {
    aEscribir.push({ linea, item: candidatos[0] });
  }
}

const bloque = (l) => (l.bloque === "finas" ? "FINAS" : "SUBPR");

console.log(`\nInforme: lote ${informe.lote} · ${informe.subcliente}`);
console.log(`Plantilla de ${especie}: ${plantilla.length} ítems activos\n`);

console.log(`✔ ${aEscribir.length} para mapear:`);
for (const { linea, item } of aEscribir) {
  console.log(`   ${bloque(linea)}  ${linea.producto.padEnd(24)} → ${item.codigo_item} ${item.descripcion}`);
}

if (yaEstaban.length) {
  console.log(`\n· ${yaEstaban.length} ya estaban mapeados (no se tocan).`);
}

if (ambiguos.length) {
  console.log(`\n⚠ ${ambiguos.length} AMBIGUO(S) — los resolvés vos en la grilla de Plantilla:`);
  for (const { linea, candidatos } of ambiguos) {
    console.log(`   "${linea.producto}" podría ser cualquiera de:`);
    for (const c of candidatos) console.log(`      · ${c.codigo_item} ${c.descripcion}`);
  }
}

if (sinCandidato.length) {
  console.log(`\n○ ${sinCandidato.length} del informe sin ítem con ese nombre en la plantilla:`);
  for (const l of sinCandidato) console.log(`   ${bloque(l)}  ${l.producto}`);
  console.log(
    "   (Los de SUBPR es normal que no estén: son hueso, sebo y despojos.\n" +
      "    Los de FINAS hay que mapearlos a mano si el corte sí se recibe.)",
  );
}

// Se sale con un `if` y no con `process.exit()`: el lector de PDF deja handles
// cerrándose, y matar el proceso justo ahí aborta con un assert de libuv
// —"UV_HANDLE_CLOSING"— que parece un error del script cuando en realidad ya
// terminó bien. Además no hay nada que abortar: el trabajo está hecho.
if (!aplicar) {
  console.log("\n── SIMULACRO. No se escribió nada. Agregá --aplicar para guardar.\n");
} else {
  await escribir();
}

async function escribir() {
  let escritos = 0;
  for (const { linea, item } of aEscribir) {
    const { error: e } = await supabase
      .from("carnes_plantilla_items")
      .update({ nombre_desposte: linea.producto })
      .eq("id", item.id)
      // La condición se repite en el UPDATE y no solo en el filtro de arriba:
      // entre la lectura y la escritura alguien pudo haberlo mapeado desde la
      // grilla, y este script no está para pisarle el trabajo a nadie.
      .is("nombre_desposte", null);
    if (e) {
      console.error(`   ✗ ${item.descripcion}: ${e.message}`);
    } else {
      escritos++;
    }
  }

  console.log(`\n✔ ${escritos} ítems mapeados.\n`);
}
