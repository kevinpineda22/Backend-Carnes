/**
 * Corte manual de la preliquidación: validación PURA (no lee el reloj ni la base).
 *
 * El admin puede fijar el instante del corte (cierre) mientras la preliquidación siga
 * abierta y sin liquidar, o restablecer la regla automática (`corte = null`). La RPC
 * `carnes_preliq_fijar_corte` revalida lo que depende del estado y del reloj de la base
 * bajo el lock de la cabecera; aquí se decide el resto y se arma el plan que ella escribe.
 *
 * Reglas:
 *  - El corte llega como ISO 8601 CON desfase (`...Z` o `...-05:00`): un instante sin zona
 *    sería ambiguo (Vercel corre en UTC, el admin piensa en Bogotá).
 *  - Debe estar en el futuro (> ahora).
 *  - No puede pasar de 7 días después del corte automático (evita un año mal tecleado).
 *  - Para restablecer, el corte automático no puede haber pasado ya (restablecer no debe
 *    liquidar de golpe).
 *  - Con el corte nuevo, la ventana resultante debe seguir conteniendo a todas las
 *    recepciones ya vinculadas (si se restablece o se adelanta el corte y la ventana se
 *    acorta, una recepción ya vinculada quedaría fuera).
 */

import { corteEfectivo, enVentana } from "./preliquidacionTiempo.js";
import { ventanaConCorte } from "./preliquidacionVinculacion.js";

export const MAX_DIAS_CORTE_MANUAL = 7;
const MS_DIA = 24 * 60 * 60 * 1000;
const OFFSET_BOGOTA_MS = 5 * 60 * 60 * 1000;

const ISO_CON_DESFASE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `dd/mm/aaaa hh:mm` en hora de Bogotá (UTC-5 fijo), para los mensajes al usuario. */
export function formatoBogota(instante) {
  const d = new Date(new Date(instante).getTime() - OFFSET_BOGOTA_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** El calendario real: JS acepta "2026-02-31" y lo corre a marzo; aquí eso es un error de tecleo. */
function fechaDelCalendario(texto) {
  const [anio, mes, dia] = texto.slice(0, 10).split("-").map(Number);
  const control = new Date(Date.UTC(anio, mes - 1, dia));
  return control.getUTCFullYear() === anio && control.getUTCMonth() === mes - 1 && control.getUTCDate() === dia;
}

const rechazo = (estado, codigo, mensaje) => ({ ok: false, estado, codigo, mensaje });

/**
 * @param {object} p
 * @param {string|null} p.corte ISO con desfase, o `null` para volver a la regla automática
 * @param {object} p.preliq fila de `carnes_preliquidaciones`
 * @param {Array<{recepcionId?: *, recepcion_id?: *, fechaIngreso?: string, recepcion?: {fecha_ingreso?: string}|null}>} [p.sedes]
 *   sedes vinculadas (con su recepción) a las que la ventana nueva debe seguir dando cabida
 * @param {Date} p.ahora
 * @param {number} [p.diasVentana=2]
 * @returns {{ok: true, corteManual: Date|null, corteAutomatico: Date, corteEfectivo: Date, ventanaFin: Date}
 *   | {ok: false, estado: number, codigo: string, mensaje: string}}
 */
export function validarCorteManual({ corte, preliq, sedes = [], ahora, diasVentana = 2 }) {
  if (preliq.estado !== "abierta") {
    return rechazo(409, "no_abierta", "La preliquidación no está abierta: ya no se puede cambiar su cierre.");
  }
  if (preliq.liquidada_at) {
    return rechazo(409, "ya_liquidada", "La preliquidación ya fue liquidada: ya no se puede cambiar su cierre.");
  }
  if (!preliq.fecha_primer_ingreso) {
    return rechazo(
      409,
      "corte_sin_primer_ingreso",
      "La preliquidación aún no tiene recepciones vinculadas: el cierre se puede cambiar cuando entre la primera.",
    );
  }

  const corteAutomatico = corteEfectivo({ fechaPrimerIngreso: preliq.fecha_primer_ingreso });
  const ahoraMs = new Date(ahora).getTime();

  let corteManual = null;
  if (corte !== null) {
    const valido =
      typeof corte === "string" &&
      ISO_CON_DESFASE.test(corte) &&
      fechaDelCalendario(corte) &&
      !Number.isNaN(new Date(corte).getTime());
    if (!valido) {
      return rechazo(
        422,
        "corte_invalido",
        "El cierre debe ser una fecha y hora válidas con zona horaria (por ejemplo 2026-11-27T21:30:00-05:00), o null para restablecer el automático.",
      );
    }
    corteManual = new Date(corte);
    if (corteManual.getTime() <= ahoraMs) {
      return rechazo(422, "corte_pasado", "El cierre debe ser una fecha y hora futuras.");
    }
    const limite = new Date(corteAutomatico.getTime() + MAX_DIAS_CORTE_MANUAL * MS_DIA);
    if (corteManual.getTime() > limite.getTime()) {
      return rechazo(
        422,
        "corte_excede_limite",
        `El cierre no puede pasar de ${MAX_DIAS_CORTE_MANUAL} días después del cierre automático (${formatoBogota(limite)} como máximo).`,
      );
    }
  } else if (corteAutomatico.getTime() <= ahoraMs) {
    return rechazo(
      409,
      "corte_automatico_pasado",
      `El cierre automático (${formatoBogota(corteAutomatico)}) ya pasó: indique una nueva fecha y hora futuras.`,
    );
  }

  const ventanaFin = ventanaConCorte(preliq.fecha_primer_ingreso, diasVentana, corteManual);
  const fuera = sedes
    .map((s) => ({ id: s.recepcionId ?? s.recepcion_id, fecha: s.fechaIngreso ?? s.recepcion?.fecha_ingreso ?? null }))
    .filter((s) => s.fecha && !enVentana({ ingreso: s.fecha, ventanaFin }));
  if (fuera.length > 0) {
    return rechazo(
      409,
      "corte_deja_sedes_fuera",
      `Con ese cierre la ventana de la preliquidación terminaría el ${formatoBogota(ventanaFin)} y dejaría fuera ` +
        `${fuera.length === 1 ? "la recepción" : "las recepciones"} ${fuera.map((s) => `#${s.id}`).join(", ")} ya vinculadas. ` +
        "Elija un cierre posterior o desvincule esas recepciones.",
    );
  }

  return {
    ok: true,
    corteManual,
    corteAutomatico,
    corteEfectivo: corteManual ?? corteAutomatico,
    ventanaFin,
  };
}
