/**
 * Reglas puras de la FOTO DE LA FACTURA de una recepción de proveedor.
 *
 * Puro, sin Supabase ni Express: `FacturaProveedor.model.js` habla con Storage y
 * con la base, y ESTE módulo decide (cuántos archivos, de qué tipo, de qué
 * tamaño, si se puede firmar). Así las reglas se prueban sin red.
 *
 * ─── Cómo llegan los archivos a Storage ────────────────────────────────────
 *
 * Los archivos NO pasan por el backend. Vercel limita el cuerpo de una petición a
 * ~4,5 MB y una foto de celular pesa más; subir 10 MB por una función serverless
 * fallaría con 413 antes de llegar al código. El flujo es:
 *
 *   1. `POST /:id/factura/subidas`   → el backend valida la intención (cantidad,
 *      tamaño y tipo declarados) y devuelve una URL firmada de subida por archivo.
 *   2. El navegador sube cada archivo DIRECTO a Storage con esa URL.
 *   3. `POST /:id/factura/confirmar` → el backend NO confía en lo declarado: lee de
 *      Storage el tamaño y el tipo reales, y recién ahí vincula el archivo a la
 *      recepción (`factura_archivos`).
 *   4. `finalizar` exige al menos un archivo vinculado.
 *
 * Un archivo subido y nunca confirmado queda huérfano en el bucket: es tolerable
 * (privado, sin enlace desde la base) y no bloquea nada.
 */

/** Bucket PRIVADO. Se crea en sql/036_factura_proveedor.sql. */
export const BUCKET_FACTURA = "carnes-facturas-proveedor";

export const MAX_ARCHIVOS_FACTURA = 5;
export const MAX_BYTES_FACTURA = 10 * 1024 * 1024;

/** Duración de la URL firmada de lectura: diez minutos. */
export const SEGUNDOS_URL_FACTURA = 600;

/** Tipos aceptados y la extensión con la que se guardan. */
export const TIPOS_FACTURA = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
});

const LARGO_MAX_NOMBRE = 150;

const malo = (status, codigo, mensaje) => ({ ok: false, status, codigo, mensaje });

const MB = MAX_BYTES_FACTURA / 1024 / 1024;

/** Nombre para mostrar: sin rutas ni caracteres de control, con largo acotado. */
export function normalizarNombreArchivo(nombre) {
  const limpio = String(nombre ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()
    .replace(/\s+/g, " ")
    .trim();
  return (limpio || "factura").slice(0, LARGO_MAX_NOMBRE);
}

/** Valida tipo y tamaño de UN archivo. Sirve para lo declarado y para lo leído de Storage. */
export function validarArchivo({ nombre, tipo, tamano }) {
  const etiqueta = normalizarNombreArchivo(nombre);
  if (!Object.hasOwn(TIPOS_FACTURA, tipo)) {
    return malo(
      400,
      "FACTURA_TIPO_INVALIDO",
      `"${etiqueta}" no es un tipo permitido. Adjunta una imagen (JPG, PNG, WEBP, HEIC) o un PDF.`,
    );
  }
  if (!Number.isFinite(tamano) || tamano <= 0) {
    return malo(400, "FACTURA_VACIA", `"${etiqueta}" está vacío.`);
  }
  if (tamano > MAX_BYTES_FACTURA) {
    return malo(413, "FACTURA_GRANDE", `"${etiqueta}" supera los ${MB} MB permitidos.`);
  }
  return { ok: true };
}

/**
 * Paso 1: ¿se puede pedir URL de subida para estos archivos?
 *
 * @param {{existentes?: object[], archivos?: {nombre: string, tipo: string, tamano: number}[]}} p
 * @returns {{ok: true, archivos: {nombre: string, tipo: string, tamano: number, ext: string}[]} | {ok: false, status: number, codigo: string, mensaje: string}}
 */
export function validarSolicitudSubida({ existentes = [], archivos = [] } = {}) {
  if (!Array.isArray(archivos) || archivos.length === 0) {
    return malo(400, "FACTURA_REQUERIDA", "Adjunta al menos un archivo de la factura.");
  }
  if (existentes.length + archivos.length > MAX_ARCHIVOS_FACTURA) {
    return malo(
      400,
      "FACTURA_MUCHOS_ARCHIVOS",
      `La factura admite máximo ${MAX_ARCHIVOS_FACTURA} archivos (ya hay ${existentes.length}).`,
    );
  }
  const salida = [];
  for (const a of archivos) {
    const r = validarArchivo(a);
    if (!r.ok) return r;
    salida.push({
      nombre: normalizarNombreArchivo(a.nombre),
      tipo: a.tipo,
      tamano: a.tamano,
      ext: TIPOS_FACTURA[a.tipo],
    });
  }
  return { ok: true, archivos: salida };
}

/** Ruta en el bucket: `recepcion-<id>/<timestamp>-<n>.<ext>`. */
export function rutaFactura(recepcionId, n, ext, ahora = new Date()) {
  return `recepcion-${recepcionId}/${ahora.getTime()}-${n}.${ext}`;
}

/** ¿La ruta pertenece a esta recepción y tiene la forma que genera `rutaFactura`? */
export function esRutaDeRecepcion(recepcionId, ruta) {
  if (typeof ruta !== "string") return false;
  const extensiones = Object.values(TIPOS_FACTURA).join("|");
  return new RegExp(`^recepcion-${Number(recepcionId)}/\\d{10,15}-\\d{1,2}\\.(${extensiones})$`).test(ruta);
}

/**
 * Paso 3: arma las entradas de `factura_archivos` a partir de lo que HAY en Storage.
 *
 * @param {object} p
 * @param {number|string} p.recepcionId
 * @param {object[]} p.existentes     lo ya vinculado
 * @param {{path: string, nombre?: string}[]} p.solicitados  lo que el cliente dice haber subido
 * @param {Map<string, {size?: number, mimetype?: string}>} p.enStorage  nombre de archivo (sin carpeta) → metadata real
 * @param {string|null} p.por
 * @returns {{ok: true, archivos: object[], nuevos: object[]} | {ok: false, status: number, codigo: string, mensaje: string, rutasInvalidas?: string[]}}
 */
export function armarVinculacion({ recepcionId, existentes = [], solicitados = [], enStorage, por = null, ahora = new Date() }) {
  if (!Array.isArray(solicitados) || solicitados.length === 0) {
    return malo(400, "FACTURA_REQUERIDA", "No se indicó ningún archivo para vincular.");
  }
  if (existentes.length + solicitados.length > MAX_ARCHIVOS_FACTURA) {
    return malo(
      400,
      "FACTURA_MUCHOS_ARCHIVOS",
      `La factura admite máximo ${MAX_ARCHIVOS_FACTURA} archivos (ya hay ${existentes.length}).`,
    );
  }
  const yaVinculadas = new Set(existentes.map((e) => e.path));
  const vistas = new Set();
  const nuevos = [];
  const rutasInvalidas = [];

  for (const s of solicitados) {
    if (!esRutaDeRecepcion(recepcionId, s?.path) || vistas.has(s.path)) {
      return malo(400, "FACTURA_RUTA_INVALIDA", "Uno de los archivos no pertenece a esta recepción.");
    }
    vistas.add(s.path);
    if (yaVinculadas.has(s.path)) continue; // reintento idempotente: ya estaba vinculado

    const real = enStorage?.get(s.path.split("/").pop());
    if (!real) {
      return malo(422, "FACTURA_NO_SUBIDA", "Uno de los archivos no llegó al almacenamiento. Súbelo de nuevo.");
    }
    const nombre = normalizarNombreArchivo(s.nombre);
    const tipo = String(real.mimetype ?? "").split(";")[0].trim().toLowerCase();
    const valido = validarArchivo({ nombre, tipo, tamano: Number(real.size) });
    if (!valido.ok) {
      rutasInvalidas.push(s.path);
      return { ...valido, rutasInvalidas };
    }
    nuevos.push({
      path: s.path,
      nombre,
      tipo,
      tamano: Number(real.size),
      subido_at: ahora.toISOString(),
      subido_por: por || null,
    });
  }
  return { ok: true, archivos: [...existentes, ...nuevos], nuevos };
}

/**
 * Finalizar exige al menos un archivo vinculado. Se mira lo que hay en la BASE,
 * no lo que diga el cliente.
 */
export function validarFacturaParaFinalizar(archivos) {
  if (!Array.isArray(archivos) || archivos.length === 0) {
    return malo(
      422,
      "FACTURA_REQUERIDA",
      "Falta la foto de la factura. Adjunta al menos un archivo antes de firmar.",
    );
  }
  return { ok: true };
}

/** Los metadatos sin la ruta interna de Storage (lo que ven los listados y el detalle). */
export function archivosPublicos(archivos) {
  if (!Array.isArray(archivos)) return [];
  return archivos.map(({ nombre, tipo, tamano, subido_at, subido_por }) => ({
    nombre,
    tipo,
    tamano,
    subido_at,
    subido_por,
  }));
}

/**
 * Reemplaza `factura_archivos` (con rutas) por sus metadatos públicos y el total.
 * `factura_total` = 0 marca una recepción legada, sin factura.
 */
export function conResumenFactura(cabecera) {
  if (!cabecera || typeof cabecera !== "object") return cabecera;
  const { factura_archivos, ...resto } = cabecera;
  const publicos = archivosPublicos(factura_archivos);
  return { ...resto, factura_archivos: publicos, factura_total: publicos.length };
}
