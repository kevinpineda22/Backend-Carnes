/**
 * Armado del documento AJUSTE_INV_VISCERAS (CEI) para el conector de SIESA.
 *
 * Módulo PURO, como `siesaEntrada.js`: entra una recepción con sus renglones y
 * la configuración, sale el JSON que espera el conector. Sin HTTP, sin base.
 *
 * ─── Por qué existe ───────────────────────────────────────────────────────
 *
 * Las vísceras NO van en la CEA (`vaASiesa` en `visceras.js`): la CEA es la
 * factura y solo lleva cortes. El inventario de vísceras entra por un ajuste de
 * inventario aparte, después de que la entrada oficial ya está en SIESA.
 *
 * ─── Un documento por LIQUIDACIÓN ─────────────────────────────────────────
 *
 * Primero fue un documento por sede, y el 30/09/2026 la quinta sede (#16 Villa
 * Hermosa) volvió con 400 "Item sin cantidad disponible": el CEI es una ENTRADA
 * de inventario, y con cuatro sedes ya anuladas en SIESA el saldo de la bodega
 * no alcanzaba para ese ítem. El negocio decidió UN documento con todas las
 * sedes, como la CEA consolidada, y la BODEGA de la cabecera VACÍA: la bodega y
 * el CO de cada sede viajan en cada movimiento.
 *
 * `armarAjusteVisceras` sigue armando UNA recepción —es la lógica de renglones—
 * y `armarAjusteViscerasLiquidacion` junta las sedes en un solo documento, todo
 * o nada: si una sede tiene un bloqueo, no sale el documento.
 *
 * ─── Lo que el conector tiene FIJO y lo que espera VARIABLE ───────────────
 *
 * Fijo en SIESA (no viaja): compañía 001, CO del documento 001, tipo CEI,
 * consecutivo automático, clase 61 (entrada), concepto 601, motivo 04, notas y
 * estado 1 = Aprobado/Contabilizado. Variables:
 *
 *   Documentos   CONSECUTIVO_DOCTO, FECHA_DOCTO (AAAAMMDD), BODEGA
 *   Movimientos  NRO_DOCTO, NRO_REGISTRO, "C.O.", BODEGA, "C.O MOVIMIENTO",
 *                UNIDAD_MEDIDA, CANTIDAD, COSTO_PROMEDIO, ITEM, UNIDAD_NEGOCIO
 *
 * CONSECUTIVO_DOCTO / NRO_DOCTO / NRO_REGISTRO: aunque el consecutivo es
 * automático, el plano exige f350_consec_docto, f470_consec_docto y
 * f470_nro_registro. El primer envío (29/09/2026) volvió con 400 "el campo
 * obligatorio … no fue enviado". Se mandan con los MISMOS nombres de variable
 * que usa el conector de la CEA; SIESA recalcula el consecutivo. Si el
 * conector todavía no tiene mapeadas esas variables, las ignora.
 *
 * Las claves "C.O." y "C.O MOVIMIENTO" llevan punto y espacio TAL CUAL: así las
 * define el conector. No se normalizan.
 *
 * ─── Cantidad y costo ─────────────────────────────────────────────────────
 *
 * CANTIDAD lleva los decimales de la unidad (KL 3, UND 2 truncado, igual que la
 * CEA). COSTO_PROMEDIO es el costo UNITARIO —no el total del renglón— con los
 * decimales de la moneda. Es el `costo_base` del renglón (el precio del catálogo
 * copiado al abrir la recepción): las vísceras no se prorratean, no hay costo
 * ajustado.
 *
 * ─── Sin código no se manda, y no bloquea ─────────────────────────────────
 *
 * Vísceras y Entrañita no tienen código de SIESA: se omiten en silencio, como
 * en `vaASiesa` cuando las vísceras iban en la CEA. Se devuelven en
 * `resumen.sinCodigo` para que la pantalla pueda decirlo.
 */
import {
  esVicera,
  tieneCodigoSiesa,
  ajustarCantidadAUnidad,
  decimalesDeUnidad,
} from "./visceras.js";
import { coMovimiento, fechaSiesa } from "./siesaEntrada.js";

/** El `tipo` de envío en `carnes_siesa_envios`. */
export const TIPO_AJUSTE_VISCERAS = "ajuste_visceras";

/** `f350_num_docto_referencia` admite 12 caracteres, y la tabla, VARCHAR(12). */
const LARGO_REFERENCIA = 12;

/**
 * Referencia propia del ajuste: `TC VIS R23`.
 *
 * TC = Taller de Carnes, VIS = vísceras. Entra legible hasta la recepción
 * #9999; de ahí pasa a `TCVR12345`. Igual que `referenciaEnvio`: nunca se corta
 * la forma legible, porque cortarla se come dígitos y dos recepciones distintas
 * terminarían con la misma referencia.
 *
 * Ojo: el conector NO tiene una variable para la referencia (las notas son
 * fijas), así que vive solo en `carnes_siesa_envios`, no en el documento.
 */
export function referenciaAjusteVisceras(recepcionId) {
  const legible = `TC VIS R${recepcionId}`;
  return legible.length <= LARGO_REFERENCIA
    ? legible
    : `TCVR${recepcionId}`.slice(0, LARGO_REFERENCIA);
}

/** Número con N decimales exactos, como string. Sin separador de miles. */
const decimal = (n, decimales) => {
  const d = Number.isInteger(decimales) ? decimales : 0;
  const f = 10 ** d;
  return (Math.round((Number(n) || 0) * f) / f).toFixed(d);
};

/**
 * Arma el ajuste de vísceras de UNA recepción.
 *
 * @param {object} p
 * @param {object} p.recepcion  fila de `carnes_recepciones` con `sede`
 * @param {Array}  p.items      renglones de la recepción (se filtran acá)
 * @param {object} p.config     { coDocumento, unidadNegocio, decimalesValor }
 * @returns {{
 *   payload: object,
 *   resumen: object,
 *   renglones: object[],
 *   bloqueos: string[],
 *   vacio: boolean,
 * }}
 *   `vacio`: no hay ninguna víscera para ajustar. No es un bloqueo: no hay nada
 *   que corregir, simplemente esta sede no genera documento.
 */
export function armarAjusteVisceras({ recepcion, items = [], config = {}, consecutivo }) {
  const bloqueos = [];
  const sede = recepcion?.sede || {};
  const dv = Number.isInteger(config.decimalesValor) ? config.decimalesValor : 0;
  const nombreSede = sede.nombre ?? recepcion?.sede_id ?? `#${recepcion?.id}`;

  const viceras = items.filter(esVicera);

  // Sin código: no viaja. Solo se avisa si traía cantidad (una sin cantidad no
  // es noticia).
  const sinCodigo = viceras
    .filter((i) => !tieneCodigoSiesa(i) && (Number(i.cantidad) || 0) > 0)
    .map((i) => i.descripcion);

  // Con código y con cantidad. La cantidad se mide DESPUÉS de llevarla a los
  // decimales de su unidad: 0,004 UND queda en 0,00 y SIESA no acepta renglones
  // en cero.
  const candidatas = viceras
    .filter(tieneCodigoSiesa)
    .map((i) => {
      const unidad = String(i.unidad || "KL");
      return { item: i, unidad, cantidad: ajustarCantidadAUnidad(i.cantidad, unidad) };
    })
    .filter((c) => c.cantidad > 0);

  const vacio = candidatas.length === 0;

  // El costo se redondea a los decimales de la moneda ANTES de valorizar: el
  // valor es lo que SIESA va a calcular con el costo que recibe.
  const renglones = candidatas.map(({ item, unidad, cantidad }) => {
    const costo = Math.round((Number(item.costo_base) || 0) * 10 ** dv) / 10 ** dv;
    return {
      descripcion: item.descripcion ?? null,
      codigo_item: String(item.codigo_item).trim(),
      unidad,
      cantidad,
      costo_unitario: costo,
      valor: Math.round(cantidad * costo * 100) / 100,
    };
  });

  // ─── Lo que tiene que estar, o no se manda ───
  //
  // Con la sede sin nada que ajustar no hay documento y estos datos no importan:
  // no se bloquea por ellos.
  const co = coMovimiento(sede.codigo_co);
  const fecha = fechaSiesa(recepcion?.fecha_ingreso);
  const bodega = String(sede.bodega_siesa ?? "").trim();
  if (!vacio) {
    const faltantes = ["coDocumento", "unidadNegocio"].filter(
      (k) => !String(config[k] ?? "").trim(),
    );
    if (faltantes.length) bloqueos.push(`Falta configurar en SIESA: ${faltantes.join(", ")}.`);
    if (!bodega) bloqueos.push(`La sede "${nombreSede}" no tiene bodega de SIESA configurada.`);
    if (!co) bloqueos.push(`La sede "${nombreSede}" no tiene centro de operación.`);
    if (!fecha) bloqueos.push("La recepción no tiene fecha de ingreso.");

    // Un costo unitario en cero se rechaza en SIESA y, peor, dejaría el
    // inventario valorizado en $0 en un documento ya contabilizado.
    const sinCosto = renglones.filter((r) => !(r.costo_unitario > 0));
    if (sinCosto.length) {
      bloqueos.push(
        `${sinCosto.length} víscera(s) sin costo: ` +
          sinCosto.map((r) => r.descripcion).join(", ") +
          ". Cargá el precio en la plantilla de vísceras antes de enviar.",
      );
    }
  }

  const referencia = referenciaAjusteVisceras(recepcion?.id);
  // Mismo esquema que `consecutivoDe` de la CEA (id × 10 + 1 inicial, + 2
  // oficial): + 3 para el ajuste. Es solo para que el campo viaje; con el
  // consecutivo automático, SIESA asigna el número real.
  const consec = String(consecutivo ?? Number(recepcion?.id) * 10 + 3);

  const movimientos = renglones.map((r, n) => ({
    NRO_DOCTO: consec,
    NRO_REGISTRO: String(n + 1),
    "C.O.": String(config.coDocumento ?? ""),
    BODEGA: bodega,
    "C.O MOVIMIENTO": co ?? "",
    UNIDAD_MEDIDA: r.unidad,
    CANTIDAD: decimal(r.cantidad, decimalesDeUnidad(r.unidad)),
    COSTO_PROMEDIO: decimal(r.costo_unitario, dv),
    ITEM: r.codigo_item,
    UNIDAD_NEGOCIO: String(config.unidadNegocio ?? ""),
  }));

  const totalValor = renglones.reduce((a, r) => a + r.valor, 0);
  const totalKilos = renglones.reduce((a, r) => a + (r.unidad === "KL" ? r.cantidad : 0), 0);

  return {
    payload: {
      Documentos: [{ CONSECUTIVO_DOCTO: consec, FECHA_DOCTO: fecha ?? "", BODEGA: bodega }],
      Movimientos: movimientos,
    },
    resumen: {
      tipo: TIPO_AJUSTE_VISCERAS,
      referencia,
      renglones: movimientos.length,
      // Solo lo que se pesa: 2 UND de lengua no son kilos.
      totalKilos: Math.round(totalKilos * 1000) / 1000,
      totalValor: Math.round(totalValor * 100) / 100,
      sede: sede.nombre ?? null,
      fecha: recepcion?.fecha_ingreso ?? null,
      sinCodigo,
    },
    renglones,
    bloqueos,
    vacio,
  };
}

// ─── Con qué se cruza el ajuste: la entrada oficial que ya está en SIESA ────

/**
 * Qué recepciones cubre una entrada oficial que ya está en SIESA, y con qué
 * documento.
 *
 * La consolidada cubre SOLO las recepciones con las que salió (`recepcion_ids`,
 * tal como estaban al mandarla): una recepción vinculada a la liquidación
 * DESPUÉS de la CEA no está en SIESA, y su ajuste entraría vísceras de una
 * carne que nunca entró. Las oficiales por sede del esquema anterior cubren la
 * recepción exacta a la que pertenecen.
 *
 * @param {object} p
 * @param {number[]} p.ids  recepciones de la liquidación
 * @param {object|null} p.consolidada  fila de la CEA consolidada vigente (o null)
 * @param {Array} p.porSede  filas de oficiales por sede en `ok` ({recepcion_id, payload})
 * @returns {Map<number, {payload: object|null}>}  recepción → CEA que la cubre
 */
export function coberturaOficial({ ids = [], consolidada = null, porSede = [] }) {
  const cubiertas = new Map();
  if (consolidada?.estado === "ok") {
    const cubre = new Set((consolidada.recepcion_ids || []).map(Number));
    for (const id of ids) {
      if (cubre.has(Number(id))) cubiertas.set(id, { payload: consolidada.payload ?? null });
    }
  }
  for (const e of porSede) {
    const id = ids.find((x) => Number(x) === Number(e.recepcion_id));
    if (id !== undefined && !cubiertas.has(id)) cubiertas.set(id, { payload: e.payload ?? null });
  }
  return cubiertas;
}

/** Diferencia de cantidad que se tolera al reconocer una víscera ya enviada. */
const TOLERANCIA_CANTIDAD = 0.005;

/**
 * Las vísceras de esta recepción que una CEA YA trae en su payload.
 *
 * Las CEA anteriores al 29/09/2026 mandaban las vísceras como un renglón más.
 * Si una de esas es la oficial ok que cubre la sede, el ajuste las entraría
 * dos veces, y contabilizado. Se busca en los movimientos guardados de ESA CEA.
 *
 * ¿Por qué no basta el código? Porque varios cortes comparten código con una
 * víscera (15187 lo tienen FALDITA, PUNTA DE FALDA, ENTRAÑITAS y PUNTA
 * ESPALDILLA): con solo el ITEM, la CEA de la liquidación 10 —que trae solo
 * cortes— bloquearía a todas las sedes. Un renglón es la víscera cuando
 * coinciden ITEM, la BODEGA de la sede y la CANTIDAD (con la que se guardó y con
 * la que se mandaría hoy, que difieren en los Riñones UND: 5,333 contra 5,33).
 *
 * @param {{payload: object|null, items?: Array, bodega?: string}} p
 * @returns {string[]}  descripciones de las vísceras que ya van en la CEA
 */
export function viscerasEnCea({ payload, items = [], bodega = "" }) {
  const movimientos = payload?.Movimientos;
  if (!Array.isArray(movimientos) || movimientos.length === 0) return [];
  const bodegaSede = String(bodega ?? "").trim();

  const yaEnviadas = [];
  for (const i of items.filter((x) => esVicera(x) && tieneCodigoSiesa(x))) {
    const codigo = String(i.codigo_item).trim();
    const cruda = Number(i.cantidad) || 0;
    if (cruda <= 0) continue;
    const candidatas = [cruda, ajustarCantidadAUnidad(cruda, i.unidad || "KL")];
    const esta = movimientos.some(
      (m) =>
        String(m.ITEM ?? "").trim() === codigo &&
        (!bodegaSede || String(m.BODEGA ?? "").trim() === bodegaSede) &&
        candidatas.some((c) => Math.abs((Number(m.CANTIDAD) || 0) - c) <= TOLERANCIA_CANTIDAD),
    );
    if (esta) yaEnviadas.push(i.descripcion ?? codigo);
  }
  return yaEnviadas;
}

// ─── Cuánto tiempo hay para mandar la siguiente sede ────────────────────────

/**
 * La función de Vercel vive 300 s (el default de Fluid compute; en vercel.json
 * NO hay bloque `functions` a propósito: agregarlo rompió el enrutado). Se deja
 * un margen para responder: la última espera a SIESA tiene que terminar antes.
 */
export const LIMITE_FUNCION_MS = 285_000;
/** Pasado este tiempo no se arranca otra sede: queda para un segundo clic. */
export const PRESUPUESTO_NUEVA_SEDE_MS = 40_000;
/** Con menos espera que esta, un envío nuevo es más una apuesta que un intento. */
export const ESPERA_MINIMA_MS = 30_000;

/**
 * Cuánto puede esperar a SIESA la sede que está por salir, o null si ya no se
 * debe arrancar.
 *
 * @param {number} transcurridoMs  desde el INICIO del pedido (antes de previsualizar)
 * @param {number} maxEsperaMs     la espera normal de un envío (TIMEOUT_OFICIAL_MS)
 */
export function esperaParaSede(transcurridoMs, maxEsperaMs) {
  if (transcurridoMs > PRESUPUESTO_NUEVA_SEDE_MS) return null;
  const espera = Math.min(maxEsperaMs, LIMITE_FUNCION_MS - transcurridoMs);
  return espera < ESPERA_MINIMA_MS ? null : espera;
}

// ─── El documento consolidado de una liquidación ────────────────────────────

/**
 * Consecutivo propio del ajuste consolidado: `id × 10 + 4`.
 *
 * No choca con los de la CEA (`recepción × 10 + 1/2`, `liquidación × 10 + 3`, ver
 * `SiesaEnvio.model.js`). Con el consecutivo automático SIESA asigna el número
 * real; este es solo para que el campo viaje (el plano lo exige) y para que
 * cabecera y movimientos se enlacen. Cabe en 8 dígitos.
 */
export const consecutivoAjusteLiquidacion = (liquidacionId) => Number(liquidacionId) * 10 + 4;

/**
 * Referencia del ajuste consolidado: `TC VIS L10`.
 *
 * `L` y no `R`, para distinguirla en la lista de envíos de las viejas por sede
 * (`TC VIS R12`, que quedan como historial). Igual que las demás: entra legible
 * hasta la liquidación #9999 y de ahí pasa a `TCVL12345`, sin cortar dígitos.
 */
export function referenciaAjusteLiquidacion(liquidacionId) {
  const legible = `TC VIS L${liquidacionId}`;
  return legible.length <= LARGO_REFERENCIA
    ? legible
    : `TCVL${liquidacionId}`.slice(0, LARGO_REFERENCIA);
}

/**
 * Arma UN ajuste de vísceras con todas las sedes de la liquidación.
 *
 * Cabecera: `{ CONSECUTIVO_DOCTO, FECHA_DOCTO, BODEGA: "" }`. La bodega va vacía
 * porque el documento abarca varias; cada movimiento lleva la suya y el CO de su
 * sede. Los movimientos de todas las sedes se numeran de corrido: `NRO_REGISTRO`
 * es la posición dentro del documento, no dentro de la sede.
 *
 * La fecha es UNA, con la misma regla de la CEA consolidada: todas las
 * recepciones de una liquidación llegan el mismo día, y si no, se bloquea en vez
 * de elegir una por las otras. Cuentan solo las sedes que aportan renglones.
 *
 * Todo o nada: el bloqueo de UNA sede (sin bodega, sin CO, sin costo, sin fecha)
 * bloquea el documento entero. Una sede sin vísceras no aporta ni bloquea.
 *
 * @param {object} p
 * @param {number|string} p.liquidacionId
 * @param {Array}  p.recepciones  filas de `carnes_recepciones` con `sede` e `items`
 * @param {object} p.config       { coDocumento, unidadNegocio, decimalesValor }
 * @param {number} [p.consecutivo]
 * @returns {{
 *   payload: object, resumen: object, renglones: object[], bloqueos: string[],
 *   vacio: boolean, porSede: object[], recepcion_ids: number[],
 * }}
 */
export function armarAjusteViscerasLiquidacion({
  liquidacionId,
  recepciones = [],
  config = {},
  consecutivo,
}) {
  const bloqueos = [];
  const consec = String(consecutivo ?? consecutivoAjusteLiquidacion(liquidacionId));
  const referencia = referenciaAjusteLiquidacion(liquidacionId);

  if (recepciones.length === 0) bloqueos.push("La liquidación no tiene recepciones.");

  const porSede = recepciones.map((recepcion) => {
    const armado = armarAjusteVisceras({
      recepcion,
      items: recepcion.items || [],
      config,
      consecutivo: consec,
    });
    const sede = recepcion.sede?.nombre ?? null;
    return {
      recepcion_id: recepcion.id,
      sede,
      fecha: recepcion.fecha_ingreso ?? null,
      movimientos: armado.payload.Movimientos,
      renglones: armado.renglones,
      resumen: armado.resumen,
      // "Falta configurar" es igual para todas: se dice una vez, abajo.
      bloqueos: armado.bloqueos.filter((b) => !b.startsWith("Falta configurar en SIESA")),
      vacio: armado.vacio,
      faltaConfig: armado.bloqueos.find((b) => b.startsWith("Falta configurar en SIESA")),
    };
  });

  const faltaConfig = porSede.find((s) => s.faltaConfig)?.faltaConfig;
  if (faltaConfig) bloqueos.push(faltaConfig);

  // Un bloqueo de cualquier sede es del documento. Con el nombre de la sede si el
  // mensaje no lo trae ya.
  for (const s of porSede) {
    for (const b of s.bloqueos) {
      const nombre = s.sede ?? `Recepción #${s.recepcion_id}`;
      bloqueos.push(b.includes(nombre) ? b : `${nombre}: ${b}`);
    }
  }

  const aportan = porSede.filter((s) => !s.vacio);
  const fechas = [...new Set(aportan.map((s) => fechaSiesa(s.fecha)).filter(Boolean))];
  if (fechas.length > 1) {
    bloqueos.push(
      `Las recepciones tienen fechas distintas (${fechas.join(", ")}). El ajuste lleva una sola ` +
        "fecha: revisá la fecha de ingreso de cada recepción.",
    );
  }
  // Sin ninguna fecha, cada sede ya lo dijo en su bloqueo.
  const fecha = fechas.length === 1 ? fechas[0] : null;

  const movimientos = aportan
    .flatMap((s) => s.movimientos)
    .map((m, n) => ({ ...m, NRO_DOCTO: consec, NRO_REGISTRO: String(n + 1) }));

  const renglones = aportan.flatMap((s) =>
    s.renglones.map((r) => ({ ...r, recepcion_id: s.recepcion_id, sede: s.sede })),
  );

  const totalKilos = aportan.reduce((a, s) => a + s.resumen.totalKilos, 0);
  const totalValor = aportan.reduce((a, s) => a + s.resumen.totalValor, 0);
  const sinCodigo = [...new Set(porSede.flatMap((s) => s.resumen.sinCodigo || []))];

  return {
    payload: {
      Documentos: [{ CONSECUTIVO_DOCTO: consec, FECHA_DOCTO: fecha ?? "", BODEGA: "" }],
      Movimientos: movimientos,
    },
    resumen: {
      tipo: TIPO_AJUSTE_VISCERAS,
      referencia,
      renglones: movimientos.length,
      sedes: aportan.length,
      totalKilos: Math.round(totalKilos * 1000) / 1000,
      totalValor: Math.round(totalValor * 100) / 100,
      fecha,
      consecutivo: consec,
      sinCodigo,
    },
    renglones,
    bloqueos,
    vacio: movimientos.length === 0,
    recepcion_ids: aportan.map((s) => s.recepcion_id),
    porSede: porSede.map(({ movimientos: _m, faltaConfig: _f, ...s }) => s),
  };
}

/**
 * Los ajustes por SEDE del esquema anterior que todavía ocupan el lugar
 * (enviando, ok o sin_confirmar).
 *
 * Mientras alguno siga vigente no se manda el consolidado: esa víscera ya está en
 * SIESA en OTRO documento, contabilizado, y el consolidado la entraría dos veces.
 * Hay que registrar su anulación —después de anularlo en SIESA— antes.
 *
 * @param {Array} filas  envíos de ajuste con `recepcion_id` (las viejas por sede)
 * @param {Map<number,string>} [sedes]  recepcion_id → nombre de la sede
 * @returns {{ bloqueos: string[], vigentes: object[] }}
 */
export function guardaAjustesPorSede(filas = [], sedes = new Map()) {
  // Por recepción, para que el mensaje se lea en orden.
  const vigentes = filas
    .filter((f) => f.recepcion_id && ["enviando", "ok", "sin_confirmar"].includes(f.estado))
    .sort((a, b) => Number(a.recepcion_id) - Number(b.recepcion_id));
  if (!vigentes.length) return { bloqueos: [], vigentes };

  const detalle = (f) =>
    `${sedes.get(f.recepcion_id) ?? `Recepción #${f.recepcion_id}`} ` +
    `(${f.referencia}, ${f.estado === "ok" ? "en SIESA" : f.estado === "enviando" ? "enviándose" : "sin confirmar"})`;
  return {
    vigentes,
    bloqueos: [
      `Hay ajustes de vísceras por sede del esquema anterior todavía vigentes: ` +
        `${vigentes.map(detalle).join("; ")}. Mandar el ajuste de la liquidación entraría ` +
        "esas vísceras dos veces. Anulalos en SIESA y registrá la anulación de cada uno " +
        "(«Se anuló en SIESA») antes de enviar.",
    ],
  };
}
