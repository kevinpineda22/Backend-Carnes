import { aCentavos, centavosATexto } from "./preliquidacionCosteo.js";

/**
 * Reglas puras de cierre de la preliquidación.
 *
 *  - Auto-cierre (D3): sin animales restantes y TODAS las sedes enviadas. No cierra mientras
 *    alguna sede tenga `requiere_correccion` (I5): quedaría sin quien la corrija.
 *  - Cierre manual (admin, p. ej. al vencer la ventana): permite sedes bloqueadas (el admin
 *    las acepta) pero no deja trabajo pendiente ni envíos en vuelo, que quedarían huérfanos
 *    porque una preliquidación cerrada ya no se procesa.
 *
 * El monto no asignado (animales que nunca llegaron) es el gasto total aplicado menos lo
 * asignado a las sedes enviadas, en centavos exactos.
 */

const ESTADOS_PENDIENTES = [
  "vinculada",
  "calculada",
  "lista_para_enviar",
  "error",
  "simulada",
  "anulada",
  "enviando",
  "sin_confirmar",
];

/** Gasto total aplicado menos lo asignado a las sedes `enviada`, como texto NUMERIC(14,2). */
export function montoNoAsignado({ cabecera, sedes }) {
  const total = aCentavos(cabecera.gasto_total_aplicado ?? 0);
  const asignado = sedes
    .filter((s) => s.estado === "enviada" && s.gasto_sede != null)
    .reduce((suma, s) => suma + aCentavos(s.gasto_sede), 0n);
  return centavosATexto(total - asignado);
}

function bloqueoComun(cabecera) {
  if (cabecera.estado !== "abierta") return "no_abierta";
  if (!cabecera.liquidada_at) return "no_liquidada";
  return null;
}

/**
 * ¿Se cierra sola la preliquidación? (D3 + I5)
 * @returns {{cerrar: boolean, motivo?: string, montoNoAsignado?: string}}
 */
export function decidirAutocierre({ cabecera, sedes }) {
  const comun = bloqueoComun(cabecera);
  if (comun) return { cerrar: false, motivo: comun };
  if (Number(cabecera.restantes) !== 0) return { cerrar: false, motivo: "restantes" };
  if (!sedes.length) return { cerrar: false, motivo: "sin_sedes" };
  if (sedes.some((s) => s.estado !== "enviada")) return { cerrar: false, motivo: "sedes_pendientes" };
  if (sedes.some((s) => s.requiere_correccion === true)) return { cerrar: false, motivo: "requiere_correccion" };
  return { cerrar: true, montoNoAsignado: montoNoAsignado({ cabecera, sedes }) };
}

/**
 * ¿Puede el admin cerrar la preliquidación? Sin trabajo pendiente ni correcciones por hacer.
 * @returns {{cerrar: boolean, motivo?: string, montoNoAsignado?: string}}
 */
export function decidirCierreManual({ cabecera, sedes }) {
  const comun = bloqueoComun(cabecera);
  if (comun) return { cerrar: false, motivo: comun };
  if (sedes.some((s) => ESTADOS_PENDIENTES.includes(s.estado))) return { cerrar: false, motivo: "sedes_pendientes" };
  if (sedes.some((s) => s.requiere_correccion === true)) return { cerrar: false, motivo: "requiere_correccion" };
  return { cerrar: true, montoNoAsignado: montoNoAsignado({ cabecera, sedes }) };
}
