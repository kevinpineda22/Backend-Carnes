/**
 * Aviso de "sedes que faltan" en una liquidación.
 *
 * Una misma entrega puede recibirse en días distintos: una sede recibe el
 * martes y otra el jueves, y las dos van a la misma liquidación. Buscar solo
 * en la fecha exacta de la liquidación decía "no hay ninguna recepción" de una
 * sede que sí la tenía, de otro día. Por eso se busca en una ventana alrededor
 * de las recepciones ya vinculadas.
 *
 * Funciones puras: el modelo consulta la base y decide con ellas.
 */

import { ESTADOS } from "./estados.js";

/** Días de margen antes y después de lo ya vinculado. */
export const DIAS_MARGEN = 3;

const sumarDias = (fecha, dias) => {
  const d = new Date(`${String(fecha).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

const diasEntre = (a, b) =>
  Math.abs(
    (new Date(`${String(a).slice(0, 10)}T00:00:00Z`) -
      new Date(`${String(b).slice(0, 10)}T00:00:00Z`)) /
      86400000,
  );

/**
 * Rango de fechas donde buscar las recepciones de las sedes que faltan: desde
 * la más temprana hasta la más tardía entre la fecha de la liquidación y las
 * recepciones vinculadas, con `DIAS_MARGEN` de cada lado.
 *
 * @returns {{ desde: string, hasta: string }} fechas YYYY-MM-DD
 */
export function ventanaBusqueda(liquidacion) {
  const fechas = [
    liquidacion.fecha,
    ...(liquidacion.recepciones || []).map((r) => r.fecha_ingreso),
  ]
    .filter(Boolean)
    .map((f) => String(f).slice(0, 10))
    .sort();
  return {
    desde: sumarDias(fechas[0], -DIAS_MARGEN),
    hasta: sumarDias(fechas[fechas.length - 1], DIAS_MARGEN),
  };
}

/**
 * Qué decirle al admin de cada recepción candidata. Más arriba en la lista es
 * lo más accionable: una cerrada sin vincular se resuelve con un clic.
 */
const PRIORIDAD = [
  "aprobada_sin_vincular",
  "en_curso",
  "rechazada",
  "otro_estado",
  "en_otra_liquidacion",
];

export function pistaDe(recepcion, liquidacionId) {
  if (
    recepcion.liquidacion_id &&
    String(recepcion.liquidacion_id) !== String(liquidacionId)
  ) {
    return "en_otra_liquidacion";
  }
  if (recepcion.estado === ESTADOS.APROBADO) return "aprobada_sin_vincular";
  if (recepcion.estado === ESTADOS.BORRADOR) return "en_curso";
  if (recepcion.estado === ESTADOS.RECHAZADO) return "rechazada";
  return "otro_estado";
}

/**
 * Por cada sede que falta, la recepción más útil de mostrar: primero por pista
 * (ver `PRIORIDAD`), después la de fecha más cercana a la liquidación, y entre
 * iguales la más nueva.
 *
 * @param {object} liquidacion  con `id` y `fecha`
 * @param {{id: any, nombre: string}[]} faltantes  sedes sin recepción vinculada
 * @param {object[]} candidatas recepciones de esas sedes dentro de la ventana
 */
export function armarSedesFaltantes(liquidacion, faltantes, candidatas = []) {
  const porSede = new Map();
  for (const r of candidatas) {
    const pista = pistaDe(r, liquidacion.id);
    const actual = porSede.get(r.sede_id);
    const candidata = {
      r,
      pista,
      rango: PRIORIDAD.indexOf(pista),
      distancia: diasEntre(r.fecha_ingreso, liquidacion.fecha),
    };
    const mejor =
      !actual ||
      candidata.rango < actual.rango ||
      (candidata.rango === actual.rango &&
        (candidata.distancia < actual.distancia ||
          (candidata.distancia === actual.distancia &&
            Number(r.id) > Number(actual.r.id))));
    if (mejor) porSede.set(r.sede_id, candidata);
  }

  return faltantes.map((s) => {
    const elegida = porSede.get(s.id);
    const r = elegida?.r;
    return {
      sede_id: s.id,
      nombre: s.nombre,
      pista: elegida?.pista ?? "sin_recepcion",
      recepcion_id: r?.id ?? null,
      estado: r?.estado ?? null,
      liquidacion_id: r?.liquidacion_id ?? null,
      fecha_ingreso: r?.fecha_ingreso ?? null,
    };
  });
}
