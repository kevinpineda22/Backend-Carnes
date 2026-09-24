/**
 * Informe de desposte: subirlo, leerlo, cruzarlo.
 *
 * Toda la lógica de negocio vive en `shared/desposteParser.js` (leer el PDF) y
 * `shared/cruceDesposte.js` (comparar). Este archivo es el pegamento: Supabase,
 * Storage y el orden de las operaciones.
 *
 * ─── Dos momentos para subir la guía ──────────────────────────────────────
 *
 *   después  como siempre: desde el detalle de una recepción ya cerrada.
 *   antes    la guía ANTICIPADA (sql/013): el admin la sube apenas llega del
 *            frigorífico, eligiendo sede y fecha de entrega. Queda sin
 *            recepción, y se engancha sola cuando el recibidor cierra
 *            (`vincularAnticipada`), que es cuando se compara y, si la
 *            diferencia pasa el umbral, sale el correo.
 *
 * En los dos casos el recibidor no ve la guía: la anticipada no tiene
 * recepción hasta después del cierre, así que no hay pantalla suya que la
 * encuentre.
 */

import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { ESTADOS } from "../shared/estados.js";
import {
  fallarSiFaltaMigracion,
  esMigracionFaltante,
} from "../shared/migraciones.js";
import { parsearInformeDesposte } from "../shared/desposteParser.js";
import { cruzarDesposte, verificarIdentidad } from "../shared/cruceDesposte.js";
import { extraerTexto } from "../services/pdf.service.js";
import { notificarDiferenciaDesposte } from "../services/notificaciones.service.js";

const TABLA = "carnes_desposte_informes";
const TABLA_ITEMS = "carnes_desposte_items";

/** Bucket PRIVADO. Ver la nota al pie de sql/004_desposte.sql. */
const BUCKET = "carnes-desposte";

/** Duración de la URL firmada: cinco minutos, lo que tarda en abrirse. */
const SEGUNDOS_URL = 300;

/**
 * Estados en los que el admin puede adjuntar o reemplazar el informe.
 *
 * `Borrador` NO está, y es la regla que sostiene toda la función: mientras el
 * recibidor digita, el informe no puede existir. Si pudiera verlo, no contaría
 * la carne — la transcribiría, y el cruce terminaría comparando el PDF contra
 * sí mismo.
 *
 * `Costeado` y `Enviado_SIESA` tampoco: ahí el documento ya movió plata.
 */
const EDITABLES = new Set([
  ESTADOS.RECIBIDO,
  ESTADOS.APROBADO,
  ESTADOS.RECHAZADO,
]);

// ─── Storage ───────────────────────────────────────────────────────────────

/**
 * Se asegura de que el bucket exista, una sola vez por proceso.
 *
 * Se crea desde el código y no a mano para que desplegar esto no dependa de que
 * alguien se acuerde de un paso en un panel web. Si el bucket ya está, la
 * llamada devuelve un error de duplicado que se ignora a propósito.
 */
let bucketListo = false;
async function asegurarBucket() {
  if (bucketListo) return;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false, // prueba de auditoría, no una imagen de catálogo
    fileSizeLimit: "10MB",
    allowedMimeTypes: ["application/pdf"],
  });
  // "already exists" es el camino normal a partir del segundo informe.
  if (error && !/exist/i.test(error.message)) {
    throw new Error(`No se pudo preparar el almacenamiento: ${error.message}`);
  }
  bucketListo = true;
}

/**
 * Ruta determinista: una por recepción.
 *
 * Al reemplazar el informe se pisa el archivo anterior en vez de acumular
 * huérfanos. Subir de nuevo casi siempre significa "me equivoqué de archivo", y
 * en ese caso el anterior no solo no sirve: confunde.
 */
const rutaArchivo = (recepcionId) => `recepciones/${recepcionId}/informe.pdf`;

/** Una guía anticipada: una por sede, especie y fecha de entrega. */
const rutaAnticipada = (sedeId, especie, fecha) =>
  `anticipadas/${sedeId}/${especie}/${fecha}.pdf`;

const MIGRACIONES = [
  "sql/004_desposte.sql",
  "sql/005_desposte_forzar.sql",
  "sql/013_guia_anticipada.sql",
];

// ─── Lectura ───────────────────────────────────────────────────────────────

/** La recepción con su sede. Falla 404 si no existe. */
async function obtenerRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select(
      "*, sede:carnes_sedes ( id, codigo_co, nombre, subcliente_desposte )",
    )
    .eq("id", recepcionId)
    .maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer la recepción", [
      "sql/004_desposte.sql",
      "sql/005_desposte_forzar.sql",
    ]);
  if (!data) throw createError(404, "Recepción no encontrada.");
  return data;
}

/** Los renglones que digitó el recibidor. */
async function obtenerItemsRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepcion_items")
    .select("id, tipo, plantilla_item_id, codigo_item, descripcion, cantidad")
    .eq("recepcion_id", recepcionId);
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer los renglones", [
      "sql/004_desposte.sql",
      "sql/005_desposte_forzar.sql",
    ]);
  return data || [];
}

/**
 * El diccionario PDF → plantilla, para la especie de esta recepción.
 *
 * Si la migración 004 todavía no corrió, `nombre_desposte` no existe y la
 * consulta falla. Eso NO tiene que tumbar el cruce: se devuelve vacío y el
 * resultado degrada a "solo totales", que es exactamente el estado inicial
 * previsto. La alternativa —un 500— dejaría la pantalla en blanco por una
 * columna de catálogo.
 */
async function obtenerPlantilla(especie) {
  const { data, error } = await supabase
    .from("carnes_plantilla_items")
    .select("id, descripcion, codigo_item, nombre_desposte")
    .eq("especie", especie)
    .eq("activo", true);

  if (error) {
    console.warn(
      "⚠️  No se pudo leer `nombre_desposte` (¿falta correr sql/004_desposte.sql?). " +
        "El cruce va a mostrar solo totales.",
    );
    return [];
  }
  return data || [];
}

/** El informe guardado con sus líneas, o null. */
async function obtenerInforme(recepcionId) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("recepcion_id", recepcionId)
    .maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer el informe", [
      "sql/004_desposte.sql",
      "sql/005_desposte_forzar.sql",
    ]);
  if (!data) return null;

  const { data: items, error: errorItems } = await supabase
    .from(TABLA_ITEMS)
    .select("*")
    .eq("informe_id", data.id)
    .order("bloque")
    .order("orden");
  if (errorItems)
    fallarSiFaltaMigracion(errorItems, "Error al leer las líneas", [
      "sql/004_desposte.sql",
      "sql/005_desposte_forzar.sql",
    ]);

  return { ...data, items: items || [] };
}

/**
 * Reconstruye la forma que espera `cruzarDesposte` a partir de las filas.
 *
 * Las columnas de la base usan snake_case y el módulo puro usa camelCase. La
 * traducción va acá y no allá: el módulo puro no tiene por qué saber cómo se
 * llaman las columnas de Postgres.
 */
function aFormaDeParser(fila) {
  return {
    lote: fila.lote,
    fechaDesposte: fila.fecha_desposte,
    cliente: fila.cliente,
    subcliente: fila.subcliente,
    animales: fila.animales,
    items: (fila.items || []).map((i) => ({
      bloque: i.bloque,
      producto: i.producto,
      cantidadKg: Number(i.cantidad_kg) || 0,
      pesajes: i.pesajes,
      rendimientoPct: i.rendimiento_pct,
      promedioKg: i.promedio_kg,
      orden: i.orden,
    })),
    totales: {
      kgFinas: fila.kg_finas === null ? null : Number(fila.kg_finas),
      kgSubproductos:
        fila.kg_subproductos === null ? null : Number(fila.kg_subproductos),
      kgPesoPie: fila.kg_peso_pie,
      kgCanalCaliente: fila.kg_canal_caliente,
      kgCanalFria: fila.kg_canal_fria,
      kgDesposte: fila.kg_desposte,
      kgAprovechable: fila.kg_aprovechable,
      rendimientoPct: fila.rendimiento_pct,
      mermaKg: fila.merma_kg,
      mermaPct: fila.merma_pct,
    },
  };
}

/**
 * GET — el informe de una recepción y el cruce contra lo recibido.
 *
 * El cruce se calcula AL LEER, no se guarda. Los renglones de la recepción
 * pueden cambiar —el admin homologa un adicional, el recibidor corrige tras un
 * rechazo— y un cruce congelado quedaría mintiendo sin que nada lo delate.
 */
export async function obtener(recepcionId) {
  const recepcion = await obtenerRecepcion(recepcionId);
  const informe = await obtenerInforme(recepcionId);

  if (!informe) {
    return {
      informe: null,
      cruce: null,
      puedeAdjuntar: EDITABLES.has(recepcion.estado),
      estadoRecepcion: recepcion.estado,
    };
  }

  const [items, plantilla] = await Promise.all([
    obtenerItemsRecepcion(recepcionId),
    obtenerPlantilla(recepcion.especie),
  ]);

  const cruce = cruzarDesposte({
    informe: aFormaDeParser(informe),
    items,
    plantilla,
  });

  return {
    informe,
    cruce,
    puedeAdjuntar: EDITABLES.has(recepcion.estado),
    estadoRecepcion: recepcion.estado,
  };
}

/** URL firmada de corta duración para abrir el PDF. */
export async function urlArchivo(recepcionId) {
  const informe = await obtenerInforme(recepcionId);
  if (!informe)
    throw createError(404, "Esta recepción no tiene informe adjunto.");

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(informe.archivo_path, SEGUNDOS_URL);
  if (error) throw new Error(`No se pudo generar el enlace: ${error.message}`);

  return {
    url: data.signedUrl,
    expiraEn: SEGUNDOS_URL,
    nombre: informe.archivo_nombre,
  };
}

// ─── Escritura ─────────────────────────────────────────────────────────────

/**
 * Lee el PDF y lo entiende. Falla 422 si no trae productos: un escaneo o una
 * foto no tiene texto que extraer.
 */
async function leerPdf(buffer) {
  const { texto } = await extraerTexto(buffer);
  const parseado = parsearInformeDesposte(texto);
  if (parseado.items.length === 0) {
    throw createError(
      422,
      "No se pudo leer ningún producto del PDF. Si es un escaneo o una foto no " +
        "tiene texto que extraer: adjuntá el PDF original del frigorífico.",
    );
  }
  return { texto, parseado };
}

/** Las columnas del informe que salen del PDF. Iguales para los dos momentos. */
function columnasDelPdf(parseado, texto) {
  return {
    lote: parseado.lote,
    fecha_desposte: parseado.fechaDesposte,
    cliente: parseado.cliente,
    subcliente: parseado.subcliente,
    animales: parseado.animales,
    kg_finas: parseado.totales.kgFinas,
    kg_subproductos: parseado.totales.kgSubproductos,
    kg_peso_pie: parseado.totales.kgPesoPie,
    kg_canal_caliente: parseado.totales.kgCanalCaliente,
    kg_canal_fria: parseado.totales.kgCanalFria,
    kg_desposte: parseado.totales.kgDesposte,
    kg_aprovechable: parseado.totales.kgAprovechable,
    rendimiento_pct: parseado.totales.rendimientoPct,
    merma_kg: parseado.totales.mermaKg,
    merma_pct: parseado.totales.mermaPct,
    texto_extraido: texto,
  };
}

/**
 * Las líneas se reemplazan enteras. Un informe nuevo no tiene nada que
 * conservar del anterior: es otro documento.
 */
async function reemplazarLineas(informeId, parseado) {
  await supabase.from(TABLA_ITEMS).delete().eq("informe_id", informeId);
  const lineas = parseado.items.map((i) => ({
    informe_id: informeId,
    bloque: i.bloque,
    producto: i.producto,
    cantidad_kg: i.cantidadKg,
    pesajes: i.pesajes,
    rendimiento_pct: i.rendimientoPct,
    promedio_kg: i.promedioKg,
    orden: i.orden,
  }));
  const { error } = await supabase.from(TABLA_ITEMS).insert(lineas);
  if (error) fallarSiFaltaMigracion(error, "No se pudieron guardar las líneas", MIGRACIONES);
}

/** Sube el archivo al bucket, pisando el que hubiera en esa ruta. */
async function subirArchivo(ruta, buffer) {
  await asegurarBucket();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(ruta, buffer, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`No se pudo guardar el archivo: ${error.message}`);
}

/** Borra un archivo que quedó sin fila. Si falla, queda un huérfano: se avisa. */
async function borrarArchivo(ruta) {
  if (!ruta) return;
  const { error } = await supabase.storage.from(BUCKET).remove([ruta]);
  if (error) console.warn(`⚠️  Quedó el archivo huérfano ${ruta}: ${error.message}`);
}

/**
 * ¿Este lote ya está en otro informe? Devuelve el primero que encuentre, o null.
 *
 * `.limit(1)` y no `.maybeSingle()` a secas: desde la 005 el mismo lote puede
 * estar en más de una fila (forzado), y `maybeSingle` falla con dos.
 */
async function loteEnOtroInforme(lote, { excluirId } = {}) {
  if (!lote) return null;
  let q = supabase.from(TABLA).select("id, recepcion_id").eq("lote", lote).limit(1);
  if (excluirId) q = q.neq("id", excluirId);
  const { data } = await q.maybeSingle();
  return data || null;
}

/**
 * Adjunta (o reemplaza) el informe de una recepción.
 *
 * El orden importa: se PARSEA antes de guardar nada. Si el PDF no es el que
 * corresponde a esta sede, se rechaza sin haber escrito un byte — ni en Storage
 * ni en la base. Guardar primero y validar después dejaría archivos huérfanos
 * de cada intento fallido.
 *
 * @param {number} recepcionId
 * @param {{buffer: Buffer, nombre: string, subidoPor: string, forzar?: boolean}} p
 */
export async function adjuntar(
  recepcionId,
  { buffer, nombre, subidoPor, forzar = false },
) {
  const recepcion = await obtenerRecepcion(recepcionId);

  if (!EDITABLES.has(recepcion.estado)) {
    const porque =
      recepcion.estado === ESTADOS.BORRADOR
        ? "el recibidor todavía la está digitando. El informe se adjunta después " +
          "de que cierre, para que cuente la carne sin verlo."
        : `está en ${recepcion.estado} y ya no admite cambios.`;
    throw createError(409, `No se puede adjuntar el informe: ${porque}`);
  }

  // 1. Leer y entender el PDF.
  const { texto, parseado } = await leerPdf(buffer);
  const existente = await obtenerInforme(recepcionId);

  // 2. ¿Es de esta sede?
  const identidad = verificarIdentidad(
    parseado,
    recepcion.sede,
    recepcion.fecha_ingreso,
  );
  const sedeEquivocada = identidad.problemas.some(
    (p) => p.codigo === "sede_no_coincide",
  );
  if (sedeEquivocada && !forzar) {
    // 409 y no 400: la petición está bien formada, el conflicto es con el estado
    // del mundo. El front muestra el mensaje y ofrece adjuntar igual.
    const detalle = identidad.problemas.find(
      (p) => p.codigo === "sede_no_coincide",
    );
    throw createError(409, detalle.mensaje, "sede_no_coincide");
  }

  // 3. ¿Este lote ya está en otra recepción?
  //
  // Avisa fuerte, pero no es un muro: el informe es un contraste, no una fuente
  // de plata —no alimenta el costeo ni SIESA—, así que el mismo lote en dos
  // recepciones deja mal UN cruce, no la contabilidad. Frenar en seco a alguien
  // con el camión abierto es peor que dejarlo seguir con el aviso encima.
  const loteRepetido = await loteEnOtroInforme(parseado.lote, { excluirId: existente?.id });
  if (loteRepetido && !forzar) {
    throw createError(
      409,
      `El lote ${parseado.lote} ya está ${
        loteRepetido.recepcion_id
          ? `adjunto en la recepción #${loteRepetido.recepcion_id}`
          : "en una guía anticipada"
      }. O el informe está en la sede equivocada, o esta carne se contó dos veces.`,
      "lote_repetido",
    );
  }

  // 4. Recién ahora se toca el almacenamiento.
  const archivo_path = rutaArchivo(recepcionId);
  await subirArchivo(archivo_path, buffer);

  const fila = {
    recepcion_id: recepcionId,
    ...columnasDelPdf(parseado, texto),
    archivo_path,
    archivo_nombre: nombre || "informe.pdf",
    archivo_bytes: buffer.length,
    sede_coincide: identidad.sedeCoincide,
    fecha_coincide: identidad.fechaCoincide,
    // Que el admin haya pasado por encima de una advertencia es un HECHO de este
    // informe, no un estado del sistema. Se guarda en la fila, igual que
    // `sede_verificada` en la recepción.
    forzado: Boolean(forzar && (sedeEquivocada || loteRepetido)),
    subido_por: subidoPor || null,
    subido_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // `upsert` sobre `recepcion_id`: reemplazar es el caso normal.
  const { data: guardado, error } = await supabase
    .from(TABLA)
    .upsert(fila, { onConflict: "recepcion_id" })
    .select("id")
    .single();
  if (error)
    fallarSiFaltaMigracion(error, "No se pudo guardar el informe", [
      "sql/004_desposte.sql",
      "sql/005_desposte_forzar.sql",
    ]);

  await reemplazarLineas(guardado.id, parseado);

  // Si el informe anterior vivía en otra ruta (era una guía anticipada que se
  // había enganchado), ese archivo ya no tiene fila que lo use.
  if (existente?.archivo_path && existente.archivo_path !== archivo_path) {
    await borrarArchivo(existente.archivo_path);
  }

  const resultado = await obtener(recepcionId);

  // Si lo recibido se aparta del informe más del umbral, el admin se entera
  // por correo ahora — no cuando abra el panel. Best-effort: el correo no
  // puede hacer fallar el adjunto.
  let alerta = null;
  if (resultado.cruce?.totales?.alerta) {
    alerta = await notificarDiferenciaDesposte(
      recepcion,
      resultado.cruce,
      resultado.informe,
    );
  }

  return {
    ...resultado,
    alerta,
    // Las advertencias del PARSEO (formato raro, sumas que no cuadran) no
    // sobreviven a la ida y vuelta por la base, así que se devuelven en la
    // respuesta de la subida, que es cuando importan.
    advertenciasLectura: parseado.advertencias,
    identidad: [
      ...identidad.problemas,
      ...(forzar && loteRepetido
        ? [
            {
              codigo: "lote_repetido_forzado",
              mensaje:
                `Se adjuntó igual, pero el lote ${parseado.lote} también está en la ` +
                `recepción #${loteRepetido.recepcion_id}. Una de las dos tiene el ` +
                "informe que no le corresponde.",
            },
          ]
        : []),
    ],
  };
}

/** Quita el informe de una recepción: la fila, sus líneas y el archivo. */
export async function eliminar(recepcionId) {
  const recepcion = await obtenerRecepcion(recepcionId);
  if (!EDITABLES.has(recepcion.estado)) {
    throw createError(
      409,
      `No se puede quitar el informe: la recepción está en ${recepcion.estado}.`,
    );
  }

  const informe = await obtenerInforme(recepcionId);
  if (!informe)
    throw createError(404, "Esta recepción no tiene informe adjunto.");

  // Primero la fila. Si el borrado del archivo falla, queda un huérfano en
  // Storage —molesto pero inofensivo—; al revés quedaría una fila apuntando a
  // un archivo que ya no existe, y eso rompe la pantalla.
  const { error } = await supabase.from(TABLA).delete().eq("id", informe.id);
  if (error)
    fallarSiFaltaMigracion(error, "No se pudo quitar el informe", [
      "sql/004_desposte.sql",
      "sql/005_desposte_forzar.sql",
    ]);

  const { error: errorArchivo } = await supabase.storage
    .from(BUCKET)
    .remove([informe.archivo_path]);
  if (errorArchivo) {
    console.warn(
      `⚠️  Quedó el archivo huérfano ${informe.archivo_path}: ${errorArchivo.message}`,
    );
  }

  return { eliminado: true, recepcion_id: Number(recepcionId) };
}

// ─── Guía anticipada ───────────────────────────────────────────────────────

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET — las guías anticipadas que todavía esperan su recepción.
 *
 * Es una pantalla del ADMIN. Nada del recibidor llama a esto.
 */
export async function listarAnticipadas({ especie } = {}) {
  let q = supabase
    .from(TABLA)
    .select(
      "id, sede_id, especie, fecha_entrega, lote, fecha_desposte, subcliente, kg_finas, " +
        "archivo_nombre, subido_por, subido_at, forzado, sede:carnes_sedes ( id, nombre )",
    )
    .is("recepcion_id", null)
    .order("fecha_entrega", { ascending: false })
    .order("id", { ascending: false });
  if (especie) q = q.eq("especie", especie);
  const { data, error } = await q;
  if (error) fallarSiFaltaMigracion(error, "Error al listar las guías", MIGRACIONES);
  return data || [];
}

/**
 * POST — subir la guía antes de que exista (o de que cierre) la recepción.
 *
 * Según en qué punto esté la recepción de esa sede, especie y fecha:
 *
 *   no existe, o está en Borrador → queda ANTICIPADA, sin recepción. Se
 *       engancha y se compara cuando el recibidor cierre.
 *   ya cerrada (Aprobado…)        → se adjunta directo, como siempre, y se
 *       compara en el acto. Guardarla como anticipada la dejaría esperando un
 *       cierre que ya pasó.
 *   costeada o en SIESA           → no se puede: ese documento ya movió plata.
 *
 * Mismas advertencias que el adjunto de siempre (sede distinta, lote repetido),
 * con `forzar` para pasar por encima dejando rastro.
 *
 * @param {{ sedeId, especie, fecha, buffer, nombre, subidoPor, forzar }} p
 */
export async function subirAnticipada({ sedeId, especie, fecha, buffer, nombre, subidoPor, forzar = false }) {
  if (!Number.isInteger(sedeId) || sedeId <= 0) throw createError(400, "Falta elegir la sede.");
  if (!["res", "cerdo"].includes(especie)) throw createError(400, "La especie tiene que ser res o cerdo.");
  // Formato Y fecha real: "2026-02-30" pasa la regex pero no existe.
  const fechaValida =
    ES_FECHA.test(String(fecha ?? "")) &&
    new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) === fecha;
  if (!fechaValida) throw createError(400, "La fecha de entrega no es válida (AAAA-MM-DD).");

  const { data: sede, error: errorSede } = await supabase
    .from("carnes_sedes")
    .select("id, nombre, subcliente_desposte")
    .eq("id", sedeId)
    .maybeSingle();
  if (errorSede) fallarSiFaltaMigracion(errorSede, "Error al leer la sede", MIGRACIONES);
  if (!sede) throw createError(404, "Sede no encontrada.");

  // ¿Ya hay recepción de esa sede, especie y fecha? La más reciente manda.
  const { data: recepcion } = await supabase
    .from("carnes_recepciones")
    .select("id, estado")
    .eq("sede_id", sede.id)
    .eq("especie", especie)
    .eq("fecha_ingreso", fecha)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recepcion && EDITABLES.has(recepcion.estado)) {
    const r = await adjuntar(recepcion.id, { buffer, nombre, subidoPor, forzar });
    return { ...r, destino: "recepcion", recepcion_id: recepcion.id };
  }
  if (recepcion && recepcion.estado !== ESTADOS.BORRADOR) {
    throw createError(
      409,
      `La recepción de ${sede.nombre} de esa fecha ya está en ${recepcion.estado}: ` +
        "ya movió plata y no admite la guía.",
    );
  }

  const { texto, parseado } = await leerPdf(buffer);

  // La misma verificación que al adjuntar: contra la sede elegida y la fecha
  // de entrega. La fecha distinta es solo aviso (despostan un día antes).
  const identidad = verificarIdentidad(parseado, sede, fecha);
  const sedeEquivocada = identidad.problemas.some((p) => p.codigo === "sede_no_coincide");
  if (sedeEquivocada && !forzar) {
    const detalle = identidad.problemas.find((p) => p.codigo === "sede_no_coincide");
    throw createError(409, detalle.mensaje, "sede_no_coincide");
  }

  const { data: existente } = await supabase
    .from(TABLA)
    .select("id, archivo_path")
    .is("recepcion_id", null)
    .eq("sede_id", sede.id)
    .eq("especie", especie)
    .eq("fecha_entrega", fecha)
    .maybeSingle();

  const loteRepetido = await loteEnOtroInforme(parseado.lote, { excluirId: existente?.id });
  if (loteRepetido && !forzar) {
    throw createError(
      409,
      `El lote ${parseado.lote} ya está ${
        loteRepetido.recepcion_id
          ? `adjunto en la recepción #${loteRepetido.recepcion_id}`
          : "en otra guía anticipada"
      }. O la guía es de otra sede o fecha, o esta carne se contó dos veces.`,
      "lote_repetido",
    );
  }

  const archivo_path = rutaAnticipada(sede.id, especie, fecha);
  await subirArchivo(archivo_path, buffer);

  const fila = {
    recepcion_id: null,
    sede_id: sede.id,
    especie,
    fecha_entrega: fecha,
    ...columnasDelPdf(parseado, texto),
    archivo_path,
    archivo_nombre: nombre || "guia.pdf",
    archivo_bytes: buffer.length,
    // Se recalculan al engancharla a la recepción real.
    sede_coincide: identidad.sedeCoincide,
    fecha_coincide: identidad.fechaCoincide,
    forzado: Boolean(forzar && (sedeEquivocada || loteRepetido)),
    subido_por: subidoPor || null,
    subido_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Update o insert a mano: el índice único de 013 es PARCIAL, y un upsert
  // (ON CONFLICT) no puede apoyarse en un índice parcial.
  let guardado;
  if (existente) {
    const { data, error } = await supabase
      .from(TABLA)
      .update(fila)
      .eq("id", existente.id)
      .is("recepcion_id", null)
      .select("id")
      .maybeSingle();
    if (error) fallarSiFaltaMigracion(error, "No se pudo guardar la guía", MIGRACIONES);
    if (!data) {
      throw createError(409, "Justo se cerró la recepción y la guía anterior ya se enganchó. Actualizá.");
    }
    guardado = data;
  } else {
    const { data, error } = await supabase.from(TABLA).insert(fila).select("id").single();
    if (error) {
      if (error.code === "23505") {
        throw createError(409, "Otra persona subió una guía para esa sede y fecha al mismo tiempo. Actualizá.");
      }
      fallarSiFaltaMigracion(error, "No se pudo guardar la guía", MIGRACIONES);
    }
    guardado = data;
  }

  await reemplazarLineas(guardado.id, parseado);
  if (existente?.archivo_path && existente.archivo_path !== archivo_path) {
    await borrarArchivo(existente.archivo_path);
  }

  return {
    destino: "anticipada",
    guia: { id: guardado.id, sede: sede.nombre, especie, fecha_entrega: fecha, lote: parseado.lote },
    advertenciasLectura: parseado.advertencias,
    // "Fecha distinta" es lo normal acá: se despostó antes de la entrega. Y
    // "sede sin configurar" pide guardar el Sub Cliente en la sede, algo que
    // el panel ya no ofrece: la sede del PDF es solo informativa.
    identidad: identidad.problemas.filter(
      (p) => p.codigo !== "fecha_distinta" && p.codigo !== "sede_sin_configurar",
    ),
  };
}

/** Busca una guía anticipada que todavía no se enganchó. 404 si no. */
async function anticipadaPendiente(id) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, archivo_path, archivo_nombre, recepcion_id")
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la guía", MIGRACIONES);
  if (!data) throw createError(404, "Guía no encontrada.");
  return data;
}

/** URL firmada para abrir el PDF de una guía anticipada. */
export async function urlArchivoAnticipada(id) {
  const guia = await anticipadaPendiente(id);
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(guia.archivo_path, SEGUNDOS_URL);
  if (error) throw new Error(`No se pudo generar el enlace: ${error.message}`);
  return { url: data.signedUrl, expiraEn: SEGUNDOS_URL, nombre: guia.archivo_nombre };
}

/**
 * Quita una guía anticipada que todavía no se enganchó. Una vez enganchada es
 * el informe de la recepción, y se maneja desde ahí.
 */
export async function eliminarAnticipada(id) {
  const guia = await anticipadaPendiente(id);
  if (guia.recepcion_id) {
    throw createError(
      409,
      `Esta guía ya se enganchó a la recepción #${guia.recepcion_id}. Quitala desde esa recepción.`,
    );
  }
  const { data, error } = await supabase
    .from(TABLA)
    .delete()
    .eq("id", id)
    .is("recepcion_id", null)
    .select("id")
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "No se pudo quitar la guía", MIGRACIONES);
  if (!data) throw createError(409, "La guía se acaba de enganchar a su recepción. Actualizá.");
  await borrarArchivo(guia.archivo_path);
  return { eliminado: true, id: Number(id) };
}

/**
 * Al cerrar la recepción: engancha la guía anticipada de su sede, especie y
 * fecha, compara, y si la diferencia pasa el umbral le avisa al admin por
 * correo — sobre o falte.
 *
 * NUNCA lanza. La recepción ya está cerrada cuando se llama; un problema con la
 * guía no puede devolverle un error al recibidor, que está parado en la cava.
 * Y no le devuelve nada al recibidor tampoco: el resultado es para el log y
 * para el admin.
 */
export async function vincularAnticipada(recepcionId) {
  try {
    const recepcion = await obtenerRecepcion(recepcionId);

    const { data: guia, error } = await supabase
      .from(TABLA)
      .select("id, subcliente, fecha_desposte")
      .is("recepcion_id", null)
      .eq("sede_id", recepcion.sede_id)
      .eq("especie", recepcion.especie)
      .eq("fecha_entrega", String(recepcion.fecha_ingreso).slice(0, 10))
      .maybeSingle();
    if (error) {
      // Sin la 013 no hay guías anticipadas: no es un error del cierre.
      if (esMigracionFaltante(error)) return { estado: "sin_migracion" };
      throw error;
    }
    if (!guia) return { estado: "sin_guia" };

    // Si alguien ya le adjuntó un informe a mano, ese manda: el índice único
    // por recepción no deja dos. La anticipada queda esperando en la lista del
    // admin, que la ve y la quita; se deja en el log para que no pase callada.
    if (await obtenerInforme(recepcionId)) {
      console.warn(
        `⚠️  Guía anticipada #${guia.id} sin enganchar: la recepción #${recepcionId} ya tenía informe.`,
      );
      return { estado: "ya_tenia_informe" };
    }

    const identidad = verificarIdentidad(
      { subcliente: guia.subcliente, fechaDesposte: guia.fecha_desposte },
      recepcion.sede,
      recepcion.fecha_ingreso,
    );

    // Solo si sigue sin recepción: dos cierres no se la pueden llevar a la vez.
    const { data: enganchada, error: errorVinculo } = await supabase
      .from(TABLA)
      .update({
        recepcion_id: Number(recepcionId),
        sede_coincide: identidad.sedeCoincide,
        fecha_coincide: identidad.fechaCoincide,
        vinculado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", guia.id)
      .is("recepcion_id", null)
      .select("id")
      .maybeSingle();
    if (errorVinculo) throw errorVinculo;
    if (!enganchada) return { estado: "sin_guia" };

    const resultado = await obtener(recepcionId);
    const totales = resultado.cruce?.totales;
    let correo = null;
    if (totales?.alerta) {
      correo = await notificarDiferenciaDesposte(recepcion, resultado.cruce, resultado.informe);
    }
    console.log(
      `📄 Guía anticipada #${guia.id} → recepción #${recepcionId}` +
        (totales?.alerta ? ` · diferencia ${totales.diferencia} kg, aviso ${correo?.success ? "enviado" : "NO enviado"}` : ""),
    );
    return { estado: "vinculada", alerta: Boolean(totales?.alerta), correo };
  } catch (e) {
    console.error(`🔴 Guía anticipada, recepción #${recepcionId}: ${e.message}`);
    return { estado: "error", error: e.message };
  }
}
