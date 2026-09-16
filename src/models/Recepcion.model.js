import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import * as SedeModel from "./Sede.model.js";
import * as PlantillaModel from "./Plantilla.model.js";
import {
  ESTADOS,
  validarTransicion,
  puedeEditarCantidades,
} from "../shared/estados.js";

const TABLE = "carnes_recepciones";
const TABLE_ITEMS = "carnes_recepcion_items";

/** La cabecera siempre viaja con su sede: el front nunca muestra un id pelado. */
const SELECT_CABECERA = `
  *,
  sede:carnes_sedes ( id, codigo_co, nombre )
`;

// ─── Lectura ───────────────────────────────────────────────────────────────

/** Una recepción con todos sus renglones, en el orden en que los ve el recibidor. */
export async function obtener(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_CABECERA)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la recepción: ${error.message}`);
  if (!data) throw createError(404, "Recepción no encontrada.");

  const { data: items, error: errorItems } = await supabase
    .from(TABLE_ITEMS)
    .select("*")
    .eq("recepcion_id", id)
    .order("tipo")
    .order("orden")
    .order("id");
  if (errorItems) {
    throw new Error(`Error al leer los renglones: ${errorItems.message}`);
  }

  return { ...data, items: items || [] };
}

/**
 * Listado para el panel del admin.
 *
 * `estado` acepta varios separados por coma porque la pantalla natural del admin
 * es "lo que tengo pendiente" — Recibido y Rechazado a la vez — y no una lista
 * por estado.
 */
export async function listar({
  estado,
  especie,
  sede_id,
  liquidacion_id,
  desde,
  hasta,
  limite = 100,
} = {}) {
  let q = supabase
    .from(TABLE)
    .select(SELECT_CABECERA)
    .order("fecha_ingreso", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(Number(limite) || 100, 500));

  if (estado) {
    const estados = String(estado)
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    q = estados.length > 1 ? q.in("estado", estados) : q.eq("estado", estados[0]);
  }
  if (especie) q = q.eq("especie", especie);
  if (sede_id) q = q.eq("sede_id", sede_id);
  if (liquidacion_id) q = q.eq("liquidacion_id", liquidacion_id);
  if (desde) q = q.gte("fecha_ingreso", desde);
  if (hasta) q = q.lte("fecha_ingreso", hasta);

  const { data, error } = await q;
  if (error) throw new Error(`Error al listar recepciones: ${error.message}`);
  return data || [];
}

// ─── Apertura ──────────────────────────────────────────────────────────────

/**
 * Arma los renglones iniciales copiando la plantilla activa de la especie.
 *
 * Se COPIAN, no se referencian: `costo_base` queda congelado en el renglón. Si
 * el admin corrige un precio la semana que viene, esta recepción tiene que
 * seguir valiendo lo que valía el día que llegó la carne.
 *
 * Todos arrancan en cantidad 0 y el recibidor solo escribe donde llegó algo. Es
 * más rápido que buscar y agregar ítem por ítem, y —más importante— deja ver de
 * un vistazo QUÉ NO LLEGÓ: un renglón en cero es información; un renglón ausente
 * es una duda.
 */
async function renglonesDesdePlantilla(especie) {
  const [items, viceras] = await Promise.all([
    PlantillaModel.listar("items", especie),
    PlantillaModel.listar("viceras", especie),
  ]);

  const filas = items.map((i) => ({
    tipo: "carne",
    plantilla_item_id: i.id,
    codigo_item: i.codigo_item,
    codigo_tabla: i.codigo_tabla,
    descripcion: i.descripcion,
    orden: i.orden,
    cantidad: 0,
    costo_base: i.costo_base,
  }));

  // Solo el bloque de bonificación: el informativo no toca plata y en el Excel
  // se calcula por novillo, no se recibe renglón por renglón.
  for (const v of viceras.filter((v) => v.bloque === "bonificacion")) {
    filas.push({
      tipo: "vicera",
      vicera_item_id: v.id,
      descripcion: v.nombre,
      orden: v.orden,
      cantidad: 0,
      costo_base: v.precio,
    });
  }

  return filas;
}

/**
 * Abre (o recupera) el borrador del recibidor.
 *
 * Verifica el QR ANTES de crear nada: la sede es la primera cosa que tiene que
 * estar bien, porque todo lo demás cuelga de ella.
 *
 * Si ya existe un borrador de la misma especie, sede y fecha, lo DEVUELVE en vez
 * de crear otro. El recibidor trabaja en un celular, en una cava, con las manos
 * mojadas: recargar la pantalla es lo más normal del mundo, y sin esto cada
 * recarga dejaba un borrador huérfano más. Al admin le llegarían cinco
 * recepciones vacías de la misma sede el mismo día.
 *
 * @returns {{recepcion: object, reanudada: boolean, verificacion: object}}
 */
export async function abrir({
  especie,
  sede_id,
  qr_token,
  recibido_por,
  fecha_ingreso,
  novillos = 0,
}) {
  const verificacion = await SedeModel.verificarQr(sede_id, qr_token);
  if (verificacion.estado !== "ok") {
    // 409 y no 400: el cuerpo es válido, lo que no cuadra es el estado del mundo
    // —el recibidor no está donde dijo que estaba—. El front necesita
    // distinguirlo de un error de formulario para mostrar el mensaje del QR.
    const e = createError(409, mensajeVerificacion(verificacion));
    e.verificacion = verificacion;
    throw e;
  }

  const fecha = fecha_ingreso || new Date().toISOString().slice(0, 10);

  // Se buscan los DOS estados que el recibidor todavía puede tocar.
  //
  // El rechazado importa tanto como el borrador: sin él, el admin rechazaba con
  // un motivo, el recibidor volvía a escanear, y como una rechazada no es un
  // borrador se le abría una recepción NUEVA. Resultado: el motivo no lo leía
  // nadie y quedaban dos documentos de la misma sede el mismo día. El rechazo
  // era un callejón sin salida.
  const { data: candidatas, error: errorBusca } = await supabase
    .from(TABLE)
    .select("id, estado, motivo_rechazo")
    .eq("especie", especie)
    .eq("sede_id", sede_id)
    .eq("fecha_ingreso", fecha)
    .in("estado", [ESTADOS.BORRADOR, ESTADOS.RECHAZADO])
    .order("id", { ascending: false });
  if (errorBusca) {
    throw new Error(`Error al buscar el borrador: ${errorBusca.message}`);
  }

  // Si por lo que fuera hubiera de los dos, gana el borrador: es donde está el
  // trabajo en curso.
  const existente =
    (candidatas || []).find((c) => c.estado === ESTADOS.BORRADOR) || (candidatas || [])[0];

  if (existente) {
    if (existente.estado === ESTADOS.RECHAZADO) {
      // Vuelve a Borrador para que se pueda corregir. El `motivo_rechazo` NO se
      // borra acá: el recibidor lo tiene que seguir viendo mientras arregla.
      // Se limpia recién al volver a cerrar (ver `finalizar`).
      await cambiarEstado(existente.id, ESTADOS.BORRADOR);
      return {
        recepcion: await obtener(existente.id),
        reanudada: true,
        rechazada: true,
        motivoRechazo: existente.motivo_rechazo,
        verificacion,
      };
    }
    return { recepcion: await obtener(existente.id), reanudada: true, verificacion };
  }

  const { data: cabecera, error } = await supabase
    .from(TABLE)
    .insert({
      especie,
      sede_id,
      fecha_ingreso: fecha,
      novillos,
      estado: ESTADOS.BORRADOR,
      recibido_por,
      sede_verificada: true,
      sede_verificada_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Error al abrir la recepción: ${error.message}`);

  const filas = await renglonesDesdePlantilla(especie);
  if (filas.length) {
    const { error: errorItems } = await supabase
      .from(TABLE_ITEMS)
      .insert(filas.map((f) => ({ ...f, recepcion_id: cabecera.id })));
    if (errorItems) {
      // La cabecera sin renglones es una pantalla vacía que no se puede usar y
      // que igual le aparece al admin. Se limpia acá porque no hay transacción:
      // Supabase por HTTP no puede deshacer el insert anterior solo.
      await supabase.from(TABLE).delete().eq("id", cabecera.id);
      throw new Error(`Error al cargar la plantilla: ${errorItems.message}`);
    }
  }

  return { recepcion: await obtener(cabecera.id), reanudada: false, verificacion };
}

/** Texto para una persona a partir del resultado de `verificarQr`. */
function mensajeVerificacion({ estado, sede }) {
  if (estado === "desconocido") {
    return (
      "Ese código QR no está registrado. Verificá que sea el de la zona de " +
      "recibo y no otro adhesivo."
    );
  }
  if (estado === "sede_inactiva") {
    return `El QR corresponde a ${sede.nombre}, que está inactiva. Avisale al administrador.`;
  }
  return (
    `El QR que escaneaste es de ${sede.nombre}. Cambiá la sede seleccionada ` +
    "o escaneá el código de la sede donde estás."
  );
}

// ─── Edición del borrador ──────────────────────────────────────────────────

/**
 * ¿El error es "esa columna no existe"?
 *
 * Postgres devuelve `42703` (undefined_column) y PostgREST `PGRST204` cuando su
 * cache de esquema todavía no la conoce. Se mira también el mensaje porque el
 * código no siempre viaja.
 */
function esColumnaFaltante(error, columna) {
  const codigo = error?.code || "";
  const mensaje = String(error?.message || "");
  return (
    (codigo === "42703" || codigo === "PGRST204" || /column .* does not exist/i.test(mensaje)) &&
    mensaje.includes(columna)
  );
}

/** Trae la recepción y falla si no se puede editar. Guard compartido. */
async function exigirBorrador(id) {
  const recepcion = await obtener(id);
  if (!puedeEditarCantidades(recepcion.estado)) {
    throw createError(
      409,
      `La recepción ya no se puede editar: está en "${recepcion.estado}".`,
    );
  }
  return recepcion;
}

/**
 * Guarda las cantidades del borrador.
 *
 * Body: `{ novillos?, observaciones?, items: [{ id, cantidad }] }`
 *
 * Los renglones se escriben con UN solo `upsert` y no con un `update` por fila:
 * son 38 en res, y 38 viajes de ida y vuelta desde un celular con señal de cava
 * es la diferencia entre guardar y no guardar. Como el upsert necesita las
 * columnas obligatorias, se reconstruyen desde la fila que ya está en memoria —
 * por eso se lee la recepción completa primero.
 *
 * Un `id` que no pertenece a esta recepción se IGNORA en silencio en vez de
 * fallar: la lista que manda el front puede venir de una pantalla vieja, y
 * rechazar el guardado entero por un renglón de más le haría perder al recibidor
 * todo lo que digitó.
 */
export async function guardarBorrador(id, { novillos, observaciones, items = [] }) {
  const recepcion = await exigirBorrador(id);

  const porId = new Map(recepcion.items.map((i) => [String(i.id), i]));
  const filas = [];

  for (const entrada of items) {
    const actual = porId.get(String(entrada.id));
    if (!actual) continue;

    filas.push({
      id: actual.id,
      recepcion_id: recepcion.id,
      tipo: actual.tipo,
      plantilla_item_id: actual.plantilla_item_id,
      vicera_item_id: actual.vicera_item_id,
      codigo_item: actual.codigo_item,
      codigo_tabla: actual.codigo_tabla,
      descripcion: actual.descripcion,
      orden: actual.orden,
      costo_base: actual.costo_base,
      cantidad: Number(entrada.cantidad) || 0,
    });
  }

  if (filas.length) {
    const { error } = await supabase.from(TABLE_ITEMS).upsert(filas);
    if (error) throw new Error(`Error al guardar las cantidades: ${error.message}`);
  }

  const cambios = {};
  if (novillos !== undefined) cambios.novillos = Number(novillos) || 0;
  if (observaciones !== undefined) cambios.observaciones = observaciones;

  // `iniciado_at` marca cuándo EMPEZÓ de verdad la recepción: el primer
  // guardado que trae una cantidad mayor a cero.
  //
  // No sirve `created_at` para esto. Alguien escanea el QR a las 8 solo para
  // ver cómo funciona, y a las 2 llega el camión: `created_at` diría que la
  // recepción arrancó seis horas antes de que hubiera carne.
  //
  // Se escribe UNA sola vez —solo si estaba en null— para que corregir una
  // cantidad tres horas después no mueva la hora de inicio.
  const hayCantidad = filas.some((f) => Number(f.cantidad) > 0);
  if (hayCantidad && !recepcion.iniciado_at) {
    cambios.iniciado_at = new Date().toISOString();
  }

  if (Object.keys(cambios).length) {
    const { error } = await supabase.from(TABLE).update(cambios).eq("id", id);

    // `iniciado_at` lo agrega la migración 003. Vercel despliega solo al hacer
    // push, así que el código puede llegar antes que el SQL — y si eso rompiera
    // el guardado, el recibidor se quedaría sin poder trabajar en plena jornada
    // por una columna que solo sirve para informar una hora.
    //
    // Se reintenta sin ella y se avisa en el log. Cuando la migración corra,
    // empieza a llenarse sola. Es la única columna con este trato: las demás son
    // datos que el documento necesita.
    if (error && esColumnaFaltante(error, "iniciado_at")) {
      console.warn(
        "⚠️  Falta la columna `iniciado_at` — corré sql/003_iniciado_at.sql. " +
          "Mientras tanto se guarda sin la hora de inicio.",
      );
      const { iniciado_at: _, ...sinColumna } = cambios;
      if (Object.keys(sinColumna).length) {
        const { error: e2 } = await supabase.from(TABLE).update(sinColumna).eq("id", id);
        if (e2) throw new Error(`Error al guardar la recepción: ${e2.message}`);
      }
    } else if (error) {
      throw new Error(`Error al guardar la recepción: ${error.message}`);
    }
  }

  return obtener(id);
}

/**
 * Agrega un renglón fuera de plantilla — la opción "Otro / Agregar".
 *
 * `codigo_item` queda NULL a propósito: el recibidor no sabe el código de SIESA
 * ni tiene por qué. Lo homologa el admin antes de subir, y hasta entonces el
 * NULL es la señal de que falta hacerlo. Inventar un código acá —o copiar el de
 * un ítem parecido— haría que el renglón pase desapercibido y entre al ERP como
 * otro producto.
 *
 * `orden` se manda al final para que los agregados no se mezclen con la lista
 * que el admin ordenó.
 */
export async function agregarAdicional(id, { descripcion, cantidad = 0 }) {
  await exigirBorrador(id);

  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .insert({
      recepcion_id: id,
      tipo: "adicional",
      descripcion: String(descripcion).trim(),
      cantidad: Number(cantidad) || 0,
      costo_base: 0,
      orden: 9999,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Error al agregar el ítem: ${error.message}`);
  return data;
}

/**
 * Borra un renglón. SOLO los adicionales.
 *
 * Un ítem de plantilla no se borra: se deja en cero. Borrarlo perdería la
 * información de que ese corte NO llegó, que es justo lo que el admin necesita
 * ver — y además desalinearía esta recepción de las otras sedes del mismo lote.
 */
export async function eliminarItem(id, itemId) {
  const recepcion = await exigirBorrador(id);

  const item = recepcion.items.find((i) => String(i.id) === String(itemId));
  if (!item) throw createError(404, "Renglón no encontrado en esta recepción.");
  if (item.tipo !== "adicional") {
    throw createError(
      409,
      "Los ítems de la plantilla no se borran. Dejalos en 0 si no llegaron.",
    );
  }

  const { error } = await supabase.from(TABLE_ITEMS).delete().eq("id", itemId);
  if (error) throw new Error(`Error al borrar el renglón: ${error.message}`);
  return { eliminado: itemId };
}

/**
 * Le pone código de SIESA y costo base a un renglón que el recibidor agregó a
 * mano. Lo hace el ADMIN, después de que la recepción se cerró.
 *
 * Es la contraparte de que `agregarAdicional` deje `codigo_item` en NULL. Sin
 * este paso el renglón no puede subir al ERP, y el consolidado lo bloquea a
 * propósito (ver `adicionales_sin_codigo` en shared/consolidado.js).
 *
 * NO exige borrador —justamente ocurre después— pero sí bloquea una vez que la
 * recepción ya se subió: cambiarle el código a un renglón que ya está en SIESA
 * dejaría el documento de acá diciendo una cosa y el del ERP otra.
 *
 * `costo_base` es obligatorio y no puede quedar en 0: un adicional sin costo
 * entra al ERP valiendo cero y deja el margen de ese producto en 100%. Sube sin
 * error, así que no lo descubre nadie.
 */
export async function homologarAdicional(id, itemId, cambios) {
  const recepcion = await obtener(id);

  if (recepcion.estado === ESTADOS.ENVIADO_SIESA) {
    throw createError(
      409,
      "La recepción ya se subió a SIESA: no se le puede cambiar el código a un renglón.",
    );
  }

  const item = recepcion.items.find((i) => String(i.id) === String(itemId));
  if (!item) throw createError(404, "Renglón no encontrado en esta recepción.");
  if (item.tipo !== "adicional") {
    throw createError(
      409,
      "Solo se homologan los ítems que agregó el recibidor. Los de plantilla ya tienen código.",
    );
  }

  const limpio = {
    codigo_item: String(cambios.codigo_item).trim(),
    costo_base: Number(cambios.costo_base),
  };
  if (cambios.codigo_tabla !== undefined) limpio.codigo_tabla = cambios.codigo_tabla;
  if (cambios.descripcion !== undefined) limpio.descripcion = cambios.descripcion;

  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .update(limpio)
    .eq("id", itemId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Error al homologar el renglón: ${error.message}`);
  return data;
}

/**
 * El ADMIN corrige un renglón de una recepción ya cerrada.
 *
 * Cualquier columna que el recibidor pudo haber dejado mal: cantidad, costo
 * base, código de SIESA, descripción. Se permite en Recibido y Aprobado — la
 * recepción ya está en manos del admin— y se bloquea en los dos extremos:
 *
 *   · Borrador es del recibidor. Si el admin le mueve un número mientras digita,
 *     los dos terminan escribiendo sobre el mismo renglón sin saberlo.
 *   · Costeado y Enviado_SIESA ya movieron plata. Para tocar un costeado hay
 *     que reabrir la liquidación, que es el camino que además limpia los costos.
 *
 * Deja rastro (ver sql/006): la primera vez que cambia la cantidad se guarda la
 * original, y siempre queda quién y cuándo. Sin eso, el cruce contra el informe
 * del frigorífico compararía la planta contra lo que el admin quiso, no contra
 * lo que el recibidor contó.
 */
export async function editarItem(id, itemId, cambios, editadoPor) {
  const recepcion = await obtener(id);

  if (recepcion.estado === ESTADOS.BORRADOR) {
    throw createError(
      409,
      "El recibidor todavía está digitando esta recepción. Esperá a que la cierre, o rechazala con el motivo para que él corrija.",
    );
  }
  if (![ESTADOS.RECIBIDO, ESTADOS.APROBADO].includes(recepcion.estado)) {
    const porque =
      recepcion.estado === ESTADOS.ENVIADO_SIESA
        ? "ya se subió a SIESA"
        : recepcion.estado === ESTADOS.COSTEADO
          ? "ya está costeada: reabrí la liquidación para corregirla"
          : `está en ${recepcion.estado}`;
    throw createError(409, `No se puede editar: la recepción ${porque}.`);
  }

  const item = recepcion.items.find((i) => String(i.id) === String(itemId));
  if (!item) throw createError(404, "Renglón no encontrado en esta recepción.");

  const limpio = {};
  if (cambios.cantidad !== undefined) {
    limpio.cantidad = Number(cambios.cantidad);
    // Se guarda la original SOLO la primera vez. Si se corrige tres veces, lo que
    // interesa seguir sabiendo es qué dijo el recibidor, no qué dijo el admin
    // en su segundo intento.
    if (item.cantidad_original === null || item.cantidad_original === undefined) {
      if (Number(item.cantidad) !== limpio.cantidad) {
        limpio.cantidad_original = Number(item.cantidad);
      }
    }
  }
  if (cambios.costo_base !== undefined) limpio.costo_base = Number(cambios.costo_base);
  if (cambios.codigo_item !== undefined) {
    limpio.codigo_item = String(cambios.codigo_item ?? "").trim() || null;
  }
  if (cambios.descripcion !== undefined) {
    limpio.descripcion = String(cambios.descripcion).trim();
  }

  if (Object.keys(limpio).length === 0) return item;

  limpio.editado_por = editadoPor || null;
  limpio.editado_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .update(limpio)
    .eq("id", itemId)
    .select("*")
    .maybeSingle();

  const faltaMigracion =
    error &&
    ["cantidad_original", "editado_por", "editado_at"].some((c) => esColumnaFaltante(error, c));
  if (faltaMigracion) {
    throw createError(
      503,
      "A la base le falta la migración sql/006_edicion_admin.sql. Corrala en Supabase y volvé a intentar.",
    );
  }
  if (error) throw new Error(`Error al editar el renglón: ${error.message}`);
  return data;
}

/**
 * Descarta un borrador. Borra de verdad, con sus renglones.
 *
 * Existe porque la pantalla se abre con solo escanear un QR, y no todo escaneo
 * termina en una recepción: alguien prueba, alguien se equivoca de sede, alguien
 * escanea dos veces. Sin una forma de tirarlo, esos borradores se acumulan y le
 * ensucian al admin la lista de "En curso" — que es justamente la lista donde
 * tiene que poder confiar en que hay alguien trabajando.
 *
 * Se BORRA en vez de marcarse: un borrador sin cerrar no es un documento, no
 * tiene trazabilidad que preservar y nadie lo aprobó. Guardarlo "por las dudas"
 * solo mueve el problema de una lista a una tabla.
 *
 * Solo en Borrador: una vez cerrada hay un documento con firma de quién y
 * cuándo, y eso se rechaza, no se borra.
 */
export async function descartar(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, estado, sede:carnes_sedes ( nombre )")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la recepción: ${error.message}`);
  if (!data) throw createError(404, "Recepción no encontrada.");

  if (data.estado !== ESTADOS.BORRADOR) {
    throw createError(
      409,
      `Solo se pueden descartar borradores. Esta está en "${data.estado}": ` +
        "si hay algo mal, rechazala para que quede constancia del motivo.",
    );
  }

  // Los renglones se van solos por el ON DELETE CASCADE de la FK.
  const { error: errorBorrar } = await supabase.from(TABLE).delete().eq("id", id);
  if (errorBorrar) throw new Error(`Error al descartar: ${errorBorrar.message}`);

  console.log(`🗑️  Borrador #${id} (${data.sede?.nombre}) descartado.`);
  return { descartada: id };
}

// ─── Transiciones de estado ────────────────────────────────────────────────

/**
 * Cambia el estado validando la transición. Único punto por el que se mueve una
 * recepción — ver `shared/estados.js`.
 *
 * @param {number|string} id
 * @param {string} hacia
 * @param {object} [extra]  columnas a escribir junto con el estado
 */
export async function cambiarEstado(id, hacia, extra = {}) {
  const recepcion = await obtener(id);

  const { ok, motivo } = validarTransicion(recepcion.estado, hacia);
  if (!ok) throw createError(409, motivo);

  const { error } = await supabase
    .from(TABLE)
    .update({ estado: hacia, ...extra })
    .eq("id", id);
  if (error) throw new Error(`Error al cambiar el estado: ${error.message}`);

  return obtener(id);
}

/**
 * Cierra el borrador: Borrador → Recibido.
 *
 * Exige al menos un renglón con cantidad > 0. Una recepción vacía no es un
 * documento: es un borrador que alguien cerró sin querer, y llega al admin como
 * si fuera trabajo terminado.
 */
export async function finalizar(id, { recibido_por }) {
  const recepcion = await obtener(id);

  const conCantidad = recepcion.items.filter((i) => Number(i.cantidad) > 0);
  if (conCantidad.length === 0) {
    throw createError(
      409,
      "No se puede cerrar una recepción sin cantidades. Digitá lo que llegó.",
    );
  }

  return cambiarEstado(id, ESTADOS.RECIBIDO, {
    recibido_at: new Date().toISOString(),
    // Solo se pisa si vino: si el front no lo manda, vale el de la apertura.
    ...(recibido_por ? { recibido_por } : {}),
    // Un cierre nuevo después de un rechazo tiene que limpiar el motivo viejo,
    // o el admin vuelve a leer el reclamo de la vez pasada.
    motivo_rechazo: null,
  });
}

/** Recibido → Aprobado. */
export async function aprobar(id, { aprobado_por }) {
  return cambiarEstado(id, ESTADOS.APROBADO, {
    aprobado_por,
    aprobado_at: new Date().toISOString(),
  });
}

/** Recibido → Rechazado. El motivo es obligatorio y lo lee el recibidor. */
export async function rechazar(id, { aprobado_por, motivo }) {
  return cambiarEstado(id, ESTADOS.RECHAZADO, {
    aprobado_por,
    aprobado_at: new Date().toISOString(),
    motivo_rechazo: motivo,
  });
}

/**
 * Rechazado → Borrador, para que el recibidor corrija.
 *
 * El `motivo_rechazo` NO se borra acá: se borra al volver a cerrar. Mientras
 * corrige, el recibidor tiene que seguir viendo qué le reclamaron.
 */
export async function reabrir(id) {
  return cambiarEstado(id, ESTADOS.BORRADOR);
}

/** Aprobado → Recibido: deshacer una aprobación dada por error. */
export async function desaprobar(id) {
  return cambiarEstado(id, ESTADOS.RECIBIDO, {
    aprobado_por: null,
    aprobado_at: null,
  });
}
