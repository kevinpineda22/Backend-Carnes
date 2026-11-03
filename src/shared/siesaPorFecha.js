/**
 * Decisiones puras de los documentos de SIESA que salen UNO POR FECHA DE INGRESO
 * (sql/033): la entrada oficial y el ajuste de vísceras de una liquidación.
 *
 * Una liquidación puede agrupar recepciones de días distintos. SIESA no admite
 * postear carne en un día en que no existía, así que cada fecha es su propio
 * documento, y cada documento es su propia fila de `carnes_siesa_envios`, con
 * `fecha_docto` (la columna de sql/033).
 *
 * Acá no hay base de datos ni red: dado lo que se armaría hoy (`documentos`) y lo
 * que ya hay guardado (`filas`), se decide qué falta mandar, qué estorba y si la
 * liquidación se puede cerrar. El modelo (`SiesaEnvio.model.js`) hace el I/O.
 */

import { fechaSiesa } from "./siesaEntrada.js";

/** Estados que ocupan el lugar del documento (el candado de sql/010, 012 y 033). */
export const ESTADOS_VIGENTES_DOC = ["enviando", "ok", "sin_confirmar"];

const mismosIds = (a = [], b = []) => {
  const x = [...a].map(Number).sort((m, n) => m - n);
  const y = [...b].map(Number).sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Cruza lo que se armaría hoy con lo que ya está guardado.
 *
 * Cada documento armado (uno por fecha) queda en uno de estos casos:
 *
 *   sin envío vigente   `pendiente`: hay que mandarlo.
 *   con envío vigente   el estado de ese envío (`ok`, `enviando`, `sin_confirmar`).
 *
 * El envío de una fecha es la fila vigente con ESA `fecha_docto`. Las filas de
 * antes de sql/033 tienen `fecha_docto` NULL y eran UN solo documento con todas
 * las recepciones: mientras una siga vigente cubre todas las fechas que no tengan
 * su propia fila (`deLegado`), igual que antes. Así una liquidación ya enviada
 * como consolidada no se vuelve a mandar por fechas.
 *
 * Además detecta dos cosas que hay que frenar a mano, porque duplicarían carne:
 *
 *   huerfanos    filas vigentes con una fecha que hoy no corresponde a ningún
 *                documento (se cambió la fecha de ingreso de una recepción o se
 *                la desvinculó después de enviar).
 *   desfasados   filas vigentes cuya fecha sí existe pero que salieron con otras
 *                recepciones que las de hoy (se vinculó una recepción de ese
 *                día después de enviar). Las del consolidado viejo solo fallan
 *                si les falta alguna recepción de hoy de esa fecha (puede
 *                sobrar: se desvinculó después). Esta última comparación va
 *                siempre; la de igualdad exacta, solo con `comparaRecepciones`.
 *
 * @param {object} p
 * @param {Array<{ fecha: string|null, recepcion_ids?: number[] }>} p.documentos
 *        lo que se armaría hoy, uno por fecha (AAAAMMDD)
 * @param {Array<object>} p.filas  envíos guardados del mismo tipo y liquidación,
 *        con `estado`, `fecha_docto` (date ISO o null) y `recepcion_ids`
 * @param {boolean} [p.comparaRecepciones]  también marcar `desfasados`
 */
export function planearDocumentosPorFecha({ documentos = [], filas = [], comparaRecepciones = true }) {
  const vigentes = filas.filter((f) => ESTADOS_VIGENTES_DOC.includes(f.estado));
  const legado = vigentes.find((f) => !f.fecha_docto) || null;
  const propias = vigentes.filter((f) => f.fecha_docto);
  const fechasDeHoy = new Set(documentos.map((d) => d.fecha));

  const items = documentos.map((documento) => {
    const propio = propias.find((f) => fechaSiesa(f.fecha_docto) === documento.fecha) || null;
    const envio = propio ?? legado;
    return {
      fecha: documento.fecha,
      documento,
      envio,
      deLegado: !propio && Boolean(legado),
      estado: envio ? envio.estado : "pendiente",
    };
  });

  const huerfanos = propias.filter((f) => !fechasDeHoy.has(fechaSiesa(f.fecha_docto)));
  // Las recepciones del documento de hoy: en la oficial vienen en el documento; en
  // las vísceras, dentro de su `armado`.
  const idsDe = (i) => i.documento.recepcion_ids ?? i.documento.armado?.recepcion_ids;
  const tieneIds = (i) => i.envio && Array.isArray(i.envio.recepcion_ids) && Array.isArray(idsDe(i));
  const desfasados = items.filter((i) => {
    if (!tieneIds(i)) return false;
    // El consolidado de antes cubre una fecha solo si trae TODAS las recepciones
    // de hoy de esa fecha: una vinculada después de enviarlo no está en SIESA y
    // cerrar la liquidación la marcaría enviada sin haberla mandado.
    if (i.deLegado) {
      const cubre = new Set(i.envio.recepcion_ids.map(Number));
      return !idsDe(i).every((id) => cubre.has(Number(id)));
    }
    return comparaRecepciones && !mismosIds(i.envio.recepcion_ids, idsDe(i));
  });

  const pendientes = items.filter((i) => !i.envio);
  const enCurso = items.filter((i) => i.envio && i.envio.estado !== "ok");
  const listos = items.filter((i) => i.envio?.estado === "ok");

  return {
    items,
    pendientes,
    enCurso,
    listos,
    huerfanos,
    desfasados,
    /** Todos los documentos están en SIESA (y hay al menos uno). */
    todosOk: items.length > 0 && listos.length === items.length,
    /** Algunos ya entraron y otros faltan: el envío parcial. */
    parcial: listos.length > 0 && listos.length < items.length,
  };
}

/**
 * Referencias de documentos POR MANDAR que repiten la de otro documento de la
 * misma liquidación (el pendiente de al lado o uno que ya tiene envío). La
 * referencia es lo que una persona busca en SIESA para encontrar o anular un
 * documento: dos documentos distintos no pueden compartirla.
 *
 * @param {Array} items  `planearDocumentosPorFecha(...).items`, con
 *   `documento.resumen.referencia` o `documento.armado.resumen.referencia`
 * @returns {string[]}  referencias repetidas (sin duplicar)
 */
export function referenciasEnConflicto(items = []) {
  const ref = (i) =>
    i.envio ? i.envio.referencia : (i.documento.resumen ?? i.documento.armado?.resumen)?.referencia;
  const todas = items.map(ref);
  return [
    ...new Set(
      items.filter((i) => !i.envio && todas.filter((r) => r === ref(i)).length > 1).map(ref),
    ),
  ];
}

/**
 * ¿Los envíos vigentes de la oficial cubren TODAS las recepciones de la
 * liquidación y están ok? Es lo que habilita el correo de anulación de las
 * iniciales: avisar con la mitad de las fechas en SIESA haría anular carne que
 * todavía no entró en su versión oficial.
 *
 * Funciona igual con el consolidado de antes de sql/033 (una fila que cubre todo)
 * y con las filas por fecha.
 *
 * @param {Array<object>} filas  envíos oficiales vigentes de la liquidación
 * @param {number[]} ids         recepciones de la liquidación
 */
export function oficialCompleta(filas = [], ids = []) {
  const vigentes = filas.filter((f) => ESTADOS_VIGENTES_DOC.includes(f.estado));
  if (!vigentes.length || vigentes.some((f) => f.estado !== "ok")) return false;
  const cubiertas = new Set(vigentes.flatMap((f) => (f.recepcion_ids || []).map(Number)));
  return ids.length > 0 && ids.every((id) => cubiertas.has(Number(id)));
}

/**
 * Qué pasó al mandar los documentos pendientes de la oficial y qué se hace con
 * la liquidación.
 *
 * La liquidación se cierra SOLO si todos los documentos están ok (los que ya
 * estaban de antes cuentan). Si alguno falló, quedó sin confirmar, sigue enviándose
 * o no se alcanzó a mandar, queda como estaba y la respuesta dice cuáles.
 *
 * @param {Array<{ fecha: string|null, referencia: string, estado: string,
 *   error?: string|null, repetido?: boolean }>} resultados
 *   uno por documento, en orden de fecha. `estado`: ok | error | sin_confirmar |
 *   enviando | pendiente (no se intentó).
 * @returns {{ cerrar: boolean, representante: object|null, error: string|null,
 *   ok: object[], fallidos: object[] }}
 *   `representante`: el que el front muestra como "el envío" (el primero que no
 *   quedó ok; si todos, el primero). `error`: texto para una persona, o null.
 */
export function decidirCierreOficial(resultados = []) {
  const ok = resultados.filter((r) => r.estado === "ok");
  const fallidos = resultados.filter((r) => r.estado !== "ok");
  const cerrar = resultados.length > 0 && fallidos.length === 0;
  const representante = fallidos[0] ?? resultados[0] ?? null;

  let error = null;
  if (fallidos.length) {
    const motivo = (r) => {
      if (r.estado === "pendiente") return `${r.referencia} (${r.fecha ?? "sin fecha"}): quedó pendiente de enviar`;
      if (r.estado === "enviando") return `${r.referencia} (${r.fecha ?? "sin fecha"}): se está enviando`;
      if (r.estado === "sin_confirmar") {
        return `${r.referencia} (${r.fecha ?? "sin fecha"}): quedó sin confirmar, verificala en SIESA`;
      }
      return `${r.referencia} (${r.fecha ?? "sin fecha"}): ${r.error || "SIESA no la recibió"}`;
    };
    // Con un solo documento el texto es el de siempre: solo el error de SIESA.
    error =
      resultados.length === 1
        ? (fallidos[0].error ?? null)
        : `La liquidación no se cerró: ${ok.length} de ${resultados.length} documentos entraron a SIESA. ` +
          `Faltan: ${fallidos.map(motivo).join("; ")}.` +
          (ok.length ? ` Ya entraron: ${ok.map((r) => r.referencia).join(", ")}. Volvé a enviar: solo se mandan los que faltan.` : "");
  }
  return { cerrar, representante, error, ok, fallidos };
}
