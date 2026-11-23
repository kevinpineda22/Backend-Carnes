/**
 * Liquidación alterna INFORMATIVA de la preliquidación de talleres.
 *
 * Cuando el servicio real llega después de la liquidación (tardío), se compara el
 * taller "como se liquidó" (servicio aplicado) contra el taller "con el dato real".
 * Solo informa: nunca se envía a SIESA.
 *
 * Todo el dinero va en centavos enteros (BigInt). La diferencia es de servicio
 * (servicio real - servicio aplicado, REQ-E3) y se reparte entre las sedes con
 * el mismo redondeo acumulado de `montoSedes`, de modo que las diferencias por sede
 * suman la diferencia exacta. Si la vinculación es parcial, lo que corresponde a los
 * animales aún sin llegar queda en `noAsignadaCent`.
 *
 * Puro: sin Supabase ni Express.
 */

import { aCentavos, centavosATexto, montoSedes } from "./preliquidacionCosteo.js";
import { corteBogota } from "./preliquidacionTiempo.js";

/**
 * @param {object} p
 * @param {Array<{id: *, orden: number, animales: number, estado: string, gasto_sede: string|number|null}>} p.sedesCalculadas
 *   sedes vinculadas; se consideran las que ya tienen gasto congelado y no están bloqueadas
 *   (calculada, lista_para_enviar, error, simulada y los estados de envío), enviadas o no.
 * @param {string|number} p.servicioReal servicio real cargado tarde (pesos)
 * @param {string|number} p.servicioAplicado servicio con el que se liquidó (pesos)
 * @param {number} p.animales animales declarados de la preliquidación
 * @returns {{hayAlterna: boolean, servicioRealCent: bigint, servicioAplicadoCent: bigint,
 *   diferenciaCent: bigint, porSede: Array<{sedeId: *, gastoSedeAplicadoCent: bigint,
 *   gastoSedeRealCent: bigint, diferenciaCent: bigint}>, noAsignadaCent: bigint, plan: object}}
 */
export function compararAlterna({ sedesCalculadas, servicioReal, servicioAplicado, animales }) {
  if (servicioReal == null) throw new Error("servicioReal es obligatorio para comparar la alterna");
  if (servicioAplicado == null) throw new Error("servicioAplicado es obligatorio para comparar la alterna");

  const servicioRealCent = aCentavos(servicioReal);
  const servicioAplicadoCent = aCentavos(servicioAplicado);
  const diferenciaCent = servicioRealCent - servicioAplicadoCent;

  const consideradas = [...(sedesCalculadas ?? [])]
    .filter((s) => s.gasto_sede != null && s.estado !== "bloqueada")
    .sort((a, b) => a.orden - b.orden);

  // montoSedes valida animales > 0 y que las sedes no excedan los animales declarados.
  const reparto = montoSedes(
    consideradas.map((s) => ({ sedeId: s.id, animales: s.animales })),
    { gastoTotalCent: diferenciaCent, animales },
  );

  const porSede = consideradas.map((s, i) => {
    const aplicado = aCentavos(s.gasto_sede);
    const diferencia = reparto[i].gastoSedeCent;
    return {
      sedeId: s.id,
      gastoSedeAplicadoCent: aplicado,
      gastoSedeRealCent: aplicado + diferencia,
      diferenciaCent: diferencia,
    };
  });

  const asignada = porSede.reduce((suma, s) => suma + s.diferenciaCent, 0n);
  const noAsignadaCent = diferenciaCent - asignada;

  return {
    hayAlterna: diferenciaCent !== 0n,
    servicioRealCent,
    servicioAplicadoCent,
    diferenciaCent,
    porSede,
    noAsignadaCent,
    plan: {
      servicio_real: centavosATexto(servicioRealCent),
      servicio_aplicado: centavosATexto(servicioAplicadoCent),
      diferencia: centavosATexto(diferenciaCent),
      no_asignada: centavosATexto(noAsignadaCent),
      por_sede: porSede.map((s) => ({
        sede_id: s.sedeId,
        gasto_sede_aplicado: centavosATexto(s.gastoSedeAplicadoCent),
        gasto_sede_real: centavosATexto(s.gastoSedeRealCent),
        diferencia: centavosATexto(s.diferenciaCent),
      })),
    },
  };
}

/**
 * ¿Hay una alterna tardía por registrar? (R6)
 *
 * Sí cuando la preliquidación ya se liquidó, hay un servicio cargado DESPUÉS del corte de la
 * fecha de primer ingreso (por dato, nunca por la hora de la corrida) y ese servicio es
 * distinto del aplicado. Un servicio cargado antes del corte fue el real de la liquidación, y el
 * que desbloqueó `servicio_cero` quedó como precorte (aplicado = servicio): ninguno genera alterna.
 */
export function requiereAlternaTardia({ servicio, servicioAt, servicioAplicado, fechaPrimerIngreso, liquidadaAt }) {
  if (!liquidadaAt || servicio == null || servicioAt == null || servicioAplicado == null || !fechaPrimerIngreso) return false;
  if (new Date(servicioAt).getTime() <= corteBogota(fechaPrimerIngreso).getTime()) return false;
  return aCentavos(servicio) !== aCentavos(servicioAplicado);
}
