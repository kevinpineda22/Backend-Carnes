/**
 * Envíos a SIESA: cuándo se manda, qué se guarda, qué cambia de estado.
 *
 * Armar el documento es de `shared/siesaEntrada.js`. Hacer el POST es de
 * `services/siesa.service.js`. Acá está la política:
 *
 *   inicial  automática al cerrar la recepción. Best-effort: si falla, se
 *            registra el error y la recepción se cierra igual. El recibidor
 *            no puede quedar trabado en la cava porque SIESA no responde.
 *   oficial  la dispara el admin desde la liquidación costeada. Es UNA CEA
 *            con los renglones de todas las sedes (sql/012). Si entra, las
 *            recepciones pasan a Enviado_SIESA, la liquidación a Cerrada, y
 *            sale un correo con todas las iniciales a anular. Si falla, no se
 *            cierra nada.
 *
 *            Antes era una CEA por sede. Esas filas quedan como historial, y
 *            si alguna sigue vigente bloquea la consolidada: mandar la
 *            consolidada encima de oficiales por sede duplicaría la carne.
 *
 *  ajuste_visceras
 *            las vísceras entran al inventario por un documento aparte (CEI,
 *            conector AJUSTE_INV_VISCERAS), UNO por liquidación con todas las
 *            sedes (sql/020), y SIESA lo CONTABILIZA al importarlo. Lo dispara
 *            el admin con la entrada oficial ya en SIESA. No cierra nada: la
 *            liquidación ya está cerrada. (Hasta sql/019 era uno por sede.)
 *
 *  ajuste_faltante
 *            si SIESA rechaza el ajuste de vísceras solo por "Item sin cantidad
 *            disponible", se manda un ajuste de inventario (CPE) por lo que
 *            falta, uno por bodega, y se reenvía el ajuste de vísceras (sql/021).
 *            Lo dispara el mismo botón de enviar el ajuste de vísceras.
 *
 * Todo intento —bueno o malo— deja una fila en `carnes_siesa_envios`.
 *
 * ─── El candado ───────────────────────────────────────────────────────────
 *
 * Un envío se RESERVA antes de mandarse: la fila entra en `enviando`, y un
 * índice único (sql/010) no deja que haya dos vigentes —enviando, ok o
 * sin_confirmar— para la misma recepción y tipo. Antes, "¿ya se mandó?" y el
 * POST eran dos pasos separados, y entre los dos cabía un segundo pedido: así
 * entraron R2O y R4O dos veces en la prueba de cerdo.
 */

import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { ESTADOS } from "../shared/estados.js";
import { fallarSiFaltaMigracion, esMigracionFaltante } from "../shared/migraciones.js";
import { puedeEliminarEnvio } from "../shared/eliminacionAdmin.js";
import {
  armarEntradaDirecta,
  armarEntradaLiquidacion,
  TIPO_ENVIO,
} from "../shared/siesaEntrada.js";
import {
  armarAjusteViscerasLiquidacion,
  guardaAjustesPorSede,
  consecutivoAjusteLiquidacion,
  coberturaOficial,
  viscerasEnCea,
  esperaParaSede,
  esperaParaEnvio,
  ESPERA_MINIMA_AJUSTE_MS,
  ESPERA_MAXIMA_COMPENSACION_MS,
  TIPO_AJUSTE_VISCERAS,
} from "../shared/siesaAjusteVisceras.js";
import {
  parsearFaltantes,
  soloFaltantes,
  armarAjusteFaltante,
  subirCantidadPorFaltante,
  faltantesQueNoBajaron,
  MAX_REINTENTOS_AJUSTE,
  TIPO_AJUSTE_FALTANTE,
} from "../shared/siesaFaltantes.js";
import {
  armarEntradaProveedor,
  armarNotaCreditoProveedor,
  consecutivoEntradaProveedor,
  consecutivoNotaCreditoProveedor,
  TIPO_ENVIO_PROVEEDOR,
} from "../shared/siesaProveedor.js";
import {
  armarRefrescoSnapshots,
  decidirEntradaAlFinalizar,
  decidirNotaCredito,
  decidirReintentoEntrada,
  enriquecerMovimientosProveedor,
  ESTADOS_EN_CURSO,
  esTipoProveedor,
  motivoEnvioVigente,
  notaCreditoParaFront,
  planearAnulacionEnvios,
  rechazoDeNotaCredito,
  resumirEnvios,
  siesaDeEnvios,
  siesaDeFila,
} from "../shared/siesaProveedorEnvio.js";
import { ESTADOS as ESTADOS_PROVEEDOR, puedeEnviarASiesa } from "../shared/estadosProveedor.js";
import {
  DOCUMENTO_AJUSTE_VISCERAS,
  DOCUMENTO_AJUSTE_FALTANTE,
  DOCUMENTO_CARNES,
  DOCUMENTO_NOTA_CREDITO_PROVEEDOR,
  bloqueoAjusteFaltante,
  documentoSiesa,
  siesaConfigurado,
  siesaActivo,
  faltantesSiesa,
  terceroCarnes,
  TERCEROS_CARNES,
} from "../config/siesa.js";
import {
  enviarASiesa,
  TIMEOUT_INICIAL_MS,
  TIMEOUT_OFICIAL_MS,
} from "../services/siesa.service.js";
import {
  notificarAnularInicial,
  notificarAnularIniciales,
} from "../services/notificaciones.service.js";

const TABLA = "carnes_siesa_envios";

/** Estados que ocupan el lugar del envío de una recepción. Ver sql/010. */
const VIGENTES = ["enviando", "ok", "sin_confirmar"];

/**
 * Un `enviando` más viejo que esto es un envío cuya función murió en el medio.
 * Tiene que quedar POR ENCIMA de la espera más larga a SIESA
 * (TIMEOUT_OFICIAL_MS, 4 min) y del límite de la función en Vercel (300 s, el
 * default de Fluid compute; vercel.json no lleva bloque `functions`): un envío
 * vivo nunca puede verse abandonado, o alguien lo reenvía mientras corre.
 */
const ENVIANDO_ABANDONADO_MS = 6 * 60 * 1000;

const MIGRACIONES = [
  "sql/007_siesa.sql",
  "sql/008_pagos_y_tercero.sql",
  "sql/010_siesa_candado.sql",
  "sql/011_siesa_anulacion.sql",
  "sql/012_siesa_cea_liquidacion.sql",
  "sql/019_ajuste_visceras.sql",
  "sql/020_ajuste_visceras_liquidacion.sql",
  "sql/021_ajuste_faltante.sql",
];

/**
 * Lo que necesitan los envíos de las recepciones de PROVEEDOR. Lista aparte de
 * `MIGRACIONES` a propósito: el mensaje de "falta una migración" de las rutas de
 * Talleres no tiene por qué nombrar archivos que ellas no usan.
 */
const ARCHIVO_SQL_PROVEEDOR = "sql/023_siesa_proveedor.sql";
const MIGRACIONES_PROVEEDOR = [...MIGRACIONES, "sql/022_proveedores.sql", ARCHIVO_SQL_PROVEEDOR];

/**
 * Consecutivo propio para enlazar cabecera y movimientos dentro de un envío.
 *
 * SIESA lo recalcula (`F_CONSEC_AUTO_REG = 1`), así que solo tiene que ser
 * consistente adentro del mismo JSON y caber en 8 dígitos. `id × 10 + tipo`
 * es único por recepción y tipo, y deja ver de un vistazo a qué recepción
 * pertenece.
 */
const consecutivoDe = (recepcionId, tipo) =>
  Number(recepcionId) * 10 + (tipo === TIPO_ENVIO.OFICIAL ? 2 : 1);

/** Lo mismo para la oficial consolidada: `id × 10 + 3`, no choca con las de sede. */
const consecutivoLiquidacion = (liquidacionId) => Number(liquidacionId) * 10 + 3;

// ─── Lectura ───────────────────────────────────────────────────────────────

/** La recepción con su sede (incluida la bodega) y sus renglones. */
async function cargarRecepcion(recepcionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select("*, sede:carnes_sedes ( id, codigo_co, nombre, bodega_siesa )")
    .eq("id", recepcionId)
    .maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer la recepción", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  if (!data) throw createError(404, "Recepción no encontrada.");

  const { data: items, error: e2 } = await supabase
    .from("carnes_recepcion_items")
    .select("*")
    .eq("recepcion_id", recepcionId)
    .order("tipo")
    .order("orden");
  if (e2)
    fallarSiFaltaMigracion(e2, "Error al leer los renglones", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);

  return { ...data, items: items || [] };
}

/**
 * El envío que ocupa el lugar de esta recepción y tipo —enviando, ok o
 * sin_confirmar—, o null si se puede mandar.
 */
async function envioVigente(recepcionId, tipo) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("recepcion_id", recepcionId)
    .eq("tipo", tipo)
    .in("estado", VIGENTES)
    .order("enviado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  return data || null;
}

/**
 * La oficial CONSOLIDADA que ocupa el lugar de esta liquidación —enviando, ok o
 * sin_confirmar—, o null. Es la que cuida el índice de sql/012.
 */
async function oficialDeLiquidacion(liquidacionId) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("liquidacion_id", liquidacionId)
    .is("recepcion_id", null)
    .eq("tipo", TIPO_ENVIO.OFICIAL)
    .in("estado", VIGENTES)
    .order("enviado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  return data || null;
}

/** Los ids de las recepciones vinculadas a una liquidación. */
async function idsDeLiquidacion(liquidacionId) {
  const { data, error } = await supabase
    .from("carnes_recepciones")
    .select("id")
    .eq("liquidacion_id", liquidacionId)
    .order("id");
  if (error) fallarSiFaltaMigracion(error, "Error al leer las recepciones", MIGRACIONES);
  return (data || []).map((r) => r.id);
}

/**
 * Los envíos que tocan una recepción: los directos (`recepcion_id`) y los de
 * la CEA consolidada que la incluye (`recepcion_ids`, ver sql/012).
 *
 * Lo usa `Recepcion.model.js#eliminarRecepcionAdmin` para decidir si se puede
 * borrar, y el endpoint de solo lectura que le muestra al admin qué
 * referencias de SIESA hay que anular allá antes de borrar acá.
 */
export async function enviosDeRecepcion(recepcionId) {
  const [{ data: directos, error: e1 }, { data: consolidados, error: e2 }] = await Promise.all([
    supabase
      .from(TABLA)
      .select("id, tipo, estado, referencia, enviado_at")
      .eq("recepcion_id", recepcionId),
    supabase
      .from(TABLA)
      .select("id, tipo, estado, referencia, enviado_at")
      .is("recepcion_id", null)
      .overlaps("recepcion_ids", [Number(recepcionId)]),
  ]);
  if (e1) fallarSiFaltaMigracion(e1, "Error al leer los envíos", MIGRACIONES);
  if (e2) fallarSiFaltaMigracion(e2, "Error al leer los envíos", MIGRACIONES);
  return [...(directos || []), ...(consolidados || [])];
}

/**
 * ¿El insert del ajuste falló porque a la base le falta sql/019?
 *
 * En una base sin migrar `tipo` es VARCHAR(10): 'ajuste_visceras' (15) no
 * cabe y Postgres responde 22001 (valor demasiado largo), no el CHECK. Con la
 * columna ya ensanchada pero sin el CHECK nuevo sería 23514. Los dos significan
 * lo mismo: falta correr la migración.
 */
const faltaMigracion019 = (error, tipo) =>
  tipo === TIPO_AJUSTE_VISCERAS && ["22001", "23514"].includes(error?.code);

/**
 * Lo mismo para el ajuste por faltante (sql/021): 'ajuste_faltante' mide 15 y
 * cabe en la columna que dejó sql/019, así que sin sql/021 falla el CHECK
 * (23514); si además faltara sql/019, sería 22001. Una columna que no existe
 * (`bodega`, `envio_origen_id`) la traduce `fallarSiFaltaMigracion`.
 */
const archivoMigracionFaltante = (error, tipo) => {
  // Envíos de proveedor (sql/023): sin la migración el tipo no está en el CHECK
  // (23514), no cabe (22001) o falta la columna `recepcion_proveedor_id`. Solo
  // aplica a esos dos tipos: los de Talleres siguen por las ramas de abajo.
  if (esTipoProveedor(tipo) && (["22001", "23514"].includes(error?.code) || esMigracionFaltante(error))) {
    return ARCHIVO_SQL_PROVEEDOR;
  }
  if (faltaMigracion019(error, tipo)) return "sql/019_ajuste_visceras.sql";
  if (tipo === TIPO_AJUSTE_FALTANTE && error?.code === "22001") return "sql/019_ajuste_visceras.sql";
  if (tipo === TIPO_AJUSTE_FALTANTE && error?.code === "23514") return "sql/021_ajuste_faltante.sql";
  return null;
};

const errorFaltaMigracion = (archivo) =>
  createError(503, `A la base le falta ${archivo}. Corrélo en Supabase y volvé a intentar.`);

/** Por qué no se puede mandar, dicho para una persona. */
function motivoVigente(envio) {
  if (envio.estado === "ok") return `Ya está en SIESA (${envio.referencia}).`;
  if (envio.estado === "enviando") {
    return `Hay un envío en curso (${envio.referencia}). Esperá a que termine y actualizá.`;
  }
  return (
    `El envío ${envio.referencia} quedó sin confirmar: SIESA pudo haberlo creado. ` +
    "Verificalo en SIESA y marcalo desde el panel de envíos antes de reintentar."
  );
}

/** El último envío ok de un tipo para una recepción, o null. */
async function ultimoEnvio(recepcionId, tipo, soloOk = true) {
  let q = supabase
    .from(TABLA)
    .select("*")
    .eq("recepcion_id", recepcionId)
    .eq("tipo", tipo)
    .order("enviado_at", { ascending: false })
    .limit(1);
  if (soloOk) q = q.eq("estado", "ok");
  const { data, error } = await q.maybeSingle();
  if (error)
    fallarSiFaltaMigracion(error, "Error al leer el envío", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  return data || null;
}

/**
 * GET — listado para el panel de trazabilidad.
 * @param {{tipo?, estado?, recepcion_id?, liquidacion_id?, limite?}} f
 */
export async function listar(f = {}) {
  const columnas = (conBodega) =>
    "id, recepcion_id, liquidacion_id, tipo, estado, referencia, consecutivo, tipo_docto, " +
    "http_status, error, renglones, total_kilos, total_valor, enviado_por, enviado_at, aviso_anulacion, " +
    "recepcion_ids, " +
    // `bodega` y `envio_origen_id` son de sql/021 (el ajuste por faltante).
    (conBodega ? "bodega, envio_origen_id, " : "") +
    "recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) ), " +
    // La oficial consolidada no tiene recepción: la especie y la fecha
    // salen de la liquidación.
    "liquidacion:carnes_liquidaciones ( id, especie, fecha, estado )";
  const consulta = (conBodega) => {
    let q = supabase
      .from(TABLA)
      .select(columnas(conBodega))
      .order("enviado_at", { ascending: false })
      .limit(Math.min(Number(f.limite) || 100, 500));
    if (f.tipo) q = q.eq("tipo", f.tipo);
    if (f.estado) q = q.eq("estado", f.estado);
    if (f.recepcion_id) q = q.eq("recepcion_id", f.recepcion_id);
    if (f.liquidacion_id) q = q.eq("liquidacion_id", f.liquidacion_id);
    return q;
  };

  let { data, error } = await consulta(true);
  // Sin sql/021 las columnas nuevas no existen: el panel sigue mostrando lo de
  // antes en vez de caerse.
  if (error && esMigracionFaltante(error)) ({ data, error } = await consulta(false));
  if (error)
    fallarSiFaltaMigracion(error, "Error al listar envíos", [
      "sql/007_siesa.sql",
      "sql/008_pagos_y_tercero.sql",
    ]);
  // Sin envíos de proveedor en el resultado devuelve el MISMO arreglo, sin una
  // consulta de más: el listado de Talleres no cambia.
  return conRecepcionProveedor(data || []);
}

/**
 * A los envíos de PROVEEDOR del listado les pega su recepción
 * (`recepcion_proveedor`: factura, razón social, estado y sede), que es lo que el
 * panel necesita para nombrarlos: sus columnas `recepcion` y `liquidacion` vienen
 * vacías. Los de Talleres no se tocan (no ganan ni una clave).
 *
 * Es una consulta aparte y no un embed en la principal a propósito: así la
 * consulta de Talleres, con su fallback a sql/021, queda exactamente como estaba.
 * Si esta falla (p. ej. sql/023 sin correr) el listado sale igual, sin el dato.
 */
async function conRecepcionProveedor(filas) {
  const deProveedor = filas.filter((f) => esTipoProveedor(f.tipo));
  if (!deProveedor.length) return filas;
  try {
    const { data, error } = await supabase
      .from(TABLA)
      .select(
        "id, recepcion_proveedor_id, " +
          "recepcion_proveedor:carnes_proveedor_recepciones ( id, factura, factura_siesa, proveedor_razon_social, estado, sede:carnes_sedes ( id, nombre ) )",
      )
      .in(
        "id",
        deProveedor.map((f) => f.id),
      );
    if (error) throw error;
    const porId = new Map((data || []).map((d) => [d.id, d]));
    return filas.map((f) => {
      const extra = porId.get(f.id);
      return extra
        ? { ...f, recepcion_proveedor_id: extra.recepcion_proveedor_id, recepcion_proveedor: extra.recepcion_proveedor }
        : f;
    });
  } catch (e) {
    console.error(`🔴 SIESA listado: no se pudo leer la recepción de los envíos de proveedor: ${e?.message}`);
    return filas;
  }
}

/** GET — un envío con el payload y la respuesta completos. */
export async function obtener(id) {
  const { data, error } = await supabase
    .from(TABLA)
    .select(
      "*, recepcion:carnes_recepciones ( id, especie, fecha_ingreso, estado, sede:carnes_sedes ( id, nombre ) ), " +
        "liquidacion:carnes_liquidaciones ( id, especie, fecha, estado )",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  if (!data) throw createError(404, "Envío no encontrado.");

  // Envío de una recepción de PROVEEDOR: sus renglones salen de otra tabla. Los
  // de Talleres no entran acá: siguen por todo lo de abajo, sin cambios.
  if (esTipoProveedor(data.tipo)) return obtenerEnvioProveedor(data);

  // El payload lleva el código del ítem y nada más: es lo que SIESA necesita.
  // Para la pantalla se le pega, a cada movimiento, el renglón de la recepción
  // del que salió: sede, descripción, costo base y costo ajustado. Así el admin
  // puede ver de un vistazo si la oficial salió con el costo liquidado.
  //
  // El renglón se busca por código, cantidad y —en la consolidada— bodega. Solo
  // por código no alcanza: varios cortes comparten el mismo código de SIESA
  // (15187 lo tienen FALDITA, PUNTA DE FALDA, ENTRAÑITAS y PUNTA ESPALDILLA), y
  // en la consolidada el mismo corte aparece una vez por sede.
  //
  // Los costos son los de HOY, no los del momento del envío: si la liquidación
  // se reabrió después, `costo_ajustado` puede venir vacío. El costo enviado sí
  // es el de entonces, porque sale del payload guardado.
  const idsRecepciones = data.recepcion_id
    ? [data.recepcion_id]
    : data.recepcion_ids?.length
      ? data.recepcion_ids
      : data.liquidacion_id
        ? await idsDeLiquidacion(data.liquidacion_id)
        : [];

  // El ajuste de vísceras y su compensación por faltante se explican con los
  // renglones de VÍSCERA; la CEA, con los de carne y adicionales.
  const esFaltante = data.tipo === TIPO_AJUSTE_FALTANTE;
  const esAjuste = data.tipo === TIPO_AJUSTE_VISCERAS || esFaltante;
  let items = [];
  const sedeDe = new Map();
  if (idsRecepciones.length) {
    const [{ data: filas }, { data: recs }] = await Promise.all([
      supabase
        .from("carnes_recepcion_items")
        .select("id, recepcion_id, codigo_item, descripcion, cantidad, costo_base, costo_ajustado")
        .in("recepcion_id", idsRecepciones)
        .in("tipo", esAjuste ? ["vicera"] : ["carne", "adicional"])
        .gt("cantidad", 0)
        .order("recepcion_id")
        .order("orden"),
      supabase
        .from("carnes_recepciones")
        .select("id, sede:carnes_sedes ( nombre, bodega_siesa )")
        .in("id", idsRecepciones),
    ]);
    items = filas || [];
    for (const r of recs || []) sedeDe.set(r.id, r.sede || {});
  }

  const milesimas = (n) => Math.round((Number(n) || 0) * 1000);
  const usados = new Set();
  const renglonDe = (m) => {
    // El ajuste por faltante hoy manda el ítem sin ceros (conector 257784); se
    // siguen quitando por si hay filas viejas guardadas con el formato de 7.
    const crudo = String(m.ITEM ?? "").trim();
    const codigo = esFaltante ? crudo.replace(/^0+/, "") : crudo;
    const bodega = String(m.BODEGA ?? "").trim();
    const candidatos = items.filter(
      (i) =>
        !usados.has(i.id) &&
        String(i.codigo_item ?? "").trim() === codigo &&
        // Con una sola recepción la bodega no discrimina nada; con varias, sí.
        (idsRecepciones.length === 1 ||
          String(sedeDe.get(i.recepcion_id)?.bodega_siesa ?? "").trim() === bodega),
    );
    const elegido =
      candidatos.find((i) => milesimas(i.cantidad) === milesimas(m.CANTIDAD)) ||
      candidatos[0] ||
      null;
    if (elegido) usados.add(elegido.id);
    return elegido;
  };

  const numero = (v) => (v === null || v === undefined ? null : Number(v));
  const movimientos = (data.payload?.Movimientos || []).map((m, n) => {
    const cantidad = Number(m.CANTIDAD) || 0;
    // El ajuste no manda VALOR_BRUTO sino el costo UNITARIO (COSTO_PROMEDIO), con
    // las claves "C.O." y "C.O MOVIMIENTO" del conector. Se lleva a la forma de
    // la CEA para que la pantalla lea los dos igual.
    const costoUnitario = esAjuste ? Number(m.COSTO_PROMEDIO) || 0 : null;
    const bruto = esAjuste
      ? Math.round(cantidad * costoUnitario * 100) / 100
      : Number(m.VALOR_BRUTO) || 0;
    const renglon = renglonDe(m);
    return {
      ...m,
      ...(esFaltante ? { ITEM: String(m.ITEM ?? "").replace(/^0+/, "") } : {}),
      NRO_REGISTRO: m.NRO_REGISTRO ?? String(m.f470_nro_registro ?? n + 1),
      CO_MOVIMIENTO: m.CO_MOVIMIENTO ?? m["C.O MOVIMIENTO"] ?? "",
      sede: renglon ? sedeDe.get(renglon.recepcion_id)?.nombre ?? null : null,
      descripcion: renglon?.descripcion ?? null,
      cantidad,
      valor_bruto: bruto,
      precio_unitario: esAjuste
        ? costoUnitario
        : cantidad > 0
          ? Math.round((bruto / cantidad) * 100) / 100
          : null,
      costo_base: numero(renglon?.costo_base),
      costo_ajustado: numero(renglon?.costo_ajustado),
    };
  });

  return { ...data, movimientos };
}

// ─── El envío en sí ────────────────────────────────────────────────────────

/**
 * Envío de UNA recepción (la inicial): arma y delega en `registrarYEnviar`.
 */
async function ejecutarEnvio({
  recepcion,
  tipo,
  liquidacionId = null,
  por,
  referenciaInicial,
  terceroId,
}) {
  const consecutivo = consecutivoDe(recepcion.id, tipo);
  const armado = armarEntradaDirecta({
    recepcion,
    items: recepcion.items,
    tipo,
    consecutivo,
    config: documentoSiesa(terceroId),
    referenciaInicial,
  });
  return registrarYEnviar({
    armado,
    base: { recepcion_id: recepcion.id, liquidacion_id: liquidacionId, tipo, consecutivo },
    por,
    vigente: () => envioVigente(recepcion.id, tipo),
    etiqueta: `${tipo} recepción #${recepcion.id}`,
  });
}

/**
 * Registra, reserva, manda y anota el resultado. No lanza por SIESA: devuelve
 * la fila guardada.
 *
 * Sirve para los dos niveles: una recepción (la inicial) y una liquidación (la
 * oficial consolidada). Lo que cambia es la fila base y cómo se busca el envío
 * vigente cuando el índice único rechaza la reserva.
 *
 * @param {object}   p
 * @param {object}   p.armado    { payload, resumen, bloqueos }
 * @param {object}   p.base      columnas propias: recepcion_id, liquidacion_id, tipo, consecutivo…
 * @param {string}   [p.por]
 * @param {Function} p.vigente   () => el envío que ocupa el lugar, o null
 * @param {string}   p.etiqueta  para los logs
 * @param {{idDocumento: string, nombreDocumento: string}} [p.documento]
 *        conector destino; sin él, la CEA de carnes
 * @param {number}   [p.timeoutMs]  espera a SIESA; sin él, según el tipo
 */
async function registrarYEnviar({ armado, base, por, vigente, etiqueta, documento, timeoutMs }) {
  const { payload, resumen, bloqueos } = armado;
  const tipo = base.tipo;

  const fila = {
    ...base,
    referencia: resumen.referencia,
    // El ajuste de vísceras no manda TIPO_DOCTO (es fijo en el conector): el
    // tipo, si hay, lo trae `base`.
    tipo_docto: payload.Documentos[0]?.TIPO_DOCTO || base.tipo_docto || null,
    payload,
    renglones: resumen.renglones,
    total_kilos: resumen.totalKilos,
    total_valor: resumen.totalValor,
    enviado_por: por || null,
  };

  // ─── No sale nada: se anota el motivo y listo ───
  //
  // Sin reserva: un bloqueo no manda nada a SIESA, así que no hay duplicado
  // que evitar, y la fila `error` no ocupa el lugar.
  const noSale = bloqueos.length
    ? bloqueos.join(" ")
    : !siesaConfigurado()
      ? `SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`
      : null;
  if (noSale) {
    const { data, error } = await supabase
      .from(TABLA)
      .insert({ ...fila, estado: "error", error: noSale })
      .select("*")
      .single();
    const faltaNoSale = archivoMigracionFaltante(error, tipo);
    if (faltaNoSale) throw errorFaltaMigracion(faltaNoSale);
    if (error) fallarSiFaltaMigracion(error, "No se pudo registrar el envío", MIGRACIONES);
    console.error(`🔴 SIESA ${etiqueta}: ${noSale}`);
    return data;
  }

  // ─── Reserva ───
  //
  // Si ya hay uno vigente, el índice único rechaza el insert y NO se manda.
  const { data: reserva, error: errorReserva } = await supabase
    .from(TABLA)
    .insert({ ...fila, estado: "enviando" })
    .select("*")
    .single();
  if (errorReserva) {
    if (errorReserva.code === "23505") {
      const ocupado = await vigente();
      return {
        ...(ocupado || { ...base, estado: "enviando", referencia: fila.referencia }),
        repetido: true,
      };
    }
    // Sin sql/019 el tipo `ajuste_visceras` no cabe (22001) o no está en el
    // CHECK (23514); sin sql/021 `ajuste_faltante` no está en el CHECK; sin
    // sql/010 el CHECK viejo no conoce `enviando`.
    const faltaReserva = archivoMigracionFaltante(errorReserva, tipo);
    if (faltaReserva) throw errorFaltaMigracion(faltaReserva);
    if (errorReserva.code === "23514") {
      throw createError(
        503,
        "A la base le falta sql/010_siesa_candado.sql. Corrélo en Supabase y volvé a intentar.",
      );
    }
    fallarSiFaltaMigracion(errorReserva, "No se pudo registrar el envío", MIGRACIONES);
  }

  const resultado = await enviarASiesa(payload, {
    timeoutMs:
      timeoutMs ?? (tipo === TIPO_ENVIO.OFICIAL ? TIMEOUT_OFICIAL_MS : TIMEOUT_INICIAL_MS),
    ...(documento ? { documento } : {}),
  });
  const estado = resultado.ok ? "ok" : resultado.incierto ? "sin_confirmar" : "error";

  const cierre = {
    estado,
    respuesta: resultado.respuesta,
    http_status: resultado.status,
    error: resultado.error,
  };
  // Solo si sigue en `enviando`: si alguien la resolvió o la anuló mientras
  // SIESA contestaba, no se pisa lo que esa persona registró.
  const { data, error } = await supabase
    .from(TABLA)
    .update(cierre)
    .eq("id", reserva.id)
    .eq("estado", "enviando")
    .select("*")
    .maybeSingle();
  if (error || !data) {
    // SIESA ya contestó y no se pudo anotar. Se devuelve lo que la base DICE,
    // no lo que SIESA respondió: si se devolviera `ok` sin haberlo escrito, el
    // que llama podría cerrar la liquidación con la fila todavía en `enviando`.
    // Queda trabado —se resuelve desde el panel—, que es mejor que duplicado.
    console.error(
      `🔴 SIESA ${etiqueta}: respondió "${estado}" pero no se pudo anotar ` +
        `(${error?.message || "la fila ya no estaba en enviando"}).`,
    );
    const { data: real } = await supabase
      .from(TABLA)
      .select("*")
      .eq("id", reserva.id)
      .maybeSingle();
    const actual = real || reserva;
    return {
      ...actual,
      error:
        `SIESA respondió "${estado}" pero no se pudo anotar. Verificá en SIESA la ` +
        `referencia ${actual.referencia} y resolvelo desde el panel de envíos.`,
    };
  }

  if (estado !== "ok") {
    console.error(`🔴 SIESA ${etiqueta}: ${resultado.error}`);
  }
  return data;
}

/**
 * Entrada INICIAL. Se llama al cerrar la recepción. Nunca lanza: si falla, la
 * fila queda con el error y se devuelve igual.
 */
export async function enviarInicial(recepcionId, por) {
  // Apagado: no se manda ni se registra. Registrar cada cierre como "error"
  // mientras el interruptor está en off llenaría el panel de filas que no
  // significan nada.
  if (!siesaActivo()) {
    return {
      estado: "apagado",
      tipo: TIPO_ENVIO.INICIAL,
      recepcion_id: recepcionId,
    };
  }
  try {
    const recepcion = await cargarRecepcion(recepcionId);
    // Si ya hay una inicial vigente, no se manda otra: SIESA tendría dos
    // documentos de la misma carne y el que anula no sabría cuál.
    const previa = await envioVigente(recepcionId, TIPO_ENVIO.INICIAL);
    if (previa) return { ...previa, repetido: true };

    return await ejecutarEnvio({ recepcion, tipo: TIPO_ENVIO.INICIAL, por });
  } catch (e) {
    console.error(`🔴 SIESA inicial recepción #${recepcionId}: ${e.message}`);
    return {
      estado: "error",
      error: e.message,
      tipo: TIPO_ENVIO.INICIAL,
      recepcion_id: recepcionId,
    };
  }
}

/** Reintento manual de la inicial, desde el panel. Sí lanza si no se puede. */
export async function reintentarInicial(recepcionId, por) {
  if (!siesaActivo()) {
    throw createError(
      409,
      "El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).",
    );
  }
  const recepcion = await cargarRecepcion(recepcionId);
  if (
    ![ESTADOS.RECIBIDO, ESTADOS.APROBADO, ESTADOS.COSTEADO].includes(
      recepcion.estado,
    )
  ) {
    throw createError(
      409,
      `La recepción está en ${recepcion.estado}: la inicial ya no aplica.`,
    );
  }
  const previa = await envioVigente(recepcionId, TIPO_ENVIO.INICIAL);
  if (previa) throw createError(409, motivoVigente(previa));
  const fila = await ejecutarEnvio({ recepcion, tipo: TIPO_ENVIO.INICIAL, por });
  // Otro pedido la reservó entre la pregunta de arriba y la reserva.
  if (fila.repetido) throw createError(409, motivoVigente(fila));
  return fila;
}

/**
 * Arma la oficial consolidada de una liquidación con los datos de AHORA.
 *
 * Se llama dos veces: al previsualizar y justo antes de mandar. La segunda no
 * reusa la primera: entre una y otra el admin pudo volver a costear.
 */
async function armarOficial(liquidacionId, terceroId) {
  const ids = await idsDeLiquidacion(liquidacionId);
  const recepciones = [];
  for (const id of ids) recepciones.push(await cargarRecepcion(id));
  const armado = armarEntradaLiquidacion({
    liquidacionId,
    recepciones,
    consecutivo: consecutivoLiquidacion(liquidacionId),
    config: documentoSiesa(terceroId),
  });
  return { ids, recepciones, armado };
}

/**
 * Oficiales POR SEDE (el esquema de antes) que siguen vigentes. Si hay alguna,
 * la consolidada no sale: esa carne ya está en SIESA en otro documento.
 */
async function oficialesPorSedeVigentes(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, recepcion_id, estado, referencia")
    .in("recepcion_id", ids)
    .eq("tipo", TIPO_ENVIO.OFICIAL)
    .in("estado", VIGENTES);
  if (error) fallarSiFaltaMigracion(error, "Error al leer los envíos", MIGRACIONES);
  return data || [];
}

/**
 * CEA consolidadas vigentes de OTRAS liquidaciones que ya llevan alguna de
 * estas recepciones.
 *
 * El candado de sql/012 es por liquidación: no ve que la misma recepción esté
 * en el documento de otra. Eso pasa si se la movió de liquidación con la CEA de
 * la primera todavía viva. `desvincular` ya lo frena; esto es la segunda capa,
 * justo antes de mandar, porque acá un error duplica inventario.
 */
async function oficialesDeOtrasLiquidaciones(liquidacionId, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, liquidacion_id, estado, referencia")
    .is("recepcion_id", null)
    .eq("tipo", TIPO_ENVIO.OFICIAL)
    .in("estado", VIGENTES)
    .neq("liquidacion_id", liquidacionId)
    .overlaps("recepcion_ids", ids);
  if (error) fallarSiFaltaMigracion(error, "Error al leer los envíos", MIGRACIONES);
  return data || [];
}

/**
 * Qué pasaría al enviar la oficial, sin mandar nada. Para que el botón del
 * panel pueda decir "no se puede, por esto" antes de apretarlo.
 */
export async function previsualizarOficial(liquidacionId, terceroId) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado, especie, siesa_nit, siesa_sucursal")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { ids, recepciones, armado } = await armarOficial(liquidacionId, terceroId);
  const [oficial, porSede, deOtras] = await Promise.all([
    oficialDeLiquidacion(liquidacionId),
    oficialesPorSedeVigentes(ids),
    oficialesDeOtrasLiquidaciones(liquidacionId, ids),
  ]);

  const sedes = [];
  for (const s of armado.porSede) {
    const inicial = await ultimoEnvio(s.recepcion_id, TIPO_ENVIO.INICIAL);
    const vieja = porSede.find((e) => e.recepcion_id === s.recepcion_id) || null;
    sedes.push({
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      estado: recepciones.find((r) => r.id === s.recepcion_id)?.estado,
      inicial: inicial
        ? { referencia: inicial.referencia, enviado_at: inicial.enviado_at }
        : null,
      // Oficial por sede del esquema anterior, si sigue vigente.
      oficialPorSede: vieja ? { id: vieja.id, estado: vieja.estado, referencia: vieja.referencia } : null,
      resumen: s.resumen,
      bloqueos: s.bloqueos,
    });
  }

  const configurado = siesaConfigurado();
  const bloqueosGlobales = [];
  if (liq.estado !== "Costeada" && liq.estado !== "Cerrada") {
    bloqueosGlobales.push("La liquidación tiene que estar costeada.");
  }
  if (!siesaActivo()) {
    bloqueosGlobales.push("El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).");
  }
  if (!configurado) {
    bloqueosGlobales.push(`SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`);
  }
  if (deOtras.length) {
    bloqueosGlobales.push(
      `Alguna recepción de esta liquidación ya está en la entrada oficial de otra liquidación ` +
        `(${deOtras.map((e) => `${e.referencia}, ${e.estado}`).join("; ")}). ` +
        "Anulala en SIESA y registralo antes de mandar esta, o la carne entraría dos veces.",
    );
  }
  if (porSede.length) {
    bloqueosGlobales.push(
      `Esta liquidación ya tiene oficiales por sede en SIESA (${porSede.map((e) => e.referencia).join(", ")}). ` +
        "Anulalas en SIESA y registralo antes de mandar la consolidada, o la carne entraría dos veces.",
    );
  }

  return {
    liquidacion: liq,
    terceros: TERCEROS_CARNES,
    tercero: terceroCarnes(terceroId),
    configurado,
    bloqueos: bloqueosGlobales,
    // La CEA que se mandaría: una sola, con todas las sedes.
    documento: { ...armado.resumen, bloqueos: armado.bloqueos },
    // `enviado_at` para que la pantalla distinga un envío vivo de uno abandonado.
    oficial: oficial
      ? {
          id: oficial.id,
          estado: oficial.estado,
          referencia: oficial.referencia,
          enviado_at: oficial.enviado_at,
        }
      : null,
    sedes,
    puedeEnviar:
      bloqueosGlobales.length === 0 &&
      armado.bloqueos.length === 0 &&
      !oficial &&
      sedes.length > 0,
  };
}

/**
 * Cierra la liquidación: recepciones a Enviado_SIESA, liquidación a Cerrada,
 * y se anota con qué tercero entró.
 *
 * El tercero sale del PAYLOAD que se mandó, no del que el admin tenga elegido
 * ahora en pantalla: si se cierra en un segundo clic (después de resolver un
 * "sin confirmar"), lo que vale es lo que está en SIESA.
 */
async function cerrarLiquidacion(liquidacionId, ids, envio) {
  const doc = envio.payload?.Documentos?.[0] || {};
  const { error: e1 } = await supabase
    .from("carnes_recepciones")
    .update({ estado: ESTADOS.ENVIADO_SIESA, siesa_at: new Date().toISOString() })
    .in("id", ids)
    .neq("estado", ESTADOS.ENVIADO_SIESA);
  if (e1) fallarSiFaltaMigracion(e1, "No se pudo marcar las recepciones como enviadas", MIGRACIONES);

  // Con qué tercero entró queda escrito: dentro de seis meses la pregunta es
  // "¿esta liquidación fue a nombre de quién?" y la respuesta tiene que estar
  // en la fila, no en el payload de un envío.
  const { error: e2 } = await supabase
    .from("carnes_liquidaciones")
    .update({
      estado: "Cerrada",
      siesa_nit: doc.NIT || null,
      siesa_sucursal: doc.SUCURSAL || null,
    })
    .eq("id", liquidacionId);
  if (e2) fallarSiFaltaMigracion(e2, "No se pudo cerrar la liquidación", MIGRACIONES);
}

/**
 * Entrada OFICIAL de una liquidación costeada: UNA CEA con todas las sedes.
 *
 * Si entra → cierre (recepciones a Enviado_SIESA, liquidación a Cerrada) y un
 * correo con las iniciales a anular. Si ya estaba ok (un segundo clic, o un
 * "sin confirmar" que se resolvió como ok) solo cierra: no manda nada.
 *
 * @returns {{ cerrada: boolean, envio: object }}
 */
export async function enviarOficial(liquidacionId, por, terceroId) {
  const previa = await previsualizarOficial(liquidacionId, terceroId);
  if (previa.bloqueos.length) throw createError(409, previa.bloqueos.join(" "));
  if (!previa.sedes.length) {
    throw createError(409, "La liquidación no tiene recepciones para enviar.");
  }

  if (previa.oficial) {
    if (previa.oficial.estado !== "ok") {
      throw createError(409, motivoVigente(previa.oficial));
    }
    // Ya está en SIESA: se cierra lo que haya quedado abierto, sin mandar.
    const envio = await oficialDeLiquidacion(liquidacionId);
    // Entre la previsualización y acá alguien pudo registrar la anulación.
    if (!envio || envio.estado !== "ok") {
      throw createError(409, "La entrada oficial cambió de estado. Actualizá y volvé a intentar.");
    }
    if (previa.liquidacion.estado !== "Cerrada") {
      await cerrarLiquidacion(liquidacionId, await idsDeLiquidacion(liquidacionId), envio);
    }
    return { cerrada: true, repetido: true, envio: resumenEnvio(envio) };
  }

  if (previa.documento.bloqueos.length) {
    throw createError(409, previa.documento.bloqueos.join(" "));
  }

  // Se arma de nuevo con los datos de este instante: la previsualización pudo
  // quedar vieja si alguien volvió a costear entre medio.
  const { ids, recepciones, armado } = await armarOficial(liquidacionId, terceroId);
  const fila = await registrarYEnviar({
    armado,
    base: {
      recepcion_id: null,
      liquidacion_id: Number(liquidacionId),
      recepcion_ids: ids,
      tipo: TIPO_ENVIO.OFICIAL,
      consecutivo: consecutivoLiquidacion(liquidacionId),
    },
    por,
    vigente: () => oficialDeLiquidacion(liquidacionId),
    etiqueta: `oficial liquidación #${liquidacionId}`,
  });

  if (fila.estado !== "ok") {
    return {
      cerrada: false,
      envio: {
        ...resumenEnvio(fila),
        error: fila.repetido ? motivoVigente(fila) : fila.error,
      },
    };
  }

  await cerrarLiquidacion(liquidacionId, ids, fila);
  // Si otro pedido la reservó primero (`repetido`), el correo es de él.
  if (!fila.repetido) {
    await avisarAnulacionLiquidacion(previa.liquidacion, recepciones, fila);
  }
  return { cerrada: true, repetido: Boolean(fila.repetido), envio: resumenEnvio(fila) };
}

/** Lo que el front necesita de un envío, sin el payload entero. */
function resumenEnvio(e) {
  if (!e) return null;
  return {
    id: e.id,
    estado: e.estado,
    referencia: e.referencia,
    error: e.error ?? null,
    renglones: e.renglones,
    total_kilos: e.total_kilos,
    total_valor: e.total_valor,
  };
}

/**
 * Un solo correo con todas las iniciales a anular de la liquidación.
 *
 * Las iniciales que ya están anuladas —o que nunca entraron— no se piden. Si no
 * queda ninguna, no se manda nada y el aviso se da por cumplido.
 */
async function avisarAnulacionLiquidacion(liquidacion, recepciones, oficial) {
  const iniciales = [];
  for (const r of recepciones) {
    const inicial = await ultimoEnvio(r.id, TIPO_ENVIO.INICIAL);
    if (inicial) {
      iniciales.push({
        sede: r.sede?.nombre || `Sede ${r.sede_id}`,
        referencia: inicial.referencia,
        total_kilos: inicial.total_kilos,
        total_valor: inicial.total_valor,
      });
    }
  }
  if (!iniciales.length) {
    await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
    return;
  }
  const correo = await notificarAnularIniciales(liquidacion, iniciales, oficial);
  if (correo?.success) {
    await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
  }
}

/**
 * Correo a quien anula la inicial, y se anota que salió.
 *
 * Si la inicial ya está ANULADA (se anuló todo para reenviar), no hay nada que
 * pedir: el correo diría "anulá R2I" sobre un documento que ya no existe. Se
 * marca el aviso como cumplido y no se manda.
 */
async function avisarAnulacion(recepcion, inicial, oficial) {
  if (!inicial) {
    const { data: anulada } = await supabase
      .from(TABLA)
      .select("id")
      .eq("recepcion_id", recepcion.id)
      .eq("tipo", TIPO_ENVIO.INICIAL)
      .eq("estado", "anulado")
      .limit(1)
      .maybeSingle();
    if (anulada) {
      await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
      return;
    }
  }
  const correo = await notificarAnularInicial(recepcion, inicial, oficial);
  if (correo?.success) {
    await supabase.from(TABLA).update({ aviso_anulacion: true }).eq("id", oficial.id);
  }
}

/**
 * Resolver un envío que quedó en el aire, después de mirar en SIESA.
 *
 * `sin_confirmar` (timeout o corte después de mandar) o un `enviando`
 * abandonado (la función murió en el medio). El sistema no puede saber si
 * SIESA lo creó; una persona sí, buscando la referencia. Hasta que lo diga, el
 * envío bloquea el reintento: mejor trabado que duplicado.
 *
 *   `ok`        está en SIESA → queda ok. Si es oficial, sale el correo de
 *               anulación que el envío no llegó a mandar.
 *   `no_llego`  no está → queda error, y se puede reintentar.
 *
 * @param {number|string} id
 * @param {{ resultado: "ok"|"no_llego", por?: string }} p
 */
export async function resolver(id, { resultado, por } = {}) {
  if (!["ok", "no_llego"].includes(resultado)) {
    throw createError(400, 'resultado tiene que ser "ok" o "no_llego".');
  }

  const { data: envio, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  if (!envio) throw createError(404, "Envío no encontrado.");

  const abandonado =
    envio.estado === "enviando" &&
    Date.now() - new Date(envio.enviado_at).getTime() > ENVIANDO_ABANDONADO_MS;
  if (envio.estado !== "sin_confirmar" && !abandonado) {
    throw createError(
      409,
      envio.estado === "enviando"
        ? "El envío todavía está en curso. Esperá un par de minutos."
        : `El envío está en "${envio.estado}": no hay nada que resolver.`,
    );
  }

  const nota =
    resultado === "ok"
      ? `Confirmado en SIESA por ${por || "el admin"}.`
      : `Marcado como no llegó por ${por || "el admin"}.`;
  const { data, error: e2 } = await supabase
    .from(TABLA)
    .update({
      estado: resultado === "ok" ? "ok" : "error",
      error: [envio.error, nota].filter(Boolean).join(" "),
      resuelto_por: por || null,
      resuelto_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Si alguien lo resolvió al mismo tiempo, no se pisa.
    .eq("estado", envio.estado)
    .select("*")
    .maybeSingle();
  if (e2) fallarSiFaltaMigracion(e2, "No se pudo resolver el envío", MIGRACIONES);
  if (!data) throw createError(409, "Otro usuario ya resolvió este envío. Actualizá.");

  if (data.estado === "ok" && data.tipo === TIPO_ENVIO.OFICIAL) {
    if (data.recepcion_id) {
      const recepcion = await cargarRecepcion(data.recepcion_id);
      const inicial = await ultimoEnvio(data.recepcion_id, TIPO_ENVIO.INICIAL);
      await avisarAnulacion(recepcion, inicial, data);
    } else {
      // Consolidada. La liquidación NO se cierra acá: el admin vuelve a
      // "Enviar entrada oficial", que ve la oficial en ok y solo cierra.
      const { data: liq } = await supabase
        .from("carnes_liquidaciones")
        .select("id, especie")
        .eq("id", data.liquidacion_id)
        .maybeSingle();
      const ids = data.recepcion_ids?.length ? data.recepcion_ids : await idsDeLiquidacion(data.liquidacion_id);
      const recepciones = [];
      for (const rid of ids) recepciones.push(await cargarRecepcion(rid));
      await avisarAnulacionLiquidacion(liq, recepciones, data);
    }
  }

  // Recepción de PROVEEDOR: si lo que se confirmó es la entrada, la recepción pasa
  // a Enviada_SIESA y sale la nota crédito si corresponde. Sin esto, resolver un
  // `sin_confirmar` como ok la dejaría trabada en Finalizada.
  if (data.estado === "ok" && esTipoProveedor(data.tipo)) {
    return { ...data, seguimiento: await seguirTrasResolverProveedor(data) };
  }
  return data;
}

/**
 * Las oficiales de una liquidación se anularon en SIESA: se refleja acá y se
 * deja la liquidación lista para volver a mandar.
 *
 * Lo que hace, en este orden:
 *   1. Los envíos oficiales (ok, duplicado o sin_confirmar) pasan a `anulado`.
 *      Eso libera el índice único de sql/010: se puede reservar uno nuevo.
 *      Con `inicialesAnuladas`, las iniciales también: así el reenvío no pide
 *      anular una inicial que ya no existe.
 *   2. Las recepciones vuelven de `Enviado_SIESA` a `Costeado`.
 *   3. La liquidación vuelve de `Cerrada` a `Costeada`, con los costos intactos.
 *
 * Después el admin verifica los costos —o reabre, corrige y vuelve a costear—
 * y manda la oficial de nuevo. Los duplicados los sigue cuidando el candado.
 *
 * NO toca SIESA: la anulación allá la hace una persona. Esto solo registra que
 * ya se hizo, y por eso lo dice quien lo marca.
 *
 * @param {number|string} liquidacionId
 * @param {{ por?: string, motivo?: string, inicialesAnuladas?: boolean }} p
 */
export async function anularOficiales(liquidacionId, { por, motivo, inicialesAnuladas = false } = {}) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const { data: recs, error: e1 } = await supabase
    .from("carnes_recepciones")
    .select("id")
    .eq("liquidacion_id", liquidacionId);
  if (e1) fallarSiFaltaMigracion(e1, "Error al leer las recepciones", MIGRACIONES);
  const ids = (recs || []).map((r) => r.id);
  if (!ids.length) throw createError(409, "La liquidación no tiene recepciones.");

  // Un envío en curso de verdad (no abandonado) todavía puede terminar ok: no
  // se anula algo que SIESA quizás está creando en este momento.
  // Por sede y la consolidada (que no tiene recepción, va por liquidación).
  const [porSede, consolidada] = await Promise.all([
    supabase.from(TABLA).select("id, referencia, enviado_at").in("recepcion_id", ids).eq("estado", "enviando"),
    supabase
      .from(TABLA)
      .select("id, referencia, enviado_at")
      .eq("liquidacion_id", liquidacionId)
      .is("recepcion_id", null)
      .eq("estado", "enviando"),
  ]);
  const e2 = porSede.error || consolidada.error;
  if (e2) fallarSiFaltaMigracion(e2, "Error al leer los envíos", MIGRACIONES);
  const enCurso = [...(porSede.data || []), ...(consolidada.data || [])];
  const vivos = enCurso.filter(
    (e) => Date.now() - new Date(e.enviado_at).getTime() <= ENVIANDO_ABANDONADO_MS,
  );
  if (vivos.length) {
    throw createError(
      409,
      `Hay envíos en curso (${vivos.map((e) => e.referencia).join(", ")}). Esperá a que terminen.`,
    );
  }

  const tipos = inicialesAnuladas
    ? [TIPO_ENVIO.OFICIAL, TIPO_ENVIO.INICIAL]
    : [TIPO_ENVIO.OFICIAL];
  const marca = {
    estado: "anulado",
    anulado_por: por || null,
    anulado_at: new Date().toISOString(),
    motivo_anulacion: String(motivo ?? "").trim() || null,
  };

  // Dos updates y no uno: un `enviando` solo se anula si ya está ABANDONADO,
  // y la condición va en la misma consulta que lo cambia. Si fuera en el
  // chequeo de arriba, un envío reservado entre el chequeo y el update se
  // anularía estando vivo, con su POST a SIESA todavía en camino.
  const limite = new Date(Date.now() - ENVIANDO_ABANDONADO_MS).toISOString();
  const { data: cerrados, error: e3 } = await supabase
    .from(TABLA)
    .update(marca)
    .in("recepcion_id", ids)
    .in("tipo", tipos)
    .in("estado", ["ok", "duplicado", "sin_confirmar"])
    .select("id, tipo, referencia");
  let abandonados = [];
  if (!e3) {
    const r = await supabase
      .from(TABLA)
      .update(marca)
      .in("recepcion_id", ids)
      .in("tipo", tipos)
      .eq("estado", "enviando")
      .lt("enviado_at", limite)
      .select("id, tipo, referencia");
    if (r.error) fallarSiFaltaMigracion(r.error, "No se pudieron anular los envíos", MIGRACIONES);
    abandonados = r.data || [];
  }
  // La consolidada: misma regla, pero se busca por liquidación.
  let consolidadas = [];
  if (!e3) {
    const [c1, c2] = await Promise.all([
      supabase
        .from(TABLA)
        .update(marca)
        .eq("liquidacion_id", liquidacionId)
        .is("recepcion_id", null)
        .eq("tipo", TIPO_ENVIO.OFICIAL)
        .in("estado", ["ok", "duplicado", "sin_confirmar"])
        .select("id, tipo, referencia"),
      supabase
        .from(TABLA)
        .update(marca)
        .eq("liquidacion_id", liquidacionId)
        .is("recepcion_id", null)
        .eq("tipo", TIPO_ENVIO.OFICIAL)
        .eq("estado", "enviando")
        .lt("enviado_at", limite)
        .select("id, tipo, referencia"),
    ]);
    const ec = c1.error || c2.error;
    if (ec) fallarSiFaltaMigracion(ec, "No se pudo anular la oficial consolidada", MIGRACIONES);
    consolidadas = [...(c1.data || []), ...(c2.data || [])];
  }
  const anulados = [...(cerrados || []), ...abandonados, ...consolidadas];
  if (e3) {
    // Sin sql/011, el CHECK no conoce `anulado`.
    if (e3.code === "23514") {
      throw createError(
        503,
        "A la base le falta sql/011_siesa_anulacion.sql. Corrélo en Supabase y volvé a intentar.",
      );
    }
    fallarSiFaltaMigracion(e3, "No se pudieron anular los envíos", MIGRACIONES);
  }
  const oficiales = (anulados || []).filter((e) => e.tipo === TIPO_ENVIO.OFICIAL);
  if (!oficiales.length && liq.estado !== "Cerrada") {
    throw createError(409, "Esta liquidación no tiene entradas oficiales para anular.");
  }

  const { data: reabiertas, error: e4 } = await supabase
    .from("carnes_recepciones")
    .update({ estado: ESTADOS.COSTEADO, siesa_at: null })
    .in("id", ids)
    .eq("estado", ESTADOS.ENVIADO_SIESA)
    .select("id");
  if (e4) fallarSiFaltaMigracion(e4, "No se pudieron reabrir las recepciones", MIGRACIONES);

  if (liq.estado === "Cerrada") {
    const { error: e5 } = await supabase
      .from("carnes_liquidaciones")
      .update({ estado: "Costeada" })
      .eq("id", liquidacionId);
    if (e5) fallarSiFaltaMigracion(e5, "No se pudo reabrir la liquidación", MIGRACIONES);
  }

  console.log(
    `↩️  Liquidación #${liquidacionId}: ${oficiales.length} oficial(es) anulada(s) por ${por || "—"}.`,
  );
  return {
    anulados: (anulados || []).map((e) => ({ id: e.id, tipo: e.tipo, referencia: e.referencia })),
    recepciones: (reabiertas || []).length,
  };
}

/**
 * El ADMIN borra un envío que quedó en `error`.
 *
 * Solo ese estado: ver `puedeEliminarEnvio` en `shared/eliminacionAdmin.js`.
 * No toca el candado de sql/010 —ese índice único solo cubre
 * `enviando`/`ok`/`sin_confirmar`— así que un `error` nunca lo ocupaba y
 * borrarlo no destraba ni traba nada.
 */
export async function eliminarEnvioAdmin(id) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("id, estado, referencia")
    .eq("id", id)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el envío", MIGRACIONES);
  if (!data) throw createError(404, "Envío no encontrado.");

  const { ok, motivo } = puedeEliminarEnvio({ estado: data.estado });
  if (!ok) throw createError(409, motivo);

  const { error: errorBorrar } = await supabase.from(TABLA).delete().eq("id", id);
  if (errorBorrar) fallarSiFaltaMigracion(errorBorrar, "No se pudo borrar el envío", MIGRACIONES);

  console.log(`🗑️  Envío SIESA #${id} (${data.referencia}) eliminado por el admin.`);
  return { eliminado: Number(id), referencia: data.referencia };
}

// ─── Ajuste de inventario de vísceras (CEI) ────────────────────────────────
//
// UN documento por LIQUIDACIÓN, con las vísceras de todas sus sedes (ver
// `shared/siesaAjusteVisceras.js`). Se guarda como la oficial consolidada:
// `recepcion_id` NULL, `liquidacion_id` lleno, `recepcion_ids` con las sedes que
// iban, y su candado de una vigente por liquidación es el índice de sql/020.
//
// Se manda DESPUÉS de la entrada oficial, y SIESA lo contabiliza al importar: no
// hay etapa de elaboración donde alguien lo revise. Es un solo POST, todo o
// nada: si una sede tiene un bloqueo, no sale nada.
//
// Antes era un documento por sede (sql/019). Esas filas —con `recepcion_id`
// lleno— quedan como historial, y mientras alguna siga vigente (ok, enviando o
// sin confirmar) el consolidado no sale: esas vísceras ya están en SIESA en otro
// documento y entrarían dos veces.
//
// El tiempo lo cuida `esperaParaSede` (shared/siesaAjusteVisceras.js): la espera
// a SIESA es TIMEOUT_OFICIAL_MS (4 min) recortada para terminar antes del límite
// de la función en Vercel (300 s).

const COLUMNAS_AJUSTE =
  "id, recepcion_id, estado, referencia, enviado_at, error, renglones, total_kilos, total_valor";

/**
 * El ajuste CONSOLIDADO de una liquidación que ocupa el lugar —enviando, ok o
 * sin_confirmar—, o null. Es el que cuida el índice de sql/020.
 */
async function ajusteDeLiquidacion(liquidacionId) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("liquidacion_id", liquidacionId)
    .is("recepcion_id", null)
    .eq("tipo", TIPO_AJUSTE_VISCERAS)
    .in("estado", VIGENTES)
    .order("enviado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el ajuste de vísceras", MIGRACIONES);
  return data || null;
}

/**
 * Todo lo que hay que saber de la liquidación para decidir el ajuste: sus
 * recepciones, el documento armado con los datos de AHORA, el estado de los
 * envíos y qué entrada oficial cubre a cada sede.
 *
 * Se usa al previsualizar y justo antes de mandar; la segunda no reusa la
 * primera.
 */
async function evaluarAjuste(liquidacionId) {
  const { data: liq, error } = await supabase
    .from("carnes_liquidaciones")
    .select("id, estado, especie")
    .eq("id", liquidacionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
  if (!liq) throw createError(404, "Liquidación no encontrada.");

  const ids = await idsDeLiquidacion(liquidacionId);
  const recepciones = [];
  for (const id of ids) recepciones.push(await cargarRecepcion(id));
  const armado = armarAjusteViscerasLiquidacion({
    liquidacionId,
    recepciones,
    config: DOCUMENTO_AJUSTE_VISCERAS,
  });

  const [consolidados, anteriores, consolidada, porSede] = await Promise.all([
    supabase
      .from(TABLA)
      .select(COLUMNAS_AJUSTE)
      .eq("liquidacion_id", liquidacionId)
      .is("recepcion_id", null)
      .eq("tipo", TIPO_AJUSTE_VISCERAS)
      .order("enviado_at", { ascending: false }),
    ids.length
      ? supabase
          .from(TABLA)
          .select(COLUMNAS_AJUSTE)
          .in("recepcion_id", ids)
          .eq("tipo", TIPO_AJUSTE_VISCERAS)
          .order("enviado_at", { ascending: false })
      : { data: [], error: null },
    oficialDeLiquidacion(liquidacionId),
    ids.length
      ? supabase
          .from(TABLA)
          .select("recepcion_id, payload")
          .in("recepcion_id", ids)
          .eq("tipo", TIPO_ENVIO.OFICIAL)
          .eq("estado", "ok")
      : { data: [], error: null },
  ]);
  for (const r of [consolidados, anteriores, porSede]) {
    if (r.error) fallarSiFaltaMigracion(r.error, "Error al leer los envíos", MIGRACIONES);
  }

  // Del consolidado: el vigente si lo hay (es el que ocupa el lugar) y, si no, el
  // último intento, para mostrar qué pasó.
  const filas = consolidados.data || [];
  const vigente = filas.find((f) => VIGENTES.includes(f.estado)) || null;
  const ultimo = filas[0] || null;

  // De los de antes (por sede): por recepción, igual.
  const previos = new Map();
  for (const a of anteriores.data || []) {
    const p = previos.get(a.recepcion_id) || { vigente: null, ultimo: null };
    if (!p.ultimo) p.ultimo = a;
    if (!p.vigente && VIGENTES.includes(a.estado)) p.vigente = a;
    previos.set(a.recepcion_id, p);
  }

  const cobertura = coberturaOficial({ ids, consolidada, porSede: porSede.data || [] });
  const compensaciones = await compensacionesDeLiquidacion(liquidacionId);
  return {
    liq,
    ids,
    recepciones,
    armado,
    vigente,
    ultimo,
    previos,
    cobertura,
    anteriores: anteriores.data || [],
    compensaciones,
  };
}

/** Lo que el front necesita de un envío de ajuste. */
const resumenAjuste = (a) =>
  a
    ? {
        id: a.id,
        estado: a.estado,
        referencia: a.referencia,
        enviado_at: a.enviado_at,
        error: a.error ?? null,
      }
    : null;

/**
 * Qué pasaría al mandar el ajuste de vísceras de una liquidación, sin mandar
 * nada: el documento, el desglose por sede y qué lo bloquea.
 *
 * El estado del documento:
 *   pendiente   tiene vísceras para ajustar y no hay envío vigente
 *   enviado     ya está en SIESA (ok)
 *   enCurso     hay uno enviando o sin confirmar: hasta resolverlo no se manda
 *   vacio       ninguna sede tiene vísceras con código y cantidad
 *
 * Los bloqueos son del DOCUMENTO: uno solo, todo o nada. Cada sede además
 * trae los suyos para poder señalarla en la lista.
 */
function construirPrevia(ev) {
  const { liq, recepciones, armado, vigente, ultimo, previos, cobertura } = ev;
  const enviado = vigente?.estado === "ok";
  const enCurso = Boolean(vigente) && !enviado;
  const pendiente = !armado.vacio && !vigente;

  const nombres = new Map(recepciones.map((r) => [r.id, r.sede?.nombre ?? `Recepción #${r.id}`]));
  const guarda = guardaAjustesPorSede(ev.anteriores, nombres);

  const bloqueos = [];
  const configurado = siesaConfigurado();
  if (!enviado) {
    if (!siesaActivo()) {
      bloqueos.push("El envío a SIESA está apagado (CARNES_SIESA_ACTIVO no es true).");
    }
    if (!configurado) {
      bloqueos.push(`SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`);
    }
  }

  const sedes = armado.porSede.map((s) => {
    const recepcion = recepciones.find((r) => r.id === s.recepcion_id);
    // Lo que solo importa si todavía se va a mandar el documento.
    const extra = [];
    if (pendiente && !s.vacio && cobertura.size > 0) {
      const cubre = cobertura.get(s.recepcion_id);
      if (!cubre) {
        // Hay entrada oficial en SIESA, pero salió sin esta recepción: se la
        // vinculó después. Sus vísceras entrarían sin la carne que las trajo.
        extra.push(
          "No está en la entrada oficial que ya está en SIESA (se vinculó después de " +
            "enviarla). El ajuste se manda cuando su carne esté en SIESA.",
        );
      } else {
        // Las CEA anteriores al 29/09/2026 llevaban las vísceras como un renglón
        // más: mandar el ajuste las entraría dos veces, y contabilizado.
        const yaEstan = viscerasEnCea({
          payload: cubre.payload,
          items: recepcion?.items,
          bodega: recepcion?.sede?.bodega_siesa,
        });
        if (yaEstan.length) {
          extra.push(
            `La entrada oficial que ya está en SIESA trae estas vísceras: ${yaEstan.join(", ")}. ` +
              "Mandar el ajuste las entraría dos veces. Anulá esa entrada oficial y volvela a " +
              "enviar (ya sin vísceras) antes de hacer el ajuste.",
          );
        }
      }
    }
    const p = previos.get(s.recepcion_id);
    return {
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      fecha: s.fecha,
      resumen: s.resumen,
      renglones: s.renglones,
      bloqueos: pendiente ? [...s.bloqueos, ...extra] : [],
      vacio: s.vacio,
      // El ajuste POR SEDE de antes, si esta recepción lo tuvo.
      anterior: p ? resumenAjuste(p.vigente || p.ultimo) : null,
    };
  });

  if (pendiente) {
    if (cobertura.size === 0) {
      // Ninguna sede tiene su entrada oficial en SIESA. Si solo faltan algunas, el
      // bloqueo es de cada una.
      bloqueos.push(
        "La entrada oficial todavía no está en SIESA. El ajuste de vísceras se manda después de ella.",
      );
    }
    bloqueos.push(...armado.bloqueos);
    for (const s of sedes) {
      for (const b of s.bloqueos) bloqueos.push(`${s.sede ?? `Recepción #${s.recepcion_id}`}: ${b}`);
    }
    bloqueos.push(...guarda.bloqueos);
    // Un ajuste por faltante en curso o sin confirmar: no se sabe si su saldo ya
    // está en SIESA, y reenviar sin saberlo compensaría dos veces.
    for (const c of ev.compensaciones.filter((x) => ["enviando", "sin_confirmar"].includes(x.estado))) {
      bloqueos.push(
        `El ajuste por faltante ${c.referencia} (bodega ${c.bodega}) está ${
          c.estado === "enviando" ? "en curso" : "sin confirmar"
        }: SIESA pudo haberlo creado. Buscalo en SIESA por bodega, fecha e ítem y marcalo desde ` +
          "Envíos a SIESA antes de volver a enviar.",
      );
    }
  }

  const anteriores = sedes
    .filter((s) => s.anterior)
    .map((s) => ({
      recepcion_id: s.recepcion_id,
      sede: s.sede,
      envio: s.anterior,
      vigente: VIGENTES.includes(s.anterior.estado),
    }));

  return {
    liquidacion: liq,
    documento: {
      nombre: DOCUMENTO_AJUSTE_VISCERAS.nombreDocumento,
      tipoDocto: DOCUMENTO_AJUSTE_VISCERAS.tipoDocto,
      referencia: armado.resumen.referencia,
      consecutivo: armado.resumen.consecutivo,
      fecha: armado.resumen.fecha,
      sedes: armado.resumen.sedes,
      renglones: armado.resumen.renglones,
      totalKilos: armado.resumen.totalKilos,
      totalValor: armado.resumen.totalValor,
    },
    configurado,
    activo: siesaActivo(),
    bloqueos,
    sedes,
    // Los ajustes por sede de antes. Mientras alguno esté vigente, bloquean.
    anteriores,
    // El consolidado: el vigente si lo hay; si no, el último intento.
    envio: resumenAjuste(vigente || ultimo),
    // Los ajustes por faltante (compensaciones) de esta liquidación, y si el
    // conector para mandarlos está configurado. No bloquea el envío: el ajuste
    // de vísceras puede entrar sin compensar; solo importa si SIESA rechaza por
    // faltante.
    compensaciones: ev.compensaciones,
    compensacionBloqueo: bloqueoAjusteFaltante(),
    enviado,
    enCurso,
    pendiente,
    vacio: armado.vacio,
    totales: {
      sedes: armado.resumen.sedes,
      renglones: armado.resumen.renglones,
      totalValor: armado.resumen.totalValor,
    },
    puedeEnviar: pendiente && bloqueos.length === 0,
  };
}

/** GET — qué se mandaría en el ajuste de vísceras de la liquidación. */
export async function previsualizarAjusteVisceras(liquidacionId) {
  return construirPrevia(await evaluarAjuste(liquidacionId));
}

// ─── Compensación por faltante de inventario ───────────────────────────────
//
// Si SIESA rechaza el ajuste de vísceras SOLO por "Item sin cantidad disponible"
// (la bodega no tiene el saldo que el documento exige), se manda un ajuste de
// inventario CPE por exactamente lo que falta —uno por bodega— y se REENVÍA el
// ajuste de vísceras. Es el remedio de siesa-pos-sync (`ajustarInventario`) con
// un conector propio de carnes (`DOCUMENTO_AJUSTE_FALTANTE`, sql/021).
//
// ─── Cómo retoma un segundo clic ────────────────────────────────────────────
//
// Cada `enviar` empieza otra vez por el ajuste de vísceras, no por las
// compensaciones de un rechazo anterior. Es a propósito: el "Faltante Inv." que
// devuelve SIESA es lo que TODAVÍA falta ahora, así que las compensaciones que ya
// entraron (`ok`) no reaparecen —su saldo ya está en SIESA— y nunca se repiten,
// mientras que reusar las de un origen viejo podía inyectar inventario por un
// faltante que alguien ya arregló a mano. Lo que sí se cuida por origen es que
// dos pedidos simultáneos no compensen lo mismo dos veces: el índice de sql/021 es
// único por (envío rechazado, bodega). Un ajuste por faltante en curso o sin
// confirmar bloquea el reenvío hasta resolverlo, porque no se sabe si su saldo ya
// está en SIESA.

/** Cuántas veces se reenvía el ajuste de vísceras en un mismo pedido. */
const MAX_RONDAS_AJUSTE = 3;

/** Lo que el front necesita de una compensación (con lo que se mandó, del payload). */
const resumenCompensacion = (f) => ({
  id: f.id,
  estado: f.estado,
  referencia: f.referencia,
  bodega: f.bodega ?? null,
  envio_origen_id: f.envio_origen_id ?? null,
  enviado_at: f.enviado_at,
  error: f.error ?? null,
  items: (f.payload?.Movimientos || []).map((m) => ({
    item: String(m.ITEM ?? "").replace(/^0+/, ""),
    cantidad: Number(m.CANTIDAD) || 0,
    unidad: String(m.UNIDAD_MEDIDA ?? "").trim(),
  })),
});

/**
 * Las compensaciones de una liquidación, de la más nueva a la más vieja. Sin
 * sql/021 devuelve []: la vista previa no tiene por qué caerse por eso.
 */
async function compensacionesDeLiquidacion(liquidacionId) {
  const { data, error } = await supabase
    .from(TABLA)
    .select(
      "id, estado, referencia, bodega, envio_origen_id, enviado_at, error, renglones, total_valor, payload",
    )
    .eq("liquidacion_id", liquidacionId)
    .eq("tipo", TIPO_AJUSTE_FALTANTE)
    .order("enviado_at", { ascending: false });
  if (error) {
    if (esMigracionFaltante(error)) return [];
    fallarSiFaltaMigracion(error, "Error al leer los ajustes por faltante", MIGRACIONES);
  }
  return (data || []).map(resumenCompensacion);
}

/** La compensación que ocupa el lugar de este origen y bodega, o null. */
async function compensacionVigente(origenId, bodega) {
  const { data, error } = await supabase
    .from(TABLA)
    .select("*")
    .eq("tipo", TIPO_AJUSTE_FALTANTE)
    .eq("envio_origen_id", origenId)
    .eq("bodega", bodega)
    .in("estado", VIGENTES)
    .order("enviado_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer el ajuste por faltante", MIGRACIONES);
  return data || null;
}

/**
 * Manda la compensación de UNA bodega. Si SIESA la rechaza otra vez por faltante,
 * SUBE la cantidad (anterior + faltante) y reintenta, hasta MAX_REINTENTOS_AJUSTE.
 *
 * @returns {{ ok: boolean, pendiente?: boolean, registros: object[], detalle?: string }}
 */
async function compensarBodega({ documento, origen, liquidacionId, por, inicio }) {
  const registros = [];
  let actual = documento;

  for (let intento = 1; intento <= MAX_REINTENTOS_AJUSTE; intento++) {
    const espera = esperaParaEnvio(Date.now() - inicio, {
      maxEsperaMs: ESPERA_MAXIMA_COMPENSACION_MS,
      minimoMs: 30_000,
    });
    if (espera === null) {
      return {
        ok: false,
        pendiente: true,
        registros,
        detalle: `No queda tiempo seguro para compensar la bodega ${actual.bodega}.`,
      };
    }

    const fila = await registrarYEnviar({
      armado: { payload: actual.payload, resumen: actual.resumen, bloqueos: [] },
      base: {
        recepcion_id: null,
        liquidacion_id: Number(liquidacionId),
        tipo: TIPO_AJUSTE_FALTANTE,
        consecutivo: null,
        tipo_docto: DOCUMENTO_AJUSTE_FALTANTE.tipoDocto,
        envio_origen_id: origen.id,
        bodega: actual.bodega,
      },
      por,
      vigente: () => compensacionVigente(origen.id, actual.bodega),
      etiqueta: `ajuste por faltante liquidación #${liquidacionId} bodega ${actual.bodega}`,
      documento: DOCUMENTO_AJUSTE_FALTANTE,
      timeoutMs: espera,
    });
    registros.push({ ...resumenCompensacion(fila), intento });

    // Otro pedido la reservó primero: no es un envío de este.
    if (fila.repetido) return { ok: false, registros, detalle: motivoVigente(fila) };
    if (fila.estado === "ok") return { ok: true, registros };

    if (fila.estado === "error" && soloFaltantes(fila.respuesta) && intento < MAX_REINTENTOS_AJUSTE) {
      const subida = subirCantidadPorFaltante({
        documento: actual,
        faltantes: parsearFaltantes(fila.respuesta),
        config: DOCUMENTO_AJUSTE_FALTANTE,
        liquidacionId,
      });
      if (!subida.documento) {
        return {
          ok: false,
          registros,
          detalle:
            `SIESA volvió a reportar faltante en la bodega ${actual.bodega} de un ítem que no ` +
            "está en el ajuste por faltante. Revisalo en SIESA.",
        };
      }
      actual = subida.documento;
      continue;
    }

    // Otro error, sin confirmar, o los reintentos se acabaron.
    return {
      ok: false,
      registros,
      detalle:
        fila.estado === "sin_confirmar"
          ? `El ajuste por faltante ${fila.referencia} quedó sin confirmar: SIESA pudo haberlo creado.`
          : (fila.error ?? "SIESA no recibió el ajuste por faltante."),
    };
  }
  return { ok: false, registros, detalle: "SIESA siguió reportando faltante tras subir la cantidad." };
}

/**
 * Manda el ajuste de vísceras y, si SIESA lo rechaza solo por faltantes,
 * compensa y reenvía (hasta MAX_RONDAS_AJUSTE envíos del ajuste).
 *
 * Se detiene —sin seguir— ante cualquier otra cosa: un error que no es un
 * faltante, un `sin_confirmar`, una compensación que falla, un conector de
 * compensación sin configurar, un faltante que no baja después de compensar, o
 * falta de tiempo para el próximo POST. Lo que quedó a medias se retoma con otro
 * clic (ver el comentario de arriba).
 */
async function ejecutarAjuste({ ev, liquidacionId, por, inicio }) {
  const compensaciones = [];
  let fila = null;
  let faltantesPrevios = null;
  let rondas = 0;

  const resultado = (extra = {}) => ({
    completo: fila?.estado === "ok",
    repetido: Boolean(fila?.repetido) || undefined,
    envio: {
      ...resumenEnvio(fila),
      // Otro pedido la reservó primero: no es un envío de este.
      error: fila?.repetido ? motivoVigente(fila) : (fila?.error ?? null),
    },
    compensaciones,
    rondas,
    ...extra,
  });

  for (let ronda = 1; ronda <= MAX_RONDAS_AJUSTE; ronda++) {
    rondas = ronda;
    let espera;
    if (ronda === 1) {
      // El primer envío conserva la regla de siempre: si leer tardó demasiado, no se arranca.
      espera = esperaParaSede(Date.now() - inicio, TIMEOUT_OFICIAL_MS);
      if (espera === null) {
        throw createError(
          503,
          "Leer la liquidación tardó demasiado para mandar el ajuste con margen. Volvé a intentar.",
        );
      }
    } else {
      espera = esperaParaEnvio(Date.now() - inicio, {
        maxEsperaMs: TIMEOUT_OFICIAL_MS,
        minimoMs: ESPERA_MINIMA_AJUSTE_MS,
      });
      if (espera === null) {
        return resultado({
          pendiente: true,
          detalle:
            "Las compensaciones por faltante ya entraron, pero no queda tiempo seguro para " +
            "reenviar el ajuste de vísceras. Pendiente: volvé a enviar.",
        });
      }
    }

    fila = await registrarYEnviar({
      armado: ev.armado,
      base: {
        recepcion_id: null,
        liquidacion_id: Number(liquidacionId),
        recepcion_ids: ev.armado.recepcion_ids,
        tipo: TIPO_AJUSTE_VISCERAS,
        consecutivo: consecutivoAjusteLiquidacion(liquidacionId),
        tipo_docto: DOCUMENTO_AJUSTE_VISCERAS.tipoDocto,
      },
      por,
      vigente: () => ajusteDeLiquidacion(liquidacionId),
      etiqueta: `ajuste vísceras liquidación #${liquidacionId}${ronda > 1 ? ` (ronda ${ronda})` : ""}`,
      documento: DOCUMENTO_AJUSTE_VISCERAS,
      timeoutMs: espera,
    });

    // ok, sin confirmar, reservado por otro: no hay nada que compensar.
    if (fila.estado !== "error" || fila.repetido) return resultado();
    // Un error que no es solo faltante: compensar no lo arregla.
    if (!soloFaltantes(fila.respuesta)) return resultado();

    const faltantes = parsearFaltantes(fila.respuesta);

    // El conector propio de carnes todavía no está: se dice qué falta.
    const sinConector = bloqueoAjusteFaltante();
    if (sinConector) return resultado({ detalle: sinConector });

    // Si compensar no bajó el faltante, el ajuste no está sumando inventario (por
    // ejemplo, si SIESA lo tomara como una salida): seguir solo lo empeoraría.
    const sinBajar = faltantesQueNoBajaron(faltantesPrevios, faltantes);
    if (sinBajar.length) {
      return resultado({
        detalle:
          "El ajuste por faltante no está sumando inventario: " +
          sinBajar
            .map((f) => `ítem ${f.item} bodega ${f.bodega} seguía con ${f.antes} y ahora ${f.ahora}`)
            .join("; ") +
          ". No se sigue compensando. Revisá en SIESA el movimiento del ajuste (naturaleza).",
      });
    }
    faltantesPrevios = faltantes;

    if (ronda === MAX_RONDAS_AJUSTE) {
      return resultado({
        detalle: `SIESA sigue reportando faltantes después de ${MAX_RONDAS_AJUSTE} envíos del ajuste.`,
      });
    }

    const { documentos, bloqueos } = armarAjusteFaltante({
      faltantes,
      movimientosCei: ev.armado.payload.Movimientos,
      config: DOCUMENTO_AJUSTE_FALTANTE,
      fecha: ev.armado.payload.Documentos[0]?.FECHA_DOCTO,
      liquidacionId,
    });
    if (bloqueos.length) return resultado({ detalle: bloqueos.join(" ") });

    for (const documento of documentos) {
      const r = await compensarBodega({ documento, origen: fila, liquidacionId, por, inicio });
      compensaciones.push(...r.registros);
      if (!r.ok) {
        return resultado({
          pendiente: r.pendiente || undefined,
          detalle: r.pendiente ? `${r.detalle} Pendiente: volvé a enviar.` : r.detalle,
        });
      }
    }
    // Todas las bodegas compensadas: se reenvía el ajuste de vísceras.
  }
  return resultado();
}

/**
 * Manda el ajuste de vísceras de la liquidación: UN documento con todas las
 * sedes.
 *
 * Si ya está ok no manda nada (un segundo clic). Con un envío en curso o sin
 * confirmar, o con cualquier bloqueo, responde 409: el documento se contabiliza
 * al entrar y no hay forma de mandarlo a medias.
 *
 * Si SIESA lo rechaza por inventario insuficiente, compensa y reenvía (ver
 * `ejecutarAjuste`). Como la oficial, no lanza por SIESA: devuelve el resultado
 * en `envio`, y lo que se compensó en `compensaciones`.
 *
 * @returns {{ completo: boolean, repetido?: boolean, envio: object,
 *   compensaciones?: object[], rondas?: number, pendiente?: boolean, detalle?: string }}
 */
export async function enviarAjusteVisceras(liquidacionId, por) {
  // El reloj arranca ANTES de leer: cargar las recepciones también gasta función.
  const inicio = Date.now();
  const ev = await evaluarAjuste(liquidacionId);
  const previa = construirPrevia(ev);

  if (previa.enviado) {
    return { completo: true, repetido: true, envio: resumenEnvio(ev.vigente) };
  }
  if (previa.enCurso) throw createError(409, motivoVigente(ev.vigente));
  if (previa.vacio) {
    throw createError(409, "Ninguna sede tiene vísceras con código y cantidad para ajustar.");
  }
  if (previa.bloqueos.length) throw createError(409, previa.bloqueos.join(" "));

  return ejecutarAjuste({ ev, liquidacionId, por, inicio });
}

/**
 * Un ajuste de vísceras se anuló en SIESA: se refleja acá y se libera el lugar
 * para mandarlo de nuevo. No toca SIESA: la anulación allá la hace una persona.
 *
 * Con `recepcionId`, el ajuste POR SEDE del esquema anterior de esa recepción
 * (cada una era un documento distinto: liberar todas haría que el reenvío
 * duplicara las que siguen vivas). Sin `recepcionId`, el consolidado de la
 * liquidación.
 *
 * Solo se anula un `ok`, un `sin_confirmar` o un `enviando` ya abandonado; uno
 * en vuelo de verdad todavía puede terminar ok.
 *
 * @param {number|string} liquidacionId
 * @param {{ recepcionId?: number|string, por?: string, motivo?: string }} p
 */
export async function anularAjusteVisceras(liquidacionId, { recepcionId, por, motivo } = {}) {
  if (recepcionId) {
    const ids = await idsDeLiquidacion(liquidacionId);
    if (!ids.includes(Number(recepcionId))) {
      throw createError(404, "Esa recepción no está en esta liquidación.");
    }
  } else {
    const { data: liq, error } = await supabase
      .from("carnes_liquidaciones")
      .select("id")
      .eq("id", liquidacionId)
      .maybeSingle();
    if (error) fallarSiFaltaMigracion(error, "Error al leer la liquidación", MIGRACIONES);
    if (!liq) throw createError(404, "Liquidación no encontrada.");
  }

  const marca = {
    estado: "anulado",
    anulado_por: por || null,
    anulado_at: new Date().toISOString(),
    motivo_anulacion: String(motivo ?? "").trim() || null,
  };
  const limite = new Date(Date.now() - ENVIANDO_ABANDONADO_MS).toISOString();
  const base = () => {
    const q = supabase.from(TABLA).update(marca).eq("tipo", TIPO_AJUSTE_VISCERAS);
    return recepcionId
      ? q.eq("recepcion_id", recepcionId)
      : q.eq("liquidacion_id", liquidacionId).is("recepcion_id", null);
  };

  const [cerrados, abandonados] = await Promise.all([
    base().in("estado", ["ok", "sin_confirmar"]).select("id, referencia"),
    // La condición va en la misma consulta que lo cambia: un envío reservado
    // entre un chequeo y el update no se anula estando vivo.
    base().eq("estado", "enviando").lt("enviado_at", limite).select("id, referencia"),
  ]);
  const e = cerrados.error || abandonados.error;
  if (e) fallarSiFaltaMigracion(e, "No se pudo anular el ajuste de vísceras", MIGRACIONES);

  const anulados = [...(cerrados.data || []), ...(abandonados.data || [])];
  if (!anulados.length) {
    throw createError(
      409,
      recepcionId
        ? "Esa sede no tiene un ajuste de vísceras para anular (o está en curso)."
        : "La liquidación no tiene un ajuste de vísceras para anular (o está en curso).",
    );
  }

  console.log(
    `↩️  Ajuste de vísceras ${
      recepcionId ? `recepción #${recepcionId}` : `liquidación #${liquidacionId}`
    }: ${anulados.map((a) => a.referencia).join(", ")} anulado por ${por || "—"}.`,
  );
  return { anulados: anulados.map((a) => ({ id: a.id, referencia: a.referencia })) };
}

// ─── Recepciones de PROVEEDOR ──────────────────────────────────────────────
//
// La entrada (CEA, `entrada_proveedor`) y la nota crédito de lo devuelto
// (`nc_proveedor`) de una recepción de `carnes_proveedor_recepciones` (sql/022)
// van por el MISMO candado que los demás: se reserva (fila `enviando`), se manda y
// se anota (`registrarYEnviar`). Lo que cambia es de dónde salen los datos y qué
// se hace con el resultado. Las decisiones —mandar, reconciliar, esperar,
// rechazar— son puras y viven en `shared/siesaProveedorEnvio.js`, con tests.
//
//   · `finalizar` manda la entrada sola, UNA vez (`enviarEntradaProveedor`).
//     Cuando queda ok: recepción Finalizada → Enviada_SIESA + `siesa_at`, y la
//     nota crédito si hubo devoluciones. Nunca lanza: la recepción ya está firmada.
//   · Lo que falle lo reintenta el admin (`reintentarEntradaProveedor`), que si la
//     entrada ya está ok no la manda de nuevo sino que RECONCILIA el estado.
//   · Antes de reservar, cada camino vuelve a LEER la recepción y exige que siga
//     Finalizada (la nota crédito, Finalizada o Enviada_SIESA): entre que se
//     decidió y que se reserva alguien pudo anularla.
//   · Con CARNES_SIESA_ACTIVO apagado no se manda ni se anota nada, como la
//     inicial de Talleres.

const TABLA_RECEPCION_PROVEEDOR = "carnes_proveedor_recepciones";
const TABLA_ITEMS_PROVEEDOR = "carnes_proveedor_recepcion_items";

/** Cabecera sin `firma_data` ni cédula del recibidor: acá no hacen falta. */
const COLUMNAS_RECEPCION_PROVEEDOR =
  "id, proveedor_id, proveedor_nit, proveedor_sucursal, proveedor_razon_social, " +
  "factura, factura_siesa, sede_id, bodega_siesa, codigo_co, fecha_recepcion, " +
  "estado, recibido_por, finalizado_at, siesa_at, sede:carnes_sedes ( id, codigo_co, nombre )";

/** Los envíos SIN `payload` ni `respuesta` (pesan): para decidir y para el detalle. */
const COLUMNAS_ENVIO_PROVEEDOR =
  "id, recepcion_proveedor_id, tipo, estado, referencia, consecutivo, tipo_docto, http_status, error, " +
  "renglones, total_kilos, total_valor, enviado_por, enviado_at, resuelto_por, resuelto_at, " +
  "anulado_por, anulado_at, motivo_anulacion";

/** La recepción de proveedor con su sede y sus renglones. 404 si no existe. */
async function cargarRecepcionProveedor(recepcionId) {
  const { data, error } = await supabase
    .from(TABLA_RECEPCION_PROVEEDOR)
    .select(COLUMNAS_RECEPCION_PROVEEDOR)
    .eq("id", recepcionId)
    .maybeSingle();
  if (error) fallarSiFaltaMigracion(error, "Error al leer la recepción", MIGRACIONES_PROVEEDOR);
  if (!data) throw createError(404, "Recepción no encontrada.");

  const { data: items, error: errorItems } = await supabase
    .from(TABLA_ITEMS_PROVEEDOR)
    .select("*")
    .eq("recepcion_id", recepcionId)
    .order("orden")
    .order("id");
  if (errorItems) fallarSiFaltaMigracion(errorItems, "Error al leer los renglones", MIGRACIONES_PROVEEDOR);
  return { ...data, items: items || [] };
}

/**
 * Todos los envíos de una recepción de proveedor (los dos tipos, cualquier
 * estado), del más nuevo al más viejo, sin el payload. Lo usa el detalle del admin.
 */
export async function enviosDeRecepcionProveedor(recepcionId) {
  const { data, error } = await supabase
    .from(TABLA)
    .select(COLUMNAS_ENVIO_PROVEEDOR)
    .eq("recepcion_proveedor_id", recepcionId)
    .order("enviado_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) fallarSiFaltaMigracion(error, "Error al leer los envíos", MIGRACIONES_PROVEEDOR);
  return data || [];
}

/** La recepción (con renglones) y todos sus envíos, leídos juntos. */
async function leerRecepcionYEnvios(recepcionId) {
  const recepcion = await cargarRecepcionProveedor(recepcionId);
  const envios = await enviosDeRecepcionProveedor(recepcionId);
  return { recepcion, envios };
}

/**
 * El envío que ocupa el lugar de esta recepción para este tipo, o —si no hay— el
 * que esté EN VUELO de cualquier tipo: el índice `..._proveedor_en_vuelo` de
 * sql/023 también rechaza (23505) una nota crédito mientras la entrada está
 * enviando o sin confirmar. Es lo que `registrarYEnviar` devuelve como `repetido`.
 */
async function envioQueOcupaProveedor(recepcionId, tipo) {
  const envios = await enviosDeRecepcionProveedor(recepcionId);
  return (
    resumirEnvios(envios, tipo).vigente ||
    envios.find((e) => ESTADOS_EN_CURSO.includes(e.estado)) ||
    null
  );
}

/** Base de la fila del envío: una recepción de proveedor, nunca de Talleres. */
const baseProveedor = (recepcionId, tipo, consecutivo) => ({
  recepcion_id: null,
  liquidacion_id: null,
  recepcion_proveedor_id: Number(recepcionId),
  tipo,
  consecutivo,
});

/** Reserva, manda y anota la ENTRADA. Devuelve la fila; lanza solo por la base. */
async function mandarEntrada(recepcion, por) {
  const armado = armarEntradaProveedor({
    recepcion,
    items: recepcion.items,
    // El tercero es el proveedor; de la config solo salen tipo de documento y
    // unidad de negocio. `DOCUMENTO_CARNES` es el mismo conector 256783 de Talleres.
    config: DOCUMENTO_CARNES,
  });
  return registrarYEnviar({
    armado,
    base: baseProveedor(
      recepcion.id,
      TIPO_ENVIO_PROVEEDOR.ENTRADA,
      consecutivoEntradaProveedor(recepcion.id),
    ),
    por,
    vigente: () => envioQueOcupaProveedor(recepcion.id, TIPO_ENVIO_PROVEEDOR.ENTRADA),
    etiqueta: `entrada proveedor recepción #${recepcion.id}`,
  });
}

/**
 * Recepción Finalizada → Enviada_SIESA (+ `siesa_at`), condicional a que siga
 * Finalizada: si alguien la anuló o ya la movió, no se pisa. Idempotente.
 *
 * @returns {{cambio: boolean, estado: string, siesa_at: ?string}}
 */
async function marcarEnviadaSiesa(recepcionId) {
  const { data, error } = await supabase
    .from(TABLA_RECEPCION_PROVEEDOR)
    .update({ estado: ESTADOS_PROVEEDOR.ENVIADA_SIESA, siesa_at: new Date().toISOString() })
    .eq("id", recepcionId)
    .eq("estado", ESTADOS_PROVEEDOR.FINALIZADA)
    .select("id, estado, siesa_at");
  if (error) fallarSiFaltaMigracion(error, "No se pudo marcar la recepción como enviada", MIGRACIONES_PROVEEDOR);
  if (data?.length) return { cambio: true, estado: data[0].estado, siesa_at: data[0].siesa_at };

  const { data: actual, error: errorLectura } = await supabase
    .from(TABLA_RECEPCION_PROVEEDOR)
    .select("estado, siesa_at")
    .eq("id", recepcionId)
    .maybeSingle();
  if (errorLectura) fallarSiFaltaMigracion(errorLectura, "Error al leer la recepción", MIGRACIONES_PROVEEDOR);
  return { cambio: false, estado: actual?.estado ?? null, siesa_at: actual?.siesa_at ?? null };
}

/**
 * Lo que sigue cuando la ENTRADA está ok en SIESA —al enviarla, al reconciliar o
 * al resolver un sin confirmar—: la recepción pasa a Enviada_SIESA y, si hubo
 * devoluciones, sale la nota crédito. NUNCA lanza: SIESA ya tiene el documento, y
 * un fallo acá se informa (`aviso`) en vez de hacerlo parecer un envío fallido.
 *
 * @returns {Promise<{cambios: ?{estado: string, siesa_at: ?string}, aviso: ?string, notaCredito: object}>}
 */
async function alQuedarOkLaEntrada(recepcion, por) {
  let cambios = null;
  let aviso = null;
  try {
    const marca = await marcarEnviadaSiesa(recepcion.id);
    cambios = { estado: marca.estado, siesa_at: marca.siesa_at };
    if (marca.estado === ESTADOS_PROVEEDOR.ANULADA) {
      aviso =
        "La entrada ya está en SIESA pero la recepción figura como anulada: anulá el documento en SIESA " +
        "o revisá la recepción.";
    }
  } catch (e) {
    console.error(`🔴 SIESA entrada proveedor #${recepcion.id}: ${e.message}`);
    aviso =
      "La entrada quedó en SIESA pero no se pudo actualizar el estado de la recepción. " +
      "Reintentá el envío: no manda otra, solo vuelve a alinear el estado.";
  }

  let notaCredito;
  try {
    notaCredito = (await dispararNotaCreditoSiCorresponde(recepcion.id, por)).notaCredito;
  } catch (e) {
    console.error(`🔴 SIESA nota crédito proveedor #${recepcion.id}: ${e.message}`);
    notaCredito = {
      requerida: hayDevolucionesDe(recepcion),
      estado: "error",
      bloqueo: null,
      referencia: null,
      error: e.message,
    };
  }
  return { cambios, aviso, notaCredito };
}

const hayDevolucionesDe = (recepcion) =>
  (recepcion.items || []).some((i) => Number(i.cantidad) > 0 && Number(i.cantidad_devuelta) > 0);

// ─── Entrada ───────────────────────────────────────────────────────────────

/**
 * La nota crédito tal como está AHORA, sin mandar nada: lo que se le informa al
 * front cuando no se envió. Si hoy se podría enviar pero todavía no se disparó,
 * es "pendiente".
 */
async function notaCreditoActual(recepcion, envios) {
  const { decision } = await evaluarNotaCredito(recepcion, envios);
  return notaCreditoParaFront(decision);
}

/**
 * La entrada que sale al FINALIZAR. Se llama desde `PostFinalizarProveedor`, con
 * la recepción ya firmada. NUNCA lanza.
 *
 * Manda solo si no hay NINGÚN envío de entrada (ver `decidirEntradaAlFinalizar`):
 * cada recarga del celular reintenta `finalizar`, y un error no se reintenta solo.
 * Apagado: no manda ni anota. Si la entrada ya estaba ok pero la recepción seguía
 * Finalizada (un cierre que se cortó), repara el estado.
 *
 * @returns {Promise<{siesa: object, notaCredito: ?object, cambios: ?object, aviso: ?string}>}
 *          `cambios` = columnas de la recepción que cambiaron (estado, siesa_at).
 */
export async function enviarEntradaProveedor(recepcionId, por) {
  try {
    const { recepcion, envios } = await leerRecepcionYEnvios(recepcionId);
    const decision = decidirEntradaAlFinalizar({
      estado: recepcion.estado,
      envios,
      activo: siesaActivo(),
    });

    if (decision.accion === "apagado") {
      return {
        siesa: { estado: "apagado", referencia: null, error: null, envio_id: null },
        notaCredito: await notaCreditoActual(recepcion, envios),
        cambios: null,
        aviso: null,
      };
    }

    if (decision.accion === "omitir") {
      const entrada = resumirEnvios(envios, TIPO_ENVIO_PROVEEDOR.ENTRADA);
      if (entrada.ok && recepcion.estado === ESTADOS_PROVEEDOR.FINALIZADA) {
        const cierre = await alQuedarOkLaEntrada(recepcion, por);
        return { siesa: siesaDeEnvios(envios), ...cierre };
      }
      return {
        siesa: siesaDeEnvios(envios),
        notaCredito: await notaCreditoActual(recepcion, envios),
        cambios: null,
        aviso: null,
      };
    }

    const fila = await mandarEntrada(recepcion, por);
    if (fila.estado === "ok") {
      const cierre = await alQuedarOkLaEntrada(recepcion, por);
      return { siesa: siesaDeFila(fila), ...cierre };
    }
    return {
      siesa: siesaDeFila(fila),
      notaCredito: await notaCreditoActual(recepcion, [...envios, fila]),
      cambios: null,
      aviso: null,
    };
  } catch (e) {
    console.error(`🔴 SIESA entrada proveedor recepción #${recepcionId}: ${e.message}`);
    return {
      siesa: { estado: "error", referencia: null, error: e.message, envio_id: null },
      notaCredito: null,
      cambios: null,
      aviso: null,
    };
  }
}

/**
 * Antes de volver a mandar, la foto del proveedor y de la sede se refresca desde
 * los maestros: un NIT, una bodega o un C.O. corregidos desde que se firmó tienen
 * que llegar bien a SIESA. Solo se llama sin entrada vigente ni ok (después queda
 * congelada) y el UPDATE es condicional a que siga Finalizada.
 */
async function refrescarSnapshotsProveedor(recepcion) {
  const [proveedor, sede] = await Promise.all([
    supabase
      .from("carnes_proveedores")
      .select("nit, sucursal, razon_social")
      .eq("id", recepcion.proveedor_id)
      .maybeSingle(),
    supabase.from("carnes_sedes").select("codigo_co, bodega_siesa").eq("id", recepcion.sede_id).maybeSingle(),
  ]);
  if (proveedor.error) fallarSiFaltaMigracion(proveedor.error, "Error al leer el proveedor", MIGRACIONES_PROVEEDOR);
  if (sede.error) fallarSiFaltaMigracion(sede.error, "Error al leer la sede", MIGRACIONES_PROVEEDOR);

  const cambios = armarRefrescoSnapshots(recepcion, { proveedor: proveedor.data, sede: sede.data });
  if (!Object.keys(cambios).length) return false;

  const { data, error } = await supabase
    .from(TABLA_RECEPCION_PROVEEDOR)
    .update(cambios)
    .eq("id", recepcion.id)
    .eq("estado", ESTADOS_PROVEEDOR.FINALIZADA)
    .select("id");
  if (error) fallarSiFaltaMigracion(error, "No se pudo actualizar la recepción", MIGRACIONES_PROVEEDOR);
  return Boolean(data?.length);
}

/**
 * Reintento MANUAL de la entrada (admin). Sí lanza (409) cuando no se puede.
 *
 *   · Con una entrada ya `ok` NO manda otra: RECONCILIA (Finalizada →
 *     Enviada_SIESA) y dispara la nota crédito que falte. No depende de que SIESA
 *     esté activo: no habla con SIESA.
 *   · Con una en curso o sin confirmar: 409, se resuelve primero.
 *   · Si no, refresca la foto de proveedor y sede, vuelve a leer la recepción
 *     (tiene que seguir Finalizada) y manda por el candado.
 *
 * @returns {Promise<{reconciliada: boolean, siesa: object, notaCredito: ?object,
 *   cambios: ?object, aviso: ?string}>}
 */
export async function reintentarEntradaProveedor(recepcionId, por) {
  const { recepcion, envios } = await leerRecepcionYEnvios(recepcionId);
  const decision = decidirReintentoEntrada({
    estado: recepcion.estado,
    envios,
    activo: siesaActivo(),
  });
  if (decision.accion === "rechazar") throw createError(decision.status, decision.mensaje, decision.codigo);

  if (decision.accion === "reconciliar") {
    const cierre = await alQuedarOkLaEntrada(recepcion, por);
    return { reconciliada: true, siesa: siesaDeFila(decision.envio), ...cierre };
  }

  await refrescarSnapshotsProveedor(recepcion);

  // Releída justo antes de reservar: tiene que seguir Finalizada.
  const fresca = await cargarRecepcionProveedor(recepcionId);
  if (!puedeEnviarASiesa(fresca.estado)) {
    throw createError(409, `La recepción está en "${fresca.estado}": ya no se puede enviar.`, "RECEPCION_CAMBIO");
  }

  const fila = await mandarEntrada(fresca, por);
  // Otro pedido la reservó entre la pregunta de arriba y la reserva.
  if (fila.repetido) throw createError(409, motivoEnvioVigente(fila), "ENVIO_VIGENTE");

  if (fila.estado === "ok") {
    const cierre = await alQuedarOkLaEntrada(fresca, por);
    return { reconciliada: false, siesa: siesaDeFila(fila), ...cierre };
  }
  return {
    reconciliada: false,
    siesa: siesaDeFila(fila),
    notaCredito: await notaCreditoActual(fresca, [...envios, fila]),
    cambios: null,
    aviso: null,
  };
}

// ─── Nota crédito ──────────────────────────────────────────────────────────

/**
 * Arma la nota crédito con los datos de AHORA y decide qué hacer. El armador
 * dice primero si falta el conector (`DOCUMENTO_NOTA_CREDITO_PROVEEDOR`); a eso
 * se le suma que SIESA no tenga credenciales. Nada de esto toca la base.
 */
async function evaluarNotaCredito(recepcion, envios, { manual = false } = {}) {
  const armado = armarNotaCreditoProveedor({
    recepcion,
    items: recepcion.items,
    config: DOCUMENTO_NOTA_CREDITO_PROVEEDOR,
  });
  const bloqueos = [...armado.bloqueos];
  if (!siesaConfigurado()) bloqueos.push(`SIESA no está configurado. Faltan: ${faltantesSiesa().join(", ")}.`);

  const decision = decidirNotaCredito({
    estado: recepcion.estado,
    items: recepcion.items,
    envios,
    activo: siesaActivo(),
    bloqueos,
    manual,
  });
  return { armado, decision };
}

/**
 * La nota crédito de lo devuelto: se manda si corresponde.
 *
 * Corre cada vez que la entrada queda ok (al finalizar, al reconciliar, al
 * resolver). Solo manda si ya hay una entrada ok, hay renglones devueltos y no hay
 * ningún envío de nota crédito (automático) o ninguno vigente/ok (manual).
 *
 * Si está bloqueada —el conector todavía no existe, o SIESA no tiene
 * credenciales— NO anota ningún envío: devuelve el bloqueo. Anotarlo en cada
 * disparo llenaría la tabla de filas `error` idénticas. Cuando el conector se
 * configure, la manda el siguiente disparo o el reintento del admin.
 *
 * @param {number|string} recepcionId
 * @param {string} [por]
 * @param {{manual?: boolean, lanzar?: boolean}} [opciones]
 *        `manual`: lo pidió el admin. `lanzar`: un 409 con el motivo cuando no se
 *        manda (el endpoint) en vez de devolver el estado (el disparo automático).
 * @returns {Promise<{decision: object, fila: ?object, notaCredito: object}>}
 */
export async function dispararNotaCreditoSiCorresponde(recepcionId, por, { manual = false, lanzar = false } = {}) {
  // La lectura es la releída de estado de J8: acá se decide con lo que hay AHORA.
  const { recepcion, envios } = await leerRecepcionYEnvios(recepcionId);
  const { armado, decision } = await evaluarNotaCredito(recepcion, envios, { manual });

  if (decision.accion !== "enviar") {
    if (lanzar) {
      const rechazo = rechazoDeNotaCredito(decision);
      throw createError(rechazo.status, rechazo.mensaje, rechazo.codigo);
    }
    return { decision, fila: null, notaCredito: notaCreditoParaFront(decision) };
  }

  const fila = await registrarYEnviar({
    armado,
    base: baseProveedor(
      recepcion.id,
      TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO,
      consecutivoNotaCreditoProveedor(recepcion.id),
    ),
    por,
    vigente: () => envioQueOcupaProveedor(recepcion.id, TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO),
    etiqueta: `nota crédito proveedor recepción #${recepcion.id}`,
    // Su conector propio (no el de la CEA). Sin él `decidirNotaCredito` bloquea.
    documento: {
      idDocumento: DOCUMENTO_NOTA_CREDITO_PROVEEDOR.idDocumento,
      nombreDocumento: DOCUMENTO_NOTA_CREDITO_PROVEEDOR.nombreDocumento,
    },
  });
  if (fila.repetido && lanzar) throw createError(409, motivoEnvioVigente(fila), "ENVIO_VIGENTE");
  return { decision, fila, notaCredito: notaCreditoParaFront(decision, fila) };
}

/**
 * Reintento MANUAL de la nota crédito (admin). 409 con el motivo si no se puede:
 * la entrada todavía no está en SIESA, no hay devoluciones, ya hay una vigente u
 * ok, SIESA está apagado o el conector no está configurado (en ese caso no se
 * anota ninguna fila).
 */
export async function reintentarNotaCreditoProveedor(recepcionId, por) {
  return dispararNotaCreditoSiCorresponde(recepcionId, por, { manual: true, lanzar: true });
}

// ─── Resolver, detalle y anulación ─────────────────────────────────────────

/**
 * Se resolvió como ok un envío de proveedor. Si es la ENTRADA: la recepción pasa
 * a Enviada_SIESA y sale la nota crédito. Una nota crédito ok no cambia nada en
 * la recepción. Nunca lanza: el envío ya quedó resuelto.
 */
async function seguirTrasResolverProveedor(envio) {
  try {
    if (envio.tipo !== TIPO_ENVIO_PROVEEDOR.ENTRADA) return { cambios: null, aviso: null, notaCredito: null };
    const recepcion = await cargarRecepcionProveedor(envio.recepcion_proveedor_id);
    return await alQuedarOkLaEntrada(recepcion, envio.resuelto_por);
  } catch (e) {
    console.error(`🔴 SIESA resolver proveedor envío #${envio.id}: ${e.message}`);
    return {
      cambios: null,
      notaCredito: null,
      aviso:
        "El envío quedó resuelto, pero no se pudo actualizar la recepción: reintentá el envío de la " +
        "entrada para volver a alinear su estado.",
    };
  }
}

/**
 * El detalle de un envío de PROVEEDOR: payload y respuesta completos, la
 * recepción de la que salió y cada movimiento con su renglón (equivalencia,
 * descripción, unidad, valor y precio unitario), con la forma que lee el panel.
 */
async function obtenerEnvioProveedor(envio) {
  let recepcion = null;
  let items = [];
  if (envio.recepcion_proveedor_id) {
    const { items: renglones, ...cabecera } = await cargarRecepcionProveedor(envio.recepcion_proveedor_id);
    items = renglones;
    recepcion = cabecera;
  }
  const movimientos = enriquecerMovimientosProveedor({
    tipo: envio.tipo,
    movimientos: envio.payload?.Movimientos,
    items,
    sede: recepcion?.sede,
  });
  return { ...envio, recepcion_proveedor: recepcion, movimientos };
}

/**
 * Marca como `anulado` los envíos `ok` de una recepción de proveedor, para poder
 * anular la recepción. NO toca SIESA (la anulación allá la hace una persona) ni
 * el estado de la recepción (eso lo hace quien la anula, después de esto).
 *
 *   · Con un envío en curso o sin confirmar: 409, se resuelve primero.
 *   · Con uno ok y sin `anuladoEnSiesa`: 409, hay que confirmar que ya se anuló.
 *
 * El UPDATE es condicional a `ok`: un envío que cambió de estado entre la lectura
 * y la escritura no se pisa.
 *
 * @param {number|string} recepcionId
 * @param {{por?: string, motivo?: string, anuladoEnSiesa?: boolean}} p
 * @returns {Promise<{anulados: {id: number, tipo: string, referencia: string}[]}>}
 */
export async function anularEnviosProveedor(recepcionId, { por, motivo, anuladoEnSiesa = false } = {}) {
  const envios = await enviosDeRecepcionProveedor(recepcionId);
  const plan = planearAnulacionEnvios({ envios, anuladoEnSiesa });
  if (!plan.ok) throw createError(plan.status, plan.mensaje, plan.codigo);
  if (!plan.aAnular.length) return { anulados: [] };

  const { data, error } = await supabase
    .from(TABLA)
    .update({
      estado: "anulado",
      anulado_por: por || null,
      anulado_at: new Date().toISOString(),
      motivo_anulacion: String(motivo ?? "").trim() || null,
    })
    .in(
      "id",
      plan.aAnular.map((e) => e.id),
    )
    .eq("estado", "ok")
    .select("id, tipo, referencia");
  if (error) fallarSiFaltaMigracion(error, "No se pudieron anular los envíos", MIGRACIONES_PROVEEDOR);

  const anulados = (data || []).map((e) => ({ id: e.id, tipo: e.tipo, referencia: e.referencia }));
  console.log(
    `↩️  Recepción de proveedor #${recepcionId}: ${anulados.map((a) => a.referencia).join(", ") || "—"} ` +
      `anulado(s) por ${por || "—"}.`,
  );
  return { anulados };
}
