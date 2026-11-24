import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { listarCatalogoRetomas } from "./Liquidacion.model.js";
import { actualizarCabeceraConVersion } from "./Preliquidacion.model.js";
import {
  armarFilasRetomas,
  totalKilosRetomas,
  totalRetomas,
  validarFilasRetomas,
} from "../shared/retomasLiquidacion.js";

/**
 * Retomas de la preliquidación (solo cerdo).
 *
 * Se cargan UNA vez por preliquidación, antes de congelar, con el mismo catálogo y
 * las mismas reglas de validación que las retomas de la liquidación legada. A
 * diferencia de aquella, NO se convierten en una fila de gasto (C14): las retomas
 * entran solo a la utilidad de cada sede, repartidas por animales
 * (`shared/preliquidacionFuentes.js#valorRetomasSedes`).
 */

const T_PRELIQ = "carnes_preliquidaciones";
const T_RETOMAS = "carnes_preliquidacion_retomas";

/** Lee la cabecera y exige cerdo. `escritura` además exige que no esté congelada. */
async function exigirCerdo(id, { escritura = false } = {}) {
  const { data, error } = await supabase.from(T_PRELIQ).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Error al leer la preliquidación: ${error.message}`);
  if (!data) throw createError(404, "Preliquidación no encontrada.", "no_encontrada");
  if (data.especie !== "cerdo") {
    throw createError(400, "Las retomas de la entrega son solo de cerdo.");
  }
  if (escritura && data.liquidada_at) {
    throw createError(
      409,
      "La preliquidación ya se liquidó: no se pueden cambiar las retomas.",
      "preliquidacion_congelada",
    );
  }
  return data;
}

async function leerGuardadas(id) {
  const { data, error } = await supabase
    .from(T_RETOMAS)
    .select("*")
    .eq("preliquidacion_id", id)
    .order("orden")
    .order("id");
  if (error) throw new Error(`Error al leer las retomas: ${error.message}`);
  return data || [];
}

function respuesta(cabecera, catalogo, guardadas) {
  const congelada = Boolean(cabecera.liquidada_at);
  const filas = armarFilasRetomas({ catalogo, guardadas, congelada });
  return {
    preliquidacion_id: cabecera.id,
    editable: !congelada,
    filas,
    total: totalRetomas(filas),
    total_kilos: totalKilosRetomas(filas),
  };
}

/** Filas del panel: catálogo activo de retomas de cerdo mezclado con lo guardado. */
export async function obtenerRetomas(id) {
  const cabecera = await exigirCerdo(id);
  const [catalogo, guardadas] = await Promise.all([listarCatalogoRetomas(), leerGuardadas(id)]);
  return respuesta(cabecera, catalogo, guardadas);
}

/**
 * Guarda las retomas. `filas` ES la lista completa: lo que no vino (o vino en 0
 * kilos) se borra. Las filas llevan las mismas claves en el upsert (supabase-js
 * manda NULL, no el DEFAULT, a la columna que le falta a una fila de un lote). La
 * versión de la cabecera se sube AL FINAL: una liquidación que leyó las retomas
 * viejas lleva la versión vieja y la RPC la rechaza.
 */
export async function guardarRetomas(id, { filas = [] } = {}) {
  await exigirCerdo(id, { escritura: true });

  const [catalogo, guardadas] = await Promise.all([listarCatalogoRetomas(), leerGuardadas(id)]);
  const guardadaPorItem = new Map(
    guardadas.filter((g) => g.vicera_item_id != null).map((g) => [String(g.vicera_item_id), g]),
  );
  const catalogoPorId = new Map(catalogo.map((c) => [String(c.id), c]));
  const permitidos = new Set([...catalogoPorId.keys(), ...guardadaPorItem.keys()]);

  const validacion = validarFilasRetomas(filas, permitidos);
  if (!validacion.ok) throw createError(400, validacion.errores[0]);

  const aGuardar = validacion.filas
    .filter((f) => f.kilos > 0)
    .map((f, i) => {
      const c = catalogoPorId.get(String(f.vicera_item_id));
      const g = guardadaPorItem.get(String(f.vicera_item_id));
      return {
        preliquidacion_id: id,
        vicera_item_id: f.vicera_item_id,
        nombre: c?.nombre ?? g.nombre,
        unidad: c?.unidad || g?.unidad || "KL",
        kilos: f.kilos,
        precio: f.precio,
        precio_catalogo: c ? Number(c.precio) || 0 : Number(g?.precio_catalogo) || 0,
        orden: c?.orden ?? g?.orden ?? i,
      };
    });

  if (aGuardar.length) {
    const { error } = await supabase
      .from(T_RETOMAS)
      .upsert(aGuardar, { onConflict: "preliquidacion_id,vicera_item_id" });
    if (error) throw new Error(`Error al guardar las retomas: ${error.message}`);
  }

  // Se borra lo que ya no está. Las filas sin ítem (el ítem del catálogo se borró)
  // no se tocan desde aquí.
  const conservadas = new Set(aGuardar.map((f) => String(f.vicera_item_id)));
  const sobrantes = guardadas
    .filter((g) => g.vicera_item_id != null && !conservadas.has(String(g.vicera_item_id)))
    .map((g) => g.id);
  if (sobrantes.length) {
    const { error } = await supabase.from(T_RETOMAS).delete().in("id", sobrantes);
    if (error) throw new Error(`Error al borrar retomas: ${error.message}`);
  }

  await actualizarCabeceraConVersion(id, {});

  const [cabecera, finales] = await Promise.all([exigirCerdo(id), leerGuardadas(id)]);
  return respuesta(cabecera, catalogo, finales);
}
