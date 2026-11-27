/**
 * Reglas de tiempo de la preliquidación de talleres (res / cerdo).
 *
 * Todo es puro: no lee el reloj ni la base. El llamador pasa `ahora` y los datos
 * leídos. Bogotá es UTC-5 fijo (sin horario de verano), por eso el desplazamiento
 * se aplica a mano; no depende de la zona del servidor (Vercel corre en UTC).
 *
 * - Corte: 21:30 Bogotá del día del primer ingreso. El servicio cargado hasta ese
 *   instante (inclusive) es "precorte" y entra a la primera liquidación. Un admin puede
 *   fijar a mano otro instante (`corte_manual`): el corte efectivo es ese si existe y, si
 *   no, el automático (`corteEfectivo`). Todo consumidor del corte pasa por ahí.
 * - Ventana: 2 días calendario Bogotá desde el primer ingreso, hasta las
 *   23:59:59.999 del segundo día (no son 48 horas).
 */

const OFFSET_BOGOTA_H = 5; // Bogotá = UTC-5: la hora local + 5 es la hora UTC.
const MS_MINUTO = 60_000;
const MARGEN_CORRIDA_PERDIDA_MIN = 60;

/** Parsea `YYYY-MM-DD` validando que sea una fecha real. */
function parsearFecha(fechaISO) {
  const m = typeof fechaISO === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaISO) : null;
  if (!m) throw new Error(`fecha inválida (se espera YYYY-MM-DD): ${JSON.stringify(fechaISO)}`);
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const control = new Date(Date.UTC(anio, mes - 1, dia));
  if (control.getUTCFullYear() !== anio || control.getUTCMonth() !== mes - 1 || control.getUTCDate() !== dia) {
    throw new Error(`fecha inválida (no existe en el calendario): ${fechaISO}`);
  }
  return { anio, mes, dia };
}

/** @returns {Date} instante UTC del inicio (00:00) de ese día en Bogotá */
function inicioDiaBogota(fechaISO) {
  const { anio, mes, dia } = parsearFecha(fechaISO);
  return new Date(Date.UTC(anio, mes - 1, dia, OFFSET_BOGOTA_H));
}

function aInstante(valor) {
  return valor instanceof Date ? valor : new Date(valor);
}

/**
 * Instante de corte de la fecha dada (por defecto 21:30 Bogotá).
 * @param {string} fechaISO `YYYY-MM-DD` (fecha del primer ingreso, hora Bogotá)
 * @param {string} [hhmm="21:30"]
 * @returns {Date}
 */
export function corteBogota(fechaISO, hhmm = "21:30") {
  const { anio, mes, dia } = parsearFecha(fechaISO);
  const h = typeof hhmm === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm) : null;
  if (!h) throw new Error(`hora inválida (se espera HH:MM): ${JSON.stringify(hhmm)}`);
  return new Date(Date.UTC(anio, mes - 1, dia, Number(h[1]) + OFFSET_BOGOTA_H, Number(h[2])));
}

/**
 * Corte efectivo: el manual si hay (instante absoluto) y, si no, el automático de la fecha del
 * primer ingreso. `null` si no hay ninguno (preliquidación aún sin primer ingreso).
 * @param {{fechaPrimerIngreso?: string|null, corteManual?: Date|string|null}} p
 * @returns {Date|null}
 */
export function corteEfectivo({ fechaPrimerIngreso, corteManual } = {}) {
  if (corteManual) return aInstante(corteManual);
  return fechaPrimerIngreso ? corteBogota(fechaPrimerIngreso) : null;
}

/** Corte efectivo de una fila de `carnes_preliquidaciones` (`corte_manual` si está, si no el automático). */
export function corteDePreliquidacion(preliq) {
  return corteEfectivo({ fechaPrimerIngreso: preliq?.fecha_primer_ingreso, corteManual: preliq?.corte_manual });
}

/** @returns {Date} 23:59:59.999 Bogotá del día (Bogotá) al que pertenece el instante */
export function finDiaBogota(instante) {
  const local = new Date(aInstante(instante).getTime() - OFFSET_BOGOTA_H * 3_600_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, OFFSET_BOGOTA_H) - 1,
  );
}

/**
 * `true` si el servicio se cargó a tiempo para la primera liquidación.
 * Falso cuando la preliquidación ya se liquidó (todo cambio posterior es tardío);
 * verdadero cuando aún no hay corte (sin primer ingreso ni corte manual).
 */
export function esPrecorte({ servicioAt, fechaPrimerIngreso, liquidadaAt, corteManual = null }) {
  if (liquidadaAt) return false;
  const corte = corteEfectivo({ fechaPrimerIngreso, corteManual });
  if (!corte) return true;
  return aInstante(servicioAt).getTime() <= corte.getTime();
}

/**
 * Fin de la ventana: 23:59:59.999 Bogotá del día `fechaPrimerIngreso + (dias - 1)`.
 * Con `dias = 2`: el día del primer ingreso y el siguiente, completos.
 * @returns {Date}
 */
export function ventanaFin(fechaPrimerIngreso, dias = 2) {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`dias inválido (entero >= 1): ${dias}`);
  const inicio = inicioDiaBogota(fechaPrimerIngreso);
  // Inicio del día siguiente al último día de la ventana, menos 1 ms.
  return new Date(inicio.getTime() + dias * 24 * 60 * 60 * 1000 - 1);
}

/**
 * ¿El ingreso cae dentro de la ventana? Solo hay cota superior: un ingreso
 * anterior al primer ingreso adelanta la ventana (lo decide `planearVinculacion`).
 * @param {{ingreso: string|Date, ventanaFin: Date|string|null}} p `ingreso` puede ser
 *   la fecha `YYYY-MM-DD` (se toma 00:00 Bogotá) o un instante.
 */
export function enVentana({ ingreso, ventanaFin: fin }) {
  if (!fin) return true;
  const instante = typeof ingreso === "string" ? inicioDiaBogota(ingreso) : aInstante(ingreso);
  return instante.getTime() <= aInstante(fin).getTime();
}

/** Hay primer ingreso, ya pasó el corte efectivo (inclusive) y aún no se liquidó. */
export function debeLiquidar({ preliq, ahora }) {
  if (!preliq?.fecha_primer_ingreso || preliq.liquidada_at) return false;
  return aInstante(ahora).getTime() >= corteDePreliquidacion(preliq).getTime();
}

/**
 * Corrida programada perdida: debía liquidarse, pasaron más de 60 min del corte
 * y no hay una corrida exitosa (no dry-run) que incluya la preliquidación y haya
 * terminado desde `max(corte, ahora - 60 min)`.
 */
export function corridaPerdida({ preliq, corridas = [], ahora }) {
  if (!debeLiquidar({ preliq, ahora })) return false;
  const t = aInstante(ahora).getTime();
  const corte = corteDePreliquidacion(preliq).getTime();
  if (t <= corte + MARGEN_CORRIDA_PERDIDA_MIN * MS_MINUTO) return false;

  const desde = Math.max(corte, t - MARGEN_CORRIDA_PERDIDA_MIN * MS_MINUTO);
  const cubierta = corridas.some(
    (c) =>
      c.estado === "ok" &&
      c.dry_run === false &&
      Array.isArray(c.preliquidacion_ids) &&
      c.preliquidacion_ids.includes(preliq.id) &&
      c.terminada_at != null &&
      aInstante(c.terminada_at).getTime() >= desde,
  );
  return !cubierta;
}

/** Ventana vencida con animales sin asignar y sin aviso previo (alerta única). */
export function ventanaVencida({ preliq, ahora }) {
  if (!preliq?.ventana_fin || preliq.estado !== "abierta") return false;
  if (!(preliq.restantes > 0) || preliq.aviso_ventana_at) return false;
  return aInstante(preliq.ventana_fin).getTime() < aInstante(ahora).getTime();
}
