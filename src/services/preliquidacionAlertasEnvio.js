/**
 * Transporte real de la cola de alertas de la preliquidación: completa el contexto del correo
 * con los datos de la base (especie, sede, cifras, error del envío) y lo manda por
 * `notificarPreliquidacion`.
 *
 * Las filas de la cola guardan solo las claves de deduplicación y el detalle que dio quien las
 * encoló; los datos que cambian (utilidad, intentos, error de SIESA) se leen al despachar para que
 * el correo muestre lo vigente. Todo es best-effort: una lectura que falla deja el correo con lo que
 * hay, y nada de esto lanza.
 */

/** El correo real se carga bajo demanda: así importar la cola no arrastra el servicio de correo. */
async function notificarPorDefecto(tipo, ctx) {
  return (await import("./notificaciones.service.js")).notificarPreliquidacion(tipo, ctx);
}

/** La base real se carga bajo demanda: importar el cliente exige las variables de Supabase. */
async function baseDeDatos() {
  return (await import("../config/supabase.js")).supabase;
}

async function leerUna(db, tabla, columnas, id) {
  const { data, error } = await db.from(tabla).select(columnas).eq("id", id).maybeSingle();
  if (error) throw new Error(`${tabla}: ${error.message}`);
  return data ?? null;
}

const hayId = (valor) => Number(valor) > 0;

/**
 * @param {object} ctx contexto de la alerta: el detalle más `preliquidacion_id`, `sede_id` y `ocurrencia`
 * @param {{db?: object, log?: object}} [opciones]
 * @returns {Promise<object>} el contexto enriquecido; lo que trae el detalle manda sobre lo leído
 */
export async function armarContextoAlerta(ctx, { db, log = console } = {}) {
  const base = ctx && typeof ctx === "object" ? ctx : {};
  const leido = {};
  try {
    const cliente = db ?? (await baseDeDatos());
    let recepcionId = null;

    if (hayId(base.preliquidacion_id)) {
      const cabecera = await leerUna(cliente, "carnes_preliquidaciones", "id, especie, ventana_fin", base.preliquidacion_id);
      if (cabecera) Object.assign(leido, { especie: cabecera.especie, ventana_fin: cabecera.ventana_fin });
    }

    if (hayId(base.sede_id)) {
      const sede = await leerUna(
        cliente,
        "carnes_preliquidacion_sedes",
        "id, recepcion_id, animales, gasto_sede, utilidad, motivo_bloqueo, motivo_pendiente, intentos, envio_id",
        base.sede_id,
      );
      if (sede) {
        recepcionId = sede.recepcion_id;
        Object.assign(leido, {
          recepcion_id: sede.recepcion_id,
          animales: sede.animales,
          gasto_sede: sede.gasto_sede,
          utilidad: sede.utilidad,
          motivo: sede.motivo_bloqueo ?? sede.motivo_pendiente ?? undefined,
          intentos: sede.intentos,
        });
        if (hayId(sede.envio_id)) {
          const envio = await leerUna(cliente, "carnes_siesa_envios", "id, error, novedad", sede.envio_id);
          if (envio?.error || envio?.novedad) leido.error = envio.error || envio.novedad;
        }
      }
    } else if (esAvisoDeRecepcion(base)) {
      // Avisos de recepción (sin sede): la ocurrencia es el id de la recepción.
      recepcionId = base.ocurrencia;
      leido.recepcion_id = base.ocurrencia;
    }

    if (hayId(recepcionId)) {
      const recepcion = await leerUna(cliente, "carnes_recepciones", "id, sede_id, fecha_ingreso, novillos", recepcionId);
      if (recepcion) {
        leido.fecha_ingreso = recepcion.fecha_ingreso;
        if (hayId(recepcion.sede_id)) {
          const sede = await leerUna(cliente, "carnes_sedes", "id, nombre", recepcion.sede_id);
          if (sede?.nombre) leido.sede_nombre = sede.nombre;
        }
      }
    }
  } catch (error) {
    log.warn?.(`[preliquidacion-alertas] no se pudo completar el contexto del correo: ${error?.message}`);
  }
  const sinIndefinidos = Object.fromEntries(Object.entries(leido).filter(([, v]) => v !== undefined && v !== null));
  return { ...sinIndefinidos, ...base };
}

/** Los avisos de recepción llevan `evento` en el contexto (lo pone `enviarAlerta`) y la recepción como ocurrencia. */
function esAvisoDeRecepcion(ctx) {
  return ["sin_preliquidacion", "fuera_ventana", "oficial_legacy"].includes(ctx.evento);
}

/**
 * Transporte por defecto de `despacharAlertas`: arma el contexto y manda el correo.
 *
 * @returns {Promise<{success: boolean, sandbox?: boolean, error?: string}>} nunca lanza
 */
export async function enviarAlerta(evento, ctx, { db, notificar = notificarPorDefecto, log = console } = {}) {
  try {
    const contexto = await armarContextoAlerta({ ...(ctx ?? {}), evento }, { db, log });
    const { evento: _evento, ...sinEvento } = contexto;
    return await notificar(evento, sinEvento);
  } catch (error) {
    log.error?.(`[preliquidacion-alertas] el correo de "${evento}" falló: ${error?.message}`);
    return { success: false, error: error?.message ?? String(error) };
  }
}
