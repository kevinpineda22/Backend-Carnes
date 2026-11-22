import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import {
  aCentavos,
  centavosATexto,
  costearSede,
  desbloqueaServicioCero,
  gastoTotal,
  montoSedes,
} from "../shared/preliquidacionCosteo.js";
import { valorRetomasSedes, valorVicerasSede } from "../shared/preliquidacionFuentes.js";
import { randomUUID } from "node:crypto";
import { siesaActivo } from "../config/siesa.js";
import { encolarAlerta } from "../services/preliquidacionAlertas.js";
import { costeoVigente, mapearEnvio, puedeReclamar, transicionSede } from "../shared/preliquidacionEstados.js";
import { planearEnvios } from "../shared/preliquidacionPlan.js";
import { corteBogota, debeLiquidar } from "../shared/preliquidacionTiempo.js";
import {
  elegirPreliquidacion,
  planearDesvinculacion,
  planearVentana,
  planearVinculacion,
} from "../shared/preliquidacionVinculacion.js";

/**
 * Modelo de la preliquidación de talleres.
 *
 * Las decisiones (a quién se vincula, cuánto toca a cada sede, qué se bloquea) las
 * toman las funciones puras de `src/shared/preliquidacion*.js`. Aquí solo se LEE,
 * se arma el plan que esas funciones devuelven con el contrato de sql/039 y se
 * llama a la RPC, que bloquea las filas, valida las versiones leídas y escribe.
 * Si la versión cambió (`version_cambiada`) se vuelve a leer y recalcular, hasta
 * 3 intentos.
 */

const T_PRELIQ = "carnes_preliquidaciones";
const T_SEDES = "carnes_preliquidacion_sedes";
const T_GASTOS = "carnes_preliquidacion_gastos";
const T_SALDOS = "carnes_preliquidacion_saldos";
const T_RETOMAS = "carnes_preliquidacion_retomas";
const T_CONFIG = "carnes_preliquidacion_config";
const T_RECEPCIONES = "carnes_recepciones";
const T_ITEMS = "carnes_recepcion_items";

const ESPECIES = ["res", "cerdo"];
const MAX_INTENTOS_VERSION = 3;
const VENTANA_DIAS = 2;

// ─── Código de resultado de la RPC -> error HTTP ───────────────────────────

/** Resultados que no son error (el primero es el caso normal; `excede` y `tardio` son avisos). */
const RESULTADOS_OK = new Set(["ok", "vinculada", "excede", "tardio"]);

/** Resultado de negocio -> [HTTP, mensaje]. Los mensajes llegan al navegador. */
const ERRORES_RESULTADO = {
  abierta_en_curso: [409, "Ya hay una preliquidación abierta en curso para esta especie."],
  config_servicio_cero: [409, "Configure el servicio por animal de la especie antes de crear la preliquidación."],
  version_cambiada: [409, "Los datos cambiaron mientras se procesaba. Recargue e intente de nuevo."],
  ya_vinculada: [409, "La recepción ya está vinculada a una preliquidación."],
  oficial_legacy: [409, "La recepción ya está en una liquidación o tiene un envío oficial vigente en SIESA."],
  sede_enviada: [409, "La sede ya se envió a SIESA y no se puede desvincular."],
  sede_no_editable: [409, "La sede ya no admite cambios en sus animales."],
  ya_liquidada: [409, "La preliquidación ya fue liquidada."],
  no_liberada: [409, "La sede excede los animales de la preliquidación y no se ha liberado."],
  desde_invalido: [409, "La sede cambió de estado y la operación ya no aplica."],
  no_liquidable: [409, "La preliquidación no se puede liquidar en su estado actual."],
  no_vinculada: [409, "La recepción no está vinculada a una preliquidación."],
  sin_preliquidacion: [409, "No hay una preliquidación abierta para esta especie."],
  fuera_ventana: [422, "La fecha de ingreso queda fuera de la ventana de la preliquidación."],
  excede_capacidad: [409, "Con esos animales la sede supera los de la preliquidación."],
  novillos_invalido: [422, "Los novillos o canales deben ser un entero mayor que cero."],
  invalido: [422, "Los datos enviados no son válidos."],
  datos_invalidos: [422, "Los datos enviados no son válidos."],
  servicio_invalido: [422, "El servicio debe ser un valor mayor o igual que cero."],
  recepcion_estado_invalido: [422, "El estado de recepción indicado no es válido."],
  no_reclamada: [409, "La sede cambió de estado y otra corrida la tomó o ya no aplica."],
  costeo_desactualizado: [409, "Los montos de la sede están desactualizados: hay que recalcularlos."],
  inicial_pendiente: [409, "La CEA inicial de la recepción aún no está enviada a SIESA."],
  token_invalido: [409, "El envío de la sede fue tomado por otra instancia."],
  siesa_apagado: [409, "El envío a SIESA está apagado."],
  no_abierta: [409, "La preliquidación no está abierta."],
  no_liquidada: [409, "La preliquidación aún no se ha liquidado."],
  no_encontrada: [404, "No se encontró el registro."],
  sin_recepcion: [404, "Recepción no encontrada."],
};

/**
 * Convierte la respuesta de una RPC en un error HTTP, o `null` si fue exitosa.
 * Un código que no se conoce es un 500 sin `expose`: no se le muestra al cliente.
 */
export function resultadoAError(respuesta) {
  const codigo = respuesta?.resultado;
  if (codigo && RESULTADOS_OK.has(codigo)) return null;
  const conocido = codigo ? ERRORES_RESULTADO[codigo] : null;
  if (!conocido) {
    const inesperado = new Error(`Respuesta inesperada de la base: ${JSON.stringify(respuesta)}`);
    inesperado.statusCode = 500;
    return inesperado;
  }
  const [estado, mensaje] = conocido;
  const error = createError(estado, mensaje, codigo);
  if (respuesta.motivo) error.motivo = respuesta.motivo;
  if (respuesta.detalle) error.detalle = respuesta.detalle;
  return error;
}

/** `resultadoAError` y lanza. Devuelve la respuesta si fue exitosa. */
function exigirOk(respuesta) {
  const error = resultadoAError(respuesta);
  if (error) throw error;
  return respuesta;
}

/**
 * Ejecuta `fn(intento)` (leer -> calcular -> RPC) hasta 3 veces mientras la RPC
 * responda `version_cambiada`. Cualquier otro resultado se devuelve tal cual.
 */
export async function conReintentoVersion(fn, { max = MAX_INTENTOS_VERSION } = {}) {
  for (let intento = 0; intento < max; intento += 1) {
    const respuesta = await fn(intento);
    if (respuesta?.resultado !== "version_cambiada") return respuesta;
  }
  throw resultadoAError({ resultado: "version_cambiada" });
}

async function llamarRpc(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args);
  if (error) throw new Error(`Error en ${nombre}: ${error.message}`);
  return data;
}

// ─── Lectura ───────────────────────────────────────────────────────────────

const noEncontrada = () => createError(404, "Preliquidación no encontrada.", "no_encontrada");

async function leerCabecera(id) {
  const { data, error } = await supabase.from(T_PRELIQ).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer la preliquidación: ${error.message}`);
  if (!data) throw noEncontrada();
  return data;
}

async function leerLista(tabla, filtros, { orden = "id" } = {}) {
  let q = supabase.from(tabla).select("*");
  for (const [columna, valor] of Object.entries(filtros)) q = q.eq(columna, valor);
  const { data, error } = await q.order(orden);
  if (error) throw new Error(`Error al leer ${tabla}: ${error.message}`);
  return data || [];
}

async function leerRecepciones(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from(T_RECEPCIONES).select("*").in("id", ids);
  if (error) throw new Error(`Error al leer las recepciones: ${error.message}`);
  return data || [];
}

/** Sedes de la preliquidación con los datos de su recepción que usa el plan. */
async function leerSedesConRecepcion(preliquidacionId) {
  const sedes = await leerLista(T_SEDES, { preliquidacion_id: preliquidacionId }, { orden: "orden" });
  const recepciones = await leerRecepciones(sedes.map((s) => s.recepcion_id));
  const porId = new Map(recepciones.map((r) => [String(r.id), r]));
  return sedes.map((s) => ({ ...s, recepcion: porId.get(String(s.recepcion_id)) || null }));
}

/** Fila de sede -> la forma que esperan `planearVinculacion` y `planearDesvinculacion`. */
function aSedePlan(s) {
  return {
    recepcionId: s.recepcion_id,
    animales: Number(s.animales),
    orden: s.orden,
    estado: s.estado,
    motivoBloqueo: s.motivo_bloqueo,
    liberadaAt: s.liberada_at,
    fechaIngreso: s.recepcion?.fecha_ingreso ?? null,
    recibidoAt: s.recepcion?.recibido_at ?? null,
  };
}

const particionar = (sedes) => ({
  sedesFijas: sedes.filter((s) => s.estado !== "vinculada"),
  sedesVinculadas: sedes.filter((s) => s.estado === "vinculada"),
});

/** `reordenar` solo con las vinculadas cuyo slot cambió (la RPC rechaza mover otras). */
function reordenarCambiadas(orden, sedesVinculadas, excluirRecepcionId = null) {
  const actual = new Map(sedesVinculadas.map((s) => [String(s.recepcionId), s.orden]));
  return orden
    .filter((o) => String(o.recepcionId) !== String(excluirRecepcionId))
    .filter((o) => actual.has(String(o.recepcionId)) && actual.get(String(o.recepcionId)) !== o.orden)
    .map((o) => ({ recepcion_id: o.recepcionId, orden: o.orden }));
}

const esEnteroPositivo = (n) => typeof n === "number" && Number.isInteger(n) && n > 0;

// ─── Constructores de plan (contrato de sql/039) ───────────────────────────

/**
 * Plan de `carnes_preliq_vincular`. Puro.
 *
 * @param {{cabecera: object, recepcion: {id, fechaIngreso: string, recibidoAt: *, animales: number},
 *   sedes: Array<object>}} p `sedes` ya en la forma de `aSedePlan`
 * @returns {{ok: true, plan: object, ordenVersion: number} | {ok: false, resultado: string}}
 */
export function armarPlanVincular({ cabecera, recepcion, sedes }) {
  if (!esEnteroPositivo(recepcion.animales)) return { ok: false, resultado: "novillos_invalido" };

  const ventana = planearVentana({
    fechaPrimerIngreso: cabecera.fecha_primer_ingreso,
    liquidadaAt: cabecera.liquidada_at,
    fechaIngreso: recepcion.fechaIngreso,
    dias: VENTANA_DIAS,
  });

  const { sedesFijas, sedesVinculadas } = particionar(sedes);
  const plan = planearVinculacion({
    animales: Number(cabecera.animales),
    sedesFijas,
    sedesVinculadas,
    candidata: {
      recepcionId: recepcion.id,
      animales: recepcion.animales,
      fechaIngreso: recepcion.fechaIngreso,
      recibidoAt: recepcion.recibidoAt,
    },
  });

  const ordenCandidata = plan.orden.find((o) => String(o.recepcionId) === String(recepcion.id)).orden;
  const excede = plan.candidata === "excede";
  const candidata = { animales: recepcion.animales, orden: ordenCandidata, estado: excede ? "bloqueada" : "vinculada" };
  if (excede) candidata.motivo_bloqueo = "excede_animales";

  return {
    ok: true,
    ordenVersion: cabecera.orden_version,
    plan: {
      fecha_primer_ingreso: ventana.fechaPrimerIngreso,
      ventana_fin: ventana.ventanaFin.toISOString(),
      mueve_fecha: ventana.cambia,
      candidata,
      reordenar: reordenarCambiadas(plan.orden, sedesVinculadas, recepcion.id),
      excede: plan.excede.filter((id) => String(id) !== String(recepcion.id)),
      liberadas: plan.liberadas,
      restantes: plan.restantes,
    },
  };
}

/** Plan de `carnes_preliq_desvincular` (M4: incluye `liberadas`). Puro. */
export function armarPlanDesvincular({ cabecera, sedes, recepcionId }) {
  const { sedesFijas, sedesVinculadas } = particionar(sedes);
  const plan = planearDesvinculacion({
    animales: Number(cabecera.animales),
    sedesFijas,
    sedesVinculadas,
    recepcionId,
  });
  if (!plan.ok) return { ok: false, resultado: plan.motivo };
  return {
    ok: true,
    ordenVersion: cabecera.orden_version,
    plan: {
      reordenar: reordenarCambiadas(plan.orden, sedesVinculadas),
      liberadas: plan.liberadas,
      restantes: plan.restantes,
    },
  };
}

/** Plan de `carnes_preliq_actualizar_novillos`: la sede se reubica con los animales nuevos. Puro. */
export function armarPlanNovillos({ cabecera, sedes, recepcionId, animales }) {
  if (!esEnteroPositivo(animales)) return { ok: false, resultado: "novillos_invalido" };
  const conCambio = sedes.map((s) => (String(s.recepcionId) === String(recepcionId) ? { ...s, animales } : s));
  const { sedesFijas, sedesVinculadas } = particionar(conCambio);
  const plan = planearVinculacion({ animales: Number(cabecera.animales), sedesFijas, sedesVinculadas });
  // Una sede ya costeada (fija) consume siempre: si con los animales nuevos el lote
  // se pasa, no hay a quién desbordar; se rechaza en vez de dejar capacidad negativa.
  if (plan.restantes < 0) return { ok: false, resultado: "excede_capacidad" };
  return {
    ok: true,
    ordenVersion: cabecera.orden_version,
    plan: {
      reordenar: reordenarCambiadas(plan.orden, sedesVinculadas),
      excede: plan.excede,
      liberadas: plan.liberadas,
      restantes: plan.restantes,
    },
  };
}

// ─── Operaciones de vinculación ────────────────────────────────────────────

async function leerRecepcion(id) {
  const [recepcion] = await leerRecepciones([id]);
  if (!recepcion) throw createError(404, "Recepción no encontrada.", "sin_recepcion");
  return recepcion;
}

/**
 * Vincula una recepción de taller a la preliquidación que le corresponde (o a la
 * indicada). Lee, planea y llama a `carnes_preliq_vincular`; relee si la versión cambió.
 */
export async function vincularRecepcion(recepcionId, { preliquidacionId = null } = {}) {
  const recepcion = await leerRecepcion(recepcionId);
  if (recepcion.preliquidacion_id) throw resultadoAError({ resultado: "ya_vinculada" });

  return conReintentoVersion(async () => {
    let destino = preliquidacionId;
    if (!destino) {
      const abiertas = (await leerLista(T_PRELIQ, { especie: recepcion.especie, estado: "abierta" })) || [];
      const elegida = elegirPreliquidacion({
        abiertas,
        especie: recepcion.especie,
        fechaIngreso: recepcion.fecha_ingreso,
      });
      if (!elegida.ok) throw resultadoAError({ resultado: elegida.motivo });
      destino = elegida.preliquidacionId;
    }

    const cabecera = await leerCabecera(destino);
    const sedes = (await leerSedesConRecepcion(destino)).map(aSedePlan);
    const armado = armarPlanVincular({
      cabecera,
      recepcion: {
        id: recepcion.id,
        fechaIngreso: recepcion.fecha_ingreso,
        recibidoAt: recepcion.recibido_at,
        animales: Number(recepcion.novillos),
      },
      sedes,
    });
    if (!armado.ok) throw resultadoAError({ resultado: armado.resultado });

    const respuesta = await llamarRpc("carnes_preliq_vincular", {
      p_recepcion_id: recepcion.id,
      p_preliquidacion_id: destino,
      p_orden_version: armado.ordenVersion,
      p_plan: armado.plan,
    });
    return respuesta?.resultado === "version_cambiada" ? respuesta : exigirOk(respuesta);
  });
}

/** Desvincula una sede que nunca se envió. Las sedes de desborde que ahora caben salen en `liberadas`. */
export async function desvincularSede(sedeId, { preliquidacionId = null } = {}) {
  return conReintentoVersion(async () => {
    const [sede] = await leerLista(T_SEDES, { id: sedeId });
    // Una sede que no es de la preliquidación de la URL se trata como inexistente.
    if (!sede || (preliquidacionId && String(sede.preliquidacion_id) !== String(preliquidacionId))) {
      throw resultadoAError({ resultado: "no_encontrada" });
    }

    const cabecera = await leerCabecera(sede.preliquidacion_id);
    const sedes = (await leerSedesConRecepcion(sede.preliquidacion_id)).map(aSedePlan);
    const armado = armarPlanDesvincular({ cabecera, sedes, recepcionId: sede.recepcion_id });
    if (!armado.ok) throw resultadoAError({ resultado: armado.resultado });

    const respuesta = await llamarRpc("carnes_preliq_desvincular", {
      p_sede_id: sede.id,
      p_orden_version: armado.ordenVersion,
      p_plan: armado.plan,
    });
    return respuesta?.resultado === "version_cambiada" ? respuesta : exigirOk(respuesta);
  });
}

/** Cambia los novillos de una recepción vinculada pasando por la RPC (la sede se reubica). */
export async function actualizarNovillos(recepcionId, novillos) {
  const animales = typeof novillos === "number" ? novillos : Number(novillos);
  if (!esEnteroPositivo(animales)) throw resultadoAError({ resultado: "novillos_invalido" });

  return conReintentoVersion(async () => {
    const recepcion = await leerRecepcion(recepcionId);
    if (!recepcion.preliquidacion_id) throw resultadoAError({ resultado: "no_vinculada" });

    const cabecera = await leerCabecera(recepcion.preliquidacion_id);
    const sedes = (await leerSedesConRecepcion(recepcion.preliquidacion_id)).map(aSedePlan);
    const armado = armarPlanNovillos({ cabecera, sedes, recepcionId, animales });
    if (!armado.ok) throw resultadoAError({ resultado: armado.resultado });

    const respuesta = await llamarRpc("carnes_preliq_actualizar_novillos", {
      p_recepcion_id: recepcionId,
      p_novillos: animales,
      p_orden_version: armado.ordenVersion,
      p_plan: armado.plan,
    });
    return respuesta?.resultado === "version_cambiada" ? respuesta : exigirOk(respuesta);
  });
}

// ─── CRUD de cabecera ──────────────────────────────────────────────────────

export async function listar({ especie, estado } = {}) {
  const filtros = {};
  if (especie) filtros.especie = especie;
  if (estado) filtros.estado = estado;
  return leerLista(T_PRELIQ, filtros);
}

// `obtener` va más abajo, junto al cálculo que comparte con `previsualizar`.

/** Crea la cabecera con `carnes_preliq_crear` y devuelve la preliquidación completa. */
export async function crear(especie, datos = {}, { por = null } = {}) {
  if (!ESPECIES.includes(especie)) throw createError(400, "La especie debe ser res o cerdo.");
  const pDatos = {
    animales: datos.animales,
    animal_en_pie: datos.animal_en_pie ?? 0,
    tercero_id: datos.tercero_id ?? "frigorifico",
    creado_por: por,
  };
  if (datos.servicio !== undefined && datos.servicio !== null) {
    pDatos.servicio = datos.servicio;
    // Sin primer ingreso aún no hay corte: el servicio inicial vale como precorte.
    pDatos.servicio_precorte = datos.servicio;
  }
  const respuesta = exigirOk(await llamarRpc("carnes_preliq_crear", { p_especie: especie, p_datos: pDatos }));
  return obtener(respuesta.preliquidacion_id);
}

const CAMPOS_ANTES_DE_CONGELAR = ["animales", "animal_en_pie", "servicio_por_animal", "tercero_id"];

const congelada = () =>
  createError(
    409,
    "La preliquidación ya se liquidó: solo se puede cargar el servicio. Use recalcular las sedes no enviadas.",
    "preliquidacion_congelada",
  );

/**
 * Escribe campos de la cabecera con control de versión (CAS sobre `version`) y la
 * sube en uno. `permitirCongelada` es solo para el PATCH de servicio.
 */
export async function actualizarCabeceraConVersion(id, cambios, { alLeer } = {}) {
  for (let intento = 0; intento < MAX_INTENTOS_VERSION; intento += 1) {
    const cabecera = await leerCabecera(id);
    if (cabecera.liquidada_at) throw congelada();
    if (alLeer) await alLeer(cabecera);

    const { data, error } = await supabase
      .from(T_PRELIQ)
      .update({ ...cambios, version: cabecera.version + 1 })
      .eq("id", id)
      .eq("version", cabecera.version)
      .select();
    if (error) throw new Error(`Error al actualizar la preliquidación: ${error.message}`);
    if (data && data.length > 0) return data[0];
  }
  throw resultadoAError({ resultado: "version_cambiada" });
}

/**
 * PATCH de la preliquidación.
 * - Antes de congelar: servicio (RPC, con corte y desbloqueo) y los campos de cabecera.
 * - Congelada: SOLO `servicio` (siempre tardío); lo demás es 409 `preliquidacion_congelada`.
 */
export async function actualizar(id, cambios = {}, { por = null } = {}) {
  const cabecera = await leerCabecera(id);
  const camposCabecera = Object.fromEntries(
    CAMPOS_ANTES_DE_CONGELAR.filter((c) => cambios[c] !== undefined).map((c) => [c, cambios[c]]),
  );
  const hayCampos = Object.keys(camposCabecera).length > 0;
  if (cabecera.liquidada_at && hayCampos) throw congelada();

  if (hayCampos) {
    await actualizarCabeceraConVersion(id, camposCabecera, {
      alLeer: async (leida) => {
        if (camposCabecera.animales === undefined) return;
        const sedes = await leerLista(T_SEDES, { preliquidacion_id: id });
        const consumidas = sedes
          .filter((s) => !(s.estado === "bloqueada" && s.motivo_bloqueo === "excede_animales" && !s.liberada_at))
          .reduce((suma, s) => suma + Number(s.animales), 0);
        if (Number(camposCabecera.animales) < consumidas) {
          throw createError(
            409,
            `La preliquidación ya tiene ${consumidas} animales vinculados; no puede bajar a ${camposCabecera.animales}.`,
            "animales_insuficientes",
          );
        }
        return leida;
      },
    });
  }

  let respuesta = { resultado: "ok" };
  if (cambios.servicio !== undefined && cambios.servicio !== null) {
    respuesta = await conReintentoVersion(async () => {
      const actual = await leerCabecera(id);
      const fecha = actual.fecha_primer_ingreso ?? null;
      const r = await llamarRpc("carnes_preliq_actualizar_servicio", {
        p_id: id,
        p_servicio: cambios.servicio,
        p_por: por,
        p_fecha_primer_ingreso: fecha,
        p_corte: fecha ? corteBogota(fecha).toISOString() : null,
        p_desbloqueo: desbloqueaServicioCero({
          liquidadaAt: actual.liquidada_at,
          servicioPrecorte: actual.servicio_precorte,
          servicioPorAnimal: actual.servicio_por_animal,
        }),
      });
      return r?.resultado === "version_cambiada" ? r : exigirOk(r);
    });
  }

  return { ...respuesta, preliquidacion: await leerCabecera(id) };
}

/** Reemplaza los gastos manuales (solo antes de congelar) y sube la versión al final. */
export async function guardarGastos(id, filas = []) {
  const cabecera = await leerCabecera(id);
  if (cabecera.liquidada_at) throw congelada();

  const anteriores = await leerLista(T_GASTOS, { preliquidacion_id: id });
  if (filas.length) {
    const nuevas = filas.map((f, i) => ({
      preliquidacion_id: id,
      concepto: f.concepto,
      valor: f.valor,
      signo: f.signo ?? 1,
      orden: i,
    }));
    const { error } = await supabase.from(T_GASTOS).insert(nuevas);
    if (error) throw new Error(`Error al guardar los gastos: ${error.message}`);
  }
  if (anteriores.length) {
    const { error } = await supabase
      .from(T_GASTOS)
      .delete()
      .in("id", anteriores.map((g) => g.id));
    if (error) throw new Error(`Error al reemplazar los gastos: ${error.message}`);
  }
  // La versión se sube DESPUÉS de escribir: una liquidación que leyó los gastos
  // viejos (o a medias) lleva la versión vieja y la RPC la rechaza.
  await actualizarCabeceraConVersion(id, {});
  return obtener(id);
}

// ─── Configuración por especie ─────────────────────────────────────────────

function exigirEspecie(especie) {
  if (!ESPECIES.includes(especie)) throw createError(400, "La especie debe ser res o cerdo.");
}

export async function obtenerConfig(especie) {
  exigirEspecie(especie);
  const [fila] = await leerLista(T_CONFIG, { especie }, { orden: "especie" });
  if (!fila) throw createError(404, "No hay configuración para esa especie.", "no_encontrada");
  return fila;
}

/** El servicio por animal predeterminado tiene que ser > 0 (T3). No toca preliquidaciones existentes. */
export async function guardarConfig(especie, { servicio_por_animal: servicio } = {}) {
  exigirEspecie(especie);
  let centavos;
  try {
    centavos = aCentavos(servicio);
  } catch {
    throw createError(422, "El servicio por animal debe ser un valor numérico.", "servicio_invalido");
  }
  if (centavos <= 0n) {
    throw createError(422, "El servicio por animal debe ser mayor que cero.", "servicio_invalido");
  }
  const { error } = await supabase
    .from(T_CONFIG)
    .update({ servicio_por_animal: centavosATexto(centavos) })
    .eq("especie", especie);
  if (error) throw new Error(`Error al guardar la configuración: ${error.message}`);
  return obtenerConfig(especie);
}

// ─── Cálculo (lectura de contexto + funciones puras; no escribe) ───────────

const ES_PRODUCTO = (i) => i.tipo === "carne" || i.tipo === "adicional";
const ESTADOS_CON_MONTO_FIJO = new Set(["enviando", "enviada", "sin_confirmar"]);

/** Un desborde sin liberar no consume animales ni recibe monto. */
const esDesborde = (s) => s.estado === "bloqueada" && s.motivo_bloqueo === "excede_animales" && !s.liberada_at;
const noCosteable = (s) => s.estado === "bloqueada" && !(s.motivo_bloqueo === "excede_animales" && s.liberada_at);

/** Todo lo que el cálculo necesita de la preliquidación, leído una sola vez. */
async function leerContexto(id) {
  const cabecera = await leerCabecera(id);
  const [gastos, saldos, sedes, retomas] = await Promise.all([
    leerLista(T_GASTOS, { preliquidacion_id: id }, { orden: "orden" }),
    leerLista(T_SALDOS, { destino_preliquidacion_id: id, estado: "pendiente" }),
    leerSedesConRecepcion(id),
    cabecera.especie === "cerdo" ? leerLista(T_RETOMAS, { preliquidacion_id: id }) : Promise.resolve([]),
  ]);
  return { cabecera, gastos, saldos, sedes, retomas };
}

/**
 * Gasto total de la cabecera. Ya liquidada, el gasto está CONGELADO en la cabecera
 * (`gasto_total_aplicado`): los saldos pasaron a `aplicado` y no se vuelven a sumar.
 * Sin liquidar se calcula con `gastoTotal` (única implementación de la fórmula).
 */
function gastoDeCabecera({ cabecera, gastos, saldos }) {
  if (cabecera.liquidada_at && cabecera.gasto_total_aplicado != null) {
    const gastoTotalCent = aCentavos(cabecera.gasto_total_aplicado);
    const servicioAplicadoCent = aCentavos(cabecera.servicio_aplicado ?? 0);
    const costoPorAnimalCent = aCentavos(cabecera.costo_por_animal ?? 0);
    return {
      servicioAplicadoCent,
      gastoTotalCent,
      costoPorAnimalCent,
      saldoIds: [],
      plan: {
        servicio_aplicado: centavosATexto(servicioAplicadoCent),
        gasto_total: centavosATexto(gastoTotalCent),
        costo_por_animal: centavosATexto(costoPorAnimalCent),
        saldo_ids: [],
      },
    };
  }
  return gastoTotal({
    animalEnPie: cabecera.animal_en_pie,
    servicioPrecorte: cabecera.servicio_precorte,
    servicioPorAnimal: cabecera.servicio_por_animal,
    animales: Number(cabecera.animales),
    gastos,
    saldos,
  });
}

/**
 * Gasto total, monto de cada sede y su costeo, con las funciones puras de
 * `src/shared` (única implementación: el frontend NO recalcula nada). Solo lee los
 * renglones de las sedes costeables.
 *
 * @returns {Promise<{gasto: object, resumen: object, porSede: Map<string, object>, detalle: Map<string, object>}>}
 *   `porSede` va vacío cuando hay un bloqueo de cabecera (`servicio_cero`). `detalle` guarda el
 *   costeo final (`calcularCosteo`) de cada sede: sus renglones son los que se congelan.
 */
async function calcular({ cabecera, gastos, saldos, sedes: sedesTodas, retomas }) {
  const gasto = gastoDeCabecera({ cabecera, gastos, saldos });

  const resumen = {
    servicio_aplicado: centavosATexto(gasto.servicioAplicadoCent),
    gasto_total: centavosATexto(gasto.gastoTotalCent),
    costo_por_animal: centavosATexto(gasto.costoPorAnimalCent),
    bloqueo: gasto.bloqueo ?? null,
  };
  const porSede = new Map();
  const detalle = new Map();
  if (gasto.bloqueo) return { gasto, resumen, porSede, detalle };

  const sedes = sedesTodas.filter((s) => !esDesborde(s)).sort((a, b) => a.orden - b.orden);
  const montos = montoSedes(
    sedes.map((s) => ({
      sedeId: s.id,
      animales: Number(s.animales),
      bloqueada: noCosteable(s),
      gastoSedeCentFijo: ESTADOS_CON_MONTO_FIJO.has(s.estado) && s.gasto_sede != null ? aCentavos(s.gasto_sede) : null,
    })),
    { gastoTotalCent: gasto.gastoTotalCent, animales: Number(cabecera.animales) },
  );
  const montoPorSede = new Map(montos.map((m) => [String(m.sedeId), m.gastoSedeCent]));

  const costeables = sedes.filter((s) => montoPorSede.has(String(s.id)));
  const items = costeables.length
    ? (await supabase.from(T_ITEMS).select("*").in("recepcion_id", costeables.map((s) => s.recepcion_id)).order("orden")).data || []
    : [];

  const retomasPorSede = new Map(
    cabecera.especie === "cerdo"
      ? valorRetomasSedes(
          retomas,
          costeables.map((s) => ({ sedeId: s.id, animales: Number(s.animales), bloqueada: false })),
          Number(cabecera.animales),
        ).map((r) => [String(r.sedeId), r.valorRetomasCent])
      : [],
  );

  for (const s of costeables) {
    const itemsSede = items.filter((i) => String(i.recepcion_id) === String(s.recepcion_id));
    const costeo = costearSede({
      items: itemsSede.filter(ES_PRODUCTO),
      gastoSedeCent: montoPorSede.get(String(s.id)),
      especie: cabecera.especie,
      valorVicerasCent: valorVicerasSede({ items: itemsSede }, cabecera.especie),
      valorRetomasCent: retomasPorSede.get(String(s.id)) ?? 0n,
    });
    porSede.set(String(s.id), { ...costeo.plan, bloqueos: costeo.bloqueos });
    detalle.set(String(s.id), costeo.costeoFinal);
  }
  return { gasto, resumen, porSede, detalle };
}

/**
 * Calcula —sin escribir nada— el gasto total, el monto de cada sede y su costeo.
 * Es la misma matemática pura que usará la liquidación real.
 */
export async function previsualizar(id) {
  const contexto = await leerContexto(id);
  const { resumen, porSede } = await calcular(contexto);
  const sedes = contexto.sedes
    .filter((s) => porSede.has(String(s.id)))
    .sort((a, b) => a.orden - b.orden)
    .map((s) => ({
      sede_id: s.id,
      recepcion_id: s.recepcion_id,
      animales: Number(s.animales),
      orden: s.orden,
      estado: s.estado,
      ...porSede.get(String(s.id)),
    }));
  return { preliquidacion_id: contexto.cabecera.id, especie: contexto.cabecera.especie, ...resumen, sedes };
}

const CAMPOS_MONTO_SEDE = ["gasto_sede", "utilidad", "servicio_compra", "valor_viceras", "valor_retomas"];

/**
 * Cabecera + gastos + saldos pendientes dirigidos a ella + sedes con su recepción,
 * más el cálculo del backend por sede (`gasto_sede`, `utilidad`, `servicio_compra`,
 * `valor_viceras`, `valor_retomas`, REQ-C3).
 *
 * - Sede con costeo congelado (`gasto_sede` guardado): se devuelven los montos
 *   guardados (`fuente_calculo: "congelado"`); lo enviado no se recalcula.
 * - Sede sin costeo: monto calculado ahora (`"previsualizado"`).
 * - Con bloqueo de cabecera (`servicio_cero`) no hay montos nuevos.
 *
 * Si el cálculo falla (datos inválidos) la lectura NO se cae: `calculo` va en `null`
 * y `calculo_error` explica por qué, para que el panel pueda abrir la preliquidación
 * y corregirla.
 */
export async function obtener(id) {
  const contexto = await leerContexto(id);

  let calculo = null;
  let calculoError;
  let porSede = new Map();
  try {
    const r = await calcular(contexto);
    calculo = r.resumen;
    porSede = r.porSede;
  } catch (error) {
    calculoError = error.message;
  }

  const sedes = contexto.sedes.map((s) => {
    if (s.gasto_sede != null) return { ...s, fuente_calculo: "congelado" };
    const nuevo = porSede.get(String(s.id));
    if (!nuevo) {
      return { ...s, ...Object.fromEntries(CAMPOS_MONTO_SEDE.map((c) => [c, null])), fuente_calculo: null };
    }
    const { bloqueos, ...montos } = nuevo;
    return { ...s, ...montos, bloqueos_calculo: bloqueos, fuente_calculo: "previsualizado" };
  });

  const { cabecera, gastos, saldos } = contexto;
  // `siesa_activo` permite al panel ocultar "Enviar" cuando SIESA está apagado (M5).
  const respuesta = { ...cabecera, gastos, saldos, sedes, calculo, siesa_activo: siesaActivo() };
  if (calculoError) respuesta.calculo_error = calculoError;
  return respuesta;
}

// ─── Envío de una sede (reclamar -> SIESA -> cerrar) ───────────────────────

const efectosDe = (transicion, tipo) => transicion.efectos.filter((e) => e.tipo === tipo);

/** El `plan` de `carnes_preliq_cerrar_envio`: el parche de `transicionSede` sin `estado`, más la recepción. */
function armarPlanCierre(transicion) {
  const { estado, ...campos } = transicion.campos;
  const plan = { hacia: estado, campos };
  const recepcion = efectosDe(transicion, "recepcion")[0];
  if (recepcion) plan.recepcion_estado = recepcion.estado;
  return plan;
}

/** Encola las alertas de una transición. Una alerta que falla nunca tumba el flujo. */
async function encolarAlertas(transicion, { encolar, preliquidacionId, sedeId, ocurrencia, log }) {
  for (const { evento } of efectosDe(transicion, "alerta")) {
    try {
      await encolar({ evento, preliquidacionId, sedeId, ocurrencia });
    } catch (error) {
      log.warn?.(`No se pudo encolar la alerta ${evento} de la sede ${sedeId}: ${error?.message}`);
    }
  }
}

async function enviarPorDefecto(recepcionId, opciones) {
  const { enviarOficialRecepcion } = await import("./SiesaEnvio.model.js");
  return enviarOficialRecepcion(recepcionId, opciones);
}

/**
 * Con SIESA apagado ninguna sede se reclama ni se envía: la `calculada` pasa a `simulada`
 * (M5/D8) y el resto se informa como `siesa_apagado`.
 */
async function simularSede(sede) {
  const transicion = transicionSede(sede.estado, "siesa_apagado");
  const respuesta = await llamarRpc("carnes_preliq_transicionar_sede", {
    p_sede_id: sede.id,
    p_sede_version: sede.version,
    p_desde: sede.estado,
    p_hacia: transicion.estado,
    p_campos: {},
  });
  if (respuesta?.resultado === "version_cambiada" || respuesta?.resultado === "no_encontrada") {
    return { resultado: "no_reclamada" };
  }
  exigirOk(respuesta);
  return { resultado: "simulada", estado: transicion.estado, sede_version: respuesta.sede_version };
}

/**
 * Procesa UNA sede de la preliquidación: decide si se puede reclamar, la reclama con un
 * CAS (estado + versión), manda la CEA oficial, traduce la respuesta de SIESA a un evento
 * de `transicionSede` y cierra el intento con el mismo token.
 *
 * Nunca llama a SIESA si la sede no se reclamó. Si otra instancia ganó el reclamo
 * (`no_reclamada`) es un no-op (D-S5). La RPC `cerrar_envio` solo escribe el plan.
 *
 * @param {object} sede fila de la sede (con `version`, `estado`, montos y costeo congelado)
 * @param {object} contexto
 * @param {object} contexto.header fila de la preliquidación
 * @param {string} contexto.origen schedule|sweep|dispatch|inmediato|admin
 * @param {number} contexto.corridaId nunca NULL (R14)
 * @param {Date}   [contexto.ahora]
 * @param {boolean} [contexto.siesaActivo]
 * @param {Function} [contexto.enviar] (recepcionId, {por, terceroId, timeoutMs}) -> {fila, armadoBloqueos}
 * @param {Function} [contexto.encolar] puerto de alertas
 * @returns {Promise<{resultado: string, efectos?: object[]}>}
 */
export async function procesarSede(sede, contexto = {}) {
  const {
    header,
    origen,
    corridaId,
    ahora = new Date(),
    por = null,
    terceroId,
    timeoutMs,
    enviar = enviarPorDefecto,
    encolar = encolarAlerta,
    generarToken = randomUUID,
    log = console,
  } = contexto;
  const siesaEncendido = contexto.siesaActivo ?? siesaActivo();

  if (!siesaEncendido && sede.estado === "calculada") return simularSede(sede);

  const decision = puedeReclamar(sede, { header, origen, corridaId, siesaActivo: siesaEncendido, ahora });
  if (!decision.ok) return { resultado: "no_reclamable", motivo: decision.motivo };

  const token = generarToken();
  const reclamo = await llamarRpc("carnes_preliq_reclamar_sede", {
    p_sede_id: sede.id,
    p_sede_version: sede.version,
    p_desde: sede.estado,
    p_token: token,
    p_corrida_id: corridaId,
    p_origen: origen,
    p_reset_intentos: decision.resetIntentos,
  });

  if (reclamo?.resultado === "no_reclamada") return { resultado: "no_reclamada" };
  if (reclamo?.resultado === "costeo_desactualizado") return { resultado: "costeo_desactualizado" };
  if (reclamo?.resultado === "inicial_pendiente") {
    // La RPC marca `motivo_pendiente` y sube la versión solo la primera vez: la alerta también.
    if (sede.motivo_pendiente !== "inicial_pendiente") {
      const transicion = transicionSede("calculada", "inicial_no_ok");
      await encolarAlertas(transicion, {
        encolar,
        preliquidacionId: sede.preliquidacion_id,
        sedeId: sede.id,
        ocurrencia: Number(sede.version) + 1,
        log,
      });
    }
    return { resultado: "inicial_pendiente" };
  }
  exigirOk(reclamo);

  let envio;
  try {
    envio = await enviar(sede.recepcion_id, { por, terceroId, timeoutMs });
  } catch (error) {
    // No se sabe si SIESA llegó a recibir algo: la sede queda `enviando` y se recupera por
    // abandono (la idempotencia de sql/010 evita el doble envío).
    log.error?.(`Envío de la sede ${sede.id} falló antes de cerrar: ${error?.message}`);
    return { resultado: "error_envio", error: error?.message ?? String(error) };
  }

  const { fila, armadoBloqueos = [] } = envio;
  // I4: lo que armó el envío y lo que quedó registrado deben decir lo mismo.
  const paridadArmado = armadoBloqueos.length ? fila?.error === armadoBloqueos.join(" ") : true;
  if (!paridadArmado) {
    log.warn?.(`Sede ${sede.id}: el texto de fila.error no coincide con los bloqueos del armado.`);
  }

  const { evento, ctx } = mapearEnvio(fila, { armadoBloqueos });
  const transicion = transicionSede("enviando", evento, {
    ...ctx,
    intentos: reclamo.intentos,
    requiereCorreccion: sede.requiere_correccion === true,
    claimCosteoOrdenVersion: reclamo.claim_costeo_orden_version,
    correccionOrdenVersion: sede.correccion_orden_version,
  });

  const cierre = await llamarRpc("carnes_preliq_cerrar_envio", {
    p_sede_id: sede.id,
    p_token: token,
    p_plan: armarPlanCierre(transicion),
  });
  if (cierre?.resultado === "token_invalido" || cierre?.resultado === "no_encontrada") {
    return { resultado: cierre.resultado };
  }
  exigirOk(cierre);

  await encolarAlertas(transicion, {
    encolar,
    preliquidacionId: sede.preliquidacion_id,
    sedeId: sede.id,
    ocurrencia: cierre.sede_version,
    log,
  });

  return {
    resultado: transicion.estado,
    evento,
    sede_version: cierre.sede_version,
    paridad_armado: paridadArmado,
    efectos: transicion.efectos.filter((e) => e.tipo === "intentar_autocierre" || e.tipo === "avisar_anulacion"),
  };
}

/** La sede de una recepción con su cabecera, o `null` si la recepción no está vinculada. */
export async function leerSedeDeRecepcion(recepcionId) {
  const { data, error } = await supabase.from(T_SEDES).select("*").eq("recepcion_id", recepcionId).maybeSingle();
  if (error) throw new Error(`Error al leer la sede: ${error.message}`);
  if (!data) return null;
  return { sede: data, cabecera: await leerCabecera(data.preliquidacion_id) };
}

// ─── Corrida sobre una preliquidación ──────────────────────────────────────

/**
 * Escribe una transición de `transicionSede` por `carnes_preliq_transicionar_sede` (CAS de
 * estado + versión) y encola sus alertas. `{ok:false}` si otra instancia cambió la sede.
 */
async function aplicarTransicion(sede, transicion, { encolar, log }) {
  const { estado: hacia, ...campos } = transicion.campos;
  const recepcion = efectosDe(transicion, "recepcion")[0];
  if (recepcion) campos.recepcion_estado = recepcion.estado;
  const respuesta = await llamarRpc("carnes_preliq_transicionar_sede", {
    p_sede_id: sede.id,
    p_sede_version: sede.version,
    p_desde: sede.estado,
    p_hacia: hacia,
    p_campos: campos,
  });
  if (respuesta?.resultado === "version_cambiada" || respuesta?.resultado === "no_encontrada") {
    return { ok: false, resultado: respuesta.resultado };
  }
  exigirOk(respuesta);
  await encolarAlertas(transicion, {
    encolar,
    preliquidacionId: sede.preliquidacion_id,
    sedeId: sede.id,
    ocurrencia: respuesta.sede_version,
    log,
  });
  return { ok: true, sede_version: respuesta.sede_version };
}

/** Plan de `carnes_preliq_congelar_sede` a partir del costeo de la sede y de su transición. */
function armarPlanCongelar({ sede, transicion, montos, costeoFinal }) {
  const { bloqueos, ...valores } = montos;
  const { items = [], ...resumenCosteo } = costeoFinal;
  const plan = {
    desde: sede.estado,
    hacia: transicion.estado,
    ...valores,
    costeo: resumenCosteo,
    items: items.map((i) => ({ id: i.id, costo_ajustado: i.costo_ajustado, costo_total: i.costo_total })),
    recepcion_costeado: efectosDe(transicion, "recepcion").some((e) => e.estado === "Costeado"),
  };
  const { motivo_bloqueo: motivo, detalle_bloqueo: detalle, intentos, error_tipo: errorTipo, motivo_pendiente: pendiente } =
    transicion.campos;
  if (motivo !== undefined) plan.motivo_bloqueo = motivo;
  if (detalle !== undefined) plan.detalle_bloqueo = detalle;
  const campos = {};
  if (intentos !== undefined) campos.intentos = intentos;
  if (errorTipo !== undefined) campos.error_tipo = errorTipo;
  if (pendiente !== undefined) campos.motivo_pendiente = pendiente;
  if (Object.keys(campos).length) plan.campos = campos;
  return plan;
}

/** Evento y contexto de `transicionSede` para el costeo de una sede (bloqueado o correcto). */
function eventoDeCosteo(sede, costeo, { origen, siesaActivo: siesaEncendido }) {
  if (costeo.bloqueos.length) {
    const [{ motivo, detalle }] = costeo.bloqueos;
    return { evento: "costeo_bloqueado", ctx: { motivo, detalle, motivoBloqueo: sede.motivo_bloqueo } };
  }
  return {
    evento: "costeo_ok",
    ctx: {
      origen,
      siesaActivo: siesaEncendido,
      motivoBloqueo: sede.motivo_bloqueo,
      liberada: sede.liberada_at != null,
      errorTipo: sede.error_tipo,
      intentos: sede.intentos,
      abandonado: false,
      envioId: sede.envio_id,
    },
  };
}

/** `servicio_cero` antes de liquidar: se bloquean las sedes vinculadas (I1: sin repetir escrituras). */
async function bloquearPorServicioCero(sedes, opciones) {
  let escritas = 0;
  for (const sede of sedes) {
    const bloqueadaPorServicio = sede.estado === "bloqueada" && sede.motivo_bloqueo === "servicio_cero";
    if (sede.estado !== "vinculada" && !bloqueadaPorServicio) continue;
    const transicion = transicionSede(sede.estado, "costeo_bloqueado", {
      motivo: "servicio_cero",
      detalle: "El servicio de la preliquidación es cero: cargue el servicio para liquidar.",
      motivoBloqueo: sede.motivo_bloqueo,
    });
    if (transicion.sinCambios) continue;
    const r = await aplicarTransicion(sede, transicion, opciones);
    if (r.ok) escritas += 1;
  }
  return escritas;
}

/** Liquida la cabecera una vez; relee y reintenta si cambió la versión (máx. 3). */
async function liquidarCabecera(id, contexto) {
  try {
    return await conReintentoVersion(async (intento) => {
      const ctx = intento === 0 ? contexto : await leerContexto(id);
      const { cabecera } = ctx;
      if (cabecera.liquidada_at) return { resultado: "ya_liquidada" };
      const gasto = gastoDeCabecera(ctx);
      if (gasto.bloqueo) return { resultado: "servicio_cero", ctx };
      return llamarRpc("carnes_preliq_liquidar", {
        p_id: id,
        p_version: cabecera.version,
        p_corte: corteBogota(cabecera.fecha_primer_ingreso).toISOString(),
        p_plan: gasto.plan,
      });
    });
  } catch (error) {
    if (error?.codigo === "version_cambiada") return { resultado: "version_cambiada" };
    throw error;
  }
}

/**
 * Una corrida sobre una preliquidación abierta: liquida (a partir del corte), corrige y
 * reevalúa bloqueos, congela el costeo de las sedes que lo necesitan y SOLO entonces
 * reclama y envía con el costeo vigente (T2). Idempotente: una segunda corrida sin cambios
 * no escribe nada. Cada sede es independiente: la falla de una no detiene a las demás.
 *
 * @param {number|string} id
 * @param {object} [opciones]
 * @param {Date}    [opciones.ahora]
 * @param {boolean} [opciones.dryRun] calcula el plan y NO escribe ni envía
 * @param {number}  [opciones.corridaId] obligatorio si no se pasa `corrida` (R14)
 * @param {{id: number, resumen?: {reevaluadas?: number[]}}} [opciones.corrida] se muta `resumen.reevaluadas`
 * @param {string}  [opciones.origen] schedule|sweep|dispatch|inmediato|admin
 * @param {Function} [opciones.hayPresupuesto] se consulta antes de cada envío; false = agotado
 * @param {Function} [opciones.procesarSede] inyectable para pruebas
 */
export async function procesarPreliquidacion(id, opciones = {}) {
  const {
    ahora = new Date(),
    dryRun = false,
    origen = "schedule",
    hayPresupuesto = () => true,
    soloSedeId = null,
    procesarSede: procesarUna = procesarSede,
    por = null,
    timeoutMs,
    encolar = encolarAlerta,
    log = console,
  } = opciones;
  const corrida = opciones.corrida ?? { id: opciones.corridaId };
  if (corrida.id == null) throw new Error("procesarPreliquidacion requiere corridaId (R14: nunca NULL)");
  corrida.resumen ??= {};
  corrida.resumen.reevaluadas ??= [];
  const siesaEncendido = opciones.siesaActivo ?? siesaActivo();
  // Camino inmediato: solo se congela y envía la sede indicada (la liquidación sigue siendo de la cabecera).
  const esDeLaSede = (s) => soloSedeId == null || String(s.id) === String(soloSedeId);
  const planear = (ctx) =>
    planearEnvios(ctx.sedes, { header: ctx.cabecera, origen, corrida, siesaActivo: siesaEncendido, ahora });
  const escritura = { encolar, log };

  const resumen = {
    preliquidacion_id: id,
    resultado: "ok",
    dry_run: dryRun,
    liquidada: false,
    corregidas: 0,
    reevaluadas: 0,
    congeladas: 0,
    bloqueadas: 0,
    enviadas: 0,
    simuladas: 0,
    errores: 0,
    sin_confirmar: 0,
    inicial_pendiente: 0,
    omitidas: 0,
    pendientes: 0,
    agotado: false,
  };

  let contexto = await leerContexto(id);
  if (contexto.cabecera.estado !== "abierta") return { ...resumen, resultado: "no_abierta" };

  if (!contexto.cabecera.liquidada_at) {
    if (!debeLiquidar({ preliq: contexto.cabecera, ahora })) return { ...resumen, resultado: "antes_del_corte" };
    if (gastoDeCabecera(contexto).bloqueo) {
      const escritas = dryRun ? 0 : await bloquearPorServicioCero(contexto.sedes, escritura);
      return { ...resumen, resultado: "servicio_cero", bloqueadas: escritas };
    }
    if (dryRun) return { ...resumen, liquidaria: true, pendientes: contexto.sedes.length };

    const liquidacion = await liquidarCabecera(id, contexto);
    if (liquidacion.resultado === "servicio_cero") {
      const escritas = await bloquearPorServicioCero((await leerContexto(id)).sedes, escritura);
      return { ...resumen, resultado: "servicio_cero", bloqueadas: escritas };
    }
    if (!["ok", "ya_liquidada"].includes(liquidacion.resultado)) return { ...resumen, resultado: liquidacion.resultado };
    resumen.liquidada = liquidacion.resultado === "ok";
    contexto = await leerContexto(id);
  }

  if (dryRun) {
    const plan = planear(contexto);
    return {
      ...resumen,
      plan: {
        por_corregir: plan.porCorregir.length,
        por_reevaluar: plan.porReevaluar.length,
        por_calcular: plan.porCalcular.length,
        por_enviar: plan.porEnviar.length,
        por_simular: plan.porSimular.length,
      },
      pendientes: plan.pendientes,
    };
  }

  // 1. Corregir (servicio_cero ya liquidada) y reevaluar (armado/costeo inválido, una vez por corrida).
  const plan1 = planear(contexto);
  let cambio = false;
  for (const sede of plan1.porCorregir) {
    const transicion = transicionSede("bloqueada", "corregida", { motivoBloqueo: sede.motivo_bloqueo });
    if ((await aplicarTransicion(sede, transicion, escritura)).ok) {
      resumen.corregidas += 1;
      cambio = true;
    }
  }
  if (plan1.porReevaluar.length) {
    // El costeo hipotético de las sedes bloqueadas como si estuvieran vinculadas: solo se
    // escribe si ya no hay bloqueo de costeo (si sigue inválido no se toca ni se alerta).
    const ids = new Set(plan1.porReevaluar.map((s) => s.id));
    const hipotetico = await calcular({
      ...contexto,
      sedes: contexto.sedes.map((s) => (ids.has(s.id) ? { ...s, estado: "vinculada", motivo_bloqueo: null } : s)),
    });
    for (const sede of plan1.porReevaluar) {
      corrida.resumen.reevaluadas.push(sede.id);
      resumen.reevaluadas += 1;
      const costeo = hipotetico.porSede.get(String(sede.id));
      if (!costeo || costeo.bloqueos.length) continue;
      const transicion = transicionSede("bloqueada", "corregida", { motivoBloqueo: sede.motivo_bloqueo });
      if ((await aplicarTransicion(sede, transicion, escritura)).ok) cambio = true;
    }
  }
  if (cambio) contexto = await leerContexto(id);

  // 2. Congelar el costeo de las sedes que lo requieren.
  const plan2 = planear(contexto);
  if (plan2.porCalcular.length) {
    const calculo = await calcular(contexto);
    for (const original of plan2.porCalcular.filter(esDeLaSede)) {
      let sede = original;
      const costeo = calculo.porSede.get(String(sede.id));
      if (!costeo) continue;
      try {
        if (sede.estado === "enviando") {
          // M1: se libera el reclamo abandonado y se sigue como `calculada`.
          const liberar = transicionSede("enviando", "costeo_ok", { abandonado: true, envioId: sede.envio_id });
          const r = await aplicarTransicion(sede, liberar, escritura);
          if (!r.ok) {
            resumen.omitidas += 1;
            continue;
          }
          sede = { ...sede, estado: "calculada", version: r.sede_version, claim_token: null, claimed_at: null };
        }
        const { evento, ctx } = eventoDeCosteo(sede, costeo, { origen, siesaActivo: siesaEncendido });
        const transicion = transicionSede(sede.estado, evento, ctx);
        if (transicion.sinCambios) continue;
        const respuesta = await llamarRpc("carnes_preliq_congelar_sede", {
          p_sede_id: sede.id,
          p_sede_version: sede.version,
          p_orden_version: contexto.cabecera.orden_version,
          p_plan: armarPlanCongelar({ sede, transicion, montos: costeo, costeoFinal: calculo.detalle.get(String(sede.id)) }),
        });
        if (["version_cambiada", "no_liberada", "desde_invalido", "no_encontrada"].includes(respuesta?.resultado)) {
          resumen.omitidas += 1;
          continue;
        }
        exigirOk(respuesta);
        resumen.congeladas += 1;
        if (transicion.estado === "bloqueada") resumen.bloqueadas += 1;
        await encolarAlertas(transicion, {
          encolar,
          preliquidacionId: sede.preliquidacion_id,
          sedeId: sede.id,
          ocurrencia: Number(sede.version) + 1,
          log,
        });
      } catch (error) {
        resumen.errores += 1;
        log.error?.(`Costeo de la sede ${sede.id} falló: ${error?.message}`);
      }
    }
    contexto = await leerContexto(id);
  }

  // 3. Reclamar y enviar SOLO con el costeo vigente (`costeoVigente`; el admin siempre pide recostear,
  //    por eso no se filtra por `requiereCosteo`).
  const plan3 = planear(contexto);
  const vigentes = (s) => costeoVigente(s, contexto.cabecera);
  const aProcesar = [
    ...plan3.porSimular.filter(vigentes),
    ...plan3.porEnviar.filter((i) => vigentes(i.sede)).map((i) => i.sede),
  ].filter(esDeLaSede);
  for (const sede of aProcesar) {
    if (!hayPresupuesto()) {
      resumen.agotado = true;
      break;
    }
    try {
      const r = await procesarUna(sede, {
        header: contexto.cabecera,
        origen,
        corridaId: corrida.id,
        ahora,
        siesaActivo: siesaEncendido,
        por,
        timeoutMs,
        encolar,
        log,
      });
      if (r?.resultado === "enviada") resumen.enviadas += 1;
      else if (r?.resultado === "simulada") resumen.simuladas += 1;
      else if (r?.resultado === "error_envio" || r?.resultado === "error") resumen.errores += 1;
      else if (r?.resultado === "sin_confirmar") resumen.sin_confirmar += 1;
      else if (r?.resultado === "inicial_pendiente") resumen.inicial_pendiente += 1;
    } catch (error) {
      resumen.errores += 1;
      log.error?.(`Envío de la sede ${sede.id} falló: ${error?.message}`);
    }
  }

  resumen.pendientes = planear(await leerContexto(id)).pendientes;
  return resumen;
}
