import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parsearInformeDesposte } from "../src/shared/desposteParser.js";
import {
  cruzarDesposte,
  verificarIdentidad,
  construirDiccionario,
  TOLERANCIA_KG,
} from "../src/shared/cruceDesposte.js";

const TEXTO = readFileSync(
  fileURLToPath(new URL("./fixtures/desposte-lopez-13526305.txt", import.meta.url)),
  "utf8",
);
const INFORME = parsearInformeDesposte(TEXTO);

/** Renglones como los guarda `carnes_recepcion_items`. */
const carne = (id, descripcion, cantidad) => ({
  tipo: "carne",
  plantilla_item_id: id,
  codigo_item: `C${id}`,
  descripcion,
  cantidad,
});

/**
 * Una recepción que reproduce EXACTAMENTE el informe: mismo nombre, mismos
 * kilos. Es el caso "todo llegó" y la línea base de todos los tests.
 */
const recepcionPerfecta = () =>
  INFORME.items
    .filter((i) => i.bloque === "finas")
    .map((i, n) => carne(n + 1, i.producto, i.cantidadKg));

/** Plantilla con el diccionario completo, apuntando a los mismos ids. */
const plantillaCompleta = () =>
  INFORME.items
    .filter((i) => i.bloque === "finas")
    .map((i, n) => ({
      id: n + 1,
      descripcion: i.producto,
      codigo_item: `C${n + 1}`,
      nombre_desposte: i.producto,
    }));

// ─── Cruce por totales ──────────────────────────────────────────────────────

test("totales: cuando llega todo, la diferencia es cero", () => {
  const r = cruzarDesposte({ informe: INFORME, items: recepcionPerfecta() });

  assert.equal(r.totales.kgPdf, 133.5);
  assert.equal(r.totales.kgRecibido, 133.5);
  assert.equal(r.totales.diferencia, 0);
  assert.equal(r.totales.estado, "ok");
});

test("totales: funciona SIN diccionario — es la comparación del día uno", () => {
  // Sin `plantilla`, el detalle línea por línea no puede armarse, pero el total
  // sí. Ésta es la razón por la que el cruce se entrega antes que el mapeo.
  const r = cruzarDesposte({ informe: INFORME, items: recepcionPerfecta(), plantilla: [] });

  assert.equal(r.totales.estado, "ok");
  assert.ok(r.advertencias.some((a) => a.codigo === "diccionario_incompleto"));
  assert.ok(r.lineas.every((l) => l.estado === "sin_mapear"));
});

test("totales: detecta un faltante", () => {
  const items = recepcionPerfecta();
  items[0].cantidad -= 5; // se perdieron 5 kg de CARNE PARA MOLER

  const r = cruzarDesposte({ informe: INFORME, items });

  assert.equal(r.totales.diferencia, -5);
  assert.equal(r.totales.estado, "faltante");
  const aviso = r.advertencias.find((a) => a.codigo === "faltan_kilos");
  assert.match(aviso.mensaje, /faltan 5 kg/);
});

test("totales: detecta un sobrante", () => {
  const items = recepcionPerfecta();
  items.push(carne(999, "TABLA", 14.19)); // renglón digitado dos veces

  const r = cruzarDesposte({ informe: INFORME, items });

  assert.equal(r.totales.estado, "sobrante");
  assert.ok(r.advertencias.some((a) => a.codigo === "sobran_kilos"));
});

test("totales: una diferencia de báscula no se marca en rojo", () => {
  // La planta pesa en canal, la sede en canasta, horas después. 300 gramos
  // sobre 133 kg no es un faltante: es una báscula.
  const items = recepcionPerfecta();
  items[0].cantidad -= 0.3;

  const r = cruzarDesposte({ informe: INFORME, items });

  assert.ok(0.3 < TOLERANCIA_KG);
  assert.equal(r.totales.estado, "ok");
  assert.equal(r.advertencias.filter((a) => a.codigo === "faltan_kilos").length, 0);
});

test("totales: las vísceras NO entran al cruce contra FINAS", () => {
  // Su contraparte son los subproductos, que es justamente lo que no está
  // definido. Sumarlas acá inventaría un sobrante de la nada.
  const items = [
    ...recepcionPerfecta(),
    { tipo: "vicera", plantilla_item_id: null, descripcion: "Hígado", cantidad: 12.4 },
  ];

  const r = cruzarDesposte({ informe: INFORME, items });

  assert.equal(r.totales.kgRecibido, 133.5);
  assert.equal(r.totales.estado, "ok");
});

test("totales: un adicional SÍ entra — es carne que el frigorífico facturó", () => {
  const items = [
    ...recepcionPerfecta(),
    { tipo: "adicional", plantilla_item_id: null, descripcion: "Corte raro", cantidad: 3 },
  ];

  const r = cruzarDesposte({ informe: INFORME, items });

  assert.equal(r.totales.kgRecibido, 136.5);
  assert.equal(r.totales.estado, "sobrante");
});

// ─── Cruce línea por línea ──────────────────────────────────────────────────

test("líneas: con el diccionario completo, cada corte cuadra", () => {
  const r = cruzarDesposte({
    informe: INFORME,
    items: recepcionPerfecta(),
    plantilla: plantillaCompleta(),
  });

  assert.equal(r.lineas.length, 34);
  assert.ok(
    r.lineas.every((l) => l.estado === "ok"),
    JSON.stringify(r.lineas.filter((l) => l.estado !== "ok")),
  );
  assert.equal(r.advertencias.length, 0);
});

test("líneas: señala el corte exacto que falta", () => {
  const items = recepcionPerfecta();
  const tabla = items.find((i) => i.descripcion === "TABLA");
  tabla.cantidad -= 4;

  const r = cruzarDesposte({
    informe: INFORME,
    items,
    plantilla: plantillaCompleta(),
  });

  const linea = r.lineas.find((l) => l.producto === "TABLA");
  assert.equal(linea.kgPdf, 14.19);
  assert.equal(linea.kgRecibido, 10.19);
  assert.equal(linea.diferencia, -4);
  assert.equal(linea.estado, "faltante");
});

test("líneas: un corte del informe que el recibidor no cargó sale como solo_pdf", () => {
  const items = recepcionPerfecta().filter((i) => i.descripcion !== "COGOTE");

  const r = cruzarDesposte({
    informe: INFORME,
    items,
    plantilla: plantillaCompleta(),
  });

  const linea = r.lineas.find((l) => l.producto === "COGOTE");
  assert.equal(linea.estado, "solo_pdf");
  assert.equal(linea.kgRecibido, 0);
});

test("líneas: un adicional sin plantilla sale como solo_recepcion", () => {
  const items = [
    ...recepcionPerfecta(),
    { tipo: "adicional", plantilla_item_id: null, descripcion: "Corte raro", cantidad: 3 },
  ];

  const r = cruzarDesposte({
    informe: INFORME,
    items,
    plantilla: plantillaCompleta(),
  });

  const extra = r.lineas.find((l) => l.estado === "solo_recepcion");
  assert.equal(extra.descripcion, "Corte raro");
  assert.equal(extra.kgRecibido, 3);
});

test("líneas: un corte SIN mapear no se reporta como sobrante", () => {
  // Éste es el falso positivo que hay que evitar. El recibidor cargó bien, pero
  // ese ítem de plantilla no tiene `nombre_desposte`. La ausencia significa "no
  // sé", no "sobra carne" — y decirle sobrante al admin lo manda a investigar
  // un agujero del diccionario creyendo que es un problema de operación.
  const plantilla = plantillaCompleta();
  plantilla.find((p) => p.descripcion === "COSTILLA").nombre_desposte = null;

  const r = cruzarDesposte({ informe: INFORME, items: recepcionPerfecta(), plantilla });

  assert.equal(r.lineas.filter((l) => l.estado === "solo_recepcion").length, 0);
  const sinMapear = r.lineas.find((l) => l.producto === "COSTILLA");
  assert.equal(sinMapear.estado, "sin_mapear");
  assert.ok(r.advertencias.some((a) => a.codigo === "diccionario_incompleto"));
});

test("líneas: dos renglones del mismo corte se suman antes de comparar", () => {
  const items = recepcionPerfecta();
  const tabla = items.find((i) => i.descripcion === "TABLA");
  tabla.cantidad = 10;
  items.push(carne(tabla.plantilla_item_id, "TABLA", 4.19));

  const r = cruzarDesposte({
    informe: INFORME,
    items,
    plantilla: plantillaCompleta(),
  });

  const linea = r.lineas.find((l) => l.producto === "TABLA");
  assert.equal(linea.kgRecibido, 14.19);
  assert.equal(linea.estado, "ok");
});

// ─── Subproductos ───────────────────────────────────────────────────────────

test("los subproductos se muestran pero NO entran en la diferencia", () => {
  const r = cruzarDesposte({ informe: INFORME, items: recepcionPerfecta() });

  assert.equal(r.subproductos.kgPdf, 47.33);
  assert.equal(r.subproductos.items.length, 5);
  // Si se hubieran sumado, el total daría 180.83 y marcaría un faltante de 47 kg.
  assert.equal(r.totales.kgPdf, 133.5);
  assert.equal(r.totales.estado, "ok");
});

test("un subproducto MAPEADO entra al cruce como carne", () => {
  // La operación recibe chocozuela y rompe como carne. Mapeados en la plantilla,
  // pasan a contar en el total y en el detalle; el resto de los subproductos no.
  const plantilla = [
    ...plantillaCompleta(),
    { id: 901, descripcion: "CHOCOZUELA *KL", codigo_item: "18015", nombre_desposte: "CHOCOZUELA" },
    { id: 902, descripcion: "ROMPE KILO", codigo_item: "18014", nombre_desposte: "ROMPE MALAYA - RILA" },
  ];
  const items = [
    ...recepcionPerfecta(),
    carne(901, "CHOCOZUELA *KL", 0.85),
    carne(902, "ROMPE KILO", 0.72),
  ];

  const r = cruzarDesposte({ informe: INFORME, items, plantilla });

  // 133.50 de FINAS + 0.85 + 0.72
  assert.equal(r.totales.kgPdf, 135.07);
  assert.equal(r.totales.kgRecibido, 135.07);
  assert.equal(r.totales.estado, "ok");

  const choco = r.lineas.find((l) => l.producto === "CHOCOZUELA");
  assert.equal(choco.estado, "ok");
  assert.equal(choco.plantilla_item_id, 901);
  assert.equal(choco.bloque, "subproductos");

  // Los que siguen sin mapear quedan aparte, y ya no incluyen a los dos mapeados.
  const fuera = r.subproductos.items.map((i) => i.producto);
  assert.deepEqual(fuera, ["DESPOJOS", "HUESO BLANCO", "SEBO"]);
  assert.equal(r.subproductos.kgPdf, 45.76); // 47.33 − 0.85 − 0.72
});

test("un subproducto mapeado que NO se recibió sale como solo_pdf", () => {
  const plantilla = [
    ...plantillaCompleta(),
    { id: 901, descripcion: "CHOCOZUELA *KL", codigo_item: "18015", nombre_desposte: "CHOCOZUELA" },
  ];
  const r = cruzarDesposte({ informe: INFORME, items: recepcionPerfecta(), plantilla });

  const choco = r.lineas.find((l) => l.producto === "CHOCOZUELA");
  assert.equal(choco.estado, "solo_pdf");
  assert.equal(r.totales.diferencia, -0.85);
});

test("cada línea del cruce lleva el id de plantilla para pegarla a la fila", () => {
  const r = cruzarDesposte({
    informe: INFORME,
    items: recepcionPerfecta(),
    plantilla: plantillaCompleta(),
  });
  const tabla = r.lineas.find((l) => l.producto === "TABLA");
  assert.ok(Number.isInteger(tabla.plantilla_item_id));
  const sinMapear = cruzarDesposte({ informe: INFORME, items: recepcionPerfecta() }).lineas[0];
  assert.equal(sinMapear.plantilla_item_id, null);
});

// ─── Diccionario ────────────────────────────────────────────────────────────

test("construirDiccionario ignora lo que no tiene nombre_desposte", () => {
  const d = construirDiccionario([
    { id: 1, descripcion: "Tabla", nombre_desposte: "TABLA" },
    { id: 2, descripcion: "Sin mapear", nombre_desposte: null },
    { id: 3, descripcion: "Entrañita", nombre_desposte: "Entrañitas" },
  ]);

  assert.equal(d.size, 2);
  assert.equal(d.get("TABLA").id, 1);
  // Se indexa normalizado: el PDF escribe "ENTRAÑITAS" y la plantilla puede
  // tener otra capitalización o acentuación.
  assert.equal(d.get("ENTRANITAS").id, 3);
});

// ─── Verificación de identidad ──────────────────────────────────────────────

const SEDE_LOPEZ = { id: 3, nombre: "Lopez", subcliente_desposte: "MK - 380 - BARRIO LOPEZ" };

test("identidad: el informe correcto verifica la sede", () => {
  const r = verificarIdentidad(INFORME, SEDE_LOPEZ, "2026-08-28");

  assert.equal(r.sedeCoincide, true);
  assert.equal(r.fechaCoincide, true);
  assert.deepEqual(r.problemas, []);
});

test("identidad: el informe de otra sede se detecta solo", () => {
  // Éste es el motivo por el que existe `subcliente_desposte`: el admin adjunta
  // el PDF de López a la recepción de Villa Hermosa y nadie lo lee a ojo.
  const villa = { id: 5, nombre: "Villa Hermosa", subcliente_desposte: "MK - 380 - VILLA HERMOSA" };
  const r = verificarIdentidad(INFORME, villa, "2026-08-28");

  assert.equal(r.sedeCoincide, false);
  const problema = r.problemas.find((p) => p.codigo === "sede_no_coincide");
  assert.match(problema.mensaje, /BARRIO LOPEZ/);
  assert.match(problema.mensaje, /Villa Hermosa/);
});

test("identidad: una sede sin configurar avisa pero no bloquea", () => {
  const r = verificarIdentidad(INFORME, { id: 9, nombre: "Nueva" }, "2026-08-28");

  assert.equal(r.sedeCoincide, false);
  const problema = r.problemas.find((p) => p.codigo === "sede_sin_configurar");
  // El mensaje trae el valor que hay que copiar, para que configurarlo sea un
  // copy-paste y no una investigación.
  assert.match(problema.mensaje, /MK - 380 - BARRIO LOPEZ/);
});

test("identidad: la fecha distinta informa, no invalida", () => {
  // Se desposta un día y se entrega al siguiente. Es lo normal.
  const r = verificarIdentidad(INFORME, SEDE_LOPEZ, "2026-08-29");

  assert.equal(r.sedeCoincide, true);
  assert.equal(r.fechaCoincide, false);
  assert.ok(r.problemas.some((p) => p.codigo === "fecha_distinta"));
});

test("identidad: tolera diferencias de mayúsculas y espacios en el sub-cliente", () => {
  const sede = { id: 3, nombre: "Lopez", subcliente_desposte: "mk-380-barrio  lopez" };
  const r = verificarIdentidad(INFORME, sede, "2026-08-28");

  assert.equal(r.sedeCoincide, true);
});
