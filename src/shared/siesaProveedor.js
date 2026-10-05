/**
 * Armado de los documentos de SIESA del Recibidor de Proveedores: la ENTRADA
 * (CEA, conector 256783) y la NOTA CRÉDITO de lo devuelto.
 *
 * Módulo PURO, como `siesaEntrada.js`: entra una recepción con sus renglones y
 * la configuración, salen el JSON del conector y los bloqueos. No hace HTTP ni
 * toca la base. Reusa de `siesaEntrada.js` lo que es igual para toda CEA (fecha,
 * centro de operación, decimales, notas, ajuste de la referencia).
 *
 * ─── Dos documentos, dos cantidades ────────────────────────────────────────
 *
 *   ENTRADA        lleva la cantidad y el valor FACTURADOS completos: es lo que
 *                  dice la factura física del proveedor. Una devolución NO se
 *                  resta acá.
 *   NOTA CRÉDITO   lleva SOLO lo devuelto (cantidad devuelta y su valor
 *                  proporcional, `valorDevuelto`). Va después de que la entrada
 *                  quedó ok. Su conector todavía no existe: mientras
 *                  `DOCUMENTO_NOTA_CREDITO_PROVEEDOR` tenga `idDocumento` en
 *                  null, el armador devuelve un bloqueo explícito.
 *
 * ─── Quién es el tercero ───────────────────────────────────────────────────
 *
 * El proveedor de la recepción: NIT + sucursal de la FOTO que guarda la cabecera
 * (`proveedor_nit`, `proveedor_sucursal`), no del maestro ni de
 * `DOCUMENTO_CARNES.nit` (ese es el del frigorífico de Talleres). La bodega y el
 * CO también salen de la foto de la recepción (`bodega_siesa`, `codigo_co`).
 *
 * ─── Dónde va la factura ───────────────────────────────────────────────────
 *
 * `PENDIENTE` (documento de referencia, 12 caracteres) lleva la factura del
 * proveedor, porque contabilidad busca en SIESA por ese número. Si el admin
 * corrigió la referencia para SIESA, `factura_siesa` manda sobre `factura`. Una
 * factura de más de 12 caracteres NO se recorta jamás —dos facturas distintas
 * terminarían con la misma referencia—: se bloquea el envío y se dice cómo
 * arreglarlo. Nuestra referencia interna (`TC PRV R{n}`) va PRIMERO en las
 * `NOTAS`, para que el corte de 255 caracteres nunca se la coma.
 *
 * ─── Sin Descuentos, sin IVA ───────────────────────────────────────────────
 *
 * El valor es bruto (sin IVA ni descuentos, decisión del negocio) y la clave
 * `Descuentos` NO viaja ni como arreglo vacío: el conector valida la sección
 * apenas la clave existe y responde 400 (ver `armarEntradaDirecta`).
 *
 * ─── Consecutivo ───────────────────────────────────────────────────────────
 *
 * Igual que en las otras CEA: `F_CONSEC_AUTO_REG = 1`, SIESA recalcula el número
 * al importar; el que se manda es propio, solo para enlazar Documentos y
 * Movimientos dentro del MISMO JSON. `id × 10 + 4` (entrada) y `id × 10 + 6`
 * (nota crédito) no chocan entre sí para una recepción. Los ids de talleres y de
 * proveedor son series distintas, así que el mismo número puede repetirse con un
 * envío de talleres; no importa, porque ninguna tabla ni índice usa el
 * consecutivo como llave. Cabe en 8 dígitos hasta la recepción #99999999.
 */
import { bloqueoNotaCreditoProveedor } from "../config/siesa.js";
import { ajustarCantidadAUnidad, decimalesDeUnidad } from "./visceras.js";
import { ajustarReferencia, coMovimiento, decimal, fechaSiesa, notasDocumento } from "./siesaEntrada.js";
import {
  LARGO_FACTURA_SIESA,
  facturaCabeEnSiesa,
  normalizarUnidad,
  validarRecepcion,
  valorDevuelto,
} from "./proveedorValores.js";

/** Los dos tipos de envío de proveedor (columna `tipo`, VARCHAR(20): ≤ 20 caracteres). */
export const TIPO_ENVIO_PROVEEDOR = {
  ENTRADA: "entrada_proveedor",
  NOTA_CREDITO: "nc_proveedor",
};

/** La razón social va al final de las notas y acotada: nunca desplaza la referencia. */
const LARGO_RAZON_SOCIAL_NOTAS = 120;

// ─── Referencias y consecutivos ────────────────────────────────────────────

/**
 * Referencia propia de la entrada: `TC PRV R12` (TC = Taller de Carnes, PRV =
 * proveedor, R = recepción). Es la que se guarda en `carnes_siesa_envios.referencia`
 * (12 caracteres). Legible hasta la recepción #9999; de ahí en adelante pasa a
 * `TCPR12345`. Nunca se corta la legible.
 */
export function referenciaProveedor(recepcionId) {
  return ajustarReferencia(`TC PRV R${recepcionId}`, `TCPR${recepcionId}`);
}

/**
 * Referencia de la nota crédito: `TC PRV N12` (N = nota crédito). Misma regla:
 * legible hasta la #9999, luego `TCPN12345`.
 */
export function referenciaNotaCreditoProveedor(recepcionId) {
  return ajustarReferencia(`TC PRV N${recepcionId}`, `TCPN${recepcionId}`);
}

/** Consecutivo propio de la entrada: `id × 10 + 4`. */
export const consecutivoEntradaProveedor = (recepcionId) => Number(recepcionId) * 10 + 4;

/** Consecutivo propio de la nota crédito: `id × 10 + 6`. */
export const consecutivoNotaCreditoProveedor = (recepcionId) => Number(recepcionId) * 10 + 6;

// ─── Piezas comunes ────────────────────────────────────────────────────────

/** Nombre con el que se nombra un renglón en un mensaje: equivalencia, si no la descripción de SIESA, si no el código. */
function nombreRenglon(item) {
  return (
    String(item?.equivalencia ?? "").trim() ||
    String(item?.descripcion_item ?? "").trim() ||
    String(item?.codigo_item ?? "").trim() ||
    `#${item?.id ?? "?"}`
  );
}

/** Los errores de `validarRecepcion`, dichos con el nombre del renglón. */
function bloqueosDeValidacion(items) {
  const { errores, generales } = validarRecepcion(items);
  const porId = new Map(items.map((i) => [i?.id ?? null, i]));
  const bloqueos = [...generales];
  for (const e of errores) {
    const nombre = nombreRenglon(porId.get(e.item_id));
    for (const m of e.mensajes) bloqueos.push(`Renglón "${nombre}": ${m}`);
  }
  return bloqueos;
}

/**
 * La factura tal como va en `PENDIENTE`: la corregida para SIESA si existe, si
 * no la original. Devuelve el bloqueo si no cabe (vacía o más de 12): NUNCA se
 * recorta.
 */
function pendienteDe(recepcion) {
  const corregida = String(recepcion?.factura_siesa ?? "").trim();
  const pendiente = corregida || String(recepcion?.factura ?? "").trim();
  if (facturaCabeEnSiesa(pendiente)) return { pendiente, bloqueo: null };
  if (!pendiente) return { pendiente, bloqueo: "La recepción no tiene factura." };
  return {
    pendiente,
    bloqueo:
      `La factura "${pendiente}" tiene ${pendiente.length} caracteres y la referencia de SIESA admite ` +
      `${LARGO_FACTURA_SIESA}. No se recorta: un administrador tiene que corregir la referencia para ` +
      "SIESA en la recepción y reintentar el envío.",
  };
}

/**
 * Lo que tiene que tener la recepción para que el documento se pueda armar,
 * igual para la entrada y la nota crédito. Devuelve los bloqueos y los valores
 * ya resueltos (CO, fecha, PENDIENTE).
 */
function baseDeProveedor(recepcion) {
  const bloqueos = [];
  const nombreSede = recepcion?.sede?.nombre ?? recepcion?.sede_id;

  if (!String(recepcion?.proveedor_nit ?? "").trim()) bloqueos.push("La recepción no tiene el NIT del proveedor.");
  if (!String(recepcion?.bodega_siesa ?? "").trim()) {
    bloqueos.push(`La sede "${nombreSede}" no tiene bodega de SIESA configurada.`);
  }
  const co = coMovimiento(recepcion?.codigo_co);
  if (!co) bloqueos.push(`La sede "${nombreSede}" no tiene centro de operación.`);
  const fecha = fechaSiesa(recepcion?.fecha_recepcion);
  if (!fecha) bloqueos.push("La recepción no tiene fecha de recepción.");

  const { pendiente, bloqueo } = pendienteDe(recepcion);
  if (bloqueo) bloqueos.push(bloqueo);

  return { bloqueos, co, fecha, pendiente, sede: recepcion?.sede?.nombre ?? "" };
}

/** Cabecera común: el tercero es el proveedor (foto de la recepción). */
function armarDocumento({ recepcion, tipoDocto, consec, fecha, pendiente, notas }) {
  return {
    TIPO_DOCTO: tipoDocto,
    CONSECUTIVO_DOCTO: consec,
    FECHA: fecha ?? "",
    NIT: String(recepcion?.proveedor_nit ?? "").trim(),
    SUCURSAL: String(recepcion?.proveedor_sucursal ?? "").trim(),
    // Sin `.slice`: si no cabe, ya hay un bloqueo y el documento no sale.
    PENDIENTE: pendiente,
    NOTAS: notas,
  };
}

/**
 * Un movimiento por renglón. La cantidad se lleva a los decimales de SU unidad
 * (UND 2, KL 3) con la MISMA función con que se guardó, así lo guardado, lo
 * mostrado y lo enviado coinciden. El valor ya viene en pesos enteros.
 */
function armarMovimiento({ recepcion, config, consec, co, tipoDocto, n, unidad, cantidad, valor, item }) {
  // La moneda no tiene centavos en este sistema: sin decimales configurados se
  // manda en 0, nunca en 2 (SIESA rechaza un valor con más decimales que la moneda).
  const dv = Number.isInteger(config.decimalesValor) ? config.decimalesValor : 0;
  return {
    TIPO_DOCTO: tipoDocto,
    NRO_DOCTO: consec,
    NRO_REGISTRO: String(n + 1),
    BODEGA: String(recepcion?.bodega_siesa ?? "").trim(),
    CO_MOVIMIENTO: co ?? "",
    UNIDAD_MEDIDA: unidad,
    CANTIDAD: decimal(cantidad, decimalesDeUnidad(unidad)),
    VALOR_BRUTO: decimal(valor, dv),
    ITEM: String(item?.codigo_item ?? "").trim(),
    UNIDAD_NEGOCIO: String(config.unidadNegocio ?? ""),
  };
}

/** Kilos (solo renglones en KL), unidades (solo UND) y valor de una lista de movimientos de proveedor. */
function totalesDe(filas) {
  let totalKilos = 0;
  let totalUnidades = 0;
  let totalValor = 0;
  for (const f of filas) {
    if (f.unidad === "KL") totalKilos += f.cantidad;
    else totalUnidades += f.cantidad;
    totalValor += f.valor;
  }
  return {
    totalKilos: Math.round(totalKilos * 1000) / 1000,
    totalUnidades: Math.round(totalUnidades * 100) / 100,
    totalValor: Math.round(totalValor),
  };
}

const razonSocialDe = (recepcion) =>
  String(recepcion?.proveedor_razon_social ?? "").trim().slice(0, LARGO_RAZON_SOCIAL_NOTAS);

// ─── La entrada ────────────────────────────────────────────────────────────

/**
 * Arma la ENTRADA (CEA) de una recepción de proveedor.
 *
 * Primero vuelve a correr `validarRecepcion` entera: lo que se firmó pudo
 * cambiar de reglas, o una fila se pudo editar a mano en la base. Cualquier error
 * de renglón (unidad que no es KL/UND, sin código de item, sin valor, 800 KL sin
 * confirmar, valor fuera de rango sin confirmar…) es un bloqueo.
 *
 * Van TODOS los renglones con cantidad > 0, con o sin equivalencia: la
 * "equivalencia" es solo el nombre que ve el recibidor, no cambia el ITEM de SIESA.
 * Cada uno con su unidad (KL o UND).
 *
 * @param {object} p
 * @param {object} p.recepcion    cabecera de `carnes_proveedor_recepciones`: id, proveedor_nit,
 *                                proveedor_sucursal, proveedor_razon_social, factura, factura_siesa,
 *                                bodega_siesa, codigo_co, fecha_recepcion, y `sede { nombre }`
 * @param {Array}  p.items        renglones de `carnes_proveedor_recepcion_items`
 * @param {number} [p.consecutivo] número propio; por defecto `id × 10 + 4`
 * @param {object} p.config       { tipoDocto, unidadNegocio, decimalesValor } (`DOCUMENTO_CARNES`)
 * @returns {{ payload: object, resumen: object, bloqueos: string[] }}
 */
export function armarEntradaProveedor({ recepcion, items = [], consecutivo, config = {} }) {
  const base = baseDeProveedor(recepcion);
  const bloqueos = [...base.bloqueos, ...bloqueosDeValidacion(items)];

  // El tercero no se configura: es el proveedor. Lo que sí tiene que estar es lo
  // propio del documento.
  const faltantes = ["tipoDocto", "unidadNegocio"].filter((k) => !String(config[k] ?? "").trim());
  if (faltantes.length) bloqueos.push(`Falta configurar en SIESA: ${faltantes.join(", ")}.`);

  const referencia = referenciaProveedor(recepcion?.id);
  const tipoDocto = String(config.tipoDocto ?? "").trim();
  const consec = String(consecutivo ?? consecutivoEntradaProveedor(recepcion?.id));

  // Solo lo recibido. Una fila en 0 no viaja (y `validarRecepcion` no le exige nada).
  const filas = items
    .filter((i) => (Number(i?.cantidad) || 0) > 0)
    .map((item) => {
      const unidad = normalizarUnidad(item.unidad);
      return {
        item,
        unidad,
        cantidad: ajustarCantidadAUnidad(item.cantidad, unidad),
        valor: Number(item.valor_total) || 0,
      };
    });

  const movimientos = filas.map((f, n) =>
    armarMovimiento({ recepcion, config, consec, co: base.co, tipoDocto, n, ...f }),
  );

  const documento = armarDocumento({
    recepcion,
    tipoDocto,
    consec,
    fecha: base.fecha,
    pendiente: base.pendiente,
    // La referencia propia PRIMERO: el corte de 255 caracteres nunca se la come.
    notas: notasDocumento(
      referencia,
      `RECIBO PROVEEDOR FACT ${base.pendiente} ${base.sede}`.trim(),
      razonSocialDe(recepcion),
    ),
  });

  return {
    // `Descuentos` NO va, ni siquiera vacío (ver el encabezado del módulo).
    payload: { Documentos: [documento], Movimientos: movimientos },
    resumen: {
      tipo: TIPO_ENVIO_PROVEEDOR.ENTRADA,
      referencia,
      pendiente: base.pendiente,
      renglones: movimientos.length,
      ...totalesDe(filas),
      sede: recepcion?.sede?.nombre ?? null,
      fecha: recepcion?.fecha_recepcion ?? null,
    },
    bloqueos,
  };
}

// ─── La nota crédito ───────────────────────────────────────────────────────

/**
 * Arma la NOTA CRÉDITO con SOLO lo devuelto: los renglones con
 * `cantidad_devuelta` > 0, su cantidad devuelta y su valor proporcional
 * (`valorDevuelto`, calculado: no hay columna que pueda quedar vieja).
 *
 * El conector todavía no existe. Mientras `config.idDocumento`, `nombreDocumento`
 * o `tipoDocto` falten, el armador devuelve el bloqueo
 * `bloqueoNotaCreditoProveedor` (más los demás que correspondan, para que quien
 * lo lea vea todo junto) y la nota crédito no sale.
 *
 * El JSON es PROVISIONAL: copia la forma de la CEA (Documentos + Movimientos, sin
 * Descuentos) con la factura del proveedor en `PENDIENTE`, y nombra la entrada
 * (`TC PRV R{n}`) en las notas para que quien la lea en SIESA sepa de cuál viene.
 * Cuando el conector exista, este es el único lugar que se ajusta.
 *
 * @param {object} p
 * @param {object} p.recepcion     igual que en `armarEntradaProveedor`
 * @param {Array}  p.items
 * @param {number} [p.consecutivo] por defecto `id × 10 + 6`
 * @param {object} p.config        `DOCUMENTO_NOTA_CREDITO_PROVEEDOR`
 * @returns {{ payload: object, resumen: object, bloqueos: string[] }}
 */
export function armarNotaCreditoProveedor({ recepcion, items = [], consecutivo, config = {} }) {
  const base = baseDeProveedor(recepcion);
  const bloqueos = [];

  // Primero y con el texto del config: es lo que explica por qué está pendiente.
  const sinConector = bloqueoNotaCreditoProveedor(config);
  if (sinConector) bloqueos.push(sinConector);
  bloqueos.push(...base.bloqueos, ...bloqueosDeValidacion(items));
  if (!String(config.unidadNegocio ?? "").trim()) bloqueos.push("Falta configurar en SIESA: unidadNegocio.");

  const referencia = referenciaNotaCreditoProveedor(recepcion?.id);
  const referenciaEntrada = referenciaProveedor(recepcion?.id);
  const tipoDocto = String(config.tipoDocto ?? "").trim();
  const consec = String(consecutivo ?? consecutivoNotaCreditoProveedor(recepcion?.id));

  const devueltos = items.filter((i) => (Number(i?.cantidad) || 0) > 0 && (Number(i?.cantidad_devuelta) || 0) > 0);
  if (devueltos.length === 0) bloqueos.push("La recepción no tiene renglones devueltos.");

  const filas = devueltos.map((item) => {
    const unidad = normalizarUnidad(item.unidad);
    return {
      item,
      unidad,
      cantidad: ajustarCantidadAUnidad(item.cantidad_devuelta, unidad),
      valor: valorDevuelto(item),
    };
  });

  // El conector 258258 tiene el tipo de documento FIJO (CDP) en Documentos y en
  // Movimientos: si `TIPO_DOCTO` viaja, SIESA responde 400 "Error en la
  // Estructura… el campo 'TIPO_DOCTO' no está definido". `config.tipoDocto` se
  // conserva solo para rotular el envío.
  const movimientos = filas.map((f, n) => {
    const { TIPO_DOCTO: _fijo, ...movimiento } = armarMovimiento({
      recepcion, config, consec, co: base.co, tipoDocto, n, ...f,
    });
    return movimiento;
  });

  // El conector de devoluciones (258258) llama `DOCTO_REFERENCIA` a lo que la
  // CEA llama `PENDIENTE`: es el mismo campo de SIESA (f451_num_docto_referencia).
  const { PENDIENTE: doctoReferencia, TIPO_DOCTO: _fijoDoc, ...cabecera } = armarDocumento({
    recepcion,
    tipoDocto,
    consec,
    fecha: base.fecha,
    pendiente: base.pendiente,
    notas: notasDocumento(
      referencia,
      `DEVOLUCION PROVEEDOR FACT ${base.pendiente} ${base.sede} ENTRADA ${referenciaEntrada}`.trim(),
      razonSocialDe(recepcion),
    ),
  });
  const documento = { ...cabecera, DOCTO_REFERENCIA: doctoReferencia };

  return {
    payload: { Documentos: [documento], Movimientos: movimientos },
    resumen: {
      tipo: TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO,
      referencia,
      referenciaEntrada,
      pendiente: base.pendiente,
      renglones: movimientos.length,
      ...totalesDe(filas),
      sede: recepcion?.sede?.nombre ?? null,
      fecha: recepcion?.fecha_recepcion ?? null,
    },
    bloqueos,
  };
}
