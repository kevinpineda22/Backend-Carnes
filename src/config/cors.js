import cors from "cors";
import { createError } from "../middleware/errorHandler.js";

/**
 * CORS restringido a los dominios de Merkahorro.
 *
 * ─── Qué protege y qué NO ─────────────────────────────────────────────────
 *
 * SÍ: que una pestaña de otro sitio —una página cualquiera que el usuario tenga
 * abierta— le pegue a esta API desde el navegador. Ese es el caso realista con
 * una URL pública en internet.
 *
 * NO: a alguien con `curl` o Postman. CORS lo aplica el NAVEGADOR, no el
 * servidor: un cliente que no es un navegador simplemente ignora la cabecera.
 * Para eso hace falta autenticación de verdad, que este backend todavía no
 * tiene (igual que el de traslados).
 *
 * No lo vendas como seguridad: es reducción de superficie.
 *
 * ─── Peticiones SIN origen ────────────────────────────────────────────────
 *
 * Se dejan pasar. `curl`, los health checks de Vercel y cualquier llamada
 * servidor-a-servidor no mandan `Origin`. Bloquearlas rompería el monitoreo sin
 * ganar nada: quien usa curl ya podía saltarse CORS de todos modos.
 *
 * ─── Configuración ────────────────────────────────────────────────────────
 *
 * `CARNES_ORIGENES` (opcional) reemplaza la lista, separada por comas. Sirve
 * para sumar un dominio nuevo sin tocar código:
 *
 *   CARNES_ORIGENES=https://merkahorro.com,http://localhost:5173
 */

const POR_DEFECTO = [
  // El dominio de producción.
  "https://merkahorro.com",
  "https://www.merkahorro.com",
  // El dominio viejo sigue vivo y sirve la misma app (verificado: responde 200).
  // Va incluido porque sacarlo rompería a quien entre por ahí, y agregarlo no
  // suma riesgo: es de la casa.
  "https://supermercadomerkahorro.com",
  "https://www.supermercadomerkahorro.com",
  // Desarrollo local. Vite usa 5173 y salta a 5174 si está ocupado, así que van
  // los dos: si no, el día que el puerto está tomado el front deja de hablarle
  // al backend y el error que aparece —"Network Error"— no dice por qué.
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function permitidos() {
  const raw = String(process.env.CARNES_ORIGENES || "").trim();
  if (!raw) return POR_DEFECTO;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, "")) // sin la barra final: el navegador
    .filter(Boolean); //                        manda el origen sin ella
}

export const corsMerkahorro = cors({
  origin(origen, callback) {
    if (!origen) return callback(null, true); // sin Origin — ver arriba
    if (permitidos().includes(origen.replace(/\/$/, ""))) return callback(null, true);

    // Se loguea el origen rechazado: el día que alguien sume un dominio y "no
    // funcione", este log dice exactamente qué agregar a `CARNES_ORIGENES`.
    console.warn(`🚫 CORS: origen no permitido → ${origen}`);

    // 403 y no un Error pelado: un `new Error()` cae en el handler genérico y
    // sale como 500 "Error interno del servidor", que hace buscar el problema
    // en el backend cuando en realidad el backend hizo justo lo que debía. El
    // 403 dice qué pasó y `createError` lo marca como exponible.
    return callback(createError(403, "Origen no permitido."));
  },
  credentials: true,
});

/** Para el health check: deja ver la lista sin exponer nada sensible. */
export function origenesPermitidos() {
  return permitidos();
}
