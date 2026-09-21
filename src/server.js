import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import "dotenv/config";

import routes from "./routes/index.js";
import { corsMerkahorro } from "./config/cors.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Middleware global ────────────────────────────
app.use(helmet());
app.use(corsMerkahorro);
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

// ─── Ruta raíz ───────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    nombre: "Backend Carnes — Merkahorro",
    version: "1.0.0",
    endpoints: {
      health: "/api/health",
      sedes: "/api/sedes",
      plantilla: "/api/plantilla/:especie",
      recepciones: "/api/recepciones",
      liquidaciones: "/api/liquidaciones",
      siesa: "/api/siesa/envios",
    },
  });
});

// ─── Rutas ────────────────────────────────────────
app.use("/api", routes);

// ─── 404 ──────────────────────────────────────────
//
// Dice QUÉ ruta vio Express, no solo que no la encontró. Detrás de un proxy
// —Vercel reescribe todo a este archivo— la ruta que llega puede no ser la que
// se pidió, y un "Ruta no encontrada" pelado no deja distinguir "escribí mal la
// URL" de "el proxy me la cambió".
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada",
    metodo: req.method,
    pedida: req.originalUrl,
    vista: req.url,
    montadas: ["/", "/api/health", "/api/sedes", "/api/plantilla/:especie",
               "/api/recepciones", "/api/liquidaciones", "/api/siesa"],
  });
});

// ─── Error handler ────────────────────────────────
app.use(errorHandler);

// ─── Arranque ─────────────────────────────────────
// En Vercel el archivo se importa como función serverless: ahí NO se llama a
// `listen`, por eso el guard. En local sí levanta el puerto.
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║  Backend Carnes — Merkahorro            ║
║  Puerto: ${String(PORT).padEnd(33)}║
║  Modo:   ${(process.env.NODE_ENV || "development").padEnd(33)}║
╚══════════════════════════════════════════╝
    `);
  });
}

export default app;
