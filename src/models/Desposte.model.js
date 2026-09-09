/**
 * Informe de desposte: subirlo, leerlo, cruzarlo.
 *
 * Toda la lógica de negocio vive en `shared/desposteParser.js` (leer el PDF) y
 * `shared/cruceDesposte.js` (comparar). Este archivo es el pegamento: Supabase,
 * Storage y el orden de las operaciones.
 */

import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { ESTADOS } from "../shared/estados.js";
import { parsearInformeDesposte } from "../shared/desposteParser.js";
import { cruzarDesposte, verificarIdentidad } from "../shared/cruceDesposte.js";
import { extraerTexto } from "../services/pdf.service.js";

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
const EDITABLES = new Set([ESTADOS.RECIBIDO, ESTADOS.APROBADO, ESTADOS.RECHAZADO]);

// ─── Migración ─────────────────────────────────────────────────────────────

/**
 * ¿Este error de Postgres es "todavía no corriste la migración 004"?
 *
 * Toda esta función depende de tablas y columnas que agregan `sql/004_desposte.sql`
 * y `sql/005_desposte_forzar.sql`.
 * Sin ese guard, el síntoma es un 500 con "Error interno del servidor" —el
 * `errorHandler` esconde los mensajes de Postgres a propósito, porque traen
 * nombres de tablas— y quien lo ve no tiene forma de saber que le falta correr
 * un archivo. Se traduce a un mensaje que dice exactamente qué hacer.
 *
 *   42P01 relación inexistente · 42703 columna inexistente
 *   PGRST205/204 lo mismo, visto desde PostgREST
 */
function esMigracionFaltante(error) {
  const codigo = error?.code || "";
  const mensaje = String(error?.message || "");
  return (
    ["42P01", "42703", "PGRST204", "PGRST205"].includes(codigo) ||
    /(relation|column|table).*(does not exist|not found)/i.test(mensaje) ||
    /schema cache/i.test(mensaje)
  );
}

/** Lanza el error de migración si corresponde; si no, propaga el original. */
function fallar(error, contexto) {
  if (esMigracionFaltante(error)) {
    throw createError(
      503,
      "A la base le falta parte del módulo de informes de desposte. " +
        "Corré sql/004_desposte.sql y sql/005_desposte_forzar.sql en Supabase " +
        "(en ese orden) y volvé a intentar.",
    );
  }
  throw new Error(`${contexto}: ${error.message}`);
}

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

// ─── Lectura ───────────────────────────────────────────────────────────────

/** La recepción con su sede. Falla 404 si no existe. */
async function obtenerRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select("*, sede:carnes_sedes ( id, codigo_co, nombre, subcliente_desposte )")
    .eq("id", recepcionId)
    .maybeSingle();
  if (error) fallar(error, "Error al leer la recepción");
  if (!data) throw createError(404, "Recepción no encontrada.");
  return data;
}

/** Los renglones que digitó el recibidor. */
async function obtenerItemsRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepcion_items")
    .select("id, tipo, plantilla_item_id, codigo_item, descripcion, cantidad")
    .eq("recepcion_id", recepcionId);
  if (error) fallar(error, "Error al leer los renglones");
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
  if (error) fallar(error, "Error al leer el informe");
  if (!data) return null;

  const { data: items, error: errorItems } = await supabase
    .from(TABLA_ITEMS)
    .select("*")
    .eq("informe_id", data.id)
    .order("bloque")
    .order("orden");
  if (errorItems) fallar(errorItems, "Error al leer las líneas");

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
      kgSubproductos: fila.kg_subproductos === null ? null : Number(fila.kg_subproductos),
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
  if (!informe) throw createError(404, "Esta recepción no tiene informe adjunto.");

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(informe.archivo_path, SEGUNDOS_URL);
  if (error) throw new Error(`No se pudo generar el enlace: ${error.message}`);

  return { url: data.signedUrl, expiraEn: SEGUNDOS_URL, nombre: informe.archivo_nombre };
}

// ─── Escritura ─────────────────────────────────────────────────────────────

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
export async function adjuntar(recepcionId, { buffer, nombre, subidoPor, forzar = false }) {
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
  const { texto } = await extraerTexto(buffer);
  const parseado = parsearInformeDesposte(texto);

  if (parseado.items.length === 0) {
    throw createError(
      422,
      "No se pudo leer ningún producto del PDF. Si es un escaneo o una foto no " +
        "tiene texto que extraer: adjuntá el PDF original del frigorífico.",
    );
  }

  // 2. ¿Es de esta sede?
  const identidad = verificarIdentidad(parseado, recepcion.sede, recepcion.fecha_ingreso);
  const sedeEquivocada = identidad.problemas.some((p) => p.codigo === "sede_no_coincide");
  if (sedeEquivocada && !forzar) {
    // 409 y no 400: la petición está bien formada, el conflicto es con el estado
    // del mundo. El front muestra el mensaje y ofrece adjuntar igual.
    const detalle = identidad.problemas.find((p) => p.codigo === "sede_no_coincide");
    throw createError(409, detalle.mensaje, "sede_no_coincide");
  }

  // 3. ¿Este lote ya está en otra recepción?
  //
  // Avisa fuerte, pero no es un muro: el informe es un contraste, no una fuente
  // de plata —no alimenta el costeo ni SIESA—, así que el mismo lote en dos
  // recepciones deja mal UN cruce, no la contabilidad. Frenar en seco a alguien
  // con el camión abierto es peor que dejarlo seguir con el aviso encima.
  let loteRepetido = null;
  if (parseado.lote) {
    const { data: repetido } = await supabase
      .from(TABLA)
      .select("id, recepcion_id")
      .eq("lote", parseado.lote)
      .neq("recepcion_id", recepcionId)
      .maybeSingle();
    if (repetido) {
      loteRepetido = repetido;
      if (!forzar) {
        throw createError(
          409,
          `El lote ${parseado.lote} ya está adjunto en la recepción #${repetido.recepcion_id}. ` +
            "O el informe está en la sede equivocada, o esta carne se contó dos veces.",
          "lote_repetido",
        );
      }
    }
  }

  // 4. Recién ahora se toca el almacenamiento.
  await asegurarBucket();
  const archivo_path = rutaArchivo(recepcionId);
  const { error: errorSubida } = await supabase.storage
    .from(BUCKET)
    .upload(archivo_path, buffer, { contentType: "application/pdf", upsert: true });
  if (errorSubida) {
    throw new Error(`No se pudo guardar el archivo: ${errorSubida.message}`);
  }

  const fila = {
    recepcion_id: recepcionId,
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
    archivo_path,
    archivo_nombre: nombre || "informe.pdf",
    archivo_bytes: buffer.length,
    texto_extraido: texto,
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
  if (error) fallar(error, "No se pudo guardar el informe");

  // Las líneas se reemplazan enteras. Un informe nuevo no tiene nada que
  // conservar del anterior — es otro documento.
  await supabase.from(TABLA_ITEMS).delete().eq("informe_id", guardado.id);

  const lineas = parseado.items.map((i) => ({
    informe_id: guardado.id,
    bloque: i.bloque,
    producto: i.producto,
    cantidad_kg: i.cantidadKg,
    pesajes: i.pesajes,
    rendimiento_pct: i.rendimientoPct,
    promedio_kg: i.promedioKg,
    orden: i.orden,
  }));
  const { error: errorItems } = await supabase.from(TABLA_ITEMS).insert(lineas);
  if (errorItems) fallar(errorItems, "No se pudieron guardar las líneas");

  const resultado = await obtener(recepcionId);
  return {
    ...resultado,
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
    throw createError(409, `No se puede quitar el informe: la recepción está en ${recepcion.estado}.`);
  }

  const informe = await obtenerInforme(recepcionId);
  if (!informe) throw createError(404, "Esta recepción no tiene informe adjunto.");

  // Primero la fila. Si el borrado del archivo falla, queda un huérfano en
  // Storage —molesto pero inofensivo—; al revés quedaría una fila apuntando a
  // un archivo que ya no existe, y eso rompe la pantalla.
  const { error } = await supabase.from(TABLA).delete().eq("id", informe.id);
  if (error) fallar(error, "No se pudo quitar el informe");

  const { error: errorArchivo } = await supabase.storage
    .from(BUCKET)
    .remove([informe.archivo_path]);
  if (errorArchivo) {
    console.warn(`⚠️  Quedó el archivo huérfano ${informe.archivo_path}: ${errorArchivo.message}`);
  }

  return { eliminado: true, recepcion_id: Number(recepcionId) };
}
