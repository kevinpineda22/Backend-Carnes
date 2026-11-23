import { supabase } from "../config/supabase.js";
import { transicionSede } from "../shared/preliquidacionEstados.js";
import { conReintentoVersion, resultadoAError } from "./Preliquidacion.model.js";

/**
 * Correcciones de una sede de preliquidación ya enviada a SIESA (REQ-F2/F3).
 *
 * La anulación en SIESA la hace una persona; aquí solo se REGISTRA que ya se hizo
 * (`anulacion_confirmada`) para que la sede pueda recostearse y mandarse de nuevo. Este módulo
 * jamás llama a SIESA: registra el envío como anulado (flujo existente de `SiesaEnvio.model.js`)
 * y escribe la transición por `carnes_preliq_transicionar_sede` (CAS de estado y versión).
 *
 * La decisión de qué transiciones existen es de `transicionSede`; aquí no hay reglas propias.
 */

const T_PRELIQ = "carnes_preliquidaciones";
const T_SEDES = "carnes_preliquidacion_sedes";

async function llamarRpc(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args);
  if (error) throw new Error(`Error en ${nombre}: ${error.message}`);
  return data;
}

async function leerSede(sedeId) {
  const { data, error } = await supabase.from(T_SEDES).select("*").eq("id", sedeId).maybeSingle();
  if (error) throw new Error(`Error al leer la sede: ${error.message}`);
  if (!data) throw resultadoAError({ resultado: "no_encontrada" });
  return data;
}

async function leerCabecera(id) {
  const { data, error } = await supabase.from(T_PRELIQ).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer la preliquidación: ${error.message}`);
  if (!data) throw resultadoAError({ resultado: "no_encontrada" });
  return data;
}

/** Registra la anulación del envío oficial de la recepción (sin SIESA). Se carga bajo demanda. */
async function anularEnvioPorDefecto(recepcionId, opciones) {
  const { anularOficialRecepcion } = await import("./SiesaEnvio.model.js");
  return anularOficialRecepcion(recepcionId, opciones);
}

/** Escribe una transición de `transicionSede` con CAS sobre la versión leída. */
async function escribirTransicion(sede, transicion) {
  const { estado: hacia, ...campos } = transicion.campos;
  const recepcion = transicion.efectos.find((e) => e.tipo === "recepcion");
  if (recepcion) campos.recepcion_estado = recepcion.estado;
  return llamarRpc("carnes_preliq_transicionar_sede", {
    p_sede_id: sede.id,
    p_sede_version: sede.version,
    p_desde: sede.estado,
    p_hacia: hacia,
    p_campos: campos,
  });
}

/** Lanza el error HTTP de un resultado que no es de éxito (p. ej. `no_encontrada` si la sede desapareció). */
function exigirResultado(respuesta) {
  if (respuesta?.resultado === "ok" || respuesta?.resultado === "ya_anulada") return;
  throw resultadoAError(respuesta);
}

/** Respuesta común: la transición ya escrita (o ya existente). */
const respuestaSede = (resultado, sede, extra = {}) => ({
  resultado,
  sede_id: sede.id,
  preliquidacion_id: sede.preliquidacion_id,
  ...extra,
});

/**
 * El admin confirma que la entrada oficial de la sede YA se anuló a mano en SIESA.
 *
 * - Solo una sede `enviada` se anula (`sede_no_enviada` en cualquier otro estado).
 * - Idempotente (F-S3): una sede ya `anulada` responde `ya_anulada` sin escribir; dos clics a la
 *   vez producen una sola transición (el perdedor del CAS relee y encuentra `anulada`).
 * - Primero se marca el envío como anulado (libera el candado de sql/010) y después la sede: si la
 *   segunda parte falla, el reintento termina el trabajo (marcar un envío ya anulado no hace nada).
 * - Si el registro del envío falla (F-S4) la sede sigue `enviada` y nada la reenvía.
 * - La recepción vuelve a Costeado y `requiere_correccion` NO se toca: solo un reenvío con los montos
 *   nuevos o el descarte explícito la limpian (M2).
 * Después el admin recalcula (anulada -> lista_para_enviar) y envía a mano; nunca se reenvía sola.
 *
 * @param {number|string} sedeId
 * @param {{por?: string|null, motivo?: string|null}} [datos]
 * @param {{anularEnvio?: Function, log?: Pick<Console, "info"|"warn">}} [opciones]
 */
export async function anularSede(sedeId, { por = null, motivo = null } = {}, opciones = {}) {
  const anularEnvio = opciones.anularEnvio ?? anularEnvioPorDefecto;
  const log = opciones.log ?? console;

  const respuesta = await conReintentoVersion(async () => {
    const sede = await leerSede(sedeId);
    if (sede.estado === "anulada") {
      return respuestaSede("ya_anulada", sede, { estado: "anulada", sede_version: sede.version });
    }
    const cabecera = await leerCabecera(sede.preliquidacion_id);
    if (cabecera.estado !== "abierta") throw resultadoAError({ resultado: "no_abierta" });
    if (sede.estado !== "enviada") throw resultadoAError({ resultado: "sede_no_enviada" });

    const transicion = transicionSede(sede.estado, "anulacion_confirmada");
    await anularEnvio(sede.recepcion_id, { por, motivo });
    const rpc = await escribirTransicion(sede, transicion);
    if (rpc?.resultado === "version_cambiada" || rpc?.resultado === "no_encontrada") return rpc;
    if (rpc?.resultado !== "ok") throw resultadoAError(rpc);
    return respuestaSede("ok", sede, { estado: rpc.estado, sede_version: rpc.sede_version });
  });

  exigirResultado(respuesta);
  if (respuesta.resultado === "ok") {
    log.info?.(`Sede ${sedeId}: anulación en SIESA confirmada por ${por ?? "—"}${motivo ? ` (${motivo})` : ""}.`);
  }
  return respuesta;
}

/**
 * El admin descarta el aviso `requiere_correccion` de una sede (decisión humana: lo enviado se
 * queda como está). Siempre limpia la bandera, sin importar con qué montos salió la CEA.
 *
 * La RPC no tiene columna de auditoría para el motivo (041 no cambia el esquema): queda en el log
 * junto con quién lo descartó.
 */
export async function descartarCorreccion(sedeId, { por = null, motivo = null } = {}, opciones = {}) {
  const log = opciones.log ?? console;

  const respuesta = await conReintentoVersion(async () => {
    const sede = await leerSede(sedeId);
    let transicion;
    try {
      transicion = transicionSede(sede.estado, "correccion_descartada", { requiereCorreccion: sede.requiere_correccion === true });
    } catch {
      throw resultadoAError({ resultado: "sin_correccion" });
    }
    const rpc = await escribirTransicion(sede, transicion);
    if (rpc?.resultado === "version_cambiada" || rpc?.resultado === "no_encontrada") return rpc;
    if (rpc?.resultado !== "ok") throw resultadoAError(rpc);
    return respuestaSede("ok", sede, { estado: rpc.estado, sede_version: rpc.sede_version });
  });

  exigirResultado(respuesta);
  log.info?.(`Sede ${sedeId}: corrección descartada por ${por ?? "—"}${motivo ? ` (${motivo})` : ""}.`);
  return respuesta;
}
