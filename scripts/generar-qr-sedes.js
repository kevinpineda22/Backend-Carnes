/**
 * generar-qr-sedes.js — Hoja imprimible con el QR de cada sede.
 *
 * Uso:
 *   npm run qr                    → todas las sedes activas
 *   npm run qr -- --sede "Villa"  → solo las que coincidan con ese nombre
 *   npm run qr -- --todas         → incluye las inactivas
 *
 * Genera `qr-sedes.html` en la raíz. Se abre en el navegador y se imprime.
 *
 * ─── Por qué el código va escrito DEBAJO del QR ──────────────────────────
 *
 * Porque la cámara falla. Necesita HTTPS y permiso del navegador, y no arranca
 * en un celular viejo ni con el permiso denegado una vez. El panel tiene una
 * salida manual justo para eso, y esa salida NO SIRVE si el adhesivo no trae el
 * código legible. Un QR sin su texto convierte un teléfono con la cámara rota en
 * un recibidor que no puede trabajar.
 *
 * ─── Sobre el archivo que genera ─────────────────────────────────────────
 *
 * `qr-sedes.html` contiene los tokens EN CLARO: es la lista completa de las
 * llaves de las que depende toda la verificación de sede. Está en `.gitignore`.
 * No lo subas a ningún lado, no lo mandes por correo, y borralo cuando termines
 * de imprimir.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import QRCode from "qrcode";

const args = process.argv.slice(2);
const filtro = args.includes("--sede") ? args[args.indexOf("--sede") + 1] : null;
const incluirInactivas = args.includes("--todas");
const demo = args.includes("--demo");

function esc(t) {
  return String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sedes de mentira con tokens aleatorios, para `--demo`.
 *
 * Sirve para ver e imprimir la hoja ANTES de crear las tablas, y para probar que
 * el lector del celular agarra bien el código a la distancia y con la luz reales
 * de la zona de recibo. Ese ensayo conviene hacerlo antes de pegar nada.
 *
 * Los tokens NO sirven contra el backend: son aleatorios y no están en la base.
 */
function sedesDemo() {
  const nombres = [
    ["01", "Copacabana Principal"],
    ["02", "Villa Hermosa"],
    ["03", "Girardota Parque"],
    ["04", "Girardota Llano"],
  ];
  return nombres.map(([codigo_co, nombre], i) => ({
    id: i + 1,
    codigo_co,
    nombre: `${nombre} (DEMO)`,
    qr_token: randomBytes(16).toString("hex"),
    activo: true,
  }));
}

/** Se importa perezosamente: en `--demo` no hace falta Supabase ni el .env. */
async function leerSedes() {
  const { supabase } = await import("../src/config/supabase.js");

  let q = supabase
    .from("carnes_sedes")
    .select("id, codigo_co, nombre, qr_token, activo")
    .order("nombre");
  if (!incluirInactivas) q = q.eq("activo", true);

  const { data, error } = await q;
  if (error) {
    console.error("❌ No se pudieron leer las sedes:", error.message);
    console.error("   ¿Corriste sql/001 y sql/002 en Supabase?");
    process.exit(1);
  }
  return data;
}

async function main() {
  const sedes = demo ? sedesDemo() : await leerSedes();

  const elegidas = filtro
    ? sedes.filter((s) => s.nombre.toLowerCase().includes(filtro.toLowerCase()))
    : sedes;

  if (elegidas.length === 0) {
    console.error(
      filtro ? `❌ Ninguna sede coincide con "${filtro}".` : "❌ No hay sedes cargadas.",
    );
    process.exit(1);
  }

  const tarjetas = await Promise.all(
    elegidas.map(async (s) => {
      // SVG y no PNG: el SVG es vectorial, así que imprime nítido a cualquier
      // tamaño. Un PNG escalado deja los módulos del QR borrosos y el lector
      // empieza a fallar justo cuando hay poca luz.
      const svg = await QRCode.toString(s.qr_token, {
        type: "svg",
        margin: 1,
        // Corrección de errores ALTA: este adhesivo va a vivir en una zona de
        // recibo de carnes. Se moja, se raya, se mancha. Con nivel H el código
        // sigue leyéndose con hasta un 30% de la superficie arruinada.
        errorCorrectionLevel: "H",
      });

      return `
        <div class="tarjeta">
          <div class="marca">MERKAHORRO</div>
          <h2 class="sede">${esc(s.nombre)}</h2>
          ${s.codigo_co ? `<p class="co">C.O. ${esc(s.codigo_co)}</p>` : `<p class="co co--falta">Sin C.O. asignado</p>`}
          <div class="qr">${svg}</div>
          <p class="rotulo">Si la cámara no funciona, escribí este código:</p>
          <p class="token">${esc(s.qr_token)}</p>
          <p class="pie">Recepción de carnes · pegar en la zona de recibo</p>
        </div>`;
    }),
  );

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>QR de sedes — Recepción de carnes</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    margin: 0;
    padding: 16px;
    background: #f3f4f6;
    color: #111827;
  }
  .aviso {
    max-width: 900px;
    margin: 0 auto 20px;
    padding: 12px 16px;
    border-left: 4px solid #b45309;
    background: #fef3c7;
    color: #78350f;
    font-size: 13px;
    line-height: 1.5;
  }
  .hoja {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    max-width: 900px;
    margin: 0 auto;
  }
  .tarjeta {
    background: #ffffff;
    border: 2px dashed #9ca3af;
    border-radius: 10px;
    padding: 18px 16px 14px;
    text-align: center;
    break-inside: avoid;
  }
  .marca { font-size: 10px; letter-spacing: 0.18em; color: #6b7280; }
  .sede { margin: 6px 0 2px; font-size: 20px; }
  .co { margin: 0 0 10px; font-size: 12px; color: #6b7280; }
  .co--falta { color: #b45309; font-weight: bold; }
  .qr { display: flex; justify-content: center; }
  .qr svg { width: 190px; height: 190px; }
  .rotulo { margin: 10px 0 2px; font-size: 10px; color: #6b7280; }
  .token {
    margin: 0 0 8px;
    font-family: ui-monospace, "Courier New", monospace;
    font-size: 12px;
    letter-spacing: 0.06em;
    word-break: break-all;
    color: #111827;
  }
  .pie { margin: 0; font-size: 9px; color: #9ca3af; }

  @media print {
    body { background: #ffffff; padding: 0; }
    .aviso { display: none; }
    .hoja { gap: 0; max-width: none; }
    .tarjeta { border-color: #d1d5db; }
    /* El QR y el texto TIENEN que salir en negro sólido aunque la impresora
       esté en modo ahorro: un QR gris claro no lo lee ningún teléfono. */
    * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  }
</style>
</head>
<body>
  ${demo ? `<div class="aviso" style="border-left-color:#2563eb;background:#dbeafe;color:#1e3a8a">
    <strong>Hoja de PRUEBA.</strong> Los códigos son aleatorios y NO existen en la
    base: sirven para ensayar que el celular los lee a la distancia y con la luz
    de la zona de recibo, no para verificar una sede de verdad. Los definitivos
    salen con <code>npm run qr</code> (sin <code>--demo</code>), después de correr
    sql/001 y sql/002.
  </div>` : ""}
  <div class="aviso"${demo ? ' style="display:none"' : ""}>
    <strong>Este archivo contiene los códigos en claro.</strong> Son las llaves de
    las que depende la verificación de sede. No lo subas al repositorio ni lo
    mandes por correo: imprimí, pegá los adhesivos, y borralo.
    <br><br>
    Si un adhesivo se filtra o alguien le saca una foto, regenerá SOLO esa sede:
    <code>POST /api/sedes/:id/regenerar-token</code> con el header
    <code>X-Admin-Key</code>. El QR viejo deja de servir en el acto.
  </div>
  <div class="hoja">${tarjetas.join("")}</div>
</body>
</html>`;

  const archivo = demo ? "qr-sedes-demo.html" : "qr-sedes.html";
  writeFileSync(archivo, html, "utf-8");

  console.log(`✅ ${archivo} generado con ${elegidas.length} sede(s):`);
  for (const s of elegidas) {
    console.log(`   · ${s.nombre}${s.codigo_co ? ` (C.O. ${s.codigo_co})` : " — SIN C.O."}`);
  }
  console.log("\n   Abrilo en el navegador e imprimí. Después borralo.");
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
