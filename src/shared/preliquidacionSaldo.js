/**
 * Saldo pendiente de la preliquidación de talleres (máquina de estados C12).
 *
 * El saldo nace de un servicio tardío: es la diferencia (servicio real - servicio
 * aplicado) del ORIGEN y viaja como gasto a la siguiente preliquidación de la MISMA
 * especie. Estados: pendiente -> aplicado | movido | descartado.
 *
 *  - Si el saldo del origen sigue `pendiente`, un nuevo cálculo lo actualiza en el lugar.
 *  - Si ya fue `aplicado`, esa fila NUNCA se toca: se crea una fila de ajuste cuyo valor es
 *    la nueva diferencia menos lo ya contabilizado (aplicado + pendiente) del origen.
 *  - `movido` y `descartado` no cuentan como saldo vigente.
 *
 * Puro: decide la acción; `carnes_preliq_registrar_alterna` solo la persiste.
 * Entradas en pesos (texto/número); `valorCent` en centavos BigInt.
 */

import { aCentavos, centavosATexto } from "./preliquidacionCosteo.js";

/**
 * Destino de un saldo nuevo: la preliquidación abierta más antigua (created_at, luego id)
 * de la misma especie, sin liquidar y distinta del origen; `null` si no hay (el saldo espera
 * hasta que `carnes_preliq_crear` cree una y lo adjunte).
 * @returns {number|string|null}
 */
export function elegirDestinoSaldo({ abiertas, origenId, especie }) {
  const candidatas = (abiertas ?? [])
    .filter((p) => p.especie === especie && p.estado === "abierta" && !p.liquidada_at && p.id !== origenId)
    .sort((a, b) => {
      const porFecha = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (porFecha !== 0) return porFecha;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return candidatas.length ? candidatas[0].id : null;
}

/**
 * @param {object} p
 * @param {string|number} p.diferencia diferencia vigente del origen (pesos, con signo)
 * @param {Array<{id: *, valor: string|number, estado: string}>} p.saldosOrigen filas del saldo cuyo origen es esta preliquidación
 * @param {*} [p.origenId] origen, para excluirlo al elegir el destino
 * @param {"res"|"cerdo"} [p.especie]
 * @param {Array} [p.abiertas] preliquidaciones candidatas a destino de una fila nueva
 * @returns {{accion: "nada"}
 *   | {accion: "actualizar_pendiente", saldoId: *, valor: string, valorCent: bigint, descartar: boolean}
 *   | {accion: "crear_ajuste", valor: string, valorCent: bigint, ajusteDeSaldoId: *|null, destinoId: *|null}}
 */
export function planearSaldo({ diferencia, saldosOrigen, origenId, especie, abiertas }) {
  const diferenciaCent = aCentavos(diferencia);
  const vigentes = (saldosOrigen ?? []).filter((s) => s.estado === "pendiente" || s.estado === "aplicado");
  const aplicados = vigentes.filter((s) => s.estado === "aplicado");
  const pendientes = vigentes.filter((s) => s.estado === "pendiente");

  const sumar = (filas) => filas.reduce((suma, s) => suma + aCentavos(s.valor), 0n);
  const mayorId = (filas) => filas.reduce((m, s) => (m === null || s.id > m.id ? s : m), null);

  if (pendientes.length) {
    const actual = mayorId(pendientes);
    const otros = pendientes.filter((s) => s !== actual);
    const valorCent = diferenciaCent - sumar(aplicados) - sumar(otros);
    if (valorCent === aCentavos(actual.valor)) return { accion: "nada" };
    return {
      accion: "actualizar_pendiente",
      saldoId: actual.id,
      valor: centavosATexto(valorCent),
      valorCent,
      descartar: valorCent === 0n,
    };
  }

  const valorCent = diferenciaCent - sumar(aplicados);
  if (valorCent === 0n) return { accion: "nada" };

  const ultimoAplicado = mayorId(aplicados);
  const destinoId = abiertas ? elegirDestinoSaldo({ abiertas, origenId, especie }) : null;
  return {
    accion: "crear_ajuste",
    valor: centavosATexto(valorCent),
    valorCent,
    ajusteDeSaldoId: ultimoAplicado ? ultimoAplicado.id : null,
    destinoId,
  };
}
