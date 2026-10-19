/**
 * "Mi historial" del recibidor: las recepciones que hizo la cuenta con la que
 * tiene la sesión, en Talleres y en Proveedores.
 *
 * Módulo puro (sin Supabase) para poder probar las reglas sin red:
 *   · cómo se normaliza el correo con el que se compara,
 *   · la ventana de fechas por defecto,
 *   · qué estados se muestran (nunca el borrador),
 *   · la forma de cada fila del listado.
 *
 * Las filas NO llevan firma ni cédula: se arman con una lista explícita de
 * columnas (ver `COLUMNAS_*`) y aquí solo se copian los campos nombrados.
 */

import { ESTADOS as ESTADOS_TALLERES } from "./estados.js";
import { ESTADOS as ESTADOS_PROVEEDOR } from "./estadosProveedor.js";
import { resumenRecepcion } from "./proveedorValores.js";

/** Días hacia atrás que cubre el historial si no se pide otra ventana. */
export const VENTANA_DIAS_DEFECTO = 60;
export const LIMITE_HISTORIAL_DEFECTO = 30;
export const LIMITE_HISTORIAL_MAX = 100;
/** Tope de `offset`: el historial es de pantalla, no un volcado. */
export const OFFSET_HISTORIAL_MAX = 5000;

/**
 * Cuántas recepciones por consulta de renglones. PostgREST corta en silencio en
 * 1000 filas y una plantilla puede tener ~50 renglones: 10 recepciones no pasan.
 */
export const RECEPCIONES_POR_CONSULTA_ITEMS_HISTORIAL = 10;

/** Cabecera de Talleres para el listado. Sin firma ni cédula (sql/027). */
export const COLUMNAS_HISTORIAL_TALLERES = `
  id, especie, sede_id, fecha_ingreso, estado, recibido_por, recibidor_nombre,
  sede:carnes_sedes ( id, nombre )
`;

/** Renglones de Talleres para el listado: solo lo que entra en el resumen. */
export const COLUMNAS_ITEMS_HISTORIAL_TALLERES = "recepcion_id, tipo, cantidad, unidad";

/** Cabecera de Proveedores para el listado. Sin firma ni cédula. */
export const COLUMNAS_HISTORIAL_PROVEEDOR = `
  id, proveedor_razon_social, factura, fecha_recepcion, estado, recibido_por,
  recibidor_nombre, descuento_pct, sede:carnes_sedes ( id, nombre )
`;

/** Renglones de Proveedores para el listado (los de `resumenRecepcion`). */
export const COLUMNAS_ITEMS_HISTORIAL_PROVEEDOR = "recepcion_id, cantidad, valor_total, cantidad_devuelta";

const aNumero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Correo en minúsculas y sin espacios; "" si no es texto. */
export function normalizarCorreo(valor) {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

/** ¿Estos dos correos son la misma cuenta? Vacío nunca coincide con nada. */
export function mismoCorreo(a, b) {
  const x = normalizarCorreo(a);
  return x !== "" && x === normalizarCorreo(b);
}

/**
 * Escapa `%`, `_` y `\` para usar el correo en un `ilike` sin que `_` (muy común
 * en correos) actúe de comodín.
 */
export function escaparParaIlike(texto) {
  return String(texto).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `YYYY-MM-DD` menos `dias` días (aritmética en UTC: no depende de la zona del servidor). */
export function restarDias(fecha, dias) {
  const [a, m, d] = String(fecha).split("-").map(Number);
  const resultado = new Date(Date.UTC(a, m - 1, d - dias));
  return resultado.toISOString().slice(0, 10);
}

/**
 * La ventana de fechas del historial. `hoy` es el día de Bogotá (`hoyBogota()`).
 * Sin `hasta` es hoy; sin `desde` son `VENTANA_DIAS_DEFECTO` días antes de `hasta`.
 */
export function ventanaHistorial({ desde, hasta } = {}, hoy) {
  const fin = hasta || hoy;
  return { desde: desde || restarDias(fin, VENTANA_DIAS_DEFECTO), hasta: fin };
}

/** El borrador es trabajo en curso, no historial. */
export function esEstadoDeHistorial(estado) {
  return estado !== ESTADOS_TALLERES.BORRADOR && estado !== ESTADOS_PROVEEDOR.BORRADOR;
}

/**
 * Deja solo lo que corresponde al historial de `correo`: nada en borrador y nada
 * de otra cuenta. La consulta ya filtra, pero esto es la red de seguridad (un
 * `ilike` con comodines no debe colar la recepción de otra persona).
 */
export function filtrarHistorial(filas = [], correo) {
  return filas.filter((f) => esEstadoDeHistorial(f?.estado) && mismoCorreo(f?.recibido_por, correo));
}

/**
 * Kilos de una recepción de Talleres: suma de los renglones con cantidad > 0 en
 * kilos. Igual que el total que ve el recibidor al capturar, SOLO cortes y
 * agregados: las vísceras no entran (ni en kilos ni en renglones). Los renglones
 * en unidades (UND) cuentan como renglón pero no como kilo.
 * @returns {{ total_kilos: number, renglones: number }}
 */
export function resumenTalleres(items = []) {
  let total = 0;
  let renglones = 0;
  for (const item of items) {
    if (item?.tipo === "vicera") continue;
    const cantidad = aNumero(item?.cantidad);
    if (!(cantidad > 0)) continue;
    renglones += 1;
    if (!item.unidad || String(item.unidad).toUpperCase() === "KL") total += cantidad;
  }
  return { total_kilos: Math.round(total * 1000) / 1000, renglones };
}

export function armarFilaTalleres({ cabecera, items = [] }) {
  const { total_kilos, renglones } = resumenTalleres(items);
  return {
    id: cabecera.id,
    fecha_ingreso: cabecera.fecha_ingreso,
    especie: cabecera.especie,
    sede: cabecera.sede?.nombre ?? null,
    estado: cabecera.estado,
    recibidor_nombre: cabecera.recibidor_nombre ?? null,
    total_kilos,
    renglones,
  };
}

export function armarFilaProveedor({ cabecera, items = [] }) {
  const resumen = resumenRecepcion(items, { descuentoPct: cabecera.descuento_pct });
  return {
    id: cabecera.id,
    fecha: cabecera.fecha_recepcion,
    proveedor: cabecera.proveedor_razon_social,
    factura: cabecera.factura,
    sede: cabecera.sede?.nombre ?? null,
    estado: cabecera.estado,
    recibidor_nombre: cabecera.recibidor_nombre ?? null,
    descuento_pct: aNumero(cabecera.descuento_pct),
    total: resumen.total,
    renglones: resumen.renglones,
  };
}

/**
 * Recorta a `limite` la página leída con `limite + 1` filas y dice si hay más.
 * @returns {{ filas: object[], hay_mas: boolean }}
 */
export function paginar(filas = [], limite) {
  return { filas: filas.slice(0, limite), hay_mas: filas.length > limite };
}
