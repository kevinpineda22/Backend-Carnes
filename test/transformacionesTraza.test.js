import test from "node:test";
import assert from "node:assert/strict";

import {
  JOBS,
  LIMITE_DOCUMENTOS_DETALLE,
  normalizarFiltrosEjecuciones,
  normalizarFiltrosNegativos,
  rangoDePagina,
  armarPaginacion,
  githubDeCorrida,
  conteosDeAlertas,
  agruparNegativosPorDestino,
  limitarDocumentos,
  esPaginaFueraDeRango,
  PAGINA_MAXIMA,
} from "../src/shared/transformacionesTraza.js";

const es400 = (e) => e.statusCode === 400;

test("ejecuciones: entorno PROD por defecto, QA solo si se pide", () => {
  assert.equal(normalizarFiltrosEjecuciones({ job: "tocino" }).entorno, "PROD");
  assert.equal(normalizarFiltrosEjecuciones({ job: "tocino", entorno: "qa" }).entorno, "QA");
});

test("ejecuciones: job obligatorio y limitado a tocino|negativos", () => {
  assert.deepEqual(JOBS, ["tocino", "negativos"]);
  assert.equal(normalizarFiltrosEjecuciones({ job: "NEGATIVOS" }).job, "negativos");
  assert.throws(() => normalizarFiltrosEjecuciones({}), es400);
  assert.throws(() => normalizarFiltrosEjecuciones({ job: "otro" }), es400);
});

test("ejecuciones: no existe filtro de dry-run", () => {
  const f = normalizarFiltrosEjecuciones({ job: "tocino", dry_run: "true" });
  assert.equal("dry_run" in f, false);
});

test("paginación: defaults, topes y rango", () => {
  const f = normalizarFiltrosEjecuciones({ job: "tocino" });
  assert.equal(f.pagina, 1);
  assert.equal(f.por_pagina, 50);
  assert.deepEqual(rangoDePagina(f.pagina, f.por_pagina), { desde: 0, hasta: 49 });

  const g = normalizarFiltrosEjecuciones({ job: "tocino", pagina: "3", por_pagina: "20" });
  assert.deepEqual(rangoDePagina(g.pagina, g.por_pagina), { desde: 40, hasta: 59 });

  assert.equal(normalizarFiltrosEjecuciones({ job: "tocino", por_pagina: "9999" }).por_pagina, 200);
  assert.equal(normalizarFiltrosEjecuciones({ job: "tocino", por_pagina: "0" }).por_pagina, 1);
  assert.equal(normalizarFiltrosNegativos({ por_pagina: "9999" }).por_pagina, 500);
});

test("paginación: rechaza valores no numéricos o página < 1", () => {
  assert.throws(() => normalizarFiltrosEjecuciones({ job: "tocino", pagina: "x" }), es400);
  assert.throws(() => normalizarFiltrosEjecuciones({ job: "tocino", pagina: "0" }), es400);
  assert.throws(() => normalizarFiltrosEjecuciones({ job: "tocino", por_pagina: "abc" }), es400);
});

test("armarPaginacion devuelve total y no tope fijo", () => {
  assert.deepEqual(armarPaginacion(2, 50, 1234), { pagina: 2, por_pagina: 50, total: 1234 });
  assert.deepEqual(armarPaginacion(1, 50, null), { pagina: 1, por_pagina: 50, total: 0 });
});

test("ventana de fechas: formato y orden", () => {
  const f = normalizarFiltrosEjecuciones({
    job: "tocino",
    fecha_desde: "2026-01-01",
    fecha_hasta: "2026-01-31",
  });
  assert.equal(f.fecha_desde, "2026-01-01");
  assert.equal(f.fecha_hasta, "2026-01-31");
  assert.throws(() => normalizarFiltrosEjecuciones({ job: "tocino", fecha_desde: "01/01/2026" }), es400);
  assert.throws(
    () => normalizarFiltrosEjecuciones({ job: "tocino", fecha_desde: "2026-02-10", fecha_hasta: "2026-02-01" }),
    es400,
  );
});

test("negativos: filtros status/tipo_dto/co y rechazo de status inválido", () => {
  const f = normalizarFiltrosNegativos({ status: "ambiguo", tipo_dto: "csa", co: " 001 " });
  assert.equal(f.entorno, "PROD");
  assert.equal(f.status, "AMBIGUO");
  assert.equal(f.tipo_dto, "CSA");
  assert.equal(f.co, "001");
  assert.equal(f.por_pagina, 100);
  assert.throws(() => normalizarFiltrosNegativos({ status: "NOPE" }), es400);
});

test("githubDeCorrida: arma el bloque o devuelve url null", () => {
  assert.deepEqual(
    githubDeCorrida({
      github_run_id: 99,
      github_run_attempt: 2,
      github_job: "negativos",
      github_run_url: "https://github.com/o/r/actions/runs/99",
    }),
    { run_id: 99, attempt: 2, job: "negativos", url: "https://github.com/o/r/actions/runs/99" },
  );
  const vacio = githubDeCorrida({ github_run_id: null });
  assert.equal(vacio.url, null);
  assert.equal(vacio.run_id, null);
  assert.equal(githubDeCorrida(undefined).url, null);
  assert.equal(githubDeCorrida({ github_run_url: "javascript:alert(1)" }).url, null);
});

test("githubDeCorrida: solo expone enlaces https a github.com", () => {
  const url = (u) => githubDeCorrida({ github_run_url: u }).url;
  assert.equal(url("https://github.com/o/r/actions/runs/1"), "https://github.com/o/r/actions/runs/1");
  assert.equal(url("http://github.com/o/r/actions/runs/1"), null);
  assert.equal(url("https://evil.example.com/o/r"), null);
  assert.equal(url("https://github.com.evil.com/o/r"), null);
  assert.equal(url("javascript:alert(1)"), null);
  assert.equal(url("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(url("https://"), null);
  assert.equal(url("not a url"), null);
});

test("conteosDeAlertas: solo conteos, tolera null/legacy", () => {
  assert.deepEqual(conteosDeAlertas({ v: 1, conteos: { omitidos: 3 }, listas: { omitidos: {} } }), { omitidos: 3 });
  assert.equal(conteosDeAlertas(null), null);
  assert.equal(conteosDeAlertas({ v: 1 }), null);
});

const fila = (o) => ({ co: "001", bodega: "B1", item_destino: 10, item_origen: 0, status: "OK", intentos: 1, ...o });

test("negativos: agrupa por destino con CEI y CSAs", () => {
  const destinos = agruparNegativosPorDestino([
    fila({ id: 1, tipo_dto: "CEI", respuesta: { plan: { csas_planificadas: 2 } } }),
    fila({ id: 2, tipo_dto: "CSA", item_origen: 5 }),
    fila({ id: 3, tipo_dto: "CSA", item_origen: 6, status: "ERROR", intentos: 3 }),
    fila({ id: 4, co: "002", item_destino: 11, tipo_dto: "CEI", respuesta: { plan: { csas_planificadas: 0 } } }),
  ]);
  assert.equal(destinos.length, 2);
  const d1 = destinos.find((d) => d.co === "001");
  assert.equal(d1.cei.id, 1);
  assert.deepEqual(d1.csas.map((c) => c.id), [2, 3]);
  assert.equal(d1.estado, "ERROR");
  assert.equal(d1.plan_incompleto, false);
  assert.equal(destinos.find((d) => d.co === "002").estado, "OK");
});

test("negativos: PLAN_INCOMPLETO cuando faltan CSAs", () => {
  const [d] = agruparNegativosPorDestino([
    fila({ id: 1, tipo_dto: "CEI", respuesta: { plan: { csas_planificadas: 3 } } }),
    fila({ id: 2, tipo_dto: "CSA", item_origen: 5 }),
  ]);
  assert.equal(d.plan_incompleto, true);
  assert.equal(d.estado, "PLAN_INCOMPLETO");
});

test("negativos: sin plan en la respuesta no se marca incompleto", () => {
  const [d] = agruparNegativosPorDestino([fila({ id: 1, tipo_dto: "CEI", respuesta: null })]);
  assert.equal(d.plan_incompleto, false);
  assert.equal(d.estado, "OK");
});

test("negativos: prioridad de estado AMBIGUO > ERROR > otros", () => {
  const [d] = agruparNegativosPorDestino([
    fila({ id: 1, tipo_dto: "CEI", status: "OK" }),
    fila({ id: 2, tipo_dto: "CSA", item_origen: 5, status: "AMBIGUO" }),
    fila({ id: 3, tipo_dto: "CSA", item_origen: 6, status: "ERROR" }),
  ]);
  assert.equal(d.estado, "AMBIGUO");
});

test("limitarDocumentos: tope de 1000 con bandera truncado", () => {
  assert.equal(LIMITE_DOCUMENTOS_DETALLE, 1000);
  const chico = limitarDocumentos([1, 2, 3]);
  assert.deepEqual(chico, { items: [1, 2, 3], truncado: false });
  const grande = limitarDocumentos(Array.from({ length: 1001 }, (_, i) => i));
  assert.equal(grande.items.length, 1000);
  assert.equal(grande.truncado, true);
  assert.deepEqual(limitarDocumentos(undefined), { items: [], truncado: false });
});

test("estado: PLAN_INCOMPLETO no oculta AMBIGUO ni ERROR", () => {
  const cei = fila({ id: 1, tipo_dto: "CEI", respuesta: { plan: { csas_planificadas: 3 } } });
  const [a] = agruparNegativosPorDestino([
    cei,
    fila({ id: 2, tipo_dto: "CSA", item_origen: 5 }),
    fila({ id: 3, tipo_dto: "CSA", item_origen: 6, status: "AMBIGUO" }),
  ]);
  assert.equal(a.estado, "AMBIGUO");
  assert.equal(a.plan_incompleto, true);
  const [e] = agruparNegativosPorDestino([cei, fila({ id: 2, tipo_dto: "CSA", item_origen: 5, status: "ERROR" })]);
  assert.equal(e.estado, "ERROR");
  assert.equal(e.plan_incompleto, true);
});

test("truncado: el ultimo destino queda marcado y nunca es plan_incompleto", () => {
  const filas = [
    fila({ id: 1, tipo_dto: "CEI", respuesta: { plan: { csas_planificadas: 1 } } }),
    fila({ id: 2, tipo_dto: "CSA", item_origen: 5 }),
    fila({ id: 3, co: "002", tipo_dto: "CEI", respuesta: { plan: { csas_planificadas: 4 } } }),
    fila({ id: 4, co: "002", tipo_dto: "CSA", item_origen: 5 }),
  ];
  const [d1, d2] = agruparNegativosPorDestino(filas, { truncado: true });
  assert.equal(d1.truncado, false);
  assert.equal(d2.truncado, true);
  assert.equal(d2.plan_incompleto, false);
  assert.equal(d2.estado, "OK");
  const [, sinTrunc] = agruparNegativosPorDestino(filas);
  assert.equal(sinTrunc.truncado, false);
  assert.equal(sinTrunc.plan_incompleto, true);
});

test("pagina fuera de rango: reconoce PGRST103 y 416", () => {
  assert.equal(esPaginaFueraDeRango({ code: "PGRST103", message: "Requested range not satisfiable" }), true);
  assert.equal(esPaginaFueraDeRango({ status: 416 }), true);
  assert.equal(esPaginaFueraDeRango({ code: "42P01" }), false);
  assert.equal(esPaginaFueraDeRango(null), false);
});

test("paginación: acota pagina y rechaza no enteros", () => {
  assert.equal(PAGINA_MAXIMA, 1000000);
  assert.equal(normalizarFiltrosNegativos({ pagina: "1000000" }).pagina, 1000000);
  for (const pagina of ["1000001", "1e30", "1.5", "-2", "Infinity"])
    assert.throws(() => normalizarFiltrosNegativos({ pagina }), es400, pagina);
  assert.throws(() => normalizarFiltrosNegativos({ por_pagina: "2.5" }), es400);
  assert.throws(() => normalizarFiltrosEjecuciones({ job: "tocino", pagina: "9".repeat(20) }), es400);
});
