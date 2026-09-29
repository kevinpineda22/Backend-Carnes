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
 *
 * ─── Vísceras: van, con su propia unidad y SIN prorratear ─────────────────
 *
 * Desde `sql/016_visceras_siesa.sql`, nueve de las once vísceras de res tienen
 * código de SIESA (ver `shared/visceras.js`). Van al documento igual que un
 * producto, con tres diferencias:
 *
 *   · su UNIDAD_MEDIDA es la del renglón (`item.unidad`), no la fija de la
 *     configuración — Lengua es UND, el resto KL.
 *   · su precio es SIEMPRE `costo_base`, en la inicial y en la oficial: no
 *     existe `costo_ajustado` para una víscera porque no se prorratea (no
 *     entra en el costo teórico de `calcularCosteo`).
 *   · sin código (Vísceras, Entrañita hoy) NO se manda y NO bloquea el resto
 *     del documento — a diferencia de un producto sin homologar, que si
 *     bloquea. Ver `vaASiesa` en `shared/visceras.js`.
 */
import {
  esProducto,
  tieneCodigoSiesa,
  vaASiesa,
  ajustarCantidadAUnidad,
  decimalesDeUnidad,
} from "./visceras.js";

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
 * La forma legible si entra en los 12 caracteres de `PENDIENTE`; si no, la
 * compacta. Nunca se corta la legible: cortarla se come dígitos del número y
 * dos recepciones distintas terminarían con la misma referencia en SIESA.
 */
function ajustarReferencia(legible, compacta) {
  return legible.length <= LARGO_REFERENCIA ? legible : compacta.slice(0, LARGO_REFERENCIA);
}

/**
 * Referencia propia de un envío: `TC INI R23` / `TC OFI R23`.
 *
 * TC = Taller de Carnes. Tiene que caber en 12 caracteres y leerse en SIESA sin
 * un diccionario al lado. Entra legible hasta la recepción #9999; de ahí en
 * adelante pasa a `TCIR12345`.
 *
 * Antes del 28/09/2026 el formato era `R23I` / `R23O`. Esas referencias siguen
 * en la base tal cual —se leen de cada envío, nunca se recalculan con esta
 * función—, así que el correo de anulación sigue nombrando el documento que
 * existe de verdad en SIESA.
 */
export function referenciaEnvio(recepcionId, tipo) {
  const corto = tipo === TIPO_ENVIO.OFICIAL ? "OFI" : "INI";
  return ajustarReferencia(`TC ${corto} R${recepcionId}`, `TC${corto[0]}R${recepcionId}`);
}

/**
 * Referencia de la oficial consolidada de una liquidación: `TC OFI L12`.
 *
 * `L` y no `R` para que en SIESA se distinga a simple vista de las oficiales
 * viejas por sede, que quedan en el historial. Antes del 28/09/2026: `L12O`.
 */
export function referenciaLiquidacion(liquidacionId) {
  return ajustarReferencia(`TC OFI L${liquidacionId}`, `TCOL${liquidacionId}`);
}

/** `f350_notas` es texto largo, pero no infinito: se acota por las dudas. */
const LARGO_NOTAS = 255;

/**
 * Notas del documento, legibles para quien lo abre en SIESA:
 * "TALLER DE CARNES - ENTRADA INICIAL - RECEPCION #23 Lopez - TC INI R23".
 *
 * Hoy el conector tiene `f350_notas` FIJO y las ignora (ver el comentario en
 * `armarEntradaDirecta`); el día que lo pasen a variable, esto aparece solo.
 */
function notasDocumento(nota, detalle, referencia) {
  return [nota, detalle, referencia].filter(Boolean).join(" - ").slice(0, LARGO_NOTAS);
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
 * Renglones que van a SIESA: productos (con o sin código — sin código
 * BLOQUEA, ver abajo) y vísceras CON código, todos con cantidad > 0.
 *
 * Una víscera sin código se descarta acá mismo, en silencio: `vaASiesa`
 * decide eso. Lo que queda tras este filtro es exactamente lo que sale en
 * `Movimientos`.
 */
const VA_A_SIESA = (i) => vaASiesa(i);

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

  // Sin código bloquea: un producto sin homologar no puede entrar al ERP. Las
  // vísceras no viajan nunca (`vaASiesa`), así que no cuentan acá.
  const sinCodigo = items.filter(
    (i) => esProducto(i) && (Number(i.cantidad) || 0) > 0 && !tieneCodigoSiesa(i),
  );
  if (sinCodigo.length) {
    bloqueos.push(
      `${sinCodigo.length} renglón(es) sin código de SIESA: ` +
        sinCodigo.map((i) => i.descripcion).join(", ") +
        ". Homologalos antes de enviar.",
    );
  }

  const renglones = items.filter(VA_A_SIESA);
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

  // Oficial con TODOS los PRODUCTOS al costo de lista: el factor de la
  // liquidación no se aplicó (costo teórico en cero, o un costeo que no
  // escribió). No existe una compra real donde lo pagado coincida al peso con
  // la lista en cada corte, así que no se manda: subiría como "liquidada" una
  // entrada que es la inicial con otro nombre.
  //
  // Solo productos: las vísceras SIEMPRE están "al costo de lista" (no se
  // prorratean), así que si entraran acá, una recepción con solo dos vísceras
  // y ningún producto bloquearía la entrada oficial sin que el factor tenga
  // nada que ver.
  const productosRenglones = renglones.filter(esProducto);
  if (
    tipo === TIPO_ENVIO.OFICIAL &&
    productosRenglones.length > 0 &&
    sinCosteo.length === 0 &&
    productosRenglones.every((i) => Number(i.costo_ajustado) === Number(i.costo_base))
  ) {
    bloqueos.push(
      "El costo liquidado es igual al costo base en todos los renglones: el factor de " +
        "la liquidación no se aplicó. Revisá los gastos y volvé a costear.",
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
    NOTAS: notasDocumento(
      NOTA[tipo] ?? "TALLER DE CARNES",
      `RECEPCION #${recepcion?.id} ${sede.nombre ?? ""}`.trim(),
      referencia,
    ),
  };

  // ─── Movimientos ───
  //
  // `VALOR_BRUTO` es el TOTAL del renglón (cantidad × precio), sin impuestos.
  // Si SIESA lo esperara unitario, es esta línea y solo esta.
  let totalKilos = 0;
  let totalValor = 0;
  const movimientos = renglones.map((i, n) => {
    // Con unidad propia (vísceras: UND o KL) la cantidad se lleva a los
    // decimales que SIESA acepta para esa unidad, y el valor se calcula
    // sobre ESA cantidad: si no, SIESA recibiría 2,66 UND valorizadas como 2,667.
    const cantidad = i.unidad
      ? ajustarCantidadAUnidad(i.cantidad, i.unidad)
      : Number(i.cantidad) || 0;
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
      // Del renglón si lo trae (Lengua es UND, el resto de vísceras KL); si no
      // —todo lo que es carne/adicional— la fija de la configuración.
      UNIDAD_MEDIDA: String(i.unidad || config.unidadMedida || ""),
      CANTIDAD: decimal(
        cantidad,
        i.unidad ? decimalesDeUnidad(i.unidad) : config.decimalesCantidad,
      ),
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

/**
 * La oficial CONSOLIDADA: una sola CEA con los renglones de todas las sedes de
 * la liquidación.
 *
 * La cabecera de la CEA no tiene nada de la sede —tipo, fecha, NIT, sucursal,
 * notas—; la bodega y el CO viajan en cada movimiento. Así que se arma cada
 * sede con `armarEntradaDirecta` (mismas reglas: códigos, costo ajustado, costo
 * base, bodega, CO) y se juntan los movimientos bajo una cabecera.
 *
 * Todo o nada: si una sede tiene un bloqueo, no sale el documento. Es el precio
 * de que sea uno solo, y es lo que pidió contabilidad.
 *
 * La fecha es UNA: todas las recepciones de una liquidación llegan el mismo
 * día. Si no, se bloquea en vez de elegir una fecha por las otras.
 *
 * @param {object} p
 * @param {number} p.liquidacionId
 * @param {Array}  p.recepciones  filas de `carnes_recepciones` con `sede` e `items`
 * @param {number} p.consecutivo
 * @param {object} p.config
 * @returns {{ payload: object, resumen: object, bloqueos: string[], porSede: object[] }}
 */
export function armarEntradaLiquidacion({ liquidacionId, recepciones = [], consecutivo, config = {} }) {
  const bloqueos = [];
  const referencia = referenciaLiquidacion(liquidacionId);
  const tipoDocto = String(config.tipoDocto ?? "").trim();
  const consec = String(consecutivo ?? "");

  if (recepciones.length === 0) {
    bloqueos.push("La liquidación no tiene recepciones.");
  }

  // Lo que falta en la configuración es igual para todas las sedes: se dice una
  // vez, no nueve.
  const faltantes = ["tipoDocto", "nit", "sucursal", "unidadMedida", "unidadNegocio"].filter(
    (k) => !String(config[k] ?? "").trim(),
  );
  if (faltantes.length) {
    bloqueos.push(`Falta configurar en SIESA: ${faltantes.join(", ")}.`);
  }

  const porSede = recepciones.map((recepcion) => {
    const armado = armarEntradaDirecta({
      recepcion,
      items: recepcion.items || [],
      tipo: TIPO_ENVIO.OFICIAL,
      consecutivo,
      config,
    });
    return {
      recepcion_id: recepcion.id,
      sede: recepcion.sede?.nombre ?? null,
      fecha: recepcion.fecha_ingreso ?? null,
      movimientos: armado.payload.Movimientos,
      resumen: armado.resumen,
      // La de configuración ya se dijo arriba.
      bloqueos: armado.bloqueos.filter((b) => !b.startsWith("Falta configurar en SIESA")),
    };
  });

  for (const s of porSede) {
    for (const b of s.bloqueos) bloqueos.push(`${s.sede ?? `Recepción #${s.recepcion_id}`}: ${b}`);
  }

  const fechas = [...new Set(porSede.map((s) => fechaSiesa(s.fecha)).filter(Boolean))];
  if (fechas.length > 1) {
    bloqueos.push(
      `Las recepciones tienen fechas distintas (${fechas.join(", ")}). La CEA lleva una sola ` +
        "fecha: revisá la fecha de ingreso de cada recepción.",
    );
  }
  // Sin ninguna fecha, cada sede ya lo dijo en su bloqueo.
  const fecha = fechas.length === 1 ? fechas[0] : null;

  // Movimientos de todas las sedes, numerados de corrido: `NRO_REGISTRO` es la
  // posición dentro del documento, no dentro de la sede.
  const movimientos = porSede
    .flatMap((s) => s.movimientos)
    .map((m, n) => ({ ...m, NRO_DOCTO: consec, NRO_REGISTRO: String(n + 1) }));

  const documento = {
    TIPO_DOCTO: tipoDocto,
    CONSECUTIVO_DOCTO: consec,
    FECHA: fecha ?? "",
    NIT: String(config.nit ?? "").trim(),
    SUCURSAL: String(config.sucursal ?? "").trim(),
    // Una CEA de nueve sedes no puede apuntar a nueve iniciales en un campo de
    // 12 caracteres: lleva su propia referencia, y el correo a quien anula las
    // lista todas.
    PENDIENTE: referencia,
    NOTAS: notasDocumento(NOTA[TIPO_ENVIO.OFICIAL], `LIQUIDACION #${liquidacionId}`, referencia),
  };

  const totalKilos = porSede.reduce((a, s) => a + s.resumen.totalKilos, 0);
  const totalValor = porSede.reduce((a, s) => a + s.resumen.totalValor, 0);

  return {
    payload: { Documentos: [documento], Movimientos: movimientos },
    resumen: {
      tipo: TIPO_ENVIO.OFICIAL,
      referencia,
      referenciaInicial: null,
      renglones: movimientos.length,
      sedes: porSede.length,
      totalKilos: Math.round(totalKilos * 1000) / 1000,
      totalValor: Math.round(totalValor * 100) / 100,
      fecha,
    },
    bloqueos,
    porSede: porSede.map(({ movimientos: _m, ...s }) => s),
  };
}
