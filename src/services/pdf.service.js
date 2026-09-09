/**
 * Extracción de texto de un PDF.
 *
 * Todo lo sucio de leer un PDF vive acá y solo acá: `shared/desposteParser.js`
 * recibe un string y no sabe que existe un archivo. Esa frontera es lo que
 * permite testear el parseo contra el informe real sin abrir un binario, y lo
 * que permitiría cambiar de librería sin tocar una sola regla de negocio.
 *
 * ─── Por qué `unpdf` ──────────────────────────────────────────────────────
 *
 * Es pdf.js empaquetado para servidor, sin dependencias nativas y sin worker.
 * `pdf-parse` —el otro candidato— es CommonJS y ejecuta un archivo de prueba al
 * importarse cuando no encuentra `module.parent`, cosa que pasa justamente en
 * ESM, que es como está escrito este backend. Y `pdfjs-dist` crudo necesita
 * configurar el worker, que en una función serverless de Vercel es un problema
 * de rutas que no vale la pena tener.
 */

import { createError } from "../middleware/errorHandler.js";

/** Los PDF del frigorífico pesan ~280 KB. 10 MB es holgado y acota el abuso. */
export const MAX_BYTES = 10 * 1024 * 1024;

/** `%PDF-` — los primeros bytes de todo PDF válido. */
const FIRMA_PDF = Buffer.from("%PDF-");

/**
 * ¿El buffer es realmente un PDF?
 *
 * Se mira el CONTENIDO, no la extensión ni el `Content-Type`: los dos los
 * elige quien sube el archivo. Un `.pdf` que en realidad es un Excel renombrado
 * se guardaría igual y fallaría recién al parsear, con un error incomprensible.
 */
export function esPDF(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, FIRMA_PDF.length).equals(FIRMA_PDF);
}

/**
 * Devuelve el texto plano de un PDF.
 *
 * `mergePages: true` concatena las páginas con un salto de línea. Hace falta:
 * en el informe de desposte el bloque de SUBPRODUCTOS está partido por el salto
 * de página, y procesar página por página cortaría la sección al medio.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{texto: string, paginas: number}>}
 */
export async function extraerTexto(buffer) {
  if (!esPDF(buffer)) {
    throw createError(400, "El archivo no es un PDF.");
  }
  if (buffer.length > MAX_BYTES) {
    throw createError(413, `El PDF supera los ${MAX_BYTES / 1024 / 1024} MB.`);
  }

  // `unpdf` se importa acá adentro y no arriba: pesa varios MB y solo hace falta
  // cuando alguien sube un informe. En una función serverless, cargarlo en cada
  // arranque en frío le sumaría tiempo a TODOS los endpoints, incluido el health
  // check que Vercel usa para saber si el backend está vivo.
  const { extractText, getDocumentProxy } = await import("unpdf");

  try {
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractText(doc, { mergePages: true });
    return { texto: String(text ?? ""), paginas: totalPages ?? 0 };
  } catch (error) {
    // El mensaje de pdf.js ("XRef parsing error", "Invalid PDF structure") no le
    // dice nada a quien está mirando la pantalla. Se traduce, y el original va
    // al log del servidor.
    console.error("🔴 No se pudo leer el PDF:", error.message);
    throw createError(
      400,
      "No se pudo leer el PDF. Puede estar dañado o protegido con contraseña.",
    );
  }
}
