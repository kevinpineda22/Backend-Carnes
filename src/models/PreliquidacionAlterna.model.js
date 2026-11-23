import { supabase } from "../config/supabase.js";
import { encolarAlerta } from "../services/preliquidacionAlertas.js";
import { compararAlterna, requiereAlternaTardia } from "../shared/preliquidacionAlterna.js";
import { planearSaldo } from "../shared/preliquidacionSaldo.js";

/**
 * Servicio tardío: liquidación alterna informativa y saldo pendiente.
 *
 * Lee, decide con las funciones puras (`compararAlterna`, `planearSaldo`) y escribe por
 * `carnes_preliq_registrar_alterna`, que es idempotente por (preliquidación, servicio_at).
 * NUNCA envía nada a SIESA: este módulo no conoce el envío. Tampoco importa
 * `Preliquidacion.model.js`, para que éste pueda usarlo sin ciclo de importación.
 */

const T_PRELIQ = "carnes_preliquidaciones";
const T_SEDES = "carnes_preliquidacion_sedes";
const T_SALDOS = "carnes_preliquidacion_saldos";
const T_ALTERNAS = "carnes_preliquidacion_alternas";
const MAX_INTENTOS_VERSION = 3;

/** Aviso que ve el admin cuando carga el servicio con la preliquidación ya liquidada (REQ-E1). */
export const AVISO_SERVICIO_TARDIO = Object.freeze({
  codigo: "servicio_tardio",
  mensaje:
    "El servicio se cargó después de la liquidación: no se envió nada a SIESA. " +
    "Se generó la liquidación alterna informativa y el saldo pendiente para la siguiente preliquidación.",
});

/** Variante cuando todavía no hay liquidación: la alterna sale cuando se liquide. */
export const AVISO_SERVICIO_TARDIO_SIN_LIQUIDAR = Object.freeze({
  codigo: "servicio_tardio",
  mensaje:
    "El servicio se cargó después del corte: la liquidación usará el servicio anterior. " +
    "La diferencia se mostrará como liquidación alterna informativa cuando se liquide.",
});

/** Variante cuando el servicio tardío destrabó una preliquidación con servicio en cero. */
export const AVISO_SERVICIO_DESBLOQUEO = Object.freeze({
  codigo: "servicio_tardio",
  mensaje:
    "El servicio se cargó después del corte, pero la preliquidación estaba bloqueada por servicio en cero: " +
    "se aplicará como servicio de la primera liquidación y no genera liquidación alterna.",
});

async function leerDb(id) {
  const { data: cabecera, error } = await supabase.from(T_PRELIQ).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer la preliquidación: ${error.message}`);
  if (!cabecera) return { cabecera: null };

  const [sedes, saldos, abiertas, alterna] = await Promise.all([
    supabase.from(T_SEDES).select("*").eq("preliquidacion_id", id).order("orden"),
    supabase.from(T_SALDOS).select("*").eq("origen_preliquidacion_id", id),
    supabase.from(T_PRELIQ).select("id, especie, estado, liquidada_at, created_at").eq("especie", cabecera.especie).eq("estado", "abierta"),
    cabecera.servicio_at
      ? supabase.from(T_ALTERNAS).select("id").eq("preliquidacion_id", id).eq("servicio_at", cabecera.servicio_at).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  for (const [nombre, r] of [["las sedes", sedes], ["los saldos", saldos], ["las preliquidaciones abiertas", abiertas], ["la alterna", alterna]]) {
    if (r.error) throw new Error(`Error al leer ${nombre}: ${r.error.message}`);
  }
  return { cabecera, sedes: sedes.data || [], saldos: saldos.data || [], abiertas: abiertas.data || [], alterna: alterna.data ?? null };
}

async function rpcDb(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args);
  if (error) throw new Error(`Error en ${nombre}: ${error.message}`);
  return data;
}

/** `planearSaldo` -> el `p_saldo_plan` de `carnes_preliq_registrar_alterna`. */
function aPlanSaldo(plan, por) {
  if (plan.accion === "actualizar_pendiente") {
    return { accion: plan.accion, saldo_id: plan.saldoId, valor: plan.valor, descartar: plan.descartar, por };
  }
  if (plan.accion === "crear_ajuste") {
    return {
      accion: plan.accion,
      valor: plan.valor,
      ajuste_de_saldo_id: plan.ajusteDeSaldoId,
      destino_preliquidacion_id: plan.destinoId,
      por,
    };
  }
  return { accion: "nada" };
}

/**
 * Compara el servicio real vigente de la preliquidación contra el aplicado y registra la
 * alterna y su saldo. Idempotente: si ya existe la alterna de ese `servicio_at` no hace nada.
 * Relee y reintenta (máx. 3) si cambió el estado de los saldos.
 *
 * @returns {Promise<{resultado: string, alterna?: object, alterna_id?: *}>}
 *   ok | ya_registrada | sin_diferencia | sin_servicio | no_liquidada | no_encontrada | version_cambiada | <código de la RPC>
 */
export async function registrarAlterna(id, { por = null, leer = leerDb, rpc = rpcDb, encolar = encolarAlerta, log = console } = {}) {
  let ultimo = { resultado: "version_cambiada" };
  for (let intento = 0; intento < MAX_INTENTOS_VERSION; intento += 1) {
    const { cabecera, sedes = [], saldos = [], abiertas = [], alterna = null } = await leer(id);
    if (!cabecera) return { resultado: "no_encontrada" };
    if (!cabecera.liquidada_at) return { resultado: "no_liquidada" };
    if (cabecera.servicio == null || cabecera.servicio_at == null) return { resultado: "sin_servicio" };
    if (alterna) return { resultado: "ya_registrada", alterna_id: alterna.id };

    const comparacion = compararAlterna({
      sedesCalculadas: sedes,
      servicioReal: cabecera.servicio,
      servicioAplicado: cabecera.servicio_aplicado,
      animales: Number(cabecera.animales),
    });
    if (!comparacion.hayAlterna) return { resultado: "sin_diferencia" };

    const planSaldo = planearSaldo({
      diferencia: comparacion.plan.diferencia,
      saldosOrigen: saldos,
      origenId: cabecera.id,
      especie: cabecera.especie,
      abiertas,
    });
    const respuesta = await rpc("carnes_preliq_registrar_alterna", {
      p_id: id,
      p_servicio: comparacion.plan.servicio_real,
      p_servicio_at: cabecera.servicio_at,
      p_por_sede: comparacion.plan.por_sede,
      p_diferencia: comparacion.plan.diferencia,
      p_saldo_plan: aPlanSaldo(planSaldo, por),
    });

    if (respuesta?.resultado === "version_cambiada") {
      ultimo = respuesta;
      continue;
    }
    if (respuesta?.resultado !== "ok") return { ...respuesta, resultado: respuesta?.resultado ?? "error" };

    // Aviso (deduplicado por alterna): una falla del correo no deshace la alterna.
    try {
      await encolar(
        {
          evento: "servicio_tardio",
          preliquidacionId: id,
          sedeId: 0,
          ocurrencia: respuesta.alterna_id,
          detalle: {
            especie: cabecera.especie,
            servicio_real: comparacion.plan.servicio_real,
            servicio_aplicado: comparacion.plan.servicio_aplicado,
            diferencia: comparacion.plan.diferencia,
            no_asignada: comparacion.plan.no_asignada,
            por_sede: comparacion.plan.por_sede,
          },
        },
        { log },
      );
    } catch (error) {
      log.error?.(`No se pudo encolar la alerta servicio_tardio de la preliquidación ${id}: ${error?.message}`);
    }

    return {
      resultado: "ok",
      alterna: {
        id: respuesta.alterna_id,
        servicio_real: comparacion.plan.servicio_real,
        servicio_aplicado: comparacion.plan.servicio_aplicado,
        diferencia: comparacion.plan.diferencia,
        no_asignada: comparacion.plan.no_asignada,
        por_sede: comparacion.plan.por_sede,
        saldo: { accion: planSaldo.accion, id: respuesta.saldo_id ?? null },
      },
    };
  }
  return ultimo;
}

/**
 * Revisión por corrida (R6): si el servicio tardío quedó sin alterna (cargado antes de liquidar
 * o con un registro que falló), la genera ahora. No hace nada si no hay alterna pendiente.
 * NUNCA lanza: una falla aquí no puede detener una corrida ni un envío.
 *
 * @param {object} cabecera fila de `carnes_preliquidaciones`
 * @returns {Promise<object|null>} `null` si no había nada que registrar
 */
export async function registrarAlternaTardia(cabecera, opciones = {}) {
  const { log = console } = opciones;
  try {
    const pendiente = requiereAlternaTardia({
      servicio: cabecera.servicio,
      servicioAt: cabecera.servicio_at,
      servicioAplicado: cabecera.servicio_aplicado,
      fechaPrimerIngreso: cabecera.fecha_primer_ingreso,
      liquidadaAt: cabecera.liquidada_at,
    });
    if (!pendiente) return null;
    return await registrarAlterna(cabecera.id, opciones);
  } catch (error) {
    log.error?.(`La alterna tardía de la preliquidación ${cabecera?.id} falló: ${error?.message}`);
    return { resultado: "error", error: error?.message };
  }
}
