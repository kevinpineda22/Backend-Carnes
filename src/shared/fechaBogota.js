/**
 * Fecha calendario de Colombia (America/Bogota, UTC-5, sin horario de verano).
 *
 * Única fuente de "hoy" del backend. El servidor corre en UTC (Vercel): entre las
 * 7:00 p. m. y la medianoche de Bogotá, `toISOString().slice(0, 10)` sobre el instante actual
 * ya marca el día SIGUIENTE, y una recepción abierta a las 7:30 p. m. quedaba
 * guardada con la fecha de mañana. Tampoco se debe usar `current_date` en la base
 * (también es UTC): ver sql/031_fecha_bogota.sql.
 */

const FORMATO_FECHA_BOGOTA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * @param {Date} [fecha] instante a convertir (por defecto, ahora)
 * @returns {string} `YYYY-MM-DD` en hora de Bogotá
 */
export function hoyBogota(fecha = new Date()) {
  return FORMATO_FECHA_BOGOTA.format(fecha);
}
