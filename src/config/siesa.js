/**
 * Configuración del conector de SIESA.
 *
 * Dos clases de cosas, y no se mezclan:
 *
 *   ENTORNO  lo que es secreto o cambia entre QA y producción. Sale de las
 *            variables que YA existen en Vercel para los otros módulos:
 *            CONNEKTA_BASE_URL, CONNEKTA_ID_COMPANIA, CONNI_KEY, CONNI_TOKEN.
 *            Mismos nombres que Backend-traslados y Backend-Dotacion, para
 *            que las credenciales se roten en un solo lugar.
 *
 *   NEGOCIO  lo que es una constante del documento de carnes: tipo de
 *            documento, proveedor, unidades. No es secreto y no cambia por
 *            ambiente, así que vive acá, con nombre, versionado en git. Ponerlo
 *            en el .env lo escondería en un panel donde nadie lo ve.
 *
 * Se lee por llamada y no al arrancar: en Vercel las variables se cambian sin
 * redesplegar, y un valor cacheado al arranque seguiría mandando a QA.
 */

const leer = (k) => String(process.env[k] ?? "").trim();

// ─── Constantes del documento ENTRADA_DIRECTA_ALMACEN (taller de carnes) ───
//
// Los valores que la documentación del conector fija ya están del lado de
// SIESA (compañía 001, CO 001, clase 408, concepto 401, comprador 901150440,
// moneda COP, estado 0). Acá van solo las variables del JSON que son iguales
// para toda entrada de carnes.
//
// `null` = todavía no lo dieron. El envío se bloquea con un mensaje que nombra
// exactamente qué falta, en vez de mandar un documento con un campo vacío que
// SIESA rechazaría con un error menos claro.
export const DOCUMENTO_CARNES = {
  /** Id del conector en SIESA, tal como está en la pantalla "Apis Dinámicas". */
  idDocumento: "256783",
  nombreDocumento: "ENTRADA_DIRECTA_ALMACEN",

  /** Código del tipo de documento (f350_id_tipo_docto, 3 caracteres). CEA = entrada de carnes. */
  tipoDocto: "CEA",
  /**
   * Proveedor: NIT (f350_id_tercero) y su sucursal (f451_id_sucursal_prov).
   * 70329554 = Julio Arboleda Sierra, el frigorífico que firma el informe de
   * desposte ("Cliente: 380 - JULIO ARBOLEDA SIERRA").
   */
  nit: "70329554",
  sucursal: "001",
  /**
   * Unidad de medida del movimiento (f470_id_unidad_medida, 4 caracteres).
   *
   * `KL`, NO `KG`. Confirmado contra el maestro: los cortes de carne en SIESA
   * tienen `f126_id_unidad_medida = "KL  "`. Con `KG` el conector respondió
   * "La unidad de medida en el registro no existe".
   */
  unidadMedida: "KL",

  /**
   * Cuántos decimales llevan los números del movimiento.
   *
   * El plano define el ANCHO del campo (15 enteros + punto + 4 decimales), pero
   * el conector exige que la cantidad de decimales REPORTADOS sea la que tiene
   * configurada la moneda (para el valor) y la unidad de medida (para la
   * cantidad). Mandar 4 decimales en el valor dio: "La cantidad de decimales
   * del valor bruto deben ser iguales a la cantidad de decimales de la moneda
   * en compra y venta".
   *
   * Si el conector vuelve a quejarse de decimales, se ajusta acá.
   */
  decimalesValor: 2,
  decimalesCantidad: 3,
  /** Unidad de negocio del movimiento (f470_id_un_movto). 003 = Carnes. */
  unidadNegocio: "003",
};

/**
 * Ruta del conector de importación, tal como la documenta SIESA.
 *
 * NO es la misma ruta que usan los hermanos: `CONNEKTA_BASE_URL` apunta a la
 * API de consultas (`/api/connekta/v3/ejecutarconsulta`). El importador vive
 * en `/api/siesa/v3.1/conectoresimportar`, en el mismo host. Por eso de la
 * variable se toma solo el HOST —que es lo que cambia entre QA y producción—
 * y la ruta se fija acá.
 */
const RUTA_IMPORTAR = "/api/siesa/v3.1/conectoresimportar";

/** `https://servicios.siesacloud.com/api/connekta/v3` → `https://servicios.siesacloud.com` */
function hostDe(url) {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

/** Endpoint y credenciales. Nombres compartidos con los otros backends. */
export function conexionSiesa() {
  const host = hostDe(leer("CONNEKTA_BASE_URL"));
  return {
    url: host ? `${host}${RUTA_IMPORTAR}` : "",
    idCompania: leer("CONNEKTA_ID_COMPANIA"),
    // `siesa-pos-sync` usa idSistema=1 contra el mismo servicio. Se puede
    // pisar por entorno si SIESA asigna otro.
    idSistema: leer("SIESA_ID_SISTEMA") || "1",
    conniKey: leer("CONNI_KEY"),
    conniToken: leer("CONNI_TOKEN"),
  };
}

/** Lo que va adentro del documento. Se pasa a `armarEntradaDirecta`. */
export function documentoSiesa() {
  return { ...DOCUMENTO_CARNES };
}

/**
 * Interruptor general. `CARNES_SIESA_ACTIVO=true` para que salga algo.
 *
 * Apagado por defecto, a propósito: la entrada inicial sale SOLA cada vez que
 * un recibidor cierra. Sin este freno, el día que se carguen las credenciales
 * cada recepción de prueba —la del admin, la del recibidor que está viendo
 * cómo funciona el celular— crea un documento real en SIESA que alguien tiene
 * que ir a anular. Se prende cuando se decide, no cuando se configura.
 */
export function siesaActivo() {
  return String(process.env.CARNES_SIESA_ACTIVO || "").toLowerCase() === "true";
}

/** ¿Están las credenciales? Sin esto no se intenta ningún envío. */
export function siesaConfigurado() {
  const c = conexionSiesa();
  return Boolean(c.url && c.idCompania && c.conniKey && c.conniToken);
}

/**
 * Qué falta, y DÓNDE: las de entorno se cargan en Vercel, las de negocio se
 * escriben en este archivo. El mensaje lo dice para que nadie busque en el
 * lugar equivocado.
 */
export function faltantesSiesa() {
  const c = conexionSiesa();
  const faltan = [];
  if (!c.url) faltan.push("CONNEKTA_BASE_URL (entorno)");
  if (!c.idCompania) faltan.push("CONNEKTA_ID_COMPANIA (entorno)");
  if (!c.conniKey) faltan.push("CONNI_KEY (entorno)");
  if (!c.conniToken) faltan.push("CONNI_TOKEN (entorno)");
  for (const [k, v] of Object.entries(DOCUMENTO_CARNES)) {
    if (v === null || v === "") faltan.push(`${k} (src/config/siesa.js)`);
  }
  return faltan;
}
