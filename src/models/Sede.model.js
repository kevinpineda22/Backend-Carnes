import crypto from "node:crypto";
import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { evaluarQr } from "../shared/verificacionQr.js";

const TABLE = "carnes_sedes";

/**
 * Campos que puede ver el navegador del recibidor.
 *
 * `qr_token` NO está acá, y esa ausencia es todo el mecanismo. Si el listado de
 * sedes devolviera los tokens, cualquiera abre las herramientas de desarrollo,
 * copia el de la sede que quiera y la verificación pasa a ser decorativa. El
 * token solo viaja en una dirección: del sticker al backend.
 */
//
// `subcliente_desposte` SÍ va: no es un secreto —es el nombre del cliente
// impreso en un PDF que el admin ya tiene en la mano— y la pantalla de sedes
// necesita mostrarlo para poder configurarlo.
const CAMPOS_PUBLICOS = "id, codigo_co, nombre, activo, subcliente_desposte";

/** Sedes activas, para el selector del recibidor. */
export async function listar({ incluirInactivas = false } = {}) {
  let q = supabase.from(TABLE).select(CAMPOS_PUBLICOS).order("nombre");
  if (!incluirInactivas) q = q.eq("activo", true);

  const { data, error } = await q;
  if (error) throw new Error(`Error al leer sedes: ${error.message}`);
  return data || [];
}

/** Listado completo CON el token, para imprimir los stickers. Solo admin. */
export async function listarConToken() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, codigo_co, nombre, qr_token, activo, updated_at")
    .order("nombre");
  if (error) throw new Error(`Error al leer sedes: ${error.message}`);
  return data || [];
}

export async function obtener(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(CAMPOS_PUBLICOS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la sede: ${error.message}`);
  if (!data) throw createError(404, "Sede no encontrada.");
  return data;
}

/**
 * Busca la sede del QR escaneado y, si se pidió una, verifica que coincida.
 *
 * El recibidor ya no elige la sede: la pantalla manda solo el QR y la sede sale
 * de ahí. `sedeId` sigue existiendo para el front viejo y para /sedes/verificar.
 *
 * Devuelve tres resultados distintos y cada uno importa:
 *
 *   · `desconocido` — el token no existe. QR de otra cosa, o uno viejo que ya se
 *     revocó.
 *   · `sede_distinta` — el token es válido pero es de OTRA sede. Este es el caso
 *     que justifica que exista todo esto, y la respuesta DICE cuál es la sede
 *     real. Es información que un atacante no debería tener, pero acá no hay
 *     atacante: hay un recibidor con las manos frías que se equivocó de opción en
 *     un desplegable. "QR inválido" lo deja adivinando; "estás en Girardota
 *     Parque, no en Villahermosa" lo resuelve en dos segundos.
 *   · `ok` — coincide.
 *
 * @param {number|string} sedeId  la sede que eligió el recibidor
 * @param {string} qrToken        lo que salió del escáner
 */
export async function verificarQr(sedeId, qrToken) {
  const token = String(qrToken || "").trim();
  if (!token) return { estado: "desconocido", sede: null };

  const { data, error } = await supabase
    .from(TABLE)
    .select("id, codigo_co, nombre, activo")
    .eq("qr_token", token)
    .maybeSingle();
  if (error) throw new Error(`Error al verificar el QR: ${error.message}`);

  // La decisión es pura y está testeada: ver shared/verificacionQr.js.
  return evaluarQr(data, sedeId);
}

/**
 * Genera un token nuevo para una sede e invalida el anterior.
 *
 * Es la contraparte de haber guardado el token en la base en vez de firmarlo:
 * si un sticker se filtra o alguien le sacó una foto, se rota ESTA sede sola y
 * se reimprime un solo papel. Las otras ocho siguen andando.
 */
export async function regenerarToken(id) {
  const token = crypto.randomBytes(16).toString("hex");

  const { data, error } = await supabase
    .from(TABLE)
    .update({ qr_token: token })
    .eq("id", id)
    .select("id, codigo_co, nombre, qr_token")
    .maybeSingle();
  if (error) throw new Error(`Error al regenerar el token: ${error.message}`);
  if (!data) throw createError(404, "Sede no encontrada.");
  return data;
}

export async function actualizar(id, cambios) {
  // `qr_token` se filtra a propósito: se rota SOLO por `regenerarToken`, que
  // genera un valor aleatorio. Dejarlo pasar por acá permitiría fijar un token
  // elegido a mano —"sede01"— y eso es un QR adivinable.
  const { qr_token: _ignorado, ...limpio } = cambios || {};

  const { data, error } = await supabase
    .from(TABLE)
    .update(limpio)
    .eq("id", id)
    .select(CAMPOS_PUBLICOS)
    .maybeSingle();
  if (error) throw new Error(`Error al actualizar la sede: ${error.message}`);
  if (!data) throw createError(404, "Sede no encontrada.");
  return data;
}
