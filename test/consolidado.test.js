import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { consolidarLiquidacion, puedeCerrarCosteo,
  cuadrarPagos,
} from "../src/shared/consolidado.js";

/**
 * Los ítems salen del Excel de res ("01 Septiembre 2026.xlsx"), generados con un
 * script desde las hojas de sede — no transcritos a mano. Ver el `_origen` del
 * fixture.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/res-sedes.json", import.meta.url), "utf-8"),
);

/** Arma una recepción con la forma que espera el consolidado. */
function recepcion(nombre, { estado = "Aprobado", viceras = [], extra = [] } = {}) {
  const f = FIXTURE.sedes[nombre];
  return {
    id: nombre,
    sede_id: nombre,
    sede: { nombre },
    estado,
    items: [
      ...f.items.map((i, n) => ({ ...i, id: `${nombre}-${n}` })),
      ...viceras.map((v, n) => ({ ...v, id: `${nombre}-v${n}`, tipo: "vicera" })),
      ...extra,
    ],
  };
}

const TRES_SEDES = () => [
  recepcion("Villahermosa"),
  recepcion("Parque"),
  recepcion("Lopez"),
];

// `Datos `!O5:P15 — un total de gastos plausible para probar el reparto.
const GASTOS = [
  { concepto: "Ganado Jaime", valor: 18_000_000, signo: 1 },
  { concepto: "Fletes", valor: 900_000, signo: 1 },
  { concepto: "Sacrificio", valor: 1_100_000, signo: 1 },
];
const TOTAL_GASTOS = 20_000_000;

test("los kilos por sede coinciden con los del Excel", () => {
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: GASTOS });

  // `Datos `!F41, G41, M41
  assert.equal(c.sedes[0].kilos, 388.22);
  assert.equal(c.sedes[1].kilos, 260.79);
  assert.equal(c.sedes[2].kilos, 133.5);
  // `Datos `!P17
  assert.equal(c.totalKilos, 782.51);
});

test("los % de participación coinciden con la fila 42 del Excel", () => {
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: GASTOS });

  assert.ok(Math.abs(c.sedes[0].participacion - 0.496121455316865) < 1e-12);
  assert.ok(Math.abs(c.sedes[1].participacion - 0.3332736961827964) < 1e-12);
  assert.ok(Math.abs(c.sedes[2].participacion - 0.17060484850033866) < 1e-12);
});

test("el costo teórico por sede coincide con el F48 de cada hoja", () => {
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: GASTOS });

  for (const [i, nombre] of ["Villahermosa", "Parque", "Lopez"].entries()) {
    const esperado = FIXTURE.sedes[nombre].costo_teorico_excel;
    assert.ok(
      Math.abs(c.sedes[i].costeo.costoTeorico - esperado) < 0.01,
      `${nombre}: ${c.sedes[i].costeo.costoTeorico} vs ${esperado}`,
    );
  }
});

test("CADA SEDE tiene su propio factor — no hay uno global", () => {
  // Este es el corazón del módulo. El costo real de una sede es proporcional a
  // sus KILOS, pero el teórico depende de su MEZCLA DE CORTES, y la mezcla
  // cambia por sede. Un factor global le cobraría a una el desvío de la otra.
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: GASTOS });

  const factores = c.sedes.map((s) => s.costeo.factor);
  assert.notEqual(factores[0], factores[1]);
  assert.notEqual(factores[1], factores[2]);
});

test("el reparto no crea ni pierde plata", () => {
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: GASTOS });

  const suma = c.sedes.reduce((a, s) => a + s.valorFactura, 0);
  assert.ok(Math.abs(suma - TOTAL_GASTOS) < 0.01, `repartido: ${suma}`);

  // Y lo costeado tiene que cerrar contra lo repartido, salvo el redondeo.
  assert.ok(Math.abs(c.totalCosteado - TOTAL_GASTOS) < 5, `costeado: ${c.totalCosteado}`);
});

test("una retoma con signo -1 baja el total repartido", () => {
  const c = consolidarLiquidacion({
    recepciones: TRES_SEDES(),
    gastos: [...GASTOS, { concepto: "Retomas Desposte", valor: 2_000_000, signo: -1 }],
  });

  assert.equal(c.totalGastos, TOTAL_GASTOS - 2_000_000);
  assert.ok(Math.abs(c.costoPromedioKilo - 18_000_000 / 782.51) < 0.01);
});

test("las vísceras restan solo en la sede que las recibió y con el toggle en SI", () => {
  const viceras = [
    { descripcion: "Viceras", cantidad: 25.4, costo_base: 17000 },
    { descripcion: "Mondongo", cantidad: 16.8, costo_base: 18000 },
  ];
  const conViceras = () => [
    recepcion("Villahermosa", { viceras }),
    recepcion("Parque"),
    recepcion("Lopez"),
  ];

  const apagado = consolidarLiquidacion({ recepciones: conViceras(), gastos: GASTOS });
  const encendido = consolidarLiquidacion({
    recepciones: conViceras(),
    gastos: GASTOS,
    bonificacionViceras: true,
  });

  assert.equal(apagado.sedes[0].costeo.valorViceras, 0);
  assert.equal(encendido.sedes[0].costeo.valorViceras, 25.4 * 17000 + 16.8 * 18000);

  // Villahermosa cambia; las otras dos no se enteran.
  assert.notEqual(encendido.sedes[0].costeo.factor, apagado.sedes[0].costeo.factor);
  assert.equal(encendido.sedes[1].costeo.factor, apagado.sedes[1].costeo.factor);

  // Las vísceras NO suman kilos: `Datos `!F41 suma de la fila 3 a la 40, y las
  // vísceras viven de la 44 para abajo.
  assert.equal(encendido.totalKilos, apagado.totalKilos);
  assert.equal(encendido.totalKilos, 782.51);
});

test("los adicionales SÍ suman kilos: son producto que llegó", () => {
  const conExtra = [
    recepcion("Villahermosa", {
      extra: [
        {
          id: "extra-1",
          tipo: "adicional",
          descripcion: "LOMO FINO SIN CÓDIGO",
          cantidad: 10,
          costo_base: 0,
          codigo_item: null,
        },
      ],
    }),
    recepcion("Parque"),
  ];

  const c = consolidarLiquidacion({ recepciones: conExtra, gastos: GASTOS });
  assert.equal(c.sedes[0].kilos, 398.22);
});

test("un adicional sin código de SIESA se avisa y BLOQUEA el cierre", () => {
  const c = consolidarLiquidacion({
    recepciones: [
      recepcion("Villahermosa", {
        extra: [
          {
            id: "extra-1",
            tipo: "adicional",
            descripcion: "LOMO FINO",
            cantidad: 10,
            costo_base: 0,
            codigo_item: null,
          },
        ],
      }),
    ],
    gastos: GASTOS,
  });

  const aviso = c.advertencias.find((a) => a.codigo === "adicionales_sin_codigo");
  assert.ok(aviso);
  assert.equal(aviso.detalle[0].descripcion, "LOMO FINO");

  const { ok, bloqueos } = puedeCerrarCosteo(c);
  assert.equal(ok, false);
  assert.ok(bloqueos.some((b) => b.codigo === "adicionales_sin_codigo"));
});

test("un adicional CON código pero costo 0 avisa pero NO bloquea", () => {
  const c = consolidarLiquidacion({
    recepciones: [
      recepcion("Villahermosa", {
        extra: [
          {
            id: "extra-1",
            tipo: "adicional",
            descripcion: "LOMO FINO",
            cantidad: 10,
            costo_base: 0,
            codigo_item: "15194",
          },
        ],
      }),
    ],
    gastos: GASTOS,
  });

  assert.ok(c.advertencias.some((a) => a.codigo === "adicionales_sin_costo"));
  assert.equal(puedeCerrarCosteo(c).ok, true);
});

test("sin gastos avisa Y bloquea: es el estado en que está el Excel hoy", () => {
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: [] });

  assert.ok(c.advertencias.some((a) => a.codigo === "sin_gastos"));
  // Y además cada sede reporta que su factor anula los costos.
  assert.ok(c.advertencias.some((a) => a.codigo === "factor_anula_costos"));
  assert.equal(c.sedes[0].costeo.items[0].costo_ajustado, 0);

  const { ok, bloqueos } = puedeCerrarCosteo(c);
  assert.equal(ok, false);
  assert.ok(bloqueos.length >= 2);
});

test("una recepción sin aprobar bloquea el cierre y dice cuál", () => {
  const c = consolidarLiquidacion({
    recepciones: [
      recepcion("Villahermosa", { estado: "Aprobado" }),
      recepcion("Parque", { estado: "Recibido" }),
    ],
    gastos: GASTOS,
  });

  const { ok, bloqueos } = puedeCerrarCosteo(c);
  assert.equal(ok, false);

  const bloqueo = bloqueos.find((b) => b.codigo === "recepcion_no_aprobada");
  assert.ok(bloqueo);
  assert.match(bloqueo.mensaje, /Parque/);
});

test("las advertencias de cada sede suben con el nombre adelante", () => {
  // Sin esto el admin tendría que abrir sede por sede para descubrir cuál falló.
  const c = consolidarLiquidacion({ recepciones: TRES_SEDES(), gastos: [] });
  const deSede = c.advertencias.filter((a) => a.codigo === "factor_anula_costos");

  assert.equal(deSede.length, 3);
  assert.match(deSede[0].mensaje, /^Villahermosa:/);
});

test("una liquidación vacía no explota", () => {
  const c = consolidarLiquidacion({});

  assert.equal(c.totalKilos, 0);
  assert.equal(c.totalGastos, 0);
  assert.equal(c.costoPromedioKilo, 0);
  assert.deepEqual(c.sedes, []);
  assert.ok(c.advertencias.some((a) => a.codigo === "sin_recepciones"));
  assert.equal(puedeCerrarCosteo(c).ok, false);
});

// ─── Cuadre de pagos ────────────────────────────────────────────────────────

test("cuadrarPagos: los pagos tienen que sumar lo mismo que los gastos", () => {
  // El caso del Excel: nueve sedes reparten $192.816.139, y seis beneficiarios
  // se reparten exactamente esa plata.
  const pagos = [
    { nombre: "Adriana Sanchez", valor: 43_722_400 },
    { nombre: "Santiago Sotomayor", valor: 56_563_600 },
    { nombre: "Brunt", valor: 61_979_438 },
    { nombre: "Julio Arboleda", valor: 4_900_000 },
    { nombre: "Figorinuss", valor: 12_213_200 },
    { nombre: "Colmeat", valor: 13_437_501 },
  ];
  const r = cuadrarPagos(192_816_139, pagos);

  assert.equal(r.totalPagos, 192_816_139);
  assert.equal(r.diferencia, 0);
  assert.equal(r.cuadra, true);
});

test("cuadrarPagos: un peso de más ya no cuadra", () => {
  const r = cuadrarPagos(1000, [{ valor: 1002 }]);
  assert.equal(r.diferencia, 2);
  assert.equal(r.cuadra, false);
});

test("cuadrarPagos: un peso de redondeo se tolera", () => {
  assert.equal(cuadrarPagos(1000, [{ valor: 1001 }]).cuadra, true);
  assert.equal(cuadrarPagos(1000, [{ valor: 999 }]).cuadra, true);
});

test("cuadrarPagos: sin pagos cargados no hay diferencia que reportar", () => {
  // Es el estado inicial de toda liquidación, no un error.
  const r = cuadrarPagos(500_000, []);
  assert.equal(r.cuadra, true);
  assert.equal(r.sinPagos, true);
});

test("el costeo se bloquea si los pagos no cuadran", () => {
  const r = consolidarLiquidacion({
    recepciones: [
      {
        id: 1,
        sede_id: 1,
        items: [{ tipo: "carne", codigo_item: "1", descripcion: "X", cantidad: 10, costo_base: 1000 }],
      },
    ],
    gastos: [{ concepto: "Valor de la carne", valor: 9000, signo: 1 }],
    pagos: [{ nombre: "Alguien", valor: 8000 }],
  });

  const aviso = r.advertencias.find((a) => a.codigo === "pagos_no_cuadran");
  assert.ok(aviso, JSON.stringify(r.advertencias));
  assert.match(aviso.mensaje, /faltan 1000/);
  assert.equal(r.cuadre.cuadra, false);

  const cierre = puedeCerrarCosteo(r);
  assert.equal(cierre.ok, false);
  assert.ok(cierre.bloqueos.some((b) => b.codigo === "pagos_no_cuadran"));
});
