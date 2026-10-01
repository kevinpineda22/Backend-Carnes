import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import * as SedeModel from "./Sede.model.js";
import { ESTADOS } from "../shared/estadosProveedor.js";
import {
  hoyBogota,
  normalizarFactura,
  resumenRecepcion,
  validarRecepcion,
} from "../shared/proveedorValores.js";
import * as RecibidorModel from "./Recibidor.model.js";
import {
  avisosDeFactura,
  decidirApertura,
  esConflictoReintentable,
  esRecepcionNoBorrador,
  esViolacionUnica,
  mensajeVerificacionQr,
  renglonesDesdePlantilla,
} from "../shared/aperturaProveedor.js";
import {
  calcularPendientes,
  normalizarObservaciones,
  planearGuardado,
  planearReintento,
  resolverRechazos,
} from "../shared/guardadoProveedor.js";
import {
  MENSAJE_CAMBIO_AL_FINALIZAR,
  armarActualizacionFinalizar,
  armarRecibidor,
  decidirFinalizar,
  idRecibidorListado,
  validarFirma,
} from "../shared/finalizarProveedor.js";

/* =============================================
   Recepción de proveedor — lado del RECIBIDOR: abrir, autoguardar, descartar,
   leer para reanudar y finalizar (firmar).

   Las tablas (sql/022) son aparte de `carnes_recepciones`: nada de esto toca
   Talleres, costeo ni liquidaciones. El envío a SIESA y las acciones del admin
   llegan en cortes posteriores.

   Las REGLAS no viven acá: la decisión de qué hacer con una factura repetida está
   en `shared/aperturaProveedor.js` y el plan del autoguardado en
   `shared/guardadoProveedor.js`, donde sí hay tests (este modelo no los tiene:
   no hay mock de Supabase). Acá solo se lee, se escribe y se traducen errores.
   ============================================= */

const TABLE = "carnes_proveedor_recepciones";
const TABLE_ITEMS = "carnes_proveedor_recepcion_items";
const MIGRACIONES = ["sql/022_proveedores.sql"];

/**
 * Columnas de la cabecera que ve el RECIBIDOR. Se nombran una por una (nada de
 * `*`) para que `firma_data` y `recibidor_cedula` NO salgan de acá ni por
 * accidente: esas las devuelve solo el detalle del admin. Tampoco viaja
 * `factura_clave`, que es interna.
 */
const CAMPOS_CABECERA = `
  id, proveedor_id, proveedor_nit, proveedor_sucursal, proveedor_razon_social,
  factura, factura_siesa, sede_id, bodega_siesa, codigo_co, fecha_recepcion,
  estado, recibido_por, abierto_at, recibidor_nombre, recibidor_otro,
  finalizado_at, siesa_at, observaciones, created_at, updated_at,
  sede:carnes_sedes ( id, codigo_co, nombre )
`;

/** Cuántos UPDATE de renglones corren a la vez en un autoguardado. */
const LOTE_ESCRITURAS = 10;

/**
 * Traduce un error de Supabase: un deadlock / fallo de serialización (descartar
 * cruzado con un autoguardado) es un 409 que se reintenta, no un 500; lo demás
 * sigue el camino de "falta migración" o error genérico.
 */
function fallo(error, contexto) {
  if (esConflictoReintentable(error)) throw errorReintentable();
  return fallarSiFaltaMigracion(error, contexto, MIGRACIONES);
}

function errorReintentable() {
  return createError(
    409,
    "Otra persona estaba modificando esta recepción al mismo tiempo. Intentá de nuevo.",
    "REINTENTAR",
  );
}

function errorNoBorrador() {
  return createError(409, "La recepción ya no está en borrador", "RECEPCION_NO_BORRADOR");
}

// ─── Lectura ───────────────────────────────────────────────────────────────

async function leerCabecera(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(CAMPOS_CABECERA)
    .eq("id", id)
    .maybeSingle();
  if (error) fallo(error, "Error al leer la recepción");
  if (!data) throw createError(404, "Recepción no encontrada.");
  return data;
}

async function leerItems(id) {
  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .select("*")
    .eq("recepcion_id", id)
    .order("orden")
    .order("id");
  if (error) fallo(error, "Error al leer los renglones");
  return data || [];
}

/**
 * La recepción para el recibidor (y para reanudar): cabecera + renglones en el
 * orden de la plantilla. SIN firma ni cédula del recibidor.
 */
export async function obtener(id) {
  const cabecera = await leerCabecera(id);
  const items = await leerItems(id);
  return { ...cabecera, items };
}

// ─── Abrir ─────────────────────────────────────────────────────────────────

/**
 * Las recepciones vivas del proveedor que chocan con esta factura.
 *
 * Mira las DOS llaves únicas de sql/022: la factura original
 * (`uq_carnes_prov_rec_factura_original`) y la referencia corregida por el admin
 * (la `coalesce(factura_siesa_clave, factura_clave)` de `uq_carnes_prov_rec_factura_vigente`).
 * La primera condición cubre la original y el coalesce cuando no hay corrección;
 * la segunda, la referencia corregida de OTRA recepción. `clave` es solo A-Z y
 * 0-9 (`normalizarFactura`), así que es seguro dentro del filtro `or`.
 */
async function buscarCandidatas(proveedorId, clave) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, estado, sede_id, abierto_at, finalizado_at, fecha_recepcion, sede:carnes_sedes ( id, nombre )")
    .eq("proveedor_id", proveedorId)
    .neq("estado", ESTADOS.ANULADA)
    .or(`factura_clave.eq.${clave},factura_siesa_clave.eq.${clave}`)
    .order("id");
  if (error) fallo(error, "Error al buscar la factura");
  return data || [];
}

function bloqueoDeApertura(decision) {
  return createError(409, decision.mensaje, decision.codigo);
}

/**
 * Inserta los renglones de la plantilla ignorando los que ya existen.
 *
 * `ignoreDuplicates` (ON CONFLICT DO NOTHING) sobre `(recepcion_id,
 * equivalencia_id)` hace que repetir la operación sea inofensivo: dos teléfonos
 * reanudando el mismo borrador vacío, o un reintento, no duplican renglones.
 */
async function materializarRenglones(recepcionId, equivalencias) {
  const filas = renglonesDesdePlantilla(equivalencias, recepcionId);
  if (!filas.length) return null;
  const { error } = await supabase
    .from(TABLE_ITEMS)
    .upsert(filas, { onConflict: "recepcion_id,equivalencia_id", ignoreDuplicates: true });
  return error || null;
}

/** Reanuda un borrador existente; si quedó sin renglones (falló una apertura anterior) los vuelve a crear. */
async function reanudar(id, equivalencias) {
  const items = await leerItems(id);
  if (!items.length) {
    const error = await materializarRenglones(id, equivalencias);
    // 23503: la cabecera desapareció entre la lectura y el insert (la descartó
    // quien la había abierto). Se trata como 404 para que `abrir` vuelva a decidir.
    if (error?.code === "23503") throw createError(404, "Recepción no encontrada.");
    if (error) fallo(error, "Error al cargar la plantilla");
  }
  return obtener(id);
}

/**
 * Abre (o reanuda) la recepción de una factura de proveedor.
 *
 * Orden: proveedor con plantilla → QR de la sede → factura repetida → crear.
 * Nada se escribe hasta que lo anterior pasó. `fecha_recepcion` es el día de
 * Bogotá (`hoyBogota`), NO el de UTC: la columna no tiene default a propósito.
 *
 * @returns {{recepcion: object, reanudada: boolean, verificacion: object, avisos: object[]}}
 */
export async function abrir({ proveedor_id, factura, qr_token, recibido_por }) {
  const { factura: facturaTexto, clave } = normalizarFactura(factura);
  if (!clave) throw createError(400, "El número de factura no es válido.");

  // 1. Proveedor activo y con plantilla. Sin plantilla no hay qué recibir.
  const { data: proveedor, error: errorProveedor } = await supabase
    .from("carnes_proveedores")
    .select("id, nit, sucursal, razon_social")
    .eq("id", proveedor_id)
    .eq("activo", true)
    .maybeSingle();
  if (errorProveedor) fallo(errorProveedor, "Error al leer el proveedor");
  if (!proveedor) throw createError(404, "Proveedor no encontrado.");

  const { data: equivalencias, error: errorPlantilla } = await supabase
    .from("carnes_proveedor_equivalencias")
    .select("id, codigo_item, descripcion_item, unidad, equivalencia, orden")
    .eq("proveedor_id", proveedor.id)
    .eq("activo", true)
    .order("orden")
    .order("id");
  if (errorPlantilla) fallo(errorPlantilla, "Error al leer la plantilla");
  if (!equivalencias?.length) {
    throw createError(
      409,
      "Este proveedor todavía no tiene plantilla de productos. Avisale al administrador.",
      "PROVEEDOR_SIN_PLANTILLA",
    );
  }

  // 2. QR de la sede. La sede sale del QR: no hay sede tipeada.
  const verificacion = await SedeModel.verificarQr(null, qr_token);
  if (verificacion.estado !== "ok") {
    // 409 y no 400: el cuerpo es válido, lo que no cuadra es el estado del mundo.
    const e = createError(409, mensajeVerificacionQr(verificacion), "QR_NO_VALIDO");
    e.verificacion = verificacion;
    throw e;
  }
  const sedeId = verificacion.sede.id;

  // `verificarQr` solo trae id, codigo_co, nombre y activo: la bodega de SIESA
  // hay que leerla aparte para guardarla como snapshot.
  const { data: sede, error: errorSede } = await supabase
    .from("carnes_sedes")
    .select("id, nombre, codigo_co, bodega_siesa")
    .eq("id", sedeId)
    .maybeSingle();
  if (errorSede) fallo(errorSede, "Error al leer la sede");
  if (!sede) throw createError(409, "La sede del QR ya no existe.", "QR_NO_VALIDO");

  const avisos = avisosDeFactura(facturaTexto);
  const resultado = (recepcion, reanudada) => ({ recepcion, reanudada, verificacion, avisos });

  // 3. ¿Ya existe algo con esta factura? Una sola vuelta de reintento: si el
  // INSERT pierde la carrera (23505), se vuelve a buscar y se decide con lo que
  // ganó la otra petición.
  for (let intento = 0; intento < 2; intento++) {
    const decision = decidirApertura(await buscarCandidatas(proveedor.id, clave), sedeId);
    if (decision.accion === "bloquear") throw bloqueoDeApertura(decision);
    if (decision.accion === "reanudar") {
      try {
        return resultado(await reanudar(decision.id, equivalencias), true);
      } catch (e) {
        // La ganadora descartó su borrador justo entre la búsqueda y la lectura:
        // no es un 404 para quien abre, es volver a decidir (ahora puede crear).
        if (e.statusCode === 404) continue;
        throw e;
      }
    }

    // 4. Crear la cabecera con los snapshots de proveedor y sede.
    const { data: cabecera, error } = await supabase
      .from(TABLE)
      .insert({
        proveedor_id: proveedor.id,
        proveedor_nit: proveedor.nit,
        proveedor_sucursal: proveedor.sucursal,
        proveedor_razon_social: proveedor.razon_social,
        factura: facturaTexto,
        factura_clave: clave,
        sede_id: sede.id,
        bodega_siesa: sede.bodega_siesa ?? null,
        codigo_co: sede.codigo_co ?? null,
        fecha_recepcion: hoyBogota(),
        estado: ESTADOS.BORRADOR,
        recibido_por,
      })
      .select("id")
      .single();

    if (esViolacionUnica(error)) continue;
    if (error) fallo(error, "Error al abrir la recepción");

    // 5. Renglones. Si fallan NO queda una cabecera sin renglones: es una pantalla
    // vacía que no se puede usar y que el admin vería. No hay transacción (Supabase
    // va por HTTP), así que se deshace a mano, y solo si sigue en Borrador.
    const errorItems = await materializarRenglones(cabecera.id, equivalencias);
    if (errorItems) {
      const { error: errorLimpieza } = await supabase
        .from(TABLE)
        .delete()
        .eq("id", cabecera.id)
        .eq("estado", ESTADOS.BORRADOR);
      if (errorLimpieza) {
        console.error(`🔴 No se pudo limpiar la recepción ${cabecera.id} tras fallar su plantilla:`, errorLimpieza.message);
      }
      fallo(errorItems, "Error al cargar la plantilla");
    }

    return resultado(await obtener(cabecera.id), false);
  }

  // Perdió la carrera dos veces y la ganadora ya no aparece (se descartó justo
  // entre medio): que reintente.
  throw createError(409, "No se pudo abrir la recepción. Intentá de nuevo.", "REINTENTAR");
}

// ─── Autoguardado ──────────────────────────────────────────────────────────

/**
 * Ejecuta los UPDATE de los renglones que cambiaron, en lotes. Devuelve los ids
 * de los renglones que NO se escribieron porque otro guardado los modificó antes.
 *
 * Cada UPDATE lleva como condición el `updated_at` que se leyó (el TEXTO crudo,
 * nunca un Date). Sin esa condición, dos PATCH que se cruzan sobre el mismo
 * renglón dejarían la cantidad de uno y el valor del otro — un total que no
 * corresponde a ninguna de las dos digitaciones. Con ella, el segundo encuentra 0
 * filas y se vuelve a planear sobre lo que dejó el primero.
 *
 * Falla con 409 si la recepción ya se firmó: el guardián de sql/022 rechaza la
 * escritura en la MISMA operación (una petición vieja que llega después de firmar
 * no puede pisar lo firmado).
 */
async function escribirRenglones(recepcionId, actualizaciones) {
  const conflictos = [];
  for (let i = 0; i < actualizaciones.length; i += LOTE_ESCRITURAS) {
    const lote = actualizaciones.slice(i, i + LOTE_ESCRITURAS);
    const respuestas = await Promise.all(
      lote.map(({ id, cambios, updated_at }) =>
        supabase
          .from(TABLE_ITEMS)
          .update(cambios)
          .eq("id", id)
          .eq("recepcion_id", recepcionId)
          .eq("updated_at", updated_at)
          .select("id"),
      ),
    );
    respuestas.forEach(({ data, error }, n) => {
      if (esRecepcionNoBorrador(error)) throw errorNoBorrador();
      if (error) fallo(error, "Error al guardar los renglones");
      if (!data?.length) conflictos.push(lote[n].id);
    });
  }
  return conflictos;
}

/**
 * Autoguardado del borrador.
 *
 * Body validado: `{ editado_por, observaciones?, items: [{ id, cantidad?, valor?,
 * valor_fuente?, cantidad_devuelta?, motivo_devolucion?, confirmar_exceso?,
 * confirmar_valor? }] }` (`confirmar_valor` = unitario confirmado, como texto de plata).
 *
 * La cabecera se actualiza de forma CONDICIONAL (`estado = 'Borrador'`) y los
 * renglones quedan protegidos por el trigger de la base; solo se escribe lo que
 * cambió. Lo que no se pudo aplicar no hace fallar el guardado: vuelve en
 * `pendientes` con el resto ya guardado.
 *
 * @returns {{recepcion: object, pendientes: object[], ignorados: *[], avisos: object[]}}
 */
export async function guardar(id, { editado_por, observaciones, items: entradas = [] }) {
  const cabecera = await leerCabecera(id);
  if (cabecera.estado !== ESTADOS.BORRADOR) throw errorNoBorrador();

  const actuales = await leerItems(id);
  const plan = planearGuardado({ items: actuales, entradas, por: editado_por });

  // Cabecera: solo `observaciones`, y solo si cambió. La condición de estado va
  // en el propio UPDATE: si alguien firmó entre la lectura y acá, son 0 filas.
  // Las observaciones se recortan a su tope en vez de rechazar el guardado.
  const textoObservaciones = normalizarObservaciones(observaciones);
  if (observaciones !== undefined && textoObservaciones !== (cabecera.observaciones || null)) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ observaciones: textoObservaciones })
      .eq("id", id)
      .eq("estado", ESTADOS.BORRADOR)
      .select("id");
    if (error) fallo(error, "Error al guardar la recepción");
    if (!data?.length) throw errorNoBorrador();
  }

  let rechazos = plan.rechazos;
  const conflictos = await escribirRenglones(id, plan.actualizaciones);

  // Renglones que otro guardado tocó entre la lectura y la escritura: UNA segunda
  // vuelta, releyendo lo que hay ahora y replaneando solo esos renglones. Si aún
  // chocan, van a `pendientes` como "conflicto" (200): el resto ya se guardó y no
  // se tira toda la petición por uno.
  if (conflictos.length) {
    const vigente = await leerCabecera(id); // 404 si la descartaron
    if (vigente.estado !== ESTADOS.BORRADOR) throw errorNoBorrador();
    const reintento = planearReintento({
      conflictos,
      frescos: await leerItems(id),
      entradas,
      por: editado_por,
    });
    const conflictosFinales = await escribirRenglones(id, reintento.actualizaciones);
    rechazos = resolverRechazos({ rechazos, conflictos, reintento, conflictosFinales });
  }

  // Se devuelve lo que QUEDÓ en la base (no el plan): el cliente sobrescribe sus
  // campos con esto, y el trigger de sql/022 pudo tocar `updated_at`.
  const recepcion = await obtener(id);
  return {
    recepcion,
    pendientes: calcularPendientes(recepcion.items, rechazos),
    ignorados: plan.ignorados,
    avisos: avisosDeFactura(recepcion.factura),
  };
}

// ─── Descartar ─────────────────────────────────────────────────────────────

/**
 * Descarta un borrador: deja de existir (los renglones caen en cascada). Solo en
 * Borrador y de forma condicional en el propio DELETE: con la firma puesta la
 * recepción es un documento, no un borrador, y 0 filas borradas es un 409.
 *
 * Es el mismo camino para el recibidor que abrió por error y para el admin que
 * descarta un borrador viejo de otra sede.
 */
export async function descartar(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("estado", ESTADOS.BORRADOR)
    .select("id");
  if (error) fallo(error, "Error al descartar la recepción");
  if (data?.length) return { id: data[0].id };

  // 0 filas: no existe, o ya no es borrador. Se distingue para decirle la verdad.
  const { data: existente, error: errorLectura } = await supabase
    .from(TABLE)
    .select("id, estado")
    .eq("id", id)
    .maybeSingle();
  if (errorLectura) fallo(errorLectura, "Error al leer la recepción");
  if (!existente) throw createError(404, "Recepción no encontrada.");
  throw createError(
    409,
    `Solo se puede descartar un borrador: esta recepción está en "${existente.estado}".`,
    "RECEPCION_NO_BORRADOR",
  );
}

// ─── Finalizar ─────────────────────────────────────────────────────────────

/** Lo que devuelve `finalizar`: la recepción como la ve el recibidor (SIN firma ni cédula) y su resumen. */
async function resultadoFinalizar(id, yaFinalizada) {
  const recepcion = await obtener(id);
  return { recepcion, resumen: resumenRecepcion(recepcion.items), yaFinalizada };
}

/**
 * El UPDATE condicional no encontró la fila que se leyó (0 filas). Se vuelve a
 * leer el estado para decir la verdad:
 *
 *   · ya está firmada → alguien (casi siempre un reintento de esta misma pantalla)
 *     la finalizó entre medio: es el camino de reintento, NO un error;
 *   · sigue en Borrador → alguien la editó mientras se firmaba: 409, hay que
 *     revisar y firmar de nuevo;
 *   · anulada → 409; desapareció (la descartaron) → 404 desde `leerCabecera`.
 */
async function resolverTrasConflicto(id) {
  const vigente = await leerCabecera(id);
  const decision = decidirFinalizar(vigente.estado);
  if (decision.accion === "reintento") return resultadoFinalizar(id, true);
  if (decision.accion === "rechazar") throw createError(decision.status, decision.mensaje, decision.codigo);
  throw createError(409, MENSAJE_CAMBIO_AL_FINALIZAR, "RECEPCION_CAMBIO");
}

/**
 * Firma la recepción: Borrador → Finalizada.
 *
 * Orden (el de la cabecera ANTES que el de los renglones es a propósito): se lee la
 * cabecera y se guarda su `updated_at` CRUDO (texto, nunca un Date); recién después
 * se leen los renglones. El guardián de sql/022 toca el `updated_at` de la cabecera
 * en cada escritura de un renglón, así que si un autoguardado se cuela entre las dos
 * lecturas, el `updated_at` leído queda viejo y el UPDATE final no encuentra la fila
 * — nunca se firma sobre renglones distintos a los que se validaron.
 *
 *   1. Cabecera. Si ya está firmada: reintento (devuelve el estado, NO vuelve a
 *      firmar). Anulada: 409.
 *   2. Renglones y `validarRecepcion` sobre lo que HAY EN LA BASE (422 con el
 *      detalle por renglón). Plata y cantidades del cliente no entran.
 *   3. Recibidor (de la lista: snapshot desde la base; "Otro": nombre + cédula) y
 *      firma (PNG en data URL, acotada).
 *   4. Snapshots de proveedor y sede refrescados desde los maestros.
 *   5. UPDATE condicional `estado = 'Borrador' AND updated_at = <leído>` que escribe
 *      todo junto. 0 filas → `resolverTrasConflicto`.
 *
 * @param {number|string} id
 * @param {{recibido_por: string, recibidor?: object, firma_data?: string}} cuerpo
 * @returns {{recepcion: object, resumen: object, yaFinalizada: boolean}}
 */
export async function finalizar(id, { recibido_por, recibidor, firma_data }, ahora = new Date()) {
  // 1. Cabecera primero.
  const cabecera = await leerCabecera(id);
  const decision = decidirFinalizar(cabecera.estado);
  if (decision.accion === "rechazar") throw createError(decision.status, decision.mensaje, decision.codigo);
  // Ya firmada: se ignoran firma y recibidor del cuerpo. No se reescribe nada.
  if (decision.accion === "reintento") return resultadoFinalizar(id, true);

  // 2. Renglones, y la validación completa sobre la base.
  const items = await leerItems(id);
  const validacion = validarRecepcion(items);
  if (!validacion.ok) {
    const e = createError(422, "Hay renglones por corregir antes de firmar.", "RECEPCION_INVALIDA");
    e.detalle = { errores: validacion.errores, generales: validacion.generales };
    throw e;
  }

  // 3. Recibidor y firma.
  const idListado = idRecibidorListado(recibidor);
  const fila = idListado === null ? null : await RecibidorModel.obtenerPorId(idListado);
  const quien = armarRecibidor({ recibidor, fila });
  if (!quien.ok) throw createError(quien.status, quien.mensaje, quien.codigo);

  const firma = validarFirma(firma_data);
  if (!firma.ok) throw createError(400, firma.mensaje, firma.codigo);

  // 4. Snapshots frescos de los maestros (si el maestro ya no existe se deja el que hay).
  const [respuestaProveedor, respuestaSede] = await Promise.all([
    supabase
      .from("carnes_proveedores")
      .select("nit, sucursal, razon_social")
      .eq("id", cabecera.proveedor_id)
      .maybeSingle(),
    supabase
      .from("carnes_sedes")
      .select("codigo_co, bodega_siesa")
      .eq("id", cabecera.sede_id)
      .maybeSingle(),
  ]);
  if (respuestaProveedor.error) fallo(respuestaProveedor.error, "Error al leer el proveedor");
  if (respuestaSede.error) fallo(respuestaSede.error, "Error al leer la sede");

  const cambios = armarActualizacionFinalizar({
    valores: quien.valores,
    firma: firma_data,
    por: recibido_por,
    proveedor: respuestaProveedor.data || undefined,
    sede: respuestaSede.data || undefined,
    ahora,
  });

  // 5. Un solo UPDATE, condicional a Borrador Y a que nadie la haya tocado.
  const { data, error } = await supabase
    .from(TABLE)
    .update(cambios)
    .eq("id", id)
    .eq("estado", ESTADOS.BORRADOR)
    .eq("updated_at", cabecera.updated_at)
    .select("id");
  if (error) fallo(error, "Error al finalizar la recepción");
  if (!data?.length) return resolverTrasConflicto(id);

  return resultadoFinalizar(id, false);
}
