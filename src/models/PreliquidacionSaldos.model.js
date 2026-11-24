import { supabase } from "../config/supabase.js";
import { aCentavos, centavosATexto } from "../shared/preliquidacionCosteo.js";
import { conReintentoVersion, resultadoAError } from "./Preliquidacion.model.js";

/**
 * Saldos pendientes entre preliquidaciones (REQ-E3..E5).
 *
 * La tabla de saldos es la ÚNICA fuente: el gasto de la preliquidación destino los suma al congelar
 * y el banner de las pantallas sale de los `pendiente`. Aquí solo se lee y se llama a las RPC de
 * `sql/041` (`carnes_preliq_saldo_editar|descartar|mover`), que bloquean, validan y suben la versión
 * del destino; este módulo no decide nada de negocio ni toca SIESA.
 *
 *  - Editar / quitar / mover solo aplica a un saldo `pendiente` (`no_pendiente` si ya se aplicó).
 *  - Mover solo a una preliquidación abierta, sin liquidar y de la MISMA especie (E-S6).
 */

const T_SALDOS = "carnes_preliquidacion_saldos";
const T_PRELIQ = "carnes_preliquidaciones";

export const ESTADOS_SALDO = Object.freeze(["pendiente", "aplicado", "movido", "descartado"]);

async function llamarRpc(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args);
  if (error) throw new Error(`Error en ${nombre}: ${error.message}`);
  return data;
}

/** Resumen de la preliquidación que muestra el banner (origen / destino). */
const resumenPreliq = (p) => (p ? { id: p.id, especie: p.especie, estado: p.estado } : null);

/**
 * Banner de saldo pendiente: visible mientras haya saldos `pendiente`. El total suma con signo en
 * centavos enteros (un saldo negativo reduce el gasto del destino).
 */
export function armarBanner(saldos) {
  const pendientes = saldos.filter((s) => s.estado === "pendiente");
  const total = pendientes.reduce((suma, s) => suma + aCentavos(s.valor), 0n);
  return {
    visible: pendientes.length > 0,
    cantidad: pendientes.length,
    total: centavosATexto(total),
    items: pendientes.map((s) => ({
      saldo_id: s.id,
      valor: s.valor,
      especie: s.especie,
      origen_preliquidacion_id: s.origen_preliquidacion_id,
      destino_preliquidacion_id: s.destino_preliquidacion_id ?? null,
    })),
  };
}

/**
 * GET /saldos: por defecto solo los pendientes (lo que el banner necesita). `estado = "todos"`
 * devuelve también el historial (aplicado, movido, descartado).
 *
 * @param {{especie?: "res"|"cerdo", estado?: string}} [filtros]
 * @returns {Promise<{saldos: object[], banner: ReturnType<typeof armarBanner>}>}
 */
export async function listarSaldos({ especie, estado = "pendiente" } = {}) {
  let q = supabase.from(T_SALDOS).select("*");
  if (especie) q = q.eq("especie", especie);
  if (estado !== "todos") q = q.eq("estado", estado);
  const { data, error } = await q.order("id");
  if (error) throw new Error(`Error al leer los saldos: ${error.message}`);
  const saldos = data ?? [];

  const ids = [...new Set(saldos.flatMap((s) => [s.origen_preliquidacion_id, s.destino_preliquidacion_id]).filter((v) => v != null))];
  let preliquidaciones = [];
  if (ids.length) {
    const r = await supabase.from(T_PRELIQ).select("id, especie, estado").in("id", ids);
    if (r.error) throw new Error(`Error al leer las preliquidaciones: ${r.error.message}`);
    preliquidaciones = r.data ?? [];
  }
  const porId = new Map(preliquidaciones.map((p) => [String(p.id), p]));

  const filas = saldos.map((s) => ({
    ...s,
    origen: resumenPreliq(porId.get(String(s.origen_preliquidacion_id))),
    destino: s.destino_preliquidacion_id == null ? null : resumenPreliq(porId.get(String(s.destino_preliquidacion_id))),
  }));
  return { saldos: filas, banner: armarBanner(saldos) };
}

/**
 * PATCH /saldos/:id con UNA acción: `{valor}` (editar), `{descartar: true}` (quitar) o
 * `{destino_id}` (mover). La RPC revalida bajo lock; `version_cambiada` se reintenta.
 *
 * @returns {Promise<object>} la respuesta de la RPC (`ok` o `sin_cambios`)
 */
export async function actualizarSaldo(id, cambio, { por = null } = {}) {
  const respuesta = await conReintentoVersion(() => {
    if (cambio.descartar === true) return llamarRpc("carnes_preliq_saldo_descartar", { p_saldo_id: id, p_por: por });
    if (cambio.destino_id !== undefined) {
      return llamarRpc("carnes_preliq_saldo_mover", { p_saldo_id: id, p_destino_id: cambio.destino_id, p_por: por });
    }
    return llamarRpc("carnes_preliq_saldo_editar", { p_saldo_id: id, p_valor: cambio.valor, p_por: por });
  });
  const error = resultadoAError(respuesta);
  if (error) throw error;
  return respuesta;
}
