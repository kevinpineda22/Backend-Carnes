import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { fallarSiFaltaMigracion } from "../shared/migraciones.js";
import { ESTADOS } from "../shared/estadosProveedor.js";
import { normalizarFactura, resumenRecepcion } from "../shared/proveedorValores.js";
import { esConflictoReintentable, esViolacionUnica } from "../shared/aperturaProveedor.js";
import { TIPO_ENVIO_PROVEEDOR } from "../shared/siesaProveedor.js";
import { resumirEnvios, motivoEnvioVigente, siesaDeEnvios } from "../shared/siesaProveedorEnvio.js";
import {
  COLUMNAS_DETALLE_ADMIN,
  COLUMNAS_ENVIOS_LISTA,
  COLUMNAS_ITEMS_RESUMEN,
  COLUMNAS_LISTA_ADMIN,
  LIMITE_LISTA_DEFECTO,
  RECEPCIONES_POR_CONSULTA_ENVIOS,
  RECEPCIONES_POR_CONSULTA_ITEMS,
  agruparPor,
  armarAcciones,
  armarFilaListado,
  datosBorrador,
  decidirAnulacion,
  decidirCorreccionFactura,
  enLotes,
  facturaSiesaEfectiva,
  itemsConDevuelto,
  mensajeFacturaSiesaDuplicada,
  notaCreditoAdmin,
} from "../shared/adminProveedor.js";
import * as SiesaEnvio from "./SiesaEnvio.model.js";

/* =============================================
   Recepción de proveedor — lado del ADMIN: listar, ver el detalle, corregir la
   referencia de factura para SIESA y anular.

   Aparte de `RecepcionProveedor.model.js` (el del recibidor) a propósito: allá
   NUNCA salen la firma ni la cédula, acá el detalle sí las devuelve, y mezclarlos
   en un archivo es el camino a que un día una salga por el otro lado.

   Backend-Carnes no tiene autenticación: "admin" es una frontera de la pantalla,
   no un control de acceso (la misma postura de todas las rutas de Carnes).

   Las REGLAS (qué columnas salen, qué acciones hay, qué se rechaza) están en
   `shared/adminProveedor.js`, que sí tiene tests. Acá solo se lee, se escribe y
   se traducen errores.
   ============================================= */

const TABLE = "carnes_proveedor_recepciones";
const TABLE_ITEMS = "carnes_proveedor_recepcion_items";
const TABLE_ENVIOS = "carnes_siesa_envios";
const MIGRACIONES = ["sql/022_proveedores.sql"];

/** Igual que en `RecepcionProveedor.model.js`: un deadlock es un 409 que se reintenta, no un 500. */
function fallo(error, contexto) {
  if (esConflictoReintentable(error)) {
    throw createError(
      409,
      "Otra persona estaba modificando esta recepción al mismo tiempo. Intentá de nuevo.",
      "REINTENTAR",
    );
  }
  return fallarSiFaltaMigracion(error, contexto, MIGRACIONES);
}

// ─── Listar ────────────────────────────────────────────────────────────────

/**
 * Los renglones de varias recepciones, solo lo que entra en el resumen y solo los
 * recibidos (cantidad > 0), en tandas: PostgREST corta en silencio en 1000 filas.
 */
async function leerItemsDeResumen(ids) {
  const respuestas = await Promise.all(
    enLotes(ids, RECEPCIONES_POR_CONSULTA_ITEMS).map((lote) =>
      supabase.from(TABLE_ITEMS).select(COLUMNAS_ITEMS_RESUMEN).in("recepcion_id", lote).gt("cantidad", 0),
    ),
  );
  const filas = [];
  for (const { data, error } of respuestas) {
    if (error) fallo(error, "Error al leer los renglones");
    filas.push(...(data || []));
  }
  return filas;
}

/** Los envíos de varias recepciones, sin payload ni respuesta, en tandas. */
async function leerEnviosDeLista(ids) {
  const respuestas = await Promise.all(
    enLotes(ids, RECEPCIONES_POR_CONSULTA_ENVIOS).map((lote) =>
      supabase.from(TABLE_ENVIOS).select(COLUMNAS_ENVIOS_LISTA).in("recepcion_proveedor_id", lote),
    ),
  );
  const filas = [];
  for (const { data, error } of respuestas) {
    if (error) fallo(error, "Error al leer los envíos");
    filas.push(...(data || []));
  }
  return filas;
}

/**
 * Listado de recepciones de proveedor para el admin, de la más reciente a la más
 * vieja. SIN firma ni cédula (columnas nombradas, ver `COLUMNAS_LISTA_ADMIN`).
 *
 * Filtros (todos opcionales, ya validados): `estado`, `proveedor_id`, `sede_id`,
 * `desde` / `hasta` (sobre `fecha_recepcion`, ambos inclusivos) y `factura`
 * (fragmento, se compara contra la clave normalizada de la factura original).
 * Se pide una fila de más para saber si hay más resultados que el `limite`.
 *
 * @returns {{recepciones: object[], limite: number, truncado: boolean}}
 */
export async function listar({ estado, proveedor_id, sede_id, desde, hasta, factura, limite = LIMITE_LISTA_DEFECTO } = {}, ahora = new Date()) {
  let consulta = supabase
    .from(TABLE)
    .select(COLUMNAS_LISTA_ADMIN)
    .order("fecha_recepcion", { ascending: false })
    .order("id", { ascending: false })
    .limit(limite + 1);

  if (estado) consulta = consulta.eq("estado", estado);
  if (proveedor_id) consulta = consulta.eq("proveedor_id", proveedor_id);
  if (sede_id) consulta = consulta.eq("sede_id", sede_id);
  if (desde) consulta = consulta.gte("fecha_recepcion", desde);
  if (hasta) consulta = consulta.lte("fecha_recepcion", hasta);
  if (factura) {
    // `clave` es solo A-Z y 0-9 (`normalizarFactura`): no trae comodines ni comas.
    const { clave } = normalizarFactura(factura);
    if (clave) consulta = consulta.ilike("factura_clave", `%${clave}%`);
  }

  const { data, error } = await consulta;
  if (error) fallo(error, "Error al listar las recepciones");

  const filas = data || [];
  const truncado = filas.length > limite;
  const cabeceras = truncado ? filas.slice(0, limite) : filas;
  if (!cabeceras.length) return { recepciones: [], limite, truncado };

  const ids = cabeceras.map((c) => c.id);
  const [items, envios] = await Promise.all([leerItemsDeResumen(ids), leerEnviosDeLista(ids)]);
  const itemsPor = agruparPor(items, "recepcion_id");
  const enviosPor = agruparPor(envios, "recepcion_proveedor_id");

  const recepciones = cabeceras.map((cabecera) =>
    armarFilaListado({
      cabecera,
      items: itemsPor[String(cabecera.id)] || [],
      envios: enviosPor[String(cabecera.id)] || [],
      ahora,
    }),
  );
  return { recepciones, limite, truncado };
}

// ─── Detalle ───────────────────────────────────────────────────────────────

async function leerCabeceraAdmin(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNAS_DETALLE_ADMIN)
    .eq("id", id)
    .maybeSingle();
  if (error) fallo(error, "Error al leer la recepción");
  if (!data) throw createError(404, "Recepción no encontrada.");
  return data;
}

async function leerItemsAdmin(id) {
  const { data, error } = await supabase
    .from(TABLE_ITEMS)
    .select("*")
    .eq("recepcion_id", id)
    .order("orden")
    .order("id");
  if (error) fallo(error, "Error al leer los renglones");
  return data || [];
}

/**
 * El detalle completo para el admin: cabecera CON firma y cédula del recibidor
 * (es el único lugar que las devuelve), renglones con su `valor_devuelto`
 * calculado, envíos a SIESA (sin payload; con `resolvible`), la nota crédito y las
 * acciones que hoy se pueden hacer.
 *
 * Es de SOLO LECTURA: no manda nada a SIESA ni escribe. Se lee la cabecera ANTES
 * que los renglones y los envíos; si algo cambia entre lecturas, el siguiente
 * refresco lo alinea (no hay decisiones de escritura que tomar acá).
 */
export async function detalle(id, ahora = new Date()) {
  const cabecera = await leerCabeceraAdmin(id);
  const [items, envios] = await Promise.all([leerItemsAdmin(id), SiesaEnvio.enviosAdminProveedor(id)]);

  // La firma y la cédula NO viajan a las funciones de SIESA: el armador de la nota
  // crédito solo lee los campos de la recepción que no son sensibles.
  const { firma_data: _firma, recibidor_cedula: _cedula, ...paraSiesa } = cabecera;
  const { activo, notaCredito, decisionNotaCredito } = await SiesaEnvio.evaluarSiesaProveedor(
    { ...paraSiesa, items },
    envios,
  );

  return {
    recepcion: {
      ...cabecera,
      factura_siesa_efectiva: facturaSiesaEfectiva(cabecera),
      ...datosBorrador(cabecera, ahora),
      items: itemsConDevuelto(items),
      resumen: resumenRecepcion(items),
    },
    envios,
    siesa: siesaDeEnvios(envios),
    notaCredito: notaCreditoAdmin(notaCredito, cabecera.estado),
    acciones: armarAcciones({ estado: cabecera.estado, envios, activo, decisionNotaCredito }),
  };
}

// ─── Corregir la referencia de factura para SIESA ──────────────────────────

/**
 * Otra recepción VIVA del mismo proveedor que ya ocupe `clave`, sea como factura
 * original o como referencia corregida. Es la verificación SIMÉTRICA: cubre las dos
 * llaves únicas de sql/022 (`uq_carnes_prov_rec_factura_vigente`, sobre
 * `coalesce(factura_siesa_clave, factura_clave)`, y `uq_carnes_prov_rec_factura_original`)
 * y además el caso que ninguna cubre sola: mi referencia nueva contra la factura
 * original de otra que se corrigió a otra cosa. `clave` es solo A-Z/0-9, seguro
 * dentro del filtro `or`.
 */
async function buscarChoqueDeReferencia({ proveedorId, clave, excluirId }) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, factura, factura_siesa, estado, sede:carnes_sedes ( id, nombre )")
    .eq("proveedor_id", proveedorId)
    .neq("id", excluirId)
    .neq("estado", ESTADOS.ANULADA)
    .or(`factura_clave.eq.${clave},factura_siesa_clave.eq.${clave}`)
    .order("id")
    .limit(1);
  if (error) fallo(error, "Error al buscar la referencia");
  return data?.[0] || null;
}

/**
 * Corrige la referencia de factura que se manda a SIESA (`factura_siesa`), por
 * ejemplo cuando la factura tiene más de 12 caracteres y la entrada quedó
 * bloqueada. La factura ORIGINAL no se toca (sigue ocupando su llave de duplicado).
 *
 *   1. Formato y estado (`decidirCorreccionFactura`): 400 si la referencia no es
 *      válida o no cabe en 12; 409 si no está Finalizada o ya hay una entrada
 *      vigente / ok.
 *   2. Que ninguna otra recepción viva del proveedor la use (409
 *      `FACTURA_SIESA_DUPLICADA`). La base lo vuelve a garantizar con sus índices:
 *      un 23505 en el UPDATE es el mismo 409.
 *   3. UPDATE condicional a `estado = 'Finalizada'`; 0 filas → se vuelve a leer
 *      para decir la verdad.
 *   4. Se vuelve a mirar los envíos: si una entrada arrancó mientras se corregía,
 *      el resultado trae un `aviso` (no hay forma de cerrar esa ventana sin un
 *      trigger; es la misma que reconoce U11 para reintentar).
 *
 * No hay columna para "quién corrigió": queda en el log del servidor.
 *
 * @returns {{id: number, factura: string, factura_siesa: string, estado: string, aviso: ?string}}
 */
export async function corregirFacturaSiesa(id, { por, factura_siesa }) {
  const cabecera = await leerCabeceraBasica(id);
  const envios = await SiesaEnvio.enviosDeRecepcionProveedor(id);

  const decision = decidirCorreccionFactura({ estado: cabecera.estado, envios, factura_siesa });
  if (decision.accion === "rechazar") throw createError(decision.status, decision.mensaje, decision.codigo);

  const choque = await buscarChoqueDeReferencia({
    proveedorId: cabecera.proveedor_id,
    clave: decision.clave,
    excluirId: id,
  });
  if (choque) {
    throw createError(409, mensajeFacturaSiesaDuplicada(decision.factura, choque), "FACTURA_SIESA_DUPLICADA");
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ factura_siesa: decision.factura, factura_siesa_clave: decision.clave })
    .eq("id", id)
    .eq("estado", ESTADOS.FINALIZADA)
    .select("id, factura, factura_siesa, estado");

  if (esViolacionUnica(error)) {
    // Perdió la carrera contra otra recepción: se re-lee quién la ocupa para decirlo.
    const otro = await buscarChoqueDeReferencia({
      proveedorId: cabecera.proveedor_id,
      clave: decision.clave,
      excluirId: id,
    });
    throw createError(409, mensajeFacturaSiesaDuplicada(decision.factura, otro), "FACTURA_SIESA_DUPLICADA");
  }
  if (error) fallo(error, "Error al corregir la referencia de factura");

  if (!data?.length) {
    // 0 filas: ya no está Finalizada (la enviaron, la anularon o la descartaron).
    const actual = await leerCabeceraBasica(id);
    throw createError(
      409,
      `La recepción cambió mientras se corregía: ahora está en "${actual.estado}".`,
      "RECEPCION_CAMBIO",
    );
  }

  console.log(
    `✏️  Recepción de proveedor #${id}: referencia SIESA "${cabecera.factura_siesa ?? cabecera.factura}" → ` +
      `"${decision.factura}" por ${por || "—"}.`,
  );

  // ¿Arrancó una entrada mientras se corregía? Ese envío pudo salir con la referencia vieja.
  const despues = await SiesaEnvio.enviosDeRecepcionProveedor(id);
  const { vigente } = resumirEnvios(despues, TIPO_ENVIO_PROVEEDOR.ENTRADA);
  const aviso = vigente
    ? `Se corrigió la referencia, pero ya hay un envío a SIESA (${vigente.referencia}) que pudo salir con la ` +
      `anterior. ${motivoEnvioVigente(vigente)}`
    : null;

  return { ...data[0], aviso };
}

/** Lo mínimo para decidir: estado, proveedor y la referencia vigente. 404 si no existe. */
async function leerCabeceraBasica(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, proveedor_id, estado, factura, factura_siesa")
    .eq("id", id)
    .maybeSingle();
  if (error) fallo(error, "Error al leer la recepción");
  if (!data) throw createError(404, "Recepción no encontrada.");
  return data;
}

// ─── Anular ────────────────────────────────────────────────────────────────

/**
 * Anula una recepción Finalizada o Enviada_SIESA.
 *
 *   1. `decidirAnulacion`: un borrador se descarta (409), una anulada ya no se toca.
 *   2. Los envíos (`SiesaEnvio.anularEnviosProveedor`): uno en curso o sin confirmar
 *      es 409 (se resuelve primero); uno `ok` exige `anulado_en_siesa: true` (alguien
 *      ya anuló el documento en SIESA) y recién ahí se marcan `anulado`.
 *   3. La recepción pasa a Anulada con su autor, fecha y motivo, con un UPDATE
 *      condicional al estado leído (Finalizada o Enviada_SIESA): si alguien la movió
 *      entre medio no se pisa.
 *
 * Anular libera la llave de la factura: se puede volver a recibir.
 *
 * FALLO PARCIAL: no hay transacción entre (2) y (3). Si los envíos quedaron
 * `anulado` pero la recepción no cambió de estado, el error es 500
 * `ANULACION_PARCIAL` con los envíos ya anulados, y la recepción SIGUE
 * Finalizada/Enviada_SIESA: se repite la anulación y completa lo que falta (ya no
 * hay envíos `ok` que exijan confirmación, así que pasa directo al paso 3).
 * Mientras tanto la recepción figura Enviada_SIESA con sus envíos anulados:
 * `reintentar` la rechaza (ESTADO_INCONSISTENTE) y el reintento de una Finalizada
 * mandaría de nuevo, por eso el mensaje pide repetir la anulación enseguida.
 *
 * @param {number|string} id
 * @param {{por: string, motivo: string, anulado_en_siesa?: boolean}} p
 */
export async function anular(id, { por, motivo, anulado_en_siesa = false }) {
  const cabecera = await leerCabeceraBasica(id);
  const decision = decidirAnulacion({ estado: cabecera.estado });
  if (decision.accion === "rechazar") throw createError(decision.status, decision.mensaje, decision.codigo);

  const { anulados } = await SiesaEnvio.anularEnviosProveedor(id, {
    por,
    motivo,
    anuladoEnSiesa: anulado_en_siesa === true,
  });

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      estado: ESTADOS.ANULADA,
      anulado_por: por,
      anulado_at: new Date().toISOString(),
      motivo_anulacion: motivo,
    })
    .eq("id", id)
    .in("estado", [ESTADOS.FINALIZADA, ESTADOS.ENVIADA_SIESA])
    .select("id, estado, anulado_por, anulado_at, motivo_anulacion");

  if (error) {
    if (anulados.length) throw errorParcial(anulados, error);
    fallo(error, "Error al anular la recepción");
  }

  if (!data?.length) {
    // 0 filas: ya no es Finalizada ni Enviada_SIESA. Lo más probable es una doble
    // pulsación (la otra ya la anuló); se confirma leyendo.
    const actual = await leerCabeceraBasica(id);
    if (actual.estado === ESTADOS.ANULADA) {
      throw createError(409, "La recepción ya fue anulada por otra persona.", "RECEPCION_ANULADA");
    }
    throw createError(
      409,
      `La recepción cambió mientras se anulaba: ahora está en "${actual.estado}".`,
      "RECEPCION_CAMBIO",
    );
  }

  console.log(`🚫 Recepción de proveedor #${id} anulada por ${por}: ${motivo}`);
  return { ...data[0], envios_anulados: anulados };
}

/** Los envíos quedaron anulados pero el estado no se pudo cambiar: ver `anular`. */
function errorParcial(anulados, causa) {
  console.error(`🔴 Anulación parcial de la recepción de proveedor: ${causa.message}`);
  const e = createError(
    500,
    "Los envíos a SIESA quedaron marcados como anulados pero no se pudo anular la recepción. " +
      "Repetí la anulación para completarla.",
    "ANULACION_PARCIAL",
  );
  e.detalle = { envios_anulados: anulados };
  return e;
}
