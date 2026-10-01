/**
 * Reglas puras de FINALIZAR (firmar) una recepción de proveedor y de los datos de
 * las personas que firman "recibí".
 *
 * Puro, sin Supabase ni Express: `RecepcionProveedor.model.js` lee y escribe, y
 * ESTE módulo decide. El modelo no tiene tests (no hay mock de Supabase), así que
 * todo lo que se pueda decidir sin base vive acá, donde sí se prueba.
 *
 * ─── Qué hace finalizar ────────────────────────────────────────────────────
 *
 * Borrador → Finalizada en UN solo UPDATE condicional que además escribe la
 * firma, el recibidor y la fecha (así la CHECK `carnes_prov_rec_firmada_check` de
 * sql/022 nunca ve una Finalizada sin firmar). Antes de eso se revalida TODO
 * sobre lo que está en la base: lo que el cliente diga de plata, cantidades o del
 * nombre del recibidor no cuenta.
 *
 * ─── Reintento ─────────────────────────────────────────────────────────────
 *
 * Si la petición se corta (timeout del envío a SIESA, celular sin señal) el
 * cliente vuelve a llamar. Sobre una recepción que YA está firmada eso NUNCA
 * vuelve a firmar ni reescribe nada: devuelve el estado actual (`decidirFinalizar`).
 * Lo único que un reintento puede disparar es el envío a SIESA, y solo si no hay
 * NINGÚN envío de entrada todavía (`debeEnviarEntrada`): un envío con error lo
 * reintenta el admin a propósito, no cada llamada de un celular.
 */

import { ESTADOS, estaFirmada } from "./estadosProveedor.js";
import { hoyBogota } from "./proveedorValores.js";

// ─── Firma ─────────────────────────────────────────────────────────────────

export const PREFIJO_FIRMA = "data:image/png;base64,";

/**
 * Tope del data URL completo, en caracteres.
 *
 * El `SignatureModal` exporta un canvas del ancho de la pantalla por 150 px de
 * alto: un trazo de firma comprime a unos pocos KB (decenas, en el peor caso).
 * 500.000 caracteres (~375 KB ya decodificados) dejan más de 10x de margen sobre
 * una firma real y siguen muy por debajo de los 2 MB de `express.json`, así que un
 * cliente que mande otra cosa no puede inflar una fila (la firma va en la misma
 * fila que la cabecera y viaja en cada lectura del admin).
 */
export const LARGO_MAX_FIRMA = 500_000;

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Firma de 8 bytes + un chunk IHDR completo (4 largo + 4 tipo + 13 datos + 4 CRC). */
const LARGO_MIN_PNG = 33;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * ¿Es la firma un PNG en data URL, decodificable y de tamaño razonable?
 *
 * Se mira que los bytes decodificados EMPIECEN como un PNG (firma de 8 bytes +
 * chunk IHDR), no solo el prefijo del texto: "data:image/png;base64,hola" no
 * puede quedar guardado como firma. NO se puede saber si el trazo es vacío (un
 * canvas en blanco es un PNG válido): eso lo evita el `SignatureModal`, y la
 * firma registra intención, no identidad verificada.
 *
 * @returns {{ok: true, bytes: number} | {ok: false, mensaje: string, codigo: string}}
 */
export function validarFirma(firma) {
  const malo = (mensaje, codigo = "FIRMA_INVALIDA") => ({ ok: false, mensaje, codigo });

  if (typeof firma !== "string" || !firma.trim()) {
    return malo("Falta la firma del recibidor.", "FIRMA_REQUERIDA");
  }
  if (!firma.startsWith(PREFIJO_FIRMA)) return malo("La firma no es una imagen PNG válida.");
  if (firma.length > LARGO_MAX_FIRMA) {
    return malo("La firma es demasiado grande. Borrala y firmá de nuevo.", "FIRMA_GRANDE");
  }

  const cuerpo = firma.slice(PREFIJO_FIRMA.length);
  if (!BASE64.test(cuerpo) || cuerpo.length % 4 !== 0) {
    return malo("La firma no es una imagen PNG válida.");
  }

  const bytes = Buffer.from(cuerpo, "base64");
  const esPng =
    bytes.length >= LARGO_MIN_PNG &&
    bytes.subarray(0, 8).equals(FIRMA_PNG) &&
    bytes.subarray(12, 16).toString("latin1") === "IHDR";
  if (!esPng) return malo("La firma no es una imagen PNG válida.");

  return { ok: true, bytes: bytes.length };
}

// ─── Personas (recibidores y "Otro") ───────────────────────────────────────

export const LARGO_MAX_NOMBRE = 120;
export const LARGO_MIN_NOMBRE = 3;
export const LARGO_MIN_CEDULA = 5;
export const LARGO_MAX_CEDULA = 12;

/** Espacios colapsados y recortados. Se respeta mayúsculas/minúsculas y tildes: no se "corrige" un nombre. */
export function normalizarNombre(texto) {
  return String(texto ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Solo la cédula sin puntos ni espacios: en Colombia se escribe "1.035.869.866" y
 * es el mismo número. Cualquier otro carácter (guiones, letras) se deja para que
 * `validarCedula` lo rechace en vez de adivinar.
 */
export function normalizarCedula(texto) {
  return String(texto ?? "").replace(/[.\s]/g, "");
}

/** @returns {{ok: true, valor: string} | {ok: false, mensaje: string, campo: "nombre"}} */
export function validarNombre(texto) {
  const valor = normalizarNombre(texto);
  const letras = (valor.match(/\p{L}/gu) || []).length;
  if (letras < LARGO_MIN_NOMBRE) {
    return { ok: false, campo: "nombre", mensaje: `Escribí el nombre completo (mínimo ${LARGO_MIN_NOMBRE} letras).` };
  }
  if (valor.length > LARGO_MAX_NOMBRE) {
    return { ok: false, campo: "nombre", mensaje: `El nombre no puede pasar de ${LARGO_MAX_NOMBRE} caracteres.` };
  }
  return { ok: true, valor };
}

/** @returns {{ok: true, valor: string} | {ok: false, mensaje: string, campo: "cedula"}} */
export function validarCedula(texto) {
  const valor = normalizarCedula(texto);
  if (!new RegExp(`^\\d{${LARGO_MIN_CEDULA},${LARGO_MAX_CEDULA}}$`).test(valor)) {
    return {
      ok: false,
      campo: "cedula",
      mensaje: `La cédula debe tener entre ${LARGO_MIN_CEDULA} y ${LARGO_MAX_CEDULA} números.`,
    };
  }
  return { ok: true, valor };
}

/**
 * Nombre Y cédula, los dos obligatorios: es lo que exige "Otro" al firmar y lo que
 * pide el admin al dar de alta un recibidor.
 *
 * @returns {{ok: true, nombre: string, cedula: string} | {ok: false, mensaje: string, campo: string}}
 */
export function validarPersona({ nombre, cedula } = {}) {
  const n = validarNombre(nombre);
  if (!n.ok) return n;
  const c = validarCedula(cedula);
  if (!c.ok) return c;
  return { ok: true, nombre: n.valor, cedula: c.valor };
}

/**
 * El id del recibidor de la LISTA que mandó el cliente, o null si es "Otro" o no
 * mandó ninguno. El modelo lo usa para saber si tiene que leer la fila de la base.
 */
export function idRecibidorListado(recibidor) {
  if (!recibidor || typeof recibidor !== "object" || recibidor.otro === true) return null;
  const id = recibidor.id;
  return id === undefined || id === null || id === "" ? null : id;
}

/**
 * Arma los datos del recibidor que se guardan en la recepción (el SNAPSHOT).
 *
 *   · De la lista: `fila` es lo que hay en `carnes_recibidores` para ese id, y
 *     cédula y nombre salen de AHÍ. Lo que el cliente haya mandado como nombre se
 *     ignora: el modal descarga una lista sin cédulas y un cliente alterado no
 *     puede firmar con un nombre inventado.
 *   · "Otro": nombre y cédula obligatorios; `recibidor_id` queda en null.
 *
 * `status` es el HTTP con el que el modelo debe rechazar: 400 si el cuerpo está
 * mal armado, 409 si lo que cambió fue el mundo (el recibidor ya no está activo).
 *
 * @returns {{ok: true, valores: {recibidor_id: *, recibidor_cedula: string, recibidor_nombre: string, recibidor_otro: boolean}}
 *   | {ok: false, status: number, codigo: string, mensaje: string}}
 */
export function armarRecibidor({ recibidor, fila } = {}) {
  const malo = (status, codigo, mensaje) => ({ ok: false, status, codigo, mensaje });

  if (!recibidor || typeof recibidor !== "object") {
    return malo(400, "RECIBIDOR_REQUERIDO", "Elegí quién recibió.");
  }
  const id = idRecibidorListado(recibidor);

  if (recibidor.otro === true) {
    if (recibidor.id !== undefined && recibidor.id !== null && recibidor.id !== "") {
      return malo(400, "RECIBIDOR_AMBIGUO", "Elegí un recibidor de la lista o escribí uno nuevo, no los dos.");
    }
    const persona = validarPersona(recibidor);
    if (!persona.ok) return malo(400, "RECIBIDOR_INVALIDO", persona.mensaje);
    return {
      ok: true,
      valores: {
        recibidor_id: null,
        recibidor_cedula: persona.cedula,
        recibidor_nombre: persona.nombre,
        recibidor_otro: true,
      },
    };
  }

  if (id === null) return malo(400, "RECIBIDOR_REQUERIDO", "Elegí quién recibió.");

  if (!fila || fila.activo === false || String(fila.id) !== String(id)) {
    return malo(409, "RECIBIDOR_NO_DISPONIBLE", "Ese recibidor ya no está en la lista. Elegí otro.");
  }
  return {
    ok: true,
    valores: {
      recibidor_id: fila.id,
      recibidor_cedula: fila.cedula,
      recibidor_nombre: fila.nombre,
      recibidor_otro: false,
    },
  };
}

// ─── Decisión ──────────────────────────────────────────────────────────────

/** Mensaje cuando el UPDATE condicional no encontró la fila que se leyó (la tocaron mientras se firmaba). */
export const MENSAJE_CAMBIO_AL_FINALIZAR =
  "La recepción cambió mientras finalizabas; revisá y firmá de nuevo";

/**
 * Qué hacer según el estado en que está la recepción al llegar `finalizar`.
 *
 *   · Borrador            → `finalizar` (el camino normal).
 *   · Finalizada / Enviada_SIESA → `reintento`: ya está firmada, se devuelve tal
 *     cual y NO se vuelve a firmar (ni se pisan firma, recibidor o fecha).
 *   · Anulada (o cualquier otra) → `rechazar` con 409.
 *
 * @returns {{accion: "finalizar"} | {accion: "reintento"} | {accion: "rechazar", status: 409, codigo: string, mensaje: string}}
 */
export function decidirFinalizar(estado) {
  if (estado === ESTADOS.BORRADOR) return { accion: "finalizar" };
  if (estaFirmada(estado)) return { accion: "reintento" };
  if (estado === ESTADOS.ANULADA) {
    return { accion: "rechazar", status: 409, codigo: "RECEPCION_ANULADA", mensaje: "La recepción está anulada." };
  }
  return {
    accion: "rechazar",
    status: 409,
    codigo: "ESTADO_DESCONOCIDO",
    mensaje: `No se puede finalizar una recepción en estado "${estado}".`,
  };
}

/**
 * Las columnas que escribe el UPDATE de finalizar. Todo junto, en una sola
 * operación (ver el encabezado).
 *
 *   · `fecha_recepcion` se vuelve a fijar al día de Bogotá de AHORA: la fecha del
 *     CEA que viaja a SIESA es la de la firma, no la del día en que se abrió el
 *     borrador (un borrador puede dormir días).
 *   · Los snapshots de proveedor y sede se REFRESCAN desde los maestros que se
 *     pasen (un NIT, una bodega o un C.O. corregidos desde que se abrió deben
 *     llegar bien a SIESA). Si no se pasa un maestro, ese snapshot se deja como está.
 *   · `recibido_por` es el correo de quien firma en esta sesión.
 *
 * @param {object} p
 * @param {object} p.valores    `armarRecibidor(...).valores`
 * @param {string} p.firma      data URL ya validada
 * @param {string} p.por        correo de la sesión
 * @param {{nit: string, sucursal: string, razon_social: string}} [p.proveedor]
 * @param {{codigo_co: ?string, bodega_siesa: ?string}} [p.sede]
 * @param {Date} [p.ahora]
 */
export function armarActualizacionFinalizar({ valores, firma, por, proveedor, sede, ahora = new Date() }) {
  const cambios = {
    estado: ESTADOS.FINALIZADA,
    fecha_recepcion: hoyBogota(ahora),
    finalizado_at: ahora.toISOString(),
    recibido_por: por,
    ...valores,
    firma_data: firma,
  };
  if (proveedor) {
    cambios.proveedor_nit = proveedor.nit;
    cambios.proveedor_sucursal = proveedor.sucursal;
    cambios.proveedor_razon_social = proveedor.razon_social;
  }
  if (sede) {
    cambios.bodega_siesa = sede.bodega_siesa ?? null;
    cambios.codigo_co = sede.codigo_co ?? null;
  }
  return cambios;
}

// ─── Después de firmar ─────────────────────────────────────────────────────

/**
 * ¿Hay que mandar la entrada CEA a SIESA después de esta llamada a finalizar?
 *
 * Solo si la recepción está Finalizada y NO existe ningún envío `entrada_proveedor`
 * (en ningún estado). Un envío con error NO se reintenta desde acá: lo reintenta el
 * admin a propósito, para que cada recarga del celular no genere intentos nuevos.
 * Un envío `ok` ya movió la recepción a Enviada_SIESA.
 *
 * El envío en sí llega con el corte de SIESA (ver `PostFinalizarProveedor.model.js`).
 *
 * @param {{estado: string, enviosEntrada?: object[]}} p
 */
export function debeEnviarEntrada({ estado, enviosEntrada = [] } = {}) {
  return estado === ESTADOS.FINALIZADA && (enviosEntrada || []).length === 0;
}

/** ¿Alguna línea tiene devolución? Entonces habrá nota crédito (su envío es de un corte posterior). */
export function notaCreditoRequerida(resumen) {
  return Number(resumen?.renglones_con_devolucion) > 0;
}
