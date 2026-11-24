/**
 * Regla pura: al cerrar una recepción de talleres (res o cerdo) la cantidad de
 * novillos (canales, en cerdo) es obligatoria, un entero y mayor que cero.
 *
 * Sin ese dato la preliquidación no sabe cuántos animales consume la sede, y las
 * vísceras que se cuentan por novillo quedan en cero. La regla corre SOLO al
 * finalizar: las filas ya cerradas con 0 no se tocan.
 *
 * Puro, sin Supabase ni Express. `Recepcion.model.js#finalizar` lee y este módulo
 * decide. El valor llega de Postgres como NUMERIC (puede venir como texto, "4.00").
 */

export const CODIGO_NOVILLOS_INVALIDOS = "NOVILLOS_INVALIDOS";

export const MENSAJE_NOVILLOS_INVALIDOS =
  "Falta la cantidad de novillos (canales, en cerdo): tiene que ser un número entero mayor que cero.";

/**
 * @param {unknown} novillos Valor leído de la recepción (número, texto o null).
 * @returns {{ok: true, valor: number} | {ok: false, codigo: string, mensaje: string}}
 */
export function validarNovillosCierre(novillos) {
  const invalido = {
    ok: false,
    codigo: CODIGO_NOVILLOS_INVALIDOS,
    mensaje: MENSAJE_NOVILLOS_INVALIDOS,
  };

  if (typeof novillos !== "number" && typeof novillos !== "string") return invalido;
  if (typeof novillos === "string" && novillos.trim() === "") return invalido;

  const valor = Number(novillos);
  if (!Number.isFinite(valor) || !Number.isInteger(valor) || valor <= 0) return invalido;

  return { ok: true, valor };
}
