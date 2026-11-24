/**
 * Plan de una corrida sobre las sedes de una preliquidación (`planearEnvios`).
 *
 * Puro: recibe las filas ya leídas y devuelve qué hacer con cada sede. No escribe,
 * no consulta SIESA. Es una instantánea: tras ejecutar `porCorregir` y `porReevaluar`
 * (que devuelven sedes a `vinculada`) el llamador vuelve a planear.
 *
 * Buckets (todos arreglos de filas de sede, salvo `porEnviar` y `pendientes`):
 *   porCorregir     bloqueada(servicio_cero) con la preliquidación ya liquidada -> evento `corregida`
 *   porReevaluar    bloqueada(costeo_invalido; armado_invalido solo con origen admin) aún no reevaluada en esta corrida
 *   porAgotar       enviando abandonado con intentos agotados (origen automático) -> evento `abandono_agotado`
 *   porCalcular     sedes que requieren congelar (costeo) antes de cualquier envío
 *   porEnviar       [{sede, resetIntentos, requiereCosteo}] sedes reclamables (puedeReclamar);
 *                   `requiereCosteo` = solo se reclaman después de congelar con éxito (T2)
 *   porSimular      con SIESA apagado, las que irían a `porEnviar` desde `calculada` (R10)
 *   bloqueadas, listasParaEnviar, enCurso   informativos
 *   noReclamables   [{sede, motivo}] sedes que el admin pidió enviar y no pueden salir (M5: siesa_apagado)
 *   pendientes      cantidad de sedes accionables AHORA por este origen y corrida
 */
import { costeoVigente, enviandoAbandonado, puedeReclamar, transicionSede } from "./preliquidacionEstados.js";

const ORIGENES = ["schedule", "sweep", "dispatch", "inmediato", "admin"];
const ESTADOS_RECOSTEABLES_ADMIN = ["calculada", "lista_para_enviar", "error", "simulada"];
const ESTADOS_RECOSTEABLES_AUTOMATICO = ["calculada", "lista_para_enviar", "simulada"];
const ESTADOS_SOLO_ADMIN = ["lista_para_enviar", "error", "simulada"];
const ESTADOS_RECLAMABLES = ["vinculada", "calculada", "simulada", "lista_para_enviar", "error", "enviando"];

const LIMITE_INTENTOS_AUTOMATICOS = 3;

const porId = (a, b) => a.id - b.id;

/** Sede tal como quedaría tras un costeo exitoso, o null si el costeo no es posible desde su estado. */
function proyectarTrasCosteo(sede, { header, origen, ahora, abandonoS }) {
  let destino;
  try {
    destino = transicionSede(sede.estado, "costeo_ok", {
      origen,
      siesaActivo: true,
      motivoBloqueo: sede.motivo_bloqueo,
      liberada: sede.liberada_at != null,
      errorTipo: sede.error_tipo,
      intentos: sede.intentos,
      abandonado: enviandoAbandonado(sede, ahora, abandonoS),
      envioId: sede.envio_id,
    });
  } catch {
    return null;
  }
  return {
    ...sede,
    estado: destino.estado,
    gasto_sede: sede.gasto_sede ?? "0",
    costeo_orden_version: header.orden_version,
    costeo_animales: sede.animales,
  };
}

function debeCostearse(sede, { header, esAdmin, corridaId, ahora, abandonoS }) {
  if (sede.estado === "vinculada") return header.liquidada_at != null;
  if (sede.estado === "bloqueada") {
    // M6: una liberada espera a que la preliquidación se liquide; antes no hay monto que calcular
    // y el flujo de la corrida giraría sobre ella sin poder avanzar.
    return sede.motivo_bloqueo === "excede_animales" && sede.liberada_at != null && header.liquidada_at != null;
  }
  if (esAdmin && ESTADOS_RECOSTEABLES_ADMIN.includes(sede.estado)) return true;
  if (costeoVigente(sede, header)) return false;
  if (ESTADOS_RECOSTEABLES_AUTOMATICO.includes(sede.estado)) return true;
  // M1: sedes que de otro modo quedarían varadas cuando el costeo se vuelve obsoleto.
  if (sede.estado === "error") return errorRecosteable(sede, corridaId);
  return enviandoAbandonado(sede, ahora, abandonoS);
}

/** error transitorio con intentos pendientes y no intentado en esta corrida. */
function errorRecosteable(sede, corridaId) {
  return (
    sede.error_tipo === "transitorio" &&
    Number(sede.intentos ?? 0) < LIMITE_INTENTOS_AUTOMATICOS &&
    !(sede.ultima_corrida != null && sede.ultima_corrida === corridaId)
  );
}

/**
 * @param {object[]} sedes filas de `carnes_preliquidacion_sedes`
 * @param {{header: object, origen: string, corrida: {id: number, resumen?: {reevaluadas?: number[]}},
 *          siesaActivo: boolean, ahora: Date}} ctx
 */
export function planearEnvios(sedes, { header, origen, corrida, siesaActivo, ahora, abandonoS } = {}) {
  if (!header) throw new Error("planearEnvios requiere header");
  if (!corrida || corrida.id == null) throw new Error("planearEnvios requiere corrida con id");
  if (!ORIGENES.includes(origen)) throw new Error(`origen desconocido: ${String(origen)}`);
  const esAdmin = origen === "admin";
  const liquidada = header.liquidada_at != null;
  const reevaluadas = new Set(corrida.resumen?.reevaluadas ?? []);
  const ctxReclamar = { header, origen, corridaId: corrida.id, siesaActivo: true, ahora, abandonoS };

  const porCorregir = [];
  const porReevaluar = [];
  const porCalcular = [];
  const porAgotar = [];
  const porEnviar = [];
  const porSimular = [];
  const bloqueadas = [];
  const listasParaEnviar = [];
  const enCurso = [];
  const noReclamables = [];

  for (const sede of [...sedes].sort(porId)) {
    if (sede.estado === "bloqueada") bloqueadas.push(sede);
    if (sede.estado === "lista_para_enviar") listasParaEnviar.push(sede);

    if (sede.estado === "bloqueada" && sede.motivo_bloqueo === "servicio_cero" && liquidada) porCorregir.push(sede);
    // `armado_invalido` solo lo reevalúa el admin (procesar sede / recalcular): el costeo hipotético
    // ignora el armado, así que en cada barrido automático la desbloquearía, fallaría de nuevo el
    // armado y repetiría el envío con error y el correo al admin cada hora.
    const motivosReevaluables = esAdmin ? ["armado_invalido", "costeo_invalido"] : ["costeo_invalido"];
    if (sede.estado === "bloqueada" && motivosReevaluables.includes(sede.motivo_bloqueo) && !reevaluadas.has(sede.id)) {
      porReevaluar.push(sede);
    }

    // Un `enviando` abandonado sin intentos automáticos restantes se mueve a `error` en vez de reclamarse.
    if (
      !esAdmin &&
      enviandoAbandonado(sede, ahora, abandonoS) &&
      Number(sede.intentos ?? 0) >= LIMITE_INTENTOS_AUTOMATICOS
    ) {
      porAgotar.push(sede);
      continue;
    }

    // M5: con SIESA apagado el admin no obtiene un "Enviar" sin resultado: se informa el motivo.
    if (esAdmin && !siesaActivo && ESTADOS_SOLO_ADMIN.includes(sede.estado)) {
      noReclamables.push({ sede, motivo: "siesa_apagado" });
      continue;
    }

    const recostear = debeCostearse(sede, { header, esAdmin, corridaId: corrida.id, ahora, abandonoS });
    if (recostear) porCalcular.push(sede);

    // Reclamo: sobre el costeo vigente, o sobre el que resultará de congelar (T2).
    if (!ESTADOS_RECLAMABLES.includes(sede.estado)) continue;
    const candidata = recostear ? proyectarTrasCosteo(sede, { header, origen, ahora, abandonoS }) : sede;
    if (!candidata) continue;
    const decision = puedeReclamar(candidata, ctxReclamar);
    if (decision.ok) {
      // El reinicio de intentos depende del estado de origen: el recosteo de un error o una
      // simulada los deja en `calculada`, pero el admin los reclama igualmente como tales.
      const resetIntentos = decision.resetIntentos || (esAdmin && ESTADOS_SOLO_ADMIN.includes(sede.estado));
      const item = { sede, resetIntentos, requiereCosteo: recostear };
      if (!siesaActivo && candidata.estado === "calculada") porSimular.push(sede);
      else if (siesaActivo) porEnviar.push(item);
    } else if (sede.estado === "enviando") {
      enCurso.push(sede);
    }
  }

  const accionables = new Map();
  const marcar = (lista) => lista.forEach((s) => accionables.set(s.id, s));
  marcar(porCorregir);
  marcar(porReevaluar);
  marcar(porAgotar);
  marcar(porCalcular);
  marcar(porSimular);
  for (const { sede } of porEnviar) {
    // La inicial pendiente se vuelve a comprobar en cada corrida, pero no cuenta como trabajo
    // pendiente para los orígenes automáticos: no hay nada que hacer hasta que la inicial salga.
    if (!esAdmin && sede.motivo_pendiente === "inicial_pendiente") continue;
    accionables.set(sede.id, sede);
  }

  return {
    porCorregir,
    porReevaluar,
    porCalcular,
    porAgotar,
    porEnviar,
    porSimular,
    bloqueadas,
    listasParaEnviar,
    enCurso,
    noReclamables,
    pendientes: accionables.size,
  };
}
