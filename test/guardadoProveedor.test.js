import test from "node:test";
import assert from "node:assert/strict";

import {
  LARGO_MAX_CANTIDAD,
  LARGO_MAX_MOTIVO,
  LARGO_MAX_OBSERVACIONES,
  LARGO_MAX_VALOR,
  MENSAJE_CONFLICTO,
  calcularPendientes,
  normalizarObservaciones,
  parsearCantidad,
  planearGuardado,
  planearReintento,
  resolverRechazos,
} from "../src/shared/guardadoProveedor.js";

// El plan del autoguardado de una recepción de proveedor: qué se escribe, qué se
// rechaza y qué queda pendiente. El modelo no tiene tests (no hay mock de
// Supabase); toda la regla está acá.

const POR = "recibidor@merkahorro.com";
const AHORA = "2026-09-30T15:00:00.000Z";

const fila = (extra = {}) => ({
  id: 1,
  recepcion_id: 5,
  codigo_item: "1234",
  descripcion_item: "POLLO ENTERO",
  unidad: "KL",
  equivalencia: "",
  orden: 1,
  cantidad: 0,
  valor_unitario: null,
  valor_total: null,
  valor_fuente: null,
  exceso_confirmado_cantidad: null,
  exceso_confirmado_por: null,
  exceso_confirmado_at: null,
  valor_confirmado_unitario: null,
  valor_confirmado_por: null,
  valor_confirmado_at: null,
  cantidad_devuelta: 0,
  motivo_devolucion: null,
  ...extra,
});

const plan = (items, entradas) => planearGuardado({ items, entradas, por: POR, ahora: AHORA });
const cambiosDe = (p, id = 1) => p.actualizaciones.find((a) => a.id === id)?.cambios;

// ─── parsearCantidad ───────────────────────────────────────────────────────

test("parsearCantidad: coma o punto decimal, como el front", () => {
  const casos = [
    ["12,5", 12.5],
    ["12.5", 12.5],
    ["12", 12],
    [" 7 ", 7],
    ["12,", 12],
    [",5", 0.5],
    [0, 0],
    [3.25, 3.25],
    ["1.234,5", null], // la cantidad no tiene separador de miles
    ["-1", null],
    [-1, null],
    ["abc", null],
    ["1e3", null],
    ["", null],
    ["  ", null],
    [null, null],
    [undefined, null],
    [NaN, null],
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(parsearCantidad(entrada), esperado, `parsearCantidad(${JSON.stringify(entrada)})`);
  }
});

// ─── Cantidad y valor ──────────────────────────────────────────────────────

test("cantidad con coma + unitario '20.000': total 250000, fuente unitario", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "12,5", valor: "20.000", valor_fuente: "unitario" }]);
  assert.deepEqual(cambiosDe(p), {
    cantidad: 12.5,
    valor_unitario: 20000,
    valor_total: 250000,
    valor_fuente: "unitario",
  });
  assert.deepEqual(p.rechazos, []);
  assert.deepEqual(p.pendientes, []);
});

test("total '100.000' con cantidad 3: unitario derivado a 4 decimales, total intacto", () => {
  const p = plan([fila({ cantidad: 3 })], [{ id: 1, valor: "100.000", valor_fuente: "total" }]);
  assert.deepEqual(cambiosDe(p), {
    valor_unitario: 33333.3333,
    valor_total: 100000,
    valor_fuente: "total",
  });
});

test("total con cantidad 0: no se deriva unitario (sin dividir por 0)", () => {
  const p = plan([fila()], [{ id: 1, valor: "100.000", valor_fuente: "total" }]);
  const c = cambiosDe(p);
  assert.equal(c.valor_total, 100000);
  assert.equal(c.valor_fuente, "total");
  assert.equal("valor_unitario" in c, false); // sigue null
});

test("cantidad UND se guarda truncada a 2 decimales (2,667 → 2,66)", () => {
  const p = plan([fila({ unidad: "UND" })], [{ id: 1, cantidad: "2,667" }]);
  assert.equal(cambiosDe(p).cantidad, 2.66);
});

test("cambiar solo la cantidad recalcula el lado derivado desde la fuente guardada", () => {
  // fuente unitario: el total sigue al unitario.
  const conUnitario = fila({ cantidad: 10, valor_unitario: 20000, valor_total: 200000, valor_fuente: "unitario" });
  const p1 = plan([conUnitario], [{ id: 1, cantidad: "12" }]);
  assert.deepEqual(cambiosDe(p1), { cantidad: 12, valor_total: 240000 });

  // fuente total: el unitario sigue al total, que NO cambia.
  const conTotal = fila({ cantidad: 10, valor_unitario: 10000, valor_total: 100000, valor_fuente: "total" });
  const p2 = plan([conTotal], [{ id: 1, cantidad: "8" }]);
  assert.deepEqual(cambiosDe(p2), { cantidad: 8, valor_unitario: 12500 });
});

test("cantidad vacía es 0; valor vacío borra el valor", () => {
  const llena = fila({ cantidad: 10, valor_unitario: 20000, valor_total: 200000, valor_fuente: "unitario" });
  const p = plan([llena], [{ id: 1, cantidad: "", valor: "" }]);
  assert.deepEqual(cambiosDe(p), {
    cantidad: 0,
    valor_unitario: null,
    valor_total: null,
    valor_fuente: null,
  });
  assert.deepEqual(p.rechazos, []);
});

test("un valor sin fuente (ni en el pedido ni guardada) se rechaza", () => {
  const p = plan([fila({ cantidad: 5 })], [{ id: 1, valor: "20.000" }]);
  assert.equal(p.actualizaciones.length, 0);
  assert.equal(p.rechazos[0].tipo, "valor_invalido");
  assert.match(p.rechazos[0].mensaje, /unitario o total/);
});

test("un valor sin fuente en el pedido usa la guardada", () => {
  const p = plan(
    [fila({ cantidad: 5, valor_unitario: 1000, valor_total: 5000, valor_fuente: "unitario" })],
    [{ id: 1, valor: "20.000" }],
  );
  assert.deepEqual(cambiosDe(p), { valor_unitario: 20000, valor_total: 100000 });
});

// ─── [J4] Plata que no se entiende, renglones sin cambios ──────────────────

test("[J4] plata ambigua ('20.00'): ese valor se rechaza, el resto del guardado se aplica", () => {
  const items = [fila({ id: 1 }), fila({ id: 2, codigo_item: "5678" })];
  const p = plan(items, [
    { id: 1, cantidad: "10", valor: "20.00", valor_fuente: "unitario" },
    { id: 2, cantidad: "4", valor: "20.000", valor_fuente: "unitario" },
  ]);

  // El renglón 1 guarda su cantidad pero NO el valor que no se entiende.
  assert.deepEqual(cambiosDe(p, 1), { cantidad: 10 });
  assert.deepEqual(cambiosDe(p, 2), {
    cantidad: 4,
    valor_unitario: 20000,
    valor_total: 80000,
    valor_fuente: "unitario",
  });
  assert.deepEqual(p.rechazos, [
    { item_id: 1, tipo: "valor_invalido", mensaje: "Usá punto para miles y coma para decimales" },
  ]);
  assert.deepEqual(p.pendientes, [
    { item_id: 1, mensajes: ["Usá punto para miles y coma para decimales"], tipos: ["valor_invalido"] },
  ]);
});

test("[J4] un valor rechazado no pisa el que ya estaba guardado", () => {
  const guardado = fila({ cantidad: 10, valor_unitario: 20000, valor_total: 200000, valor_fuente: "unitario" });
  const p = plan([guardado], [{ id: 1, valor: "1,500.00", valor_fuente: "unitario" }]);
  assert.equal(p.actualizaciones.length, 0);
  assert.equal(p.items[0].valor_unitario, 20000);
  assert.equal(p.rechazos.length, 1);
});

test("[J4][J11] un renglón idéntico a lo guardado no genera escritura", () => {
  const guardado = fila({
    cantidad: 12.5,
    valor_unitario: 20000,
    valor_total: 250000,
    valor_fuente: "unitario",
    cantidad_devuelta: 1,
    motivo_devolucion: "Mal estado",
  });
  const p = plan([guardado], [
    {
      id: 1,
      cantidad: "12,5",
      valor: "20.000",
      valor_fuente: "unitario",
      cantidad_devuelta: "1",
      motivo_devolucion: " Mal estado ",
    },
  ]);
  assert.deepEqual(p.actualizaciones, []);
});

test("un id que no es de esta recepción se ignora sin romper el resto", () => {
  const p = plan([fila()], [
    { id: 999, cantidad: "5" },
    { id: 1, cantidad: "5" },
  ]);
  assert.deepEqual(p.ignorados, [999]);
  assert.deepEqual(cambiosDe(p), { cantidad: 5 });
});

test("dos entradas del mismo renglón: la segunda parte de lo que dejó la primera", () => {
  const p = plan([fila()], [
    { id: 1, cantidad: "10", valor: "20.000", valor_fuente: "unitario" },
    { id: 1, cantidad: "12" },
  ]);
  assert.deepEqual(cambiosDe(p), {
    cantidad: 12,
    valor_unitario: 20000,
    valor_total: 240000,
    valor_fuente: "unitario",
  });
});

// ─── [J14] Desborde ────────────────────────────────────────────────────────

test("[J14] unitario válido × cantidad grande: error del renglón, no se aplica ni cantidad ni valor", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "999999999", valor: "999.999.999", valor_fuente: "unitario" }]);
  assert.equal(p.actualizaciones.length, 0);
  assert.deepEqual(p.rechazos, [
    { item_id: 1, tipo: "valor_invalido", mensaje: "El valor es demasiado grande" },
  ]);
});

test("[J14] subir la cantidad de un renglón con unitario grande tampoco desborda la base", () => {
  const guardado = fila({
    cantidad: 1,
    valor_unitario: 999999999999 - 1,
    valor_total: 999999999998,
    valor_fuente: "unitario",
  });
  const p = plan([guardado], [{ id: 1, cantidad: "999999999" }]);
  assert.equal(p.actualizaciones.length, 0);
  assert.equal(p.items[0].cantidad, 1);
  assert.equal(p.rechazos[0].mensaje, "El valor es demasiado grande");
});

test("cantidad que no cabe en NUMERIC(12,3) o que no se entiende se rechaza", () => {
  const p1 = plan([fila()], [{ id: 1, cantidad: "1000000000" }]);
  assert.equal(p1.rechazos[0].tipo, "cantidad_invalida");
  const p2 = plan([fila()], [{ id: 1, cantidad: "abc" }]);
  assert.equal(p2.rechazos[0].tipo, "cantidad_invalida");
  assert.equal(p2.actualizaciones.length, 0);
});

// ─── Devolución ────────────────────────────────────────────────────────────

test("devolución: cantidad y motivo pasan; se tolera mayor a lo recibido (finalizar lo exige)", () => {
  const p = plan([fila({ cantidad: 100 })], [
    { id: 1, cantidad_devuelta: "10", motivo_devolucion: "  Mal estado " },
  ]);
  assert.deepEqual(cambiosDe(p), { cantidad_devuelta: 10, motivo_devolucion: "Mal estado" });

  const p2 = plan([fila({ cantidad: 100 })], [{ id: 1, cantidad_devuelta: "101" }]);
  assert.equal(cambiosDe(p2).cantidad_devuelta, 101);
  assert.deepEqual(p2.rechazos, []);
});

test("[J13] cantidad_devuelta pasa por el ajuste de la unidad (UND 1,999 → 1,99)", () => {
  const p = plan([fila({ unidad: "UND", cantidad: 10 })], [{ id: 1, cantidad_devuelta: "1,999" }]);
  assert.equal(cambiosDe(p).cantidad_devuelta, 1.99);
});

test("devolución inválida se rechaza sin tumbar lo demás; motivo vacío queda null", () => {
  const conMotivo = fila({ cantidad: 10, cantidad_devuelta: 2, motivo_devolucion: "Golpeado" });
  const p = plan([conMotivo], [
    { id: 1, cantidad: "20", cantidad_devuelta: "x", motivo_devolucion: "   " },
  ]);
  assert.deepEqual(cambiosDe(p), { cantidad: 20, motivo_devolucion: null });
  assert.equal(p.rechazos[0].tipo, "devolucion_invalida");
});

// ─── 800 KL ────────────────────────────────────────────────────────────────

test("más de 800 KL sin confirmar: se guarda y queda pendiente (no se pierde lo digitado)", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "900" }]);
  assert.deepEqual(cambiosDe(p), { cantidad: 900 });
  assert.equal(p.pendientes.length, 1);
  assert.deepEqual(p.pendientes[0].tipos, ["exceso"]);
});

test("800 justos y UND 5000 no piden confirmación", () => {
  const p = plan([fila({ id: 1 }), fila({ id: 2, unidad: "UND" })], [
    { id: 1, cantidad: "800" },
    { id: 2, cantidad: "5000" },
  ]);
  assert.deepEqual(p.pendientes, []);
});

test("confirmar_exceso con la misma cantidad: guarda quién y cuándo", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "850", confirmar_exceso: "850" }]);
  assert.deepEqual(cambiosDe(p), {
    cantidad: 850,
    exceso_confirmado_cantidad: 850,
    exceso_confirmado_por: POR,
    exceso_confirmado_at: AHORA,
  });
  assert.deepEqual(p.pendientes, []);
});

test("confirmar_exceso acepta coma decimal y número", () => {
  const a = plan([fila()], [{ id: 1, cantidad: "850,5", confirmar_exceso: "850,5" }]);
  assert.equal(cambiosDe(a).exceso_confirmado_cantidad, 850.5);
  const b = plan([fila()], [{ id: 1, cantidad: 850, confirmar_exceso: 850 }]);
  assert.equal(cambiosDe(b).exceso_confirmado_cantidad, 850);
});

test("confirmar 850 y dejar 851: la confirmación NO se guarda y sigue pendiente", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "851", confirmar_exceso: "850" }]);
  assert.deepEqual(cambiosDe(p), { cantidad: 851 });
  assert.equal(p.rechazos[0].tipo, "confirmacion_ignorada");
  assert.deepEqual(p.pendientes[0].tipos.sort(), ["confirmacion_ignorada", "exceso"]);
});

test("confirmada 850 y editada después a 8500: vuelve a pedirla", () => {
  const confirmada = fila({
    cantidad: 850,
    exceso_confirmado_cantidad: 850,
    exceso_confirmado_por: POR,
    exceso_confirmado_at: AHORA,
  });
  assert.deepEqual(calcularPendientes([confirmada]), []);
  const p = plan([confirmada], [{ id: 1, cantidad: "8500" }]);
  assert.deepEqual(p.pendientes.map((x) => x.tipos), [["exceso"]]);
});

test("bajar a 800 o menos: ya no hace falta confirmar", () => {
  const confirmada = fila({ cantidad: 850, exceso_confirmado_cantidad: 850 });
  const p = plan([confirmada], [{ id: 1, cantidad: "800" }]);
  assert.deepEqual(p.pendientes, []);
});

test("re-confirmar con el mismo valor no reescribe quién ni cuándo", () => {
  const confirmada = fila({
    cantidad: 850,
    exceso_confirmado_cantidad: 850,
    exceso_confirmado_por: "otro@merkahorro.com",
    exceso_confirmado_at: "2026-09-29T10:00:00.000Z",
  });
  const p = plan([confirmada], [{ id: 1, confirmar_exceso: "850" }]);
  assert.deepEqual(p.actualizaciones, []);
});

test("confirmar_exceso en un renglón que no excede no hace nada ni molesta", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "10", confirmar_exceso: "10" }]);
  assert.deepEqual(cambiosDe(p), { cantidad: 10 });
  assert.deepEqual(p.rechazos, []);
});

// ─── Valor implausible ─────────────────────────────────────────────────────

test("unitario implausible ('20' por '20.000'): se guarda y queda pendiente de confirmar", () => {
  const p = plan([fila()], [{ id: 1, cantidad: "10", valor: "20", valor_fuente: "unitario" }]);
  assert.equal(cambiosDe(p).valor_total, 200);
  assert.deepEqual(p.pendientes.map((x) => x.tipos), [["valor"]]);
});

test("confirmar_valor guarda el unitario confirmado, quién y cuándo", () => {
  const p = plan([fila()], [
    { id: 1, cantidad: "10", valor: "20", valor_fuente: "unitario", confirmar_valor: "20" },
  ]);
  const c = cambiosDe(p);
  assert.equal(c.valor_confirmado_unitario, 20);
  assert.equal(c.valor_confirmado_por, POR);
  assert.equal(c.valor_confirmado_at, AHORA);
  assert.deepEqual(p.pendientes, []);
});

test("confirmado $20 y luego otro valor implausible: hay que confirmar de nuevo", () => {
  const confirmado = fila({
    cantidad: 10,
    valor_unitario: 20,
    valor_total: 200,
    valor_fuente: "unitario",
    valor_confirmado_unitario: 20,
  });
  assert.deepEqual(calcularPendientes([confirmado]), []);
  const p = plan([confirmado], [{ id: 1, valor: "30", valor_fuente: "unitario" }]);
  assert.deepEqual(p.pendientes.map((x) => x.tipos), [["valor"]]);
});

test("confirmar_valor con valor plausible no guarda nada", () => {
  const p = plan([fila()], [
    { id: 1, cantidad: "10", valor: "20.000", valor_fuente: "unitario", confirmar_valor: "20.000" },
  ]);
  assert.equal("valor_confirmado_unitario" in cambiosDe(p), false);
  assert.deepEqual(p.rechazos, []);
});

test("confirmar_valor lleva el unitario como texto de plata con hasta 4 decimales", () => {
  // total 100 / 3 = 33.3333 por unidad: implausible, y se confirma con "33,3333".
  const p = plan([fila({ cantidad: 3 })], [
    { id: 1, valor: "100", valor_fuente: "total", confirmar_valor: "33,3333" },
  ]);
  assert.equal(cambiosDe(p).valor_unitario, 33.3333);
  assert.equal(cambiosDe(p).valor_confirmado_unitario, 33.3333);
  assert.deepEqual(p.pendientes, []);
});

test("confirmar_valor que NO coincide con el unitario resultante se ignora y se reporta", () => {
  // Confirmó $20 pero el renglón quedó en $30.
  const p = plan([fila()], [
    { id: 1, cantidad: "10", valor: "30", valor_fuente: "unitario", confirmar_valor: "20" },
  ]);
  assert.equal("valor_confirmado_unitario" in cambiosDe(p), false);
  assert.deepEqual(p.rechazos, [
    { item_id: 1, tipo: "confirmacion_ignorada", mensaje: "La confirmación no coincide con el valor unitario actual" },
  ]);
  assert.deepEqual(p.pendientes.map((x) => x.tipos.sort()), [["confirmacion_ignorada", "valor"]]);
});

test("confirmar_valor ilegible, booleano o numérico se ignora como confirmación (no confirma nada)", () => {
  for (const malo of ["abc", "20.00", true, 20]) {
    const p = plan([fila()], [
      { id: 1, cantidad: "10", valor: "20", valor_fuente: "unitario", confirmar_valor: malo },
    ]);
    assert.equal("valor_confirmado_unitario" in cambiosDe(p), false, String(malo));
    assert.equal(p.rechazos[0].tipo, "confirmacion_ignorada", String(malo));
  }
});

test("confirmar_valor vacío es como no mandarlo", () => {
  const p = plan([fila()], [
    { id: 1, cantidad: "10", valor: "20", valor_fuente: "unitario", confirmar_valor: "" },
  ]);
  assert.deepEqual(p.rechazos, []);
  assert.equal("valor_confirmado_unitario" in cambiosDe(p), false);
});

test("re-confirmar el mismo unitario no reescribe quién ni cuándo", () => {
  const confirmado = fila({
    cantidad: 10, valor_unitario: 20, valor_total: 200, valor_fuente: "unitario",
    valor_confirmado_unitario: 20, valor_confirmado_por: "otro@merkahorro.com",
    valor_confirmado_at: "2026-09-29T10:00:00.000Z",
  });
  const p = plan([confirmado], [{ id: 1, confirmar_valor: "20" }]);
  assert.deepEqual(p.actualizaciones, []);
});

test("con fuente total, editar la cantidad cambia el unitario y descarta la confirmación", () => {
  const confirmado = fila({
    cantidad: 10,
    valor_unitario: 500,
    valor_total: 5000,
    valor_fuente: "total",
    valor_confirmado_unitario: 500,
  });
  const p = plan([confirmado], [{ id: 1, cantidad: "20" }]); // unitario pasa a 250
  assert.deepEqual(p.pendientes.map((x) => x.tipos), [["valor"]]);
});

// ─── Pendientes de TODA la recepción ───────────────────────────────────────

test("pendientes incluye renglones que esta petición no tocó", () => {
  const sinConfirmar = fila({ id: 1, cantidad: 900 });
  const otro = fila({ id: 2, codigo_item: "5678" });
  const p = plan([sinConfirmar, otro], [{ id: 2, cantidad: "5" }]);
  assert.deepEqual(p.pendientes.map((x) => [x.item_id, x.tipos]), [[1, ["exceso"]]]);
});

test("pendientes sale en el orden de los renglones", () => {
  const items = [fila({ id: 3, cantidad: 900 }), fila({ id: 1, cantidad: 900 }), fila({ id: 2, cantidad: 900 })];
  assert.deepEqual(calcularPendientes(items).map((x) => x.item_id), [3, 1, 2]);
});

test("planearGuardado no muta los renglones que recibe", () => {
  const items = [fila()];
  const copia = JSON.parse(JSON.stringify(items));
  plan(items, [{ id: 1, cantidad: "12", valor: "20.000", valor_fuente: "unitario" }]);
  assert.deepEqual(items, copia);
});

test("sin entradas: nada que escribir", () => {
  const p = plan([fila({ cantidad: 5 })], []);
  assert.deepEqual(p.actualizaciones, []);
  assert.deepEqual(p.ignorados, []);
  assert.deepEqual(p.pendientes, []);
});

// ─── Campos demasiado largos: rechazo por renglón, no 400 ──────────────────

test("valor de más de 25 caracteres: ese valor se rechaza, lo demás se guarda", () => {
  const largo = "1".repeat(LARGO_MAX_VALOR + 1);
  const p = plan([fila({ id: 1 }), fila({ id: 2 })], [
    { id: 1, cantidad: "10", valor: largo, valor_fuente: "unitario" },
    { id: 2, cantidad: "4" },
  ]);
  assert.deepEqual(cambiosDe(p, 1), { cantidad: 10 });
  assert.deepEqual(cambiosDe(p, 2), { cantidad: 4 });
  assert.deepEqual(p.rechazos, [{ item_id: 1, tipo: "valor_invalido", mensaje: "El valor es demasiado largo" }]);
});

test("cantidad y cantidad_devuelta de más de 20 caracteres se rechazan por renglón", () => {
  const largo = "1".repeat(LARGO_MAX_CANTIDAD + 1);
  const p = plan([fila()], [{ id: 1, cantidad: largo, cantidad_devuelta: largo }]);
  assert.equal(p.actualizaciones.length, 0);
  assert.deepEqual(p.rechazos.map((r) => r.tipo), ["cantidad_invalida", "devolucion_invalida"]);
});

test("motivo de más de 500 caracteres: devolucion_invalida y no se guarda; la devuelta sí", () => {
  const p = plan([fila({ cantidad: 10 })], [
    { id: 1, cantidad_devuelta: "2", motivo_devolucion: "x".repeat(LARGO_MAX_MOTIVO + 1) },
  ]);
  assert.deepEqual(cambiosDe(p), { cantidad_devuelta: 2 });
  assert.equal(p.rechazos[0].tipo, "devolucion_invalida");
  // En el tope exacto entra.
  const ok = plan([fila({ cantidad: 10 })], [{ id: 1, motivo_devolucion: "x".repeat(LARGO_MAX_MOTIVO) }]);
  assert.equal(cambiosDe(ok).motivo_devolucion.length, LARGO_MAX_MOTIVO);
});

test("normalizarObservaciones recorta al tope, no rechaza", () => {
  assert.equal(normalizarObservaciones("  hola  "), "hola");
  assert.equal(normalizarObservaciones("   "), null);
  assert.equal(normalizarObservaciones(null), null);
  assert.equal(normalizarObservaciones(undefined), null);
  assert.equal(normalizarObservaciones("a".repeat(LARGO_MAX_OBSERVACIONES + 500)).length, LARGO_MAX_OBSERVACIONES);
});

// ─── Concurrencia por renglón ──────────────────────────────────────────────

test("cada actualización lleva el updated_at CRUDO leído (condición del UPDATE)", () => {
  const raw = "2026-09-30T15:00:00.123456+00:00";
  const p = plan([fila({ updated_at: raw })], [{ id: 1, cantidad: "5" }]);
  assert.equal(p.actualizaciones[0].updated_at, raw);
});

test("[conflicto] el reintento replanea SOLO los renglones en conflicto sobre lo que hay ahora", () => {
  const entradas = [
    { id: 1, cantidad: "12", valor: "20.000", valor_fuente: "unitario" },
    { id: 2, cantidad: "3" },
  ];
  const frescos = [
    fila({ id: 1, cantidad: 7, valor_unitario: 1000, valor_total: 7000, valor_fuente: "unitario" }),
    fila({ id: 2 }),
  ];
  const r = planearReintento({ conflictos: [1], frescos, entradas, por: POR, ahora: AHORA });
  assert.equal(r.actualizaciones.length, 1); // solo el renglón 1
  assert.deepEqual(r.actualizaciones[0].cambios, {
    cantidad: 12,
    valor_unitario: 20000,
    valor_total: 240000,
  });
});

test("[conflicto] el reintento recalcula el valor sobre la cantidad nueva de la otra petición", () => {
  // Solo mandó valor; la otra petición subió la cantidad a 50 mientras tanto.
  const r = planearReintento({
    conflictos: [1],
    frescos: [fila({ id: 1, cantidad: 50 })],
    entradas: [{ id: 1, valor: "20.000", valor_fuente: "unitario" }],
    por: POR,
    ahora: AHORA,
  });
  assert.equal(r.actualizaciones[0].cambios.valor_total, 1000000); // 50 x 20.000, no la cantidad vieja
});

test("[conflicto] si el renglón desapareció no se escribe nada ni se inventa un rechazo", () => {
  const r = planearReintento({ conflictos: [1], frescos: [], entradas: [{ id: 1, cantidad: "5" }], por: POR });
  assert.deepEqual(r.actualizaciones, []);
  assert.deepEqual(r.ignorados, [1]);
});

test("resolverRechazos: reemplaza los del primer plan en conflicto y agrega 'conflicto' a los que siguen chocando", () => {
  const primer = [
    { item_id: 1, tipo: "valor_invalido", mensaje: "viejo" },
    { item_id: 3, tipo: "cantidad_invalida", mensaje: "otro renglón" },
  ];
  const reintento = { rechazos: [{ item_id: 1, tipo: "confirmacion_ignorada", mensaje: "nuevo" }] };
  const r = resolverRechazos({ rechazos: primer, conflictos: [1, 2], reintento, conflictosFinales: [2] });
  assert.deepEqual(r, [
    { item_id: 3, tipo: "cantidad_invalida", mensaje: "otro renglón" },
    { item_id: 1, tipo: "confirmacion_ignorada", mensaje: "nuevo" },
    { item_id: 2, tipo: "conflicto", mensaje: MENSAJE_CONFLICTO },
  ]);
});

test("un conflicto que persiste sale en pendientes con tipo 'conflicto'", () => {
  const rechazos = resolverRechazos({ rechazos: [], conflictos: [1], reintento: { rechazos: [] }, conflictosFinales: [1] });
  assert.deepEqual(calcularPendientes([fila()], rechazos), [
    { item_id: 1, mensajes: [MENSAJE_CONFLICTO], tipos: ["conflicto"] },
  ]);
});
