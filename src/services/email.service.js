import nodemailer from "nodemailer";
import { sandboxOn } from "../config/sandbox.js";

/* =============================================
   Servicio de correo (SMTP Office365)

   Mismo patrón que Backend-traslados: nodemailer sobre el SMTP corporativo, con
   las credenciales en el .env:

     SMTP_HOST=smtp.office365.com
     SMTP_PORT=587
     SMTP_SECURE=false
     EMAIL_USER=<cuenta emisora>
     EMAIL_PASS=<contraseña de la cuenta>

   El host, el puerto y el flag de TLS se leen como `SMTP_*` con respaldo a
   `EMAIL_*`. El respaldo existe porque los otros backends de la casa
   (traslados, inventarios) usan el prefijo `EMAIL_`: si mañana alguien copia un
   .env de allá para levantar este rápido, funciona igual en vez de fallar por un
   nombre de variable.

   Destinatarios (acepta varios separados por coma):

     CARNES_MAIL_ADMIN → quien recibe el aviso de "el recibidor ya terminó".
   ============================================= */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.office365.com",
  port: Number(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587,
  // false para 587 (STARTTLS). Solo `true` explícito lo prende.
  secure: (process.env.SMTP_SECURE ?? process.env.EMAIL_SECURE) === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { ciphers: "TLSv1.2" },
});

/**
 * Parsea una lista de correos separados por coma, deduplicando sin distinguir
 * mayúsculas. Sin la deduplicación, un correo repetido en la variable de entorno
 * le llega dos veces a la misma persona.
 */
function lista(valor) {
  const vistos = new Set();
  return String(valor || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((correo) => {
      const clave = correo.toLowerCase();
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
}

/** Se lee por llamada, no se cachea: ver el comentario de `sandboxOn`. */
export function destinatariosAdmin() {
  return lista(process.env.CARNES_MAIL_ADMIN);
}

export function emailConfigurado() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

/**
 * Se conecta al SMTP y autentica SIN enviar nada.
 *
 * Existe porque "las variables están cargadas" no es lo mismo que "el correo
 * funciona": la contraseña puede estar vencida o el tenant puede tener SMTP AUTH
 * apagado. Sin esto, la única forma de comprobarlo es cerrar una recepción de
 * verdad y esperar a que el admin diga que no le llegó nada.
 */
export async function verificarEmail() {
  if (!emailConfigurado()) {
    return { ok: false, error: "Faltan EMAIL_USER o EMAIL_PASS en el entorno." };
  }
  try {
    await transporter.verify();
    return { ok: true, usuario: process.env.EMAIL_USER };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Envía un correo. NUNCA lanza.
 *
 * Devuelve `{ success }` en vez de tirar una excepción a propósito: esto es un
 * efecto secundario best-effort. El recibidor cierra la recepción parado en la
 * cava con la carne afuera; si el SMTP está caído, lo último que puede pasar es
 * que su recepción falle. El aviso al admin es importante, pero no es la
 * operación — se loguea el error y el flujo sigue.
 *
 * @param {{to: string|string[], subject: string, html: string}} mail
 */
export async function sendEmail({ to, subject, html }) {
  const destinatarios = (Array.isArray(to) ? to : [to]).filter(Boolean);

  // El sandbox corta ACÁ, en el único punto por el que sale todo correo, y ANTES
  // de mirar credenciales: en una máquina de pruebas puede no haberlas, y el
  // resultado tiene que ser "no salió porque estoy probando", no un error de
  // configuración que hace dudar de si el correo funciona.
  if (sandboxOn()) {
    console.warn(
      `[email] 🧪 SANDBOX — "${subject}" NO se envió ` +
        `(iba a ${destinatarios.join(", ") || "nadie"}).`,
    );
    return { success: true, sandbox: true };
  }

  if (!emailConfigurado()) {
    console.error(
      `[email] ❌ EMAIL_USER/EMAIL_PASS no configurados — NO se envió "${subject}". ` +
        "Cargá las variables EMAIL_* en el entorno (Vercel → Settings → Environment Variables).",
    );
    return { success: false, error: "Configuración de correo incompleta" };
  }

  if (destinatarios.length === 0) {
    console.error(
      `[email] ❌ sin destinatarios — NO se envió "${subject}". ` +
        "Falta CARNES_MAIL_ADMIN en el entorno.",
    );
    return { success: false, error: "Sin destinatarios" };
  }

  try {
    const info = await transporter.sendMail({
      from: `"Recepción de Carnes Merkahorro" <${process.env.EMAIL_USER}>`,
      to: destinatarios.join(", "),
      subject,
      html,
    });
    console.log(`[email] ✅ "${subject}" → ${destinatarios.join(", ")} (${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[email] ❌ falló "${subject}": ${error.message}`);
    return { success: false, error: error.message };
  }
}
