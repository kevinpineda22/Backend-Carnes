/**
 * Guardas de la anulación de la preliquidación completa (R12). Puras: leen filas ya cargadas.
 *
 * Solo se anula una preliquidación `abierta` de la que NUNCA salió nada a SIESA y cuyo saldo (si
 * generó alguno) no se aplicó en otra preliquidación. La RPC `carnes_preliq_anular` revalida las
 * mismas guardas bajo lock, en el mismo orden de precedencia:
 *
 *   1. `no_abierta`      la preliquidación ya está cerrada o anulada.
 *   2. `sede_enviada`    alguna sede está (o estuvo) enviando/enviada/sin_confirmar/anulada, tiene un
 *                        envío vinculado ok/enviando/sin_confirmar o su recepción ya es Enviado_SIESA.
 *   3. `saldo_aplicado`  un saldo que ELLA originó ya viajó en la liquidación de otra.
 *
 * Una sede `anulada` cuenta como enviada: su CEA existió. Para corregirla se usa el flujo por sede.
 */

const ESTADOS_SEDE_ENVIADA = ["enviando", "enviada", "sin_confirmar", "anulada"];
const ESTADOS_ENVIO_VIGENTE = ["ok", "enviando", "sin_confirmar"];

/**
 * @param {{cabecera: {estado: string}, sedes?: Array<{estado: string, envio_id?: *, recepcion_id?: *}>,
 *   envios?: Array<{id: *, estado: string}>, recepciones?: Array<{id: *, estado: string}>,
 *   saldos?: Array<{estado: string}>}} p `saldos` = los que la preliquidación ORIGINÓ
 * @returns {{ok: true} | {ok: false, motivo: "no_abierta"|"sede_enviada"|"saldo_aplicado"}}
 */
export function decidirAnulacionPreliquidacion({ cabecera, sedes = [], envios = [], recepciones = [], saldos = [] }) {
  if (cabecera?.estado !== "abierta") return { ok: false, motivo: "no_abierta" };

  const enviosPorId = new Map(envios.map((e) => [String(e.id), e]));
  const recepcionesPorId = new Map(recepciones.map((r) => [String(r.id), r]));
  const salioAlgo = sedes.some((s) => {
    if (ESTADOS_SEDE_ENVIADA.includes(s.estado)) return true;
    const envio = s.envio_id != null ? enviosPorId.get(String(s.envio_id)) : null;
    if (envio && ESTADOS_ENVIO_VIGENTE.includes(envio.estado)) return true;
    return recepcionesPorId.get(String(s.recepcion_id))?.estado === "Enviado_SIESA";
  });
  if (salioAlgo) return { ok: false, motivo: "sede_enviada" };

  if (saldos.some((s) => s.estado === "aplicado")) return { ok: false, motivo: "saldo_aplicado" };
  return { ok: true };
}
