/**
 * Faltantes de inventario que SIESA reporta, y el ajuste que los compensa.
 *
 * Módulo PURO, como `siesaAjusteVisceras.js`: sin HTTP, sin base.
 *
 * ─── Qué problema resuelve ────────────────────────────────────────────────
 *
 * SIESA rechaza un documento de inventario con 400 cuando una bodega no tiene
 * saldo suficiente del ítem:
 *
 *   f_valor:   "Item:0015187Bodega:00201"
 *   f_detalle: "Movto Inventario: Item sin cantidad disponible
 *               Faltante Inv.: -1.998000 Faltante Adic.: 0.0000"
 *
 * Es lo que le pasa al ajuste de vísceras cuando el POS vendió un ítem que la
 * bodega no tenía. El remedio es el de `siesa-pos-sync` (syncVentas.js,
 * `ajustarInventario`): PRIMERO un ajuste de inventario CPE por exactamente lo
 * que falta, DESPUÉS reenviar el documento. Acá vive lo puro de eso.
 *
 * ─── El conector: 257784 AJUSTE_DESARROLLO_CARNES_ERRORES ────────────────
 *
 * Propio de carnes (motivo 03 fijo). Las claves son las variables de ESE
 * conector, que es copia del de requisiciones y NO del de siesa-pos-sync:
 *
 *   Documentos   CONSECUTIVO_DOCTO, FECHA_DOCTO, BODEGA
 *   Movimientos  consec_docto, nro_registro, BODEGA, "C.O MOVIMIENTO",
 *                UNIDAD_MEDIDA, CANTIDAD, COSTO_PROMEDIO, ITEM, UNIDAD_NEGOCIO
 *
 * Los números van como en la CEA y la CEI, que SIESA ya acepta: la cantidad
 * con los decimales de su unidad (KL 3, UND 2), el costo con los de la moneda
 * (0) y el ítem sin ceros a la izquierda. El formato de siesa-pos-sync (20 de
 * ancho, 4 decimales) no se usa: SIESA exige que los decimales reportados sean
 * los de la unidad, y eso ya nos rechazó un envío.
 *
 * Un documento por bodega: cada cabecera lleva la suya. El costo y la unidad
 * salen del renglón de víscera de ESA bodega en el documento rechazado. Un
 * faltante de un ítem que no es una víscera de este documento NO se compensa:
 * se avisa.
 *
 * ─── Cuánto se compensa ───────────────────────────────────────────────────
 *
 * El faltante redondeado HACIA ARRIBA a los decimales de la unidad (KL 3; UND,
 * entero, como siesa-pos-sync). Y si el propio ajuste vuelve con faltante, se
 * SUMA a lo que ya se mandaba (anterior + faltante), no se reemplaza: el
 * "Faltante Inv." es lo que TODAVÍA falta con la cantidad enviada
 * (costos-acumulacion/ajusteCostos.js lo documenta, verificado en producción:
 * mandar 1 → faltante 2; mandar 2 → faltante 1; necesita 3).
 */

/** El `tipo` de envío en `carnes_siesa_envios` (sql/021). */
import { decimalesDeUnidad } from "./visceras.js";

export const TIPO_AJUSTE_FALTANTE = "ajuste_faltante";

/** Cuántas veces se sube la cantidad de UN ajuste antes de darlo por perdido. */
export const MAX_REINTENTOS_AJUSTE = 3;

const RE_ITEM = /Item:(.+?)Bodega:(\w+)/;
const RE_FALTANTE = /Faltante Inv\.:\s*(-?[\d.]+)/;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** El ítem del error sin ceros a la izquierda: `0015187` → `15187`. */
function itemDelError(crudo) {
  // SIESA a veces concatena el ítem rellenado con su código otra vez
  // ("Item:00050645064Bodega:..."), o con su extensión ("0001705A-0001705"): se
  // toman los primeros 7 caracteres, igual que siesa-pos-sync.
  return String(crudo).slice(0, 7).replace(/^0+/, "");
}

/** El arreglo `detalle` de una respuesta del conector, o []. */
function detalleDe(respuesta) {
  if (Array.isArray(respuesta)) return respuesta;
  return Array.isArray(respuesta?.detalle) ? respuesta.detalle : [];
}

/** Las advertencias no explican un rechazo: no cuentan. */
const esAdvertencia = (d) => /^Advertencia/i.test(String(d?.f_detalle ?? ""));

/** ¿Este detalle es un "Item sin cantidad disponible" con faltante positivo? */
function leerFaltante(d) {
  const texto = String(d?.f_detalle ?? "");
  if (!/Item sin cantidad disponible/i.test(texto)) return null;
  const mItem = String(d?.f_valor ?? "").match(RE_ITEM);
  const mFalt = texto.match(RE_FALTANTE);
  if (!mItem || !mFalt) return null;
  const faltante = Math.abs(num(mFalt[1]));
  const item = itemDelError(mItem[1]);
  if (!item || !(faltante > 0)) return null;
  return { item, bodega: mItem[2], faltante };
}

/**
 * Los faltantes de inventario que trae una respuesta de SIESA.
 *
 * Ignora todo detalle que no sea un faltante. Si un mismo ítem y bodega aparece
 * más de una vez se queda con el mayor: no se suman, sería contarlo doble.
 *
 * @param {object|Array} respuesta  el cuerpo del 400, o su arreglo `detalle`
 * @returns {{item: string, bodega: string, faltante: number}[]}
 */
export function parsearFaltantes(respuesta) {
  const porClave = new Map();
  for (const d of detalleDe(respuesta)) {
    const f = leerFaltante(d);
    if (!f) continue;
    const clave = `${f.bodega}|${f.item}`;
    const previo = porClave.get(clave);
    if (!previo || f.faltante > previo.faltante) porClave.set(clave, f);
  }
  return [...porClave.values()];
}

/**
 * ¿SIESA rechazó SOLO por faltantes?
 *
 * Es la condición para compensar: si además hay otro error (un ítem que no
 * existe, un campo obligatorio), compensar el faltante no arregla nada y solo
 * deja inventario de más.
 */
export function soloFaltantes(respuesta) {
  const relevantes = detalleDe(respuesta).filter((d) => !esAdvertencia(d));
  return relevantes.length > 0 && relevantes.every((d) => leerFaltante(d) !== null);
}

// ─── Números ────────────────────────────────────────────────────────────────

/** Número con N decimales exactos, como string, sin relleno ni miles. */
export function formatDecimal(numero, decimales) {
  const d = Number.isInteger(decimales) ? decimales : 0;
  return num(numero).toFixed(d);
}

/**
 * La cantidad llevada HACIA ARRIBA a los decimales de su unidad (KL 3, UND 2,
 * los mismos que acepta la CEI): nunca queda corta, y tampoco inyecta de más.
 * siesa-pos-sync sube UND al entero, pero acá SIESA ya aceptó 5,33 UND de Riñón:
 * redondear 0,66 a 1,00 dejaría 0,34 unidades fantasma por ronda.
 */
export function cantidadHaciaArriba(cantidad, unidad) {
  const d = decimalesDeUnidad(String(unidad ?? "").trim());
  const f = 10 ** d;
  // toFixed antes de ceil: 1.998 × 1000 da 1997.9999999999998 y no debe subir a 1999.
  return Math.ceil(Number((num(cantidad) * f).toFixed(6))) / f;
}

// ─── Referencia ─────────────────────────────────────────────────────────────

/** `f350_num_docto_referencia` admite 12 caracteres, y la tabla, VARCHAR(12). */
const LARGO_REFERENCIA = 12;

/**
 * Referencia del ajuste por faltante de UNA bodega: `TF L10 00201`.
 *
 * TF = "taller, faltante". Lleva el código de la bodega ENTERO, así que dos
 * bodegas nunca comparten referencia. Si la liquidación es de más de dos dígitos
 * no entra en 12 y pasa a `F100-00201`; nunca se corta la bodega.
 *
 * Como las demás referencias del módulo, no viaja a SIESA (el conector no tiene
 * dónde recibirla): vive solo en `carnes_siesa_envios`.
 */
export function referenciaAjusteFaltante(liquidacionId, bodega) {
  const b = String(bodega ?? "").trim();
  const legible = `TF L${liquidacionId} ${b}`;
  if (legible.length <= LARGO_REFERENCIA) return legible;
  return `F${liquidacionId}-${b}`.slice(0, LARGO_REFERENCIA);
}

/**
 * Lo mismo para el CEI de UNA recepción (tipo `visceras_recepcion`): `TF R12 00201`.
 * `R` y no `L` para no chocar con el de liquidación; pasada la recepción #99 no
 * entra en 12 y pasa a `FR123-00201` (el prefijo `FR` tampoco choca con `F10-…`).
 */
export function referenciaAjusteFaltanteRecepcion(recepcionId, bodega) {
  const b = String(bodega ?? "").trim();
  const legible = `TF R${recepcionId} ${b}`;
  if (legible.length <= LARGO_REFERENCIA) return legible;
  return `FR${recepcionId}-${b}`.slice(0, LARGO_REFERENCIA);
}

// ─── El documento ───────────────────────────────────────────────────────────

/**
 * Arma el JSON de UNA bodega con las variables del conector 257784.
 *
 * El consecutivo viaja aunque sea automático: el plano lo exige (la CEI lo
 * rechazó sin él). `liquidación × 10 + 5` no choca con la CEA (+1, +2, +3) ni
 * con el ajuste de vísceras (+4), y SIESA asigna el número real igual.
 */
function construirDocumento({ liquidacionId, recepcionId, bodega, fecha, lineas, config }) {
  // Con `recepcionId` es la compensación del CEI de una recepción: recepción × 10
  // + 8 (el +7 es el propio CEI), que no choca con ningún otro consecutivo.
  const consec = String(recepcionId ? Number(recepcionId) * 10 + 8 : Number(liquidacionId) * 10 + 5);
  const dv = Number.isInteger(config.decimalesValor) ? config.decimalesValor : 0;
  const movimientos = lineas.map((l, n) => ({
    consec_docto: consec,
    nro_registro: String(n + 1),
    BODEGA: bodega,
    "C.O MOVIMIENTO": l.co,
    UNIDAD_MEDIDA: l.unidad,
    CANTIDAD: formatDecimal(l.cantidad, decimalesDeUnidad(l.unidad)),
    COSTO_PROMEDIO: formatDecimal(l.costo, dv),
    ITEM: String(l.item),
    UNIDAD_NEGOCIO: l.un,
  }));

  const totalValor = lineas.reduce((a, l) => a + l.cantidad * l.costo, 0);
  const totalKilos = lineas.reduce((a, l) => a + (l.unidad === "KL" ? l.cantidad : 0), 0);

  return {
    bodega,
    lineas,
    payload: {
      Documentos: [{ CONSECUTIVO_DOCTO: consec, FECHA_DOCTO: fecha, BODEGA: bodega }],
      Movimientos: movimientos,
    },
    resumen: {
      tipo: "ajuste_faltante",
      referencia: recepcionId
        ? referenciaAjusteFaltanteRecepcion(recepcionId, bodega)
        : referenciaAjusteFaltante(liquidacionId, bodega),
      renglones: movimientos.length,
      totalKilos: Math.round(totalKilos * 1000) / 1000,
      totalValor: Math.round(totalValor * 100) / 100,
      bodega,
      fecha,
    },
  };
}

/**
 * Arma los ajustes que compensan los faltantes: UN documento POR BODEGA.
 *
 * El ítem, la unidad, el costo, el CO y la unidad de negocio salen del renglón
 * del documento rechazado (`movimientosCei`) para ESA bodega: es lo que se quiso
 * entrar, y el costo es el `costo_base` de la víscera. Un faltante que no
 * corresponde a un renglón del documento (otro ítem u otra bodega) bloquea: no se
 * adivina un costo para inyectar inventario a mano.
 *
 * @param {object} p
 * @param {{item: string, bodega: string, faltante: number}[]} p.faltantes
 * @param {object[]} p.movimientosCei  `payload.Movimientos` del documento rechazado
 * @param {object} p.config            `DOCUMENTO_AJUSTE_FALTANTE`
 * @param {string} p.fecha             AAAAMMDD (la del documento rechazado)
 * @param {number|string} p.liquidacionId
 * @param {number|string} [p.recepcionId]  si el documento rechazado es el CEI de una
 *   recepción (no el de una liquidación): cambia la referencia y el consecutivo
 * @returns {{ documentos: object[], bloqueos: string[] }}
 */
export function armarAjusteFaltante({
  faltantes = [],
  movimientosCei = [],
  config = {},
  fecha,
  liquidacionId,
  recepcionId,
}) {
  const bloqueos = [];
  if (!faltantes.length) return { documentos: [], bloqueos: ["No hay faltantes que compensar."] };

  const fallan = ["coDocumento"].filter((k) => !String(config[k] ?? "").trim());
  if (fallan.length) bloqueos.push(`Falta configurar en SIESA: ${fallan.join(", ")}.`);
  if (!String(fecha ?? "").trim()) bloqueos.push("El documento rechazado no tiene fecha.");

  const buscar = (item, bodega) =>
    movimientosCei.find(
      (m) =>
        String(m.ITEM ?? "").trim().replace(/^0+/, "") === item &&
        String(m.BODEGA ?? "").trim() === bodega,
    );

  const porBodega = new Map();
  for (const f of faltantes) {
    const mov = buscar(f.item, f.bodega);
    if (!mov) {
      bloqueos.push(
        `SIESA reporta faltante del ítem ${f.item} en la bodega ${f.bodega}, que no es una ` +
          "víscera de este ajuste: no se compensa solo. Revisá ese inventario en SIESA.",
      );
      continue;
    }
    const costo = Math.round(num(mov.COSTO_PROMEDIO));
    const co = String(mov["C.O MOVIMIENTO"] ?? "").trim();
    const un = String(mov.UNIDAD_NEGOCIO ?? "").trim();
    const unidad = String(mov.UNIDAD_MEDIDA ?? "").trim();
    if (!(costo > 0)) {
      bloqueos.push(`El ítem ${f.item} (bodega ${f.bodega}) no tiene costo para compensarlo.`);
      continue;
    }
    if (!co || !un || !unidad) {
      bloqueos.push(
        `El renglón del ítem ${f.item} (bodega ${f.bodega}) no trae CO, unidad de negocio o ` +
          "unidad de medida.",
      );
      continue;
    }
    const linea = {
      item: f.item,
      co,
      un,
      unidad,
      costo,
      faltante: f.faltante,
      cantidad: cantidadHaciaArriba(f.faltante, unidad),
    };
    const lista = porBodega.get(f.bodega) || [];
    lista.push(linea);
    porBodega.set(f.bodega, lista);
  }

  const documentos = [...porBodega.keys()]
    .sort()
    .map((bodega) =>
      construirDocumento({
        liquidacionId,
        recepcionId,
        bodega,
        fecha,
        lineas: porBodega.get(bodega),
        config,
      }),
    );
  return { documentos, bloqueos };
}

/**
 * El mismo ajuste con la cantidad SUBIDA porque SIESA volvió a reportar faltante
 * (anterior + faltante, con el redondeo de la unidad).
 *
 * @param {object} documento  uno de `armarAjusteFaltante(...).documentos`
 * @param {{item: string, bodega: string, faltante: number}[]} faltantes  los que
 *   reportó SIESA al rechazar ESTE ajuste
 * @param {object} config
 * @param {number|string} liquidacionId
 * @returns {{ documento: object|null, cambios: object[], noAplicables: object[] }}
 *   `documento` es null si ningún faltante corresponde a un renglón (no hay qué
 *   subir); `noAplicables` son los que no encajaron.
 */
export function subirCantidadPorFaltante({ documento, faltantes, config, liquidacionId, recepcionId }) {
  const cambios = [];
  const noAplicables = [];
  const lineas = documento.lineas.map((l) => ({ ...l }));
  for (const f of faltantes) {
    const linea = lineas.find((l) => l.item === f.item && documento.bodega === f.bodega);
    if (!linea) {
      noAplicables.push(f);
      continue;
    }
    const anterior = linea.cantidad;
    linea.cantidad = cantidadHaciaArriba(anterior + f.faltante, linea.unidad);
    cambios.push({ item: f.item, anterior, faltante: f.faltante, nueva: linea.cantidad });
  }
  if (!cambios.length) return { documento: null, cambios, noAplicables };
  return {
    documento: construirDocumento({
      liquidacionId,
      recepcionId,
      bodega: documento.bodega,
      fecha: documento.payload.Documentos[0].FECHA_DOCTO,
      lineas,
      config,
    }),
    cambios,
    noAplicables,
  };
}

/**
 * ¿Compensar sirvió? Compara los faltantes de la ronda anterior con los de
 * ahora: si alguno NO bajó, el ajuste no está sumando inventario (por ejemplo,
 * si SIESA lo tomara como una salida) y seguir solo empeoraría el saldo.
 *
 * @returns {{item: string, bodega: string, antes: number, ahora: number}[]}
 *   los que siguen igual o peor; vacío si todo mejoró
 */
export function faltantesQueNoBajaron(antes, ahora = []) {
  // `antes` es null en la primera ronda: el valor por defecto no cubre null.
  const previo = new Map((antes || []).map((f) => [`${f.bodega}|${f.item}`, f.faltante]));
  return ahora
    .filter((f) => previo.has(`${f.bodega}|${f.item}`))
    .filter((f) => f.faltante >= previo.get(`${f.bodega}|${f.item}`) - 1e-9)
    .map((f) => ({
      item: f.item,
      bodega: f.bodega,
      antes: previo.get(`${f.bodega}|${f.item}`),
      ahora: f.faltante,
    }));
}
