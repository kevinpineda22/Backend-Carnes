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

// ─── Anular una preliquidación YA enviada a SIESA (sql/046) ───────────────────

const TIPOS_VISCERAS = ["visceras_recepcion", "ajuste_visceras"];
const ENVIO_VISCERAS_VIGENTE = ["enviando", "ok", "duplicado", "sin_confirmar"];

/**
 * Guardas de `carnes_preliq_anular_enviada`, en el mismo orden de precedencia que la RPC (que las
 * revalida bajo lock). El admin confirma que los oficiales YA se anularon a mano en SIESA; aquí solo se
 * decide si el resto del estado deja liberar las recepciones:
 *
 *   1. `ya_anulada`         la cabecera no es abierta ni cerrada.
 *   2. `sede_ambigua`       una sede enviando/sin_confirmar, o un envío oficial enviando/sin_confirmar.
 *   3. `visceras_vigentes`  una CEI de vísceras vigente de alguna recepción (fuera de alcance).
 *   4. `envio_compartido`   un oficial ok/duplicado cubre también recepciones ajenas a la preliquidación.
 *   5. `saldo_aplicado`     un saldo que ELLA originó ya viajó en la liquidación de otra.
 *
 * @param {{cabecera: {estado: string}, sedes?: Array<{estado: string, recepcion_id: *}>,
 *   envios?: Array<{tipo: string, estado: string, recepcion_id?: *, recepcion_ids?: *[]|null}>,
 *   saldos?: Array<{estado: string}>}} p `envios` = los de las recepciones de las sedes
 * @returns {{ok: true} | {ok: false, motivo: string}}
 */
export function decidirAnulacionEnviada({ cabecera, sedes = [], envios = [], saldos = [] }) {
  if (cabecera?.estado !== "abierta" && cabecera?.estado !== "cerrada") return { ok: false, motivo: "ya_anulada" };

  const recepciones = new Set(sedes.map((s) => String(s.recepcion_id)));
  const cubre = (e) => [e.recepcion_id, ...(e.recepcion_ids ?? [])].some((id) => id != null && recepciones.has(String(id)));
  const propios = envios.filter(cubre);

  const enVuelo = (e) => e.estado === "enviando" || e.estado === "sin_confirmar";
  if (sedes.some(enVuelo) || propios.some((e) => e.tipo === "oficial" && enVuelo(e))) {
    return { ok: false, motivo: "sede_ambigua" };
  }
  if (propios.some((e) => TIPOS_VISCERAS.includes(e.tipo) && ENVIO_VISCERAS_VIGENTE.includes(e.estado))) {
    return { ok: false, motivo: "visceras_vigentes" };
  }
  const compartido = propios.some(
    (e) =>
      e.tipo === "oficial" &&
      (e.estado === "ok" || e.estado === "duplicado") &&
      Array.isArray(e.recepcion_ids) &&
      e.recepcion_ids.some((id) => !recepciones.has(String(id))),
  );
  if (compartido) return { ok: false, motivo: "envio_compartido" };

  if (saldos.some((s) => s.estado === "aplicado")) return { ok: false, motivo: "saldo_aplicado" };
  return { ok: true };
}
