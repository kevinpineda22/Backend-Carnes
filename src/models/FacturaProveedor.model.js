import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { ESTADOS } from "../shared/estadosProveedor.js";
import { esConflictoReintentable } from "../shared/aperturaProveedor.js";
import {
  BUCKET_FACTURA,
  SEGUNDOS_URL_FACTURA,
  armarVinculacion,
  archivosPublicos,
  rutaFactura,
  validarSolicitudSubida,
} from "../shared/facturaProveedor.js";

/* =============================================
   Foto de la factura de una recepción de proveedor.

   Las REGLAS (cantidad, tipo, tamaño, rutas, qué exige finalizar) viven en
   `shared/facturaProveedor.js`, donde se prueban. Acá solo se habla con Storage y
   con la base. Ver ese archivo para el flujo completo (subida directa con URL
   firmada: Vercel no deja pasar 10 MB por una función).
   ============================================= */

const TABLE = "carnes_proveedor_recepciones";
const MIGRACIONES = ["sql/036_factura_proveedor.sql"];

function fallo(error, contexto) {
  if (esConflictoReintentable(error)) throw errorReintentable();
  return fallarSiFaltaMigracion(error, contexto, MIGRACIONES);
}

function errorReintentable() {
  return createError(
    409,
    "Otra persona estaba modificando esta recepción al mismo tiempo. Intenta de nuevo.",
    "REINTENTAR",
  );
}

function errorNoBorrador() {
  return createError(409, "La recepción ya no está en borrador", "RECEPCION_NO_BORRADOR");
}

async function leerCabecera(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, estado, updated_at, factura_archivos")
    .eq("id", id)
    .maybeSingle();
  if (error) fallo(error, "Error al leer la recepción");
  if (!data) throw createError(404, "Recepción no encontrada.");
  return { ...data, factura_archivos: Array.isArray(data.factura_archivos) ? data.factura_archivos : [] };
}

async function leerBorrador(id) {
  const cabecera = await leerCabecera(id);
  if (cabecera.estado !== ESTADOS.BORRADOR) throw errorNoBorrador();
  return cabecera;
}

/**
 * Escribe `factura_archivos` solo si la recepción SIGUE en Borrador y nadie la tocó
 * desde que se leyó (`updated_at`). 0 filas = otra persona la modificó: 409 que se
 * reintenta (o ya no es borrador, que se distingue releyendo).
 */
async function escribirArchivos(cabecera, archivos) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ factura_archivos: archivos })
    .eq("id", cabecera.id)
    .eq("estado", ESTADOS.BORRADOR)
    .eq("updated_at", cabecera.updated_at)
    .select("id");
  if (error) fallo(error, "Error al guardar la factura");
  if (data?.length) return;
  const vigente = await leerCabecera(cabecera.id);
  throw vigente.estado === ESTADOS.BORRADOR ? errorReintentable() : errorNoBorrador();
}

// ─── Subida ────────────────────────────────────────────────────────────────

/**
 * Paso 1: valida lo declarado y devuelve una URL firmada de subida por archivo.
 * Solo en Borrador. Nada se guarda en la base todavía.
 *
 * @returns {Promise<{subidas: {path: string, token: string, url: string, nombre: string, tipo: string}[]}>}
 */
export async function solicitarSubidas(id, { archivos }, ahora = new Date()) {
  const cabecera = await leerBorrador(id);
  const plan = validarSolicitudSubida({ existentes: cabecera.factura_archivos, archivos });
  if (!plan.ok) throw createError(plan.status, plan.mensaje, plan.codigo);

  const subidas = [];
  for (const [n, a] of plan.archivos.entries()) {
    const path = rutaFactura(id, n, a.ext, ahora);
    const { data, error } = await supabase.storage.from(BUCKET_FACTURA).createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(`No se pudo preparar la subida: ${error?.message || "sin respuesta de Storage"}`);
    }
    subidas.push({ path, token: data.token, url: data.signedUrl, nombre: a.nombre, tipo: a.tipo });
  }
  return { subidas };
}

/** Lo que HAY en Storage para esta recepción: nombre de archivo → metadata real. */
async function leerStorage(id) {
  const { data, error } = await supabase.storage
    .from(BUCKET_FACTURA)
    .list(`recepcion-${id}`, { limit: 1000 });
  if (error) throw new Error(`No se pudo leer el almacenamiento: ${error.message}`);
  return new Map((data || []).map((f) => [f.name, f.metadata || {}]));
}

/** Borra objetos del bucket sin fallar: un huérfano es tolerable, un error acá no. */
async function borrarObjetos(rutas) {
  if (!rutas.length) return;
  try {
    await supabase.storage.from(BUCKET_FACTURA).remove(rutas);
  } catch {
    /* huérfano tolerable */
  }
}

/**
 * Paso 3: vincula a la recepción los archivos que ya están en Storage. El tamaño y
 * el tipo salen de Storage, no del cliente. Idempotente: reconfirmar un archivo ya
 * vinculado no lo duplica.
 *
 * @returns {Promise<{factura_archivos: object[]}>} con la ruta (es del borrador de quien sube)
 */
export async function confirmar(id, { archivos, por }, ahora = new Date()) {
  const cabecera = await leerBorrador(id);
  const enStorage = await leerStorage(id);
  const plan = armarVinculacion({
    recepcionId: id,
    existentes: cabecera.factura_archivos,
    solicitados: archivos,
    enStorage,
    por,
    ahora,
  });
  if (!plan.ok) {
    // Un archivo que no cumple (tipo o tamaño reales) no debe quedarse en el bucket.
    await borrarObjetos(plan.rutasInvalidas || []);
    throw createError(plan.status, plan.mensaje, plan.codigo);
  }
  if (plan.nuevos.length) await escribirArchivos(cabecera, plan.archivos);
  return { factura_archivos: plan.archivos };
}

/** Quita un archivo del borrador (antes de firmar) y lo borra de Storage. */
export async function quitar(id, { path }) {
  const cabecera = await leerBorrador(id);
  if (!cabecera.factura_archivos.some((a) => a.path === path)) {
    throw createError(404, "Ese archivo no está en la factura.", "FACTURA_ARCHIVO_NO_ENCONTRADO");
  }
  const restantes = cabecera.factura_archivos.filter((a) => a.path !== path);
  await escribirArchivos(cabecera, restantes);
  await borrarObjetos([path]);
  return { factura_archivos: restantes };
}

/**
 * Al descartar un borrador se borran sus archivos del bucket (vinculados o no).
 * Mejor esfuerzo: si falla, quedan huérfanos y no pasa nada.
 */
export async function limpiarStorage(id) {
  try {
    const { data } = await supabase.storage.from(BUCKET_FACTURA).list(`recepcion-${id}`, { limit: 1000 });
    await borrarObjetos((data || []).map((f) => `recepcion-${id}/${f.name}`));
  } catch {
    /* mejor esfuerzo */
  }
}

// ─── Lectura (admin, contabilidad, logística) ──────────────────────────────

/**
 * Los archivos de la factura con URL firmada de corta duración, en el orden en que
 * se subieron. Solo lectura. Con `soloEnviada` (contabilidad y consulta) la recepción
 * tiene que estar en SIESA, igual que el acta: en cualquier otro estado, 404.
 *
 * @returns {Promise<{archivos: object[], expiraEn: number}>}
 */
export async function urlsDeFactura(id, { soloEnviada = false } = {}) {
  const cabecera = await leerCabecera(id);
  if (soloEnviada && cabecera.estado !== ESTADOS.ENVIADA_SIESA) {
    throw createError(404, "Recepción no encontrada.");
  }
  const archivos = cabecera.factura_archivos;
  if (!archivos.length) return { archivos: [], expiraEn: SEGUNDOS_URL_FACTURA };

  const { data, error } = await supabase.storage
    .from(BUCKET_FACTURA)
    .createSignedUrls(
      archivos.map((a) => a.path),
      SEGUNDOS_URL_FACTURA,
    );
  if (error) throw new Error(`No se pudieron generar los enlaces: ${error.message}`);

  const urlPorRuta = new Map((data || []).map((d) => [d.path, d.error ? null : d.signedUrl]));
  const publicos = archivosPublicos(archivos);
  return {
    archivos: publicos.map((p, i) => ({ ...p, url: urlPorRuta.get(archivos[i].path) ?? null })),
    expiraEn: SEGUNDOS_URL_FACTURA,
  };
}
