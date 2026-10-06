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
   * Proveedor por defecto: NIT (f350_id_tercero) y sucursal
   * (f451_id_sucursal_prov). 70329554 = Julio Arboleda Sierra, el frigorífico
   * que firma el informe de desposte.
   *
   * La entrada OFICIAL lo pisa con el tercero que elige el admin — ver
   * `TERCEROS_CARNES`. Esto es lo que usa la inicial, que sale sola.
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
   * `decimalesValor: 0` — el peso colombiano no tiene centavos en este sistema.
   * La prueba es limpia: en un envío de tres renglones, SIESA reclamó SOLO el
   * que daba 117.967,50 y dejó pasar los dos que daban pesos exactos.
   *
   * Consecuencia: el valor de cada renglón se redondea al peso, así que la suma
   * de los renglones puede diferir del total de la recepción en unos pocos
   * pesos. Es la moneda del ERP la que manda; no se puede mandar el centavo.
   *
   * `decimalesCantidad: 3` — los kilos con tres decimales pasaron sin queja.
   */
  decimalesValor: 0,
  decimalesCantidad: 3,
  /** Unidad de negocio del movimiento (f470_id_un_movto). 003 = Carnes. */
  unidadNegocio: "003",
};

// ─── Constantes del documento AJUSTE_INV_VISCERAS (vísceras de res) ────────
//
// Las vísceras no entran en la CEA (ver `vaASiesa` en shared/visceras.js): el
// inventario las recibe por un documento propio, un ajuste de inventario CEI.
// Va UN documento por recepción (sede): la cabecera lleva una sola bodega.
//
// Lo que el conector 257135 tiene FIJO del lado de SIESA y por eso NO viaja en
// el JSON: compañía 001, CO del documento 001, tipo CEI, consecutivo automático
// (F_CONSEC_AUTO_REG = 1, no se manda consecutivo), clase 61 (entrada), concepto
// 601, motivo 04, notas "TALLER DE CARNES (VÍSCERAS)".
//
// ATENCIÓN: el estado fijo es 1 = Aprobado/Contabilizado. A diferencia de la
// CEA, que queda en elaboración, este documento se CONTABILIZA al importarse y
// no hay nadie que lo revise antes. Por eso solo se manda con la entrada oficial
// ya en SIESA y detrás de una confirmación explícita en pantalla.
export const DOCUMENTO_AJUSTE_VISCERAS = {
  /** Id del conector en SIESA, tal como está en la pantalla "Apis Dinámicas". */
  idDocumento: "257135",
  nombreDocumento: "AJUSTE_INV_VISCERAS",

  /** Código del tipo de documento (f350_id_tipo_docto). CEI = ajuste de inventario. */
  tipoDocto: "CEI",
  /**
   * Valor de la variable "C.O." de cada movimiento: el CO del DOCUMENTO.
   *
   * SUPUESTO POR VERIFICAR con el primer envío real: se asume que es el mismo
   * "001" fijo del documento (no el CO de la sede, que va en "C.O MOVIMIENTO").
   * Si SIESA lo rechaza o lo lee distinto, este es el único lugar que se toca.
   */
  coDocumento: "001",
  /** Unidad de negocio del movimiento: la misma de la CEA (003 = Carnes). */
  unidadNegocio: DOCUMENTO_CARNES.unidadNegocio,
  /**
   * Decimales del costo unitario (`COSTO_PROMEDIO`): los de la moneda, igual que
   * el valor de la CEA. El conector exige que coincidan con los del ERP.
   */
  decimalesValor: DOCUMENTO_CARNES.decimalesValor,
};

// ─── Constantes del documento AJUSTE_INVENTARIO (compensación por faltante) ──
//
// Cuando SIESA rechaza el ajuste de vísceras con "Item sin cantidad disponible"
// —la bodega tiene menos saldo del que el documento exige, por ventas del POS
// sin stock—, se manda PRIMERO un ajuste de inventario CPE por exactamente lo que
// falta y DESPUÉS se reenvía el ajuste de vísceras. Es el mismo remedio que usa
// `siesa-pos-sync` (syncVentas.js, `ajustarInventario`) con sus facturas.
//
// ─── El conector NO es el de siesa-pos-sync ─────────────────────────────────
//
// `siesa-pos-sync` usa el conector 241913 AJUSTE_INVENTARIO_DEV, que tiene FIJOS
// del lado de SIESA el tipo CPE, la clase 61, el concepto 601, el motivo "17" y
// la nota "AJUSTE FACTURACIÓN", y que corre cada hora en producción para las
// ventas. NO SE TOCA. Carnes necesita su propia copia, con el motivo "03" fijo y
// las MISMAS variables; el negocio la crea aparte.
//
// Hasta que esa copia exista, `idDocumento` y `nombreDocumento` son `null`: el
// ajuste por faltante NO se manda y el envío del ajuste de vísceras se detiene,
// con un mensaje que dice qué falta, en vez de compensar contra el conector de
// otro módulo (que registraría el motivo 17). Cuando la copia esté, se escriben
// acá los dos valores, tal como salen de la pantalla "Apis Dinámicas".
//
// El JSON tiene las MISMAS claves que el de siesa-pos-sync (ver
// `shared/siesaFaltantes.js`): así la copia funciona sin cambiar nada.
export const DOCUMENTO_AJUSTE_FALTANTE = {
  /**
   * Conector PROPIO de carnes, creado el 29/09/2026 como copia del de
   * requisiciones (250295). No se usa el 241913 AJUSTE_INVENTARIO_DEV de
   * siesa-pos-sync ni el 250295: los dos tienen el motivo FIJO (17 y 18) y son de
   * otros módulos; cambiarlos rompería flujos que hoy funcionan.
   *
   * Fijo en SIESA: CPE, clase 61, concepto 601, MOTIVO 03, CO 001, consecutivo
   * automático, estado 1 = contabilizado. Variables: Documentos FECHA_DOCTO y
   * BODEGA; Movimientos consec_docto, nro_registro, BODEGA, "C.O MOVIMIENTO",
   * UNIDAD_MEDIDA, CANTIDAD, COSTO_PROMEDIO, ITEM, UNIDAD_NEGOCIO.
   */
  idDocumento: "257784",
  nombreDocumento: "AJUSTE_DESARROLLO_CARNES_ERRORES",

  /** Fijo en el conector; se conserva para rotular el envío en el panel. */
  tipoDocto: "CPE",
  /** Motivo fijo en el conector. Informativo: SIESA no lo lee del JSON. */
  motivo: "03",
  /** CO del documento, fijo en el conector. Se exige configurado como el resto. */
  coDocumento: "001",
  /** Decimales de la moneda para COSTO_PROMEDIO, igual que la CEA y la CEI. */
  decimalesValor: 0,
};

/**
 * Qué falta para poder mandar el ajuste por faltante, dicho para una persona.
 * `null` si está todo. Mismo patrón que `faltantesSiesa()`: lo que es `null` en
 * este archivo se escribe acá, no en Vercel.
 */
export function bloqueoAjusteFaltante() {
  const faltan = ["idDocumento", "nombreDocumento"].filter(
    (k) => !String(DOCUMENTO_AJUSTE_FALTANTE[k] ?? "").trim(),
  );
  if (!faltan.length) return null;
  return (
    "Falta configurar el conector del ajuste por faltante: " +
    faltan.map((k) => `${k} (src/config/siesa.js → DOCUMENTO_AJUSTE_FALTANTE)`).join(", ") +
    ". SIESA rechazó el ajuste de vísceras por inventario insuficiente y hace falta compensarlo " +
    "con un ajuste de inventario propio de carnes (motivo 03); no se usa el conector de " +
    "siesa-pos-sync porque registraría el motivo 17."
  );
}

// ─── Constantes del documento de nota crédito a proveedor (devoluciones) ─────
//
// El recibidor de proveedores registra las devoluciones en el mismo renglón de la
// recepción. La entrada (CEA, conector 256783) lleva la cantidad y el valor
// FACTURADOS completos —lo que dice la factura física del proveedor— y lo
// devuelto sale en una nota crédito APARTE, con solo lo devuelto.
//
// Conector 258496 DEVOLUCIONES_DEV_CARNES_final: hermano de la CEA con clase 413
// (devoluciones), concepto 402, motivo 06 y naturaleza 2 (salida), fijos del
// lado de SIESA; `TIPO_DOCTO` y `NOTAS` (también por movimiento) son variables.
// Reemplaza al 258258 (mismo nombre sin "_final", con TIPO_DOCTO fijo), que SIESA
// rechazó: "plano [0 · 413] Compras comercial: la clase debe ser 408 o 420".
// Queda en elaboración (estado 0): alguien la revisa en SIESA antes de
// contabilizar. Si algún día vuelve a faltar un valor, la nota crédito
// NO se manda y queda bloqueada con un mensaje que dice qué falta
// (`bloqueoNotaCreditoProveedor`).
//
// A diferencia de la CEA, la factura del proveedor viaja en `DOCTO_REFERENCIA`
// (f451_num_docto_referencia), no en `PENDIENTE` (ver `armarNotaCreditoProveedor`).
export const DOCUMENTO_NOTA_CREDITO_PROVEEDOR = {
  /** Id del conector en SIESA, tal como está en la pantalla "Apis Dinámicas". */
  idDocumento: "258496",
  nombreDocumento: "DEVOLUCIONES_DEV_CARNES_final",

  /** Código del tipo de documento de la nota crédito (f350_id_tipo_docto). */
  tipoDocto: "CDP",
  /** Unidad de negocio del movimiento: la misma de la CEA (003 = Carnes). */
  unidadNegocio: DOCUMENTO_CARNES.unidadNegocio,
  /** Decimales de la moneda para el valor, igual que la CEA. */
  decimalesValor: DOCUMENTO_CARNES.decimalesValor,
};

/**
 * Qué falta para poder mandar la nota crédito a proveedor, dicho para una
 * persona. `null` si está todo. Mismo patrón que `bloqueoAjusteFaltante()`.
 *
 * Recibe la configuración (por defecto la de este archivo) para que el armador
 * puro y los tests puedan probar el caso "configurado" sin tocar la constante.
 */
export function bloqueoNotaCreditoProveedor(config = DOCUMENTO_NOTA_CREDITO_PROVEEDOR) {
  const faltan = ["idDocumento", "nombreDocumento", "tipoDocto"].filter(
    (k) => !String(config?.[k] ?? "").trim(),
  );
  if (!faltan.length) return null;
  return (
    "Conector de nota crédito no configurado: falta " +
    faltan.map((k) => `${k} (src/config/siesa.js → DOCUMENTO_NOTA_CREDITO_PROVEEDOR)`).join(", ") +
    ". La devolución a un proveedor sale como nota crédito aparte de la entrada (la entrada lleva " +
    "lo facturado completo) y hace falta que el negocio cree ese conector en SIESA; mientras " +
    "tanto la nota crédito queda pendiente."
  );
}

/**
 * Con qué tercero puede entrar la entrada oficial.
 *
 * Según cómo se compró el ganado, la entrada va al frigorífico o a la cuenta de
 * proveedores varios de carnes. Lo elige el ADMIN al enviar —el sistema no
 * puede deducirlo de los datos de la recepción— y queda guardado en la
 * liquidación.
 *
 * La entrada INICIAL no elige: sale sola al cerrar la recepción, cuando todavía
 * no hay liquidación ni quién decida. Usa el del frigorífico y, si estuviera
 * mal, la oficial la corrige — que es justamente para lo que la inicial se
 * anula.
 */
export const TERCEROS_CARNES = [
  {
    id: "frigorifico",
    nit: "70329554",
    sucursal: "001",
    etiqueta: "Julio Arboleda Sierra",
    descripcion: "El frigorífico que firma el informe de desposte.",
  },
  {
    id: "varios",
    nit: "PVARIOS-CARNES",
    sucursal: "001",
    etiqueta: "Proveedores varios — Carnes",
    descripcion: "Cuando la compra no va a nombre del frigorífico.",
  },
];

/** El tercero por `id`, o el primero (frigorífico) si no se especifica. */
export function terceroCarnes(id) {
  return TERCEROS_CARNES.find((x) => x.id === id) || TERCEROS_CARNES[0];
}

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

/**
 * Lo que va adentro del documento. Se pasa a `armarEntradaDirecta`.
 *
 * `terceroId` cambia el NIT y la sucursal; el resto es igual para toda entrada
 * de carnes. Sin argumento sale el frigorífico, que es el caso de la inicial.
 */
export function documentoSiesa(terceroId) {
  const tercero = terceroCarnes(terceroId);
  return { ...DOCUMENTO_CARNES, nit: tercero.nit, sucursal: tercero.sucursal };
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

/**
 * `CARNES_SIESA_VISCERAS_AL_CIERRE=true` manda las vísceras de res a SIESA al
 * cerrar la recepción (un CEI por recepción, tipo `visceras_recepcion`, sql/025)
 * en vez de esperar al ajuste consolidado de la liquidación.
 *
 * Apagado por defecto, y TAMBIÉN necesita `CARNES_SIESA_ACTIVO`: el CEI se
 * contabiliza al importarse y es una entrada de inventario, así que no se
 * prende por accidente. Apagado, todo funciona como antes.
 */
export function viscerasAlCierre() {
  return String(process.env.CARNES_SIESA_VISCERAS_AL_CIERRE || "").toLowerCase() === "true";
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
