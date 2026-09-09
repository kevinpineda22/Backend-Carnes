/**
 * Recepción del PDF que sube el admin.
 *
 * `memoryStorage` y no disco: en Vercel esto corre como función serverless y el
 * sistema de archivos es efímero y compartido entre invocaciones. El buffer va
 * directo a Supabase Storage sin tocar el disco en ningún momento.
 */

import multer from "multer";
import { MAX_BYTES } from "../services/pdf.service.js";
import { createError } from "./errorHandler.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Filtro barato y temprano por el tipo declarado. NO es la validación real:
    // el `Content-Type` lo elige quien sube el archivo, así que el chequeo que
    // vale es el de la firma `%PDF-` en `pdf.service.js`, ya con los bytes en la
    // mano. Éste solo evita cargar 10 MB de video en memoria para descartarlos
    // después.
    if (file.mimetype === "application/pdf") return cb(null, true);
    cb(createError(400, "Solo se aceptan archivos PDF."));
  },
});

const unico = upload.single("archivo");

/**
 * Envuelve a multer para que sus errores salgan con el mismo formato que el
 * resto de la API. Sin esto, pasarse de tamaño devuelve un 500 con
 * "MulterError: File too large", que no le dice nada a quien está mirando.
 */
export function subirPDF(req, res, next) {
  unico(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return next(createError(413, `El PDF supera los ${MAX_BYTES / 1024 / 1024} MB.`));
    }
    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      return next(createError(400, "El archivo tiene que ir en el campo `archivo`."));
    }
    next(error.statusCode ? error : createError(400, error.message));
  });
}
