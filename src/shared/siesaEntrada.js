/**
 * Armado del documento ENTRADA_DIRECTA_ALMACEN para el conector de SIESA.
 *
 * Módulo PURO, como `costeo.js`: entra una recepción con sus renglones y la
 * configuración, sale el JSON que espera el conector. No hace HTTP, no toca la
 * base. Por eso se puede testear contra la recepción real de López sin tener
 * las credenciales de SIESA a mano.
 *
 * ─── Las dos entradas ─────────────────────────────────────────────────────
 *
 * Cada recepción va DOS veces a SIESA, y las dos quedan "en elaboración":
 *
 *   INICIAL  cuando el recibidor cierra. Precio = costo base de la plantilla.
 *            Sirve para que inventario vea que la carne llegó, mientras llega
 *            la factura. Alguien la ANULA en SIESA cuando sale la oficial.
 *   OFICIAL  cuando el admin costea la liquidación. Precio = costo ajustado
 *            por el factor. Es la que se aprueba.
 *
 * Las notas dicen cuál es cuál, y la oficial lleva en `PENDIENTE` (documento
 * de referencia) la referencia de la inicial, para que quien anula sepa qué
 * anular sin buscar.
 *
 * ─── Lo que el conector tiene FIJO y lo que espera VARIABLE ───────────────
 *
 * En la configuración del conector (pantallazos del 21/09) hay valores fijos
 * que NO viajan en el JSON: compañía 001, CO del documento 001, clase 408,
 * concepto 401, grupo 403, comprador 901150440, moneda COP, estado 0
 * (elaboración), consecutivo automático. Acá se arman solo las variables.
 *
 * ─── Sobre el consecutivo ─────────────────────────────────────────────────
 *
 * `F_CONSEC_AUTO_REG = 1`: SIESA recalcula el consecutivo al importar. El que
 * se manda acá es un número propio para que Documentos y Movimientos se
 * enlacen entre sí en el mismo envío — no es el número que va a tener el
 * documento en SIESA. Por eso la referencia cruzada entre inicial y oficial
 * va por `PENDIENTE` y por las notas, que sí viajan tal cual.
 */

/** Los dos tipos de envío, y cómo se leen en SIESA. */
export const TIPO_ENVIO = {
  INICIAL: "inicial",
  OFICIAL: "oficial",
};

const NOTA = {
  [TIPO_ENVIO.INICIAL]: "TALLER DE CARNES - ENTRADA INICIAL",
  [TIPO_ENVIO.OFICIAL]: "TALLER DE CARNES - ENTRADA OFICIAL",
};

/** `PENDIENTE` (f451_num_docto_referencia) admite 12 caracteres. */
const LARGO_REFERENCIA = 12;

/**
 * Referencia propia de un envío: `R23I` / `R23O`.
 *
 * Corta a propósito: tiene que caber en 12 caracteres junto con lo que sea que
 * se quiera agregar después, y tiene que poder buscarse en SIESA a ojo.
 */
export function referenciaEnvio(recepcionId, tipo) {
  const sufijo = tipo === TIPO_ENVIO.OFICIAL ? "O" : "I";
  return `R${recepcionId}${sufijo}`.slice(0, LARGO_REFERENCIA);
}

/** `2026-09-16` → `20260916`. El plano pide AAAAMMDD. */
export function fechaSiesa(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

/**
 * Centro de operación del movimiento, en el formato del plano (3 caracteres).
 *
 * `carnes_sedes.codigo_co` guarda "01".."08"; el plano pide "001". Se rellena
 * con ceros a la izquierda. Si SIESA usara otro código para el CO de la sede,
 * se cambia acá y en ningún otro lado.
 */
export function coMovimiento(codigoCo) {
  const limpio = String(codigoCo ?? "").trim();
  if (!limpio) return null;
  return limpio.padStart(3, "0").slice(-3);
}

/**
 * Número con N decimales exactos, como string. Sin separador de miles.
 *
 * La cantidad de decimales la manda SIESA, no el ancho del campo del plano: el
 * valor tiene que traer los de la moneda y la cantidad los de la unidad de
 * medida. Ver `decimalesValor` / `decimalesCantidad` en config/siesa.js.
 */
const decimal = (n, decimales) => {
  const d = Number.isInteger(decimales) ? decimales : 2;
  const f = 10 ** d;
  return (Math.round((Number(n) || 0) * f) / f).toFixed(d);
};

/**
 * Renglones que van a SIESA: carne y adicionales CON código, con cantidad > 0.
 *
 * Las vísceras no van: hoy el catálogo no tiene código de ítem. Si algún día
 * lo tiene, se saca este filtro y listo.
 */
const VA_A_SIESA = (i) =>
  (i.tipo === "carne" || i.tipo === "adicional") && (Number(i.cantidad) || 0) > 0;

/**
 * Arma el JSON del conector.
 *
 * @param {object} p
 * @param {object} p.recepcion   fila de `carnes_recepciones` con `sede`
 * @param {Array}  p.items       renglones de la recepción
 * @param {string} p.tipo        TIPO_ENVIO.INICIAL | TIPO_ENVIO.OFICIAL
 * @param {number} p.consecutivo número propio, enlaza cabecera y movimientos
 * @param {object} p.config      { tipoDocto, nit, sucursal, unidadMedida, unidadNegocio }
 * @param {string} [p.referenciaInicial] en la oficial: la referencia de la inicial
 * @returns {{ payload: object, resumen: object, bloqueos: string[] }}
 */
export function armarEntradaDirecta({
  recepcion,
  items = [],
  tipo,
  consecutivo,
  config = {},
  referenciaInicial,
}) {
  const bloqueos = [];
  const sede = recepcion?.sede || {};

  // ─── Lo que tiene que estar, o no se manda ───
  const faltantes = ["tipoDocto", "nit", "sucursal", "unidadMedida", "unidadNegocio"].filter(
    (k) => !String(config[k] ?? "").trim(),
  );
  if (faltantes.length) {
    bloqueos.push(`Falta configurar en SIESA: ${faltantes.join(", ")}.`);
  }
  if (!sede.bodega_siesa) {
    bloqueos.push(`La sede "${sede.nombre ?? recepcion?.sede_id}" no tiene bodega de SIESA configurada.`);
  }
  const co = coMovimiento(sede.codigo_co);
  if (!co) {
    bloqueos.push(`La sede "${sede.nombre ?? recepcion?.sede_id}" no tiene centro de operación.`);
  }
  const fecha = fechaSiesa(recepcion?.fecha_ingreso);
  if (!fecha) bloqueos.push("La recepción no tiene fecha de ingreso.");

  const renglones = items.filter(VA_A_SIESA);
  const sinCodigo = renglones.filter((i) => !String(i.codigo_item ?? "").trim());
  if (sinCodigo.length) {
    bloqueos.push(
      `${sinCodigo.length} renglón(es) sin código de SIESA: ` +
        sinCodigo.map((i) => i.descripcion).join(", ") +
        ". Homologalos antes de enviar.",
    );
  }
  if (renglones.length === 0) bloqueos.push("La recepción no tiene renglones con cantidad.");

  // ─── El precio depende del tipo de entrada ───
  //
  // Inicial: costo base (lo que dice la plantilla). Oficial: costo ajustado por
  // el factor de la liquidación. Si se pide la oficial y el renglón no tiene
  // costo ajustado, es que la liquidación no se costeó: se bloquea, no se
  // manda el precio de lista como si fuera el real.
  const precioDe = (i) => {
    if (tipo === TIPO_ENVIO.OFICIAL) {
      if (i.costo_ajustado === null || i.costo_ajustado === undefined) return null;
      return Number(i.costo_ajustado);
    }
    return Number(i.costo_base) || 0;
  };
  const sinCosteo = renglones.filter((i) => precioDe(i) === null);
  if (sinCosteo.length) {
    bloqueos.push(
      "La entrada oficial necesita el costo ajustado y hay renglones sin costear. " +
        "Costeá la liquidación primero.",
    );
  }

  const referencia = referenciaEnvio(recepcion?.id, tipo);
  const tipoDocto = String(config.tipoDocto ?? "").trim();
  const consec = String(consecutivo ?? "");

  // ─── Documentos ───
  //
  // `PENDIENTE` es el documento de referencia (12 chars). En la oficial apunta a
  // la inicial, que es lo que quien anula necesita leer. En la inicial lleva su
  // propia referencia, para que aparezca en SIESA y se pueda buscar.
  //
  // `NOTAS` NO está entre las variables del conector tal como quedó configurado
  // (f350_notas está fijo en "TALLER DE CARNES"). Se manda igual: si en el
  // conector cambian f350_notas de fijo a variable NOTAS, las dos entradas
  // quedan distinguibles a simple vista. Si no lo cambian, el conector ignora
  // la clave y no pasa nada.
  const documento = {
    TIPO_DOCTO: tipoDocto,
    CONSECUTIVO_DOCTO: consec,
    FECHA: fecha ?? "",
    NIT: String(config.nit ?? "").trim(),
    SUCURSAL: String(config.sucursal ?? "").trim(),
    PENDIENTE: (tipo === TIPO_ENVIO.OFICIAL && referenciaInicial ? referenciaInicial : referencia).slice(
      0,
      LARGO_REFERENCIA,
    ),
    NOTAS: `${NOTA[tipo] ?? "TALLER DE CARNES"} ${referencia}`,
  };

  // ─── Movimientos ───
  //
  // `VALOR_BRUTO` es el TOTAL del renglón (cantidad × precio), sin impuestos.
  // Si SIESA lo esperara unitario, es esta línea y solo esta.
  let totalKilos = 0;
  let totalValor = 0;
  const movimientos = renglones.map((i, n) => {
    const cantidad = Number(i.cantidad) || 0;
    const precio = precioDe(i) ?? 0;
    // Se redondea a los MISMOS decimales que se van a reportar: si se redondea
    // a 2 y se imprime con 4, los dos últimos son ceros inventados.
    const dv = Number.isInteger(config.decimalesValor) ? config.decimalesValor : 2;
    const bruto = Math.round(cantidad * precio * 10 ** dv) / 10 ** dv;
    totalKilos += cantidad;
    totalValor += bruto;
    return {
      TIPO_DOCTO: tipoDocto,
      NRO_DOCTO: consec,
      NRO_REGISTRO: String(n + 1),
      BODEGA: String(sede.bodega_siesa ?? ""),
      CO_MOVIMIENTO: co ?? "",
      UNIDAD_MEDIDA: String(config.unidadMedida ?? ""),
      CANTIDAD: decimal(cantidad, config.decimalesCantidad),
      VALOR_BRUTO: decimal(bruto, config.decimalesValor),
      ITEM: String(i.codigo_item ?? "").trim(),
      UNIDAD_NEGOCIO: String(config.unidadNegocio ?? ""),
    };
  });

  return {
    // `Descuentos` NO va, ni siquiera como arreglo vacío.
    //
    // El conector valida la sección apenas la clave existe: con `Descuentos: []`
    // respondió 400 "Error en la Estructura" y siete quejas pidiendo TIPO_DOCTO,
    // CONSECUTIVO_DOCTO, NRO_REGISTRO, ORDEN_DESCUENTO y VALOR_TOTAL "en la
    // sección Descuentos". Omitir la clave es lo que significa "esta entrada no
    // tiene descuentos" — y no los tiene: el factor de la liquidación ya viene
    // aplicado en el precio de cada renglón.
    payload: {
      Documentos: [documento],
      Movimientos: movimientos,
    },
    resumen: {
      tipo,
      referencia,
      referenciaInicial: tipo === TIPO_ENVIO.OFICIAL ? (referenciaInicial ?? null) : null,
      renglones: movimientos.length,
      totalKilos: Math.round(totalKilos * 1000) / 1000,
      totalValor: Math.round(totalValor * 100) / 100,
      sede: sede.nombre ?? null,
      fecha: recepcion?.fecha_ingreso ?? null,
    },
    bloqueos,
  };
}
