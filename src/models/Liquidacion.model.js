import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import {
  consolidarLiquidacion,
  puedeCerrarCosteo,
} from "../shared/consolidado.js";
import { ESTADOS } from "../shared/estados.js";
import {
  fallarSiFaltaMigracion,
  esMigracionFaltante,
} from "../shared/migraciones.js";

const TABLE = "carnes_liquidaciones";
const TABLE_GASTOS = "carnes_liquidacion_gastos";
const TABLE_PAGOS = "carnes_liquidacion_pagos";
const TABLE_RECEPCIONES = "carnes_recepciones";
const TABLE_ITEMS = "carnes_recepcion_items";

export const ESTADOS_LIQUIDACION = {
  ABIERTA: "Abierta",
  COSTEADA: "Costeada",
  CERRADA: "Cerrada",
};

// ─── Lectura ───────────────────────────────────────────────────────────────

/** Cabecera + gastos + recepciones con sus renglones. Todo lo que necesita el costeo. */
export async function obtener(id) {
  const { data: cabecera, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la liquidación: ${error.message}`);
  if (!cabecera) throw createError(404, "Liquidación no encontrada.");

  const { data: gastos, error: errorGastos } = await supabase
    .from(TABLE_GASTOS)
    .select("*")
    .eq("liquidacion_id", id)
    .order("id");
  if (errorGastos)
    throw new Error(`Error al leer los gastos: ${errorGastos.message}`);

  // Los pagos pueden no existir todavía (migración 008 sin correr): se degrada
  // a lista vacía en vez de tumbar la pantalla entera de la liquidación.
  const { data: pagos, error: errorPagos } = await supabase
    .from(TABLE_PAGOS)
    .select("*")
    .eq("liquidacion_id", id)
    .order("orden")
    .order("id");
  if (errorPagos && !esMigracionFaltante(errorPagos)) {
    throw new Error(`Error al leer los pagos: ${errorPagos.message}`);
  }

  const { data: recepciones, error: errorRec } = await supabase
    .from(TABLE_RECEPCIONES)
    .select("*, sede:carnes_sedes ( id, codigo_co, nombre )")
    .eq("liquidacion_id", id)
    .order("id");
  if (errorRec)
    throw new Error(`Error al leer las recepciones: ${errorRec.message}`);

  // Los renglones de TODAS las recepciones en UNA consulta, no una por sede: son
  // nueve sedes por 38 ítems, y nueve viajes extra por cada vez que el admin
  // abre la pantalla se notan.
  const ids = (recepciones || []).map((r) => r.id);
  let items = [];
  if (ids.length) {
    const { data, error: errorItems } = await supabase
      .from(TABLE_ITEMS)
      .select("*")
      .in("recepcion_id", ids)
      .order("orden")
      .order("id");
    if (errorItems)
      throw new Error(`Error al leer los renglones: ${errorItems.message}`);
    items = data || [];
  }

  const porRecepcion = new Map(ids.map((i) => [i, []]));
  for (const item of items) porRecepcion.get(item.recepcion_id)?.push(item);

  return {
    ...cabecera,
    gastos: gastos || [],
    pagos: pagos || [],
    recepciones: (recepciones || []).map((r) => ({
      ...r,
      items: porRecepcion.get(r.id) || [],
    })),
  };
}

export async function listar({
  especie,
  estado,
  desde,
  hasta,
  limite = 100,
} = {}) {
  let q = supabase
    .from(TABLE)
    .select("*")
    .order("fecha", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(Number(limite) || 100, 500));

  if (especie) q = q.eq("especie", especie);
  if (estado) q = q.eq("estado", estado);
  if (desde) q = q.gte("fecha", desde);
  if (hasta) q = q.lte("fecha", hasta);

  const { data, error } = await q;
  if (error) throw new Error(`Error al listar liquidaciones: ${error.message}`);
  return data || [];
}

// ─── Cabecera ──────────────────────────────────────────────────────────────

export async function crear({
  especie,
  fecha,
  proveedor,
  viceras_bonificacion = false,
}) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      especie,
      fecha: fecha || new Date().toISOString().slice(0, 10),
      proveedor,
      viceras_bonificacion,
      estado: ESTADOS_LIQUIDACION.ABIERTA,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Error al crear la liquidación: ${error.message}`);
  return data;
}

/**
 * Falla si la liquidación ya no admite cambios.
 *
 * `Costeada` SÍ admite: el admin corrige un gasto y vuelve a costear, que es el
 * caso normal, no la excepción. `Cerrada` no: ya se subió a SIESA.
 */
async function exigirEditable(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, estado, especie, viceras_bonificacion")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la liquidación: ${error.message}`);
  if (!data) throw createError(404, "Liquidación no encontrada.");

  if (data.estado === ESTADOS_LIQUIDACION.CERRADA) {
    throw createError(
      409,
      "La liquidación está cerrada: ya se subió a SIESA y no se puede modificar.",
    );
  }
  return data;
}

export async function actualizar(id, cambios) {
  await exigirEditable(id);

  const permitidas = [
    "fecha",
    "proveedor",
    "viceras_bonificacion",
    "observaciones",
  ];
  const limpio = {};
  for (const c of permitidas)
    if (cambios[c] !== undefined) limpio[c] = cambios[c];

  if (Object.keys(limpio).length === 0) {
    throw createError(400, "No hay campos válidos para actualizar.");
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update(limpio)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error)
    throw new Error(`Error al actualizar la liquidación: ${error.message}`);
  return data;
}

// ─── Gastos ────────────────────────────────────────────────────────────────

/**
 * Guarda la grilla de gastos completa.
 *
 * Mismo orden que `Plantilla.guardarLote` y por la misma razón: primero se
 * escribe lo que debe existir y recién después se borra lo que el admin sacó. Sin
 * transacción, un corte en el medio deja gastos de más —visibles y corregibles—
 * en vez de gastos de menos, que abaratan el costo de cada corte sin que nada lo
 * diga.
 *
 * `concepto` y `signo` se COPIAN del catálogo a la fila. Si mañana alguien
 * cambia el signo de "Retomas Desposte", una liquidación vieja tiene que seguir
 * sumando lo que sumó el día que se cerró.
 */
export async function guardarGastos(id, filas = []) {
  await exigirEditable(id);

  const nuevas = filas.filter((f) => !f.id);
  const existentes = filas.filter((f) => f.id);

  const fila = (f) => ({
    liquidacion_id: id,
    concepto_id: f.concepto_id ?? null,
    concepto: f.concepto,
    signo: f.signo === -1 ? -1 : 1,
    valor: Number(f.valor) || 0,
    observaciones: f.observaciones ?? null,
  });

  // `select("id")` NO es decorativo: los ids de las filas recién creadas TIENEN
  // que entrar en `conservados`. Sin eso, el borrado de abajo —que elimina todo
  // lo que no vino en el envío— se lleva puesto lo que se acaba de insertar, y
  // el primer guardado (donde TODAS las filas son nuevas) deja la liquidación
  // sin un solo gasto. Respondía 200 y el total daba 0.
  const idsNuevos = [];
  if (nuevas.length) {
    const { data, error } = await supabase
      .from(TABLE_GASTOS)
      .insert(nuevas.map(fila))
      .select("id");
    if (error) throw new Error(`Error al crear gastos: ${error.message}`);
    idsNuevos.push(...(data || []).map((f) => f.id));
  }

  for (const f of existentes) {
    const { error } = await supabase
      .from(TABLE_GASTOS)
      .update(fila(f))
      .eq("id", f.id);
    if (error)
      throw new Error(
        `Error al actualizar el gasto #${f.id}: ${error.message}`,
      );
  }

  const conservados = [...existentes.map((f) => f.id), ...idsNuevos];
  let q = supabase.from(TABLE_GASTOS).delete().eq("liquidacion_id", id);
  if (conservados.length) q = q.not("id", "in", `(${conservados.join(",")})`);

  const { error: errorBorra } = await q;
  if (errorBorra)
    throw new Error(`Error al borrar gastos: ${errorBorra.message}`);

  return obtener(id);
}

/**
 * Guarda la lista de beneficiarios de una liquidación.
 *
 * Mismo patrón que `guardarGastos`: lo que llega ES la lista completa, y lo que
 * no vino se borra. Incluido el `select("id")` de las filas nuevas — sin eso el
 * primer guardado se borra a sí mismo (ver el comentario de allá).
 *
 * La suma de estos pagos tiene que dar el total de los gastos. No se valida
 * acá: se valida al costear, porque mientras el admin digita es normal que no
 * cuadre — está a mitad de cargar la lista.
 */
export async function guardarPagos(id, filas = []) {
  await exigirEditable(id);

  const nuevas = filas.filter((f) => !f.id);
  const existentes = filas.filter((f) => f.id);

  const fila = (f, i) => ({
    liquidacion_id: id,
    nombre: String(f.nombre ?? "").trim(),
    cuenta: f.cuenta ? String(f.cuenta).trim() : null,
    valor: Number(f.valor) || 0,
    orden: Number.isInteger(f.orden) ? f.orden : i,
  });

  const idsNuevos = [];
  if (nuevas.length) {
    const { data, error } = await supabase
      .from(TABLE_PAGOS)
      .insert(nuevas.map(fila))
      .select("id");
    if (error)
      fallarSiFaltaMigracion(error, "Error al guardar los pagos", [
        "sql/008_pagos_y_tercero.sql",
      ]);
    idsNuevos.push(...(data || []).map((f) => f.id));
  }

  for (const [i, f] of existentes.entries()) {
    const { error } = await supabase
      .from(TABLE_PAGOS)
      .update({ ...fila(f, i), updated_at: new Date().toISOString() })
      .eq("id", f.id);
    if (error)
      fallarSiFaltaMigracion(error, "Error al guardar los pagos", [
        "sql/008_pagos_y_tercero.sql",
      ]);
  }

  const conservados = [...existentes.map((f) => f.id), ...idsNuevos];
  let q = supabase.from(TABLE_PAGOS).delete().eq("liquidacion_id", id);
  if (conservados.length) q = q.not("id", "in", `(${conservados.join(",")})`);

  const { error: errorBorra } = await q;
  if (errorBorra)
    fallarSiFaltaMigracion(errorBorra, "Error al borrar pagos", [
      "sql/008_pagos_y_tercero.sql",
    ]);

  return obtener(id);
}

/**
 * Borra una liquidación creada por error.
 *
 * ─── Por qué SOLO cuando está Abierta ─────────────────────────────────────
 *
 * La FK de `carnes_recepciones.liquidacion_id` es `ON DELETE SET NULL`: al
 * borrar la liquidación, sus recepciones se DESVINCULAN pero siguen existiendo
 * con el estado que tenían.
 *
 * Si estaba Costeada, esas recepciones están en `Costeado` — y quedarían en
 * `Costeado` sin ninguna liquidación detrás, con costos congelados que ya no
 * corresponden a ningún cálculo. Un estado del que no se sale.
 *
 * La salida existe y está probada: `reabrir` devuelve las recepciones a
 * `Aprobado` y limpia los costos. Después de eso, borrar es seguro. Se obliga a
 * pasar por ahí en vez de replicar esa lógica acá.
 *
 * Los gastos se van solos por el `ON DELETE CASCADE` de su FK.
 */
export async function eliminar(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, estado, especie")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Error al leer la liquidación: ${error.message}`);
  if (!data) throw createError(404, "Liquidación no encontrada.");

  if (data.estado === ESTADOS_LIQUIDACION.CERRADA) {
    throw createError(
      409,
      "La liquidación ya se subió a SIESA: no se puede borrar.",
    );
  }
  if (data.estado === ESTADOS_LIQUIDACION.COSTEADA) {
    throw createError(
      409,
      "Esta liquidación ya está costeada. Reabrila primero —eso devuelve las " +
        "recepciones a Aprobado y limpia los costos— y ahí sí se puede borrar.",
    );
  }

  // Se desvinculan a mano y no por la FK: así el conteo que se devuelve es real
  // y el admin sabe cuántas recepciones quedaron libres.
  const { data: liberadas, error: errorDesv } = await supabase
    .from(TABLE_RECEPCIONES)
    .update({ liquidacion_id: null })
    .eq("liquidacion_id", id)
    .select("id");
  if (errorDesv) throw new Error(`Error al desvincular: ${errorDesv.message}`);

  const { error: errorBorrar } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id);
  if (errorBorrar)
    throw new Error(`Error al borrar la liquidación: ${errorBorrar.message}`);

  console.log(
    `🗑️  Liquidación #${id} borrada · ${liberadas?.length || 0} recepción(es) liberada(s).`,
  );
  return { eliminada: id, recepcionesLiberadas: liberadas?.length || 0 };
}

// ─── Recepciones vinculadas ────────────────────────────────────────────────

/**
 * Vincula recepciones a la liquidación.
 *
 * Rechaza las de otra especie y las que ya cuelgan de OTRA liquidación. Lo
 * segundo importa: si una recepción estuviera en dos, sus kilos contarían dos
 * veces en el reparto y las dos liquidaciones darían costos distintos para el
 * mismo corte.
 *
 * Se valida todo ANTES de escribir. Vincular la mitad y fallar dejaría el
 * consolidado a medias sin que el admin sepa cuáles entraron.
 */
export async function vincular(id, recepcionIds = []) {
  const liquidacion = await exigirEditable(id);

  const { data: candidatas, error } = await supabase
    .from(TABLE_RECEPCIONES)
    .select("id, especie, estado, liquidacion_id, sede:carnes_sedes ( nombre )")
    .in("id", recepcionIds);
  if (error) throw new Error(`Error al leer las recepciones: ${error.message}`);

  const problemas = [];
  const encontradas = new Set((candidatas || []).map((r) => String(r.id)));

  for (const pedido of recepcionIds) {
    if (!encontradas.has(String(pedido))) {
      problemas.push(`La recepción #${pedido} no existe.`);
    }
  }

  for (const r of candidatas || []) {
    const nombre = r.sede?.nombre || `#${r.id}`;
    if (r.especie !== liquidacion.especie) {
      problemas.push(
        `${nombre}: es de ${r.especie} y la liquidación es de ${liquidacion.especie}.`,
      );
    }
    if (r.liquidacion_id && String(r.liquidacion_id) !== String(id)) {
      problemas.push(
        `${nombre}: ya está en la liquidación #${r.liquidacion_id}.`,
      );
    }
    if (r.estado === ESTADOS.BORRADOR) {
      problemas.push(
        `${nombre}: todavía está en borrador, el recibidor no la cerró.`,
      );
    }
    if (r.estado === ESTADOS.RECHAZADO) {
      problemas.push(`${nombre}: está rechazada.`);
    }
  }

  if (problemas.length) throw createError(409, problemas.join(" "));

  const { error: errorUpdate } = await supabase
    .from(TABLE_RECEPCIONES)
    .update({ liquidacion_id: id })
    .in("id", recepcionIds);
  if (errorUpdate) throw new Error(`Error al vincular: ${errorUpdate.message}`);

  return obtener(id);
}

export async function desvincular(id, recepcionId) {
  await exigirEditable(id);

  // Con una CEA consolidada vigente (enviando, ok o sin confirmar), la
  // recepción ya está —o puede estar— en SIESA dentro de ese documento. Si se
  // la sacara y se vinculara a otra liquidación, entraría dos veces. Primero se
  // anula la CEA; después se reordena.
  const { data: cea, error: errorCea } = await supabase
    .from("carnes_siesa_envios")
    .select("referencia, estado")
    .eq("liquidacion_id", id)
    .is("recepcion_id", null)
    .eq("tipo", "oficial")
    .in("estado", ["enviando", "ok", "sin_confirmar"])
    .limit(1)
    .maybeSingle();
  if (errorCea) throw new Error(`Error al leer los envíos: ${errorCea.message}`);
  if (cea) {
    throw createError(
      409,
      `Esta liquidación tiene la entrada oficial ${cea.referencia} en SIESA (${cea.estado}). ` +
        "Anulala en SIESA y registralo antes de sacar recepciones, o la carne entraría dos veces.",
    );
  }

  const { data, error } = await supabase
    .from(TABLE_RECEPCIONES)
    .update({ liquidacion_id: null })
    .eq("id", recepcionId)
    .eq("liquidacion_id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Error al desvincular: ${error.message}`);
  if (!data)
    throw createError(404, "Esa recepción no está en esta liquidación.");

  return obtener(id);
}

// ─── Costeo ────────────────────────────────────────────────────────────────

/**
 * Corre el consolidado SIN escribir nada.
 *
 * Es la pantalla de "así va a quedar". Existe separado de `costear` porque el
 * admin tiene que poder mirar el factor y las advertencias antes de congelar
 * nada — y porque previsualizar tiene que MOSTRAR todos los problemas mientras
 * que cerrar solo bloquea los que invalidan el documento.
 */
export async function previsualizar(id) {
  const liquidacion = await obtener(id);

  const consolidado = consolidarLiquidacion({
    recepciones: liquidacion.recepciones,
    gastos: liquidacion.gastos,
    bonificacionViceras: liquidacion.viceras_bonificacion,
    pagos: liquidacion.pagos,
  });

  const sedesFaltantes = await buscarSedesFaltantes(liquidacion);

  return {
    liquidacion,
    consolidado,
    sedesFaltantes,
    cierre: puedeCerrarCosteo(consolidado),
  };
}

/**
 * Qué sedes activas NO están en esta liquidación.
 *
 * La operación reparte a TODAS las sedes el mismo día. Entonces una liquidación
 * a la que le falta una sede casi siempre es una liquidación a la que se le
 * olvidó vincular una recepción — y si se costea así, esa sede queda sin costo y
 * las demás absorben un gasto que no era solo de ellas.
 *
 * Es un AVISO, no un bloqueo: a veces de verdad no se mandó a una sede. La
 * decisión es del admin; lo que no puede pasar es que no se entere.
 *
 * Para cada sede que falta se busca si hay una recepción de esa especie y ese
 * día en cualquier estado. Cambia por completo qué hacer: "hay una cerrada sin
 * vincular" se resuelve vinculándola; "no hay ninguna" es preguntar si de
 * verdad no se mandó.
 *
 * Con cero recepciones vinculadas no se avisa nada: ahí faltan todas, y ya lo
 * dice el estado vacío del paso 1.
 */
async function buscarSedesFaltantes(liquidacion) {
  if (!liquidacion.recepciones?.length) return [];

  const { data: sedes, error } = await supabase
    .from("carnes_sedes")
    .select("id, nombre")
    .eq("activo", true)
    .order("nombre");
  if (error) throw new Error(`Error al leer sedes: ${error.message}`);

  const vinculadas = new Set(liquidacion.recepciones.map((r) => r.sede_id));
  const faltantes = (sedes || []).filter((s) => !vinculadas.has(s.id));
  if (faltantes.length === 0) return [];

  // Una sola consulta para todas las sedes que faltan, no una por sede.
  const { data: candidatas } = await supabase
    .from("carnes_recepciones")
    .select("id, sede_id, estado, liquidacion_id")
    .eq("especie", liquidacion.especie)
    .eq("fecha_ingreso", liquidacion.fecha)
    .in(
      "sede_id",
      faltantes.map((s) => s.id),
    )
    .order("id", { ascending: false });

  const porSede = new Map();
  for (const r of candidatas || []) {
    if (!porSede.has(r.sede_id)) porSede.set(r.sede_id, r);
  }

  return faltantes.map((s) => {
    const r = porSede.get(s.id);
    let pista;
    if (!r) {
      pista = "sin_recepcion";
    } else if (r.liquidacion_id && r.liquidacion_id !== liquidacion.id) {
      pista = "en_otra_liquidacion";
    } else if (r.estado === ESTADOS.APROBADO) {
      pista = "aprobada_sin_vincular";
    } else if (r.estado === ESTADOS.BORRADOR) {
      pista = "en_curso";
    } else if (r.estado === ESTADOS.RECHAZADO) {
      pista = "rechazada";
    } else {
      pista = "otro_estado";
    }
    return {
      sede_id: s.id,
      nombre: s.nombre,
      pista,
      recepcion_id: r?.id ?? null,
      estado: r?.estado ?? null,
      liquidacion_id: r?.liquidacion_id ?? null,
    };
  });
}

/**
 * Corre el consolidado y lo ESCRIBE: `costo_ajustado` y `costo_total` en cada
 * renglón, las recepciones a "Costeado", la liquidación a "Costeada".
 *
 * Los costos quedan CONGELADOS en la fila. No se recalculan al leer, y esa es la
 * diferencia entre un documento y una vista: lo que se aprobó y lo que se sube a
 * SIESA tiene que seguir diciendo lo mismo dentro de un año, aunque para
 * entonces el catálogo de precios haya cambiado tres veces.
 */
export async function costear(id) {
  const { liquidacion, consolidado, cierre } = await previsualizar(id);

  if (!cierre.ok) {
    const e = createError(409, "La liquidación todavía no se puede costear.");
    e.bloqueos = cierre.bloqueos;
    throw e;
  }

  // Se arman las filas completas porque el upsert necesita las columnas
  // obligatorias. Los datos ya están en memoria: no hace falta releer.
  const filas = [];
  for (const sede of consolidado.sedes) {
    for (const item of sede.costeo.items) {
      filas.push({
        id: item.id,
        recepcion_id: sede.recepcion_id,
        tipo: item.tipo,
        plantilla_item_id: item.plantilla_item_id ?? null,
        vicera_item_id: item.vicera_item_id ?? null,
        codigo_item: item.codigo_item ?? null,
        codigo_tabla: item.codigo_tabla ?? null,
        descripcion: item.descripcion,
        orden: item.orden ?? 0,
        cantidad: item.cantidad,
        costo_base: item.costo_base,
        costo_ajustado: item.costo_ajustado,
        costo_total: item.costo_total,
      });
    }
  }

  if (filas.length) {
    const { error } = await supabase.from(TABLE_ITEMS).upsert(filas);
    if (error) throw new Error(`Error al guardar el costeo: ${error.message}`);
  }

  const ahora = new Date().toISOString();
  const idsRecepciones = liquidacion.recepciones.map((r) => r.id);

  if (idsRecepciones.length) {
    const { error } = await supabase
      .from(TABLE_RECEPCIONES)
      .update({ estado: ESTADOS.COSTEADO, costeado_at: ahora })
      .in("id", idsRecepciones);
    if (error)
      throw new Error(`Error al marcar las recepciones: ${error.message}`);
  }

  const { error: errorEstado } = await supabase
    .from(TABLE)
    .update({ estado: ESTADOS_LIQUIDACION.COSTEADA })
    .eq("id", id);
  if (errorEstado)
    throw new Error(`Error al cerrar la liquidación: ${errorEstado.message}`);

  return previsualizar(id);
}

/**
 * Costeada → Abierta, para corregir un gasto y volver a costear.
 *
 * Limpia `costo_ajustado` y `costo_total`. Dejarlos sería peor que borrarlos: la
 * pantalla mostraría costos que ya no corresponden a los gastos cargados, y
 * nadie distingue un costo viejo de uno vigente mirándolo.
 */
export async function reabrir(id) {
  const liquidacion = await obtener(id);

  if (liquidacion.estado === ESTADOS_LIQUIDACION.CERRADA) {
    throw createError(409, "La liquidación está cerrada: ya se subió a SIESA.");
  }
  if (liquidacion.estado === ESTADOS_LIQUIDACION.ABIERTA) {
    throw createError(409, "La liquidación ya está abierta.");
  }

  const ids = liquidacion.recepciones.map((r) => r.id);

  if (ids.length) {
    const { error } = await supabase
      .from(TABLE_ITEMS)
      .update({ costo_ajustado: null, costo_total: null })
      .in("recepcion_id", ids);
    if (error) throw new Error(`Error al limpiar el costeo: ${error.message}`);

    // Solo las que están en "Costeado": si alguna ya se subió a SIESA, no se
    // toca. Ese documento ya existe en el ERP.
    const { error: errorEstado } = await supabase
      .from(TABLE_RECEPCIONES)
      .update({ estado: ESTADOS.APROBADO, costeado_at: null })
      .in("id", ids)
      .eq("estado", ESTADOS.COSTEADO);
    if (errorEstado) {
      throw new Error(
        `Error al revertir las recepciones: ${errorEstado.message}`,
      );
    }
  }

  const { error } = await supabase
    .from(TABLE)
    .update({ estado: ESTADOS_LIQUIDACION.ABIERTA })
    .eq("id", id);
  if (error) throw new Error(`Error al reabrir: ${error.message}`);

  return previsualizar(id);
}
