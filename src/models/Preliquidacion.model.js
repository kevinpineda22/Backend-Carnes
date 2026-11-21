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
import { corteBogota } from "../shared/preliquidacionTiempo.js";
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
  novillos_invalido: [422, "Los novillos o canales deben ser un entero mayor que cero."],
  invalido: [422, "Los datos enviados no son válidos."],
  datos_invalidos: [422, "Los datos enviados no son válidos."],
  servicio_invalido: [422, "El servicio debe ser un valor mayor o igual que cero."],
  recepcion_estado_invalido: [422, "El estado de recepción indicado no es válido."],
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
export async function desvincularSede(sedeId) {
  return conReintentoVersion(async () => {
    const [sede] = await leerLista(T_SEDES, { id: sedeId });
    if (!sede) throw resultadoAError({ resultado: "no_encontrada" });

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

/** Cabecera + gastos + saldos pendientes dirigidos a ella + sedes con su recepción. */
export async function obtener(id) {
  const cabecera = await leerCabecera(id);
  const [gastos, saldos, sedes] = await Promise.all([
    leerLista(T_GASTOS, { preliquidacion_id: id }, { orden: "orden" }),
    leerLista(T_SALDOS, { destino_preliquidacion_id: id, estado: "pendiente" }),
    leerSedesConRecepcion(id),
  ]);
  return { ...cabecera, gastos, saldos, sedes };
}

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
async function actualizarCabeceraConVersion(id, cambios, { alLeer } = {}) {
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

// ─── Previsualización (no escribe) ─────────────────────────────────────────

const ES_PRODUCTO = (i) => i.tipo === "carne" || i.tipo === "adicional";
const ESTADOS_CON_MONTO_FIJO = new Set(["enviando", "enviada", "sin_confirmar"]);

/** Un desborde sin liberar no consume animales ni recibe monto. */
const esDesborde = (s) => s.estado === "bloqueada" && s.motivo_bloqueo === "excede_animales" && !s.liberada_at;
const noCosteable = (s) => s.estado === "bloqueada" && !(s.motivo_bloqueo === "excede_animales" && s.liberada_at);

/**
 * Calcula —sin escribir nada— el gasto total, el monto de cada sede y su costeo.
 * Es la misma matemática pura que usará la liquidación real.
 */
export async function previsualizar(id) {
  const cabecera = await leerCabecera(id);
  const [gastos, saldos, sedesTodas, retomas] = await Promise.all([
    leerLista(T_GASTOS, { preliquidacion_id: id }, { orden: "orden" }),
    leerLista(T_SALDOS, { destino_preliquidacion_id: id, estado: "pendiente" }),
    leerSedesConRecepcion(id),
    cabecera.especie === "cerdo" ? leerLista(T_RETOMAS, { preliquidacion_id: id }) : Promise.resolve([]),
  ]);

  const gasto = gastoTotal({
    animalEnPie: cabecera.animal_en_pie,
    servicioPrecorte: cabecera.servicio_precorte,
    servicioPorAnimal: cabecera.servicio_por_animal,
    animales: Number(cabecera.animales),
    gastos,
    saldos,
  });

  const base = {
    preliquidacion_id: cabecera.id,
    especie: cabecera.especie,
    servicio_aplicado: centavosATexto(gasto.servicioAplicadoCent),
    gasto_total: centavosATexto(gasto.gastoTotalCent),
    costo_por_animal: centavosATexto(gasto.costoPorAnimalCent),
    bloqueo: gasto.bloqueo ?? null,
    sedes: [],
  };
  if (gasto.bloqueo) return base;

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

  base.sedes = costeables.map((s) => {
    const itemsSede = items.filter((i) => String(i.recepcion_id) === String(s.recepcion_id));
    const valorViceras = valorVicerasSede({ items: itemsSede }, cabecera.especie);
    const valorRetomas = retomasPorSede.get(String(s.id)) ?? 0n;
    const costeo = costearSede({
      items: itemsSede.filter(ES_PRODUCTO),
      gastoSedeCent: montoPorSede.get(String(s.id)),
      especie: cabecera.especie,
      valorVicerasCent: valorViceras,
      valorRetomasCent: valorRetomas,
    });
    return {
      sede_id: s.id,
      recepcion_id: s.recepcion_id,
      animales: Number(s.animales),
      orden: s.orden,
      estado: s.estado,
      ...costeo.plan,
      bloqueos: costeo.bloqueos,
    };
  });
  return base;
}
