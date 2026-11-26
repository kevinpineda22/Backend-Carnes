// Correos de la preliquidación (4.2): `notificarPreliquidacion(tipo, ctx)` y la lectura de los
// destinatarios desde el entorno. El transporte se inyecta: aquí nunca sale un correo real.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  notificarPreliquidacion,
  destinatariosPreliquidacion,
  TIPOS_AVISO_PRELIQUIDACION,
} from "../src/services/notificaciones.service.js";
import { EVENTOS_ALERTA } from "../src/services/preliquidacionAlertas.js";

const silencio = () => {
  const llamadas = { info: [], warn: [], error: [] };
  return {
    llamadas,
    info: (...a) => llamadas.info.push(a.join(" ")),
    warn: (...a) => llamadas.warn.push(a.join(" ")),
    error: (...a) => llamadas.error.push(a.join(" ")),
  };
};

function transporte(respuesta = { success: true, messageId: "id-1" }) {
  const enviados = [];
  return {
    enviados,
    enviar: async (correo) => {
      enviados.push(correo);
      if (respuesta instanceof Error) throw respuesta;
      return respuesta;
    },
  };
}

const CTX = {
  especie: "res",
  preliquidacion_id: 7,
  sede_id: 12,
  sede_nombre: "Sede Centro",
  recepcion_id: 301,
  animales: 3,
  restantes: 1,
  solicitados: 3,
  utilidad: "-40000.00",
  gasto_sede: "3800000.00",
  motivo: "servicio_cero",
  error: "SIESA rechazó el documento",
  intentos: 5,
  ventana_fin: "2026-11-25T04:59:59.999Z",
  fecha_ingreso: "2026-11-23",
  servicio_real: "700000.00",
  servicio_aplicado: "500000.00",
  diferencia: "200000.00",
  no_asignada: "0.00",
  monto_no_asignado: "1250000.00",
  por_sede: [{ sede_id: 12, diferencia: "80000.00" }],
  por: "ana",
};

/** Lo que cada correo debe mostrar además de especie, preliquidación y sede. */
const NUMEROS = {
  excede_animales: ["1", "3"],
  utilidad_negativa: ["40.000"],
  servicio_cero: [],
  costeo_invalido: [],
  armado_invalido: [],
  sin_preliquidacion: ["301"],
  oficial_legacy: ["301"],
  fuera_ventana: ["301"],
  ventana_vencida: ["1"],
  envio_error: ["SIESA rechazó el documento"],
  visceras_error: ["SIESA rechazó el documento"],
  visceras_agotadas: ["SIESA rechazó el documento"],
  reintentos_agotados: ["5"],
  sin_confirmar: [],
  envio_en_vuelo: [],
  inicial_pendiente: [],
  servicio_tardio: ["700.000", "500.000", "200.000"],
  requiere_correccion: [],
  corrida_perdida: [],
  cerrada: ["1.250.000"],
};

const ENV = { CARNES_MAIL_PRELIQUIDACION: "ops@example.test, otro@example.test" };

function enviarTipo(tipo, ctx = CTX, extra = {}) {
  const t = transporte();
  const log = silencio();
  return notificarPreliquidacion(tipo, ctx, {
    enviar: t.enviar,
    destinatarios: () => destinatariosPreliquidacion(ENV),
    sandbox: () => false,
    log,
    ...extra,
  }).then((r) => ({ r, t, log }));
}

test("cada tipo de alerta de la cola tiene su correo (los 20: los 18 del diseño más visceras_error y visceras_agotadas)", () => {
  assert.deepEqual([...TIPOS_AVISO_PRELIQUIDACION].sort(), [...EVENTOS_ALERTA].sort());
  assert.equal(TIPOS_AVISO_PRELIQUIDACION.length, 20);
  assert.deepEqual(Object.keys(NUMEROS).sort(), [...EVENTOS_ALERTA].sort());
});

for (const tipo of EVENTOS_ALERTA) {
  test(`${tipo}: el correo lleva especie, preliquidación, sede y sus números, a los destinatarios del entorno`, async () => {
    const { r, t } = await enviarTipo(tipo);
    assert.equal(r.success, true);
    assert.equal(t.enviados.length, 1);
    const { to, subject, html } = t.enviados[0];
    assert.deepEqual(to, ["ops@example.test", "otro@example.test"]);
    assert.match(subject, /Preliquidación/);
    assert.match(subject, /#7/);
    assert.match(subject, /res/i);
    const texto = html.replace(/<[^>]+>/g, " ");
    assert.match(texto, /res/i);
    assert.match(texto, /#7/);
    if (!["sin_preliquidacion", "oficial_legacy", "fuera_ventana", "ventana_vencida", "corrida_perdida", "cerrada", "servicio_tardio"].includes(tipo)) {
      assert.match(texto, /Sede Centro/);
    }
    for (const numero of NUMEROS[tipo]) assert.ok(texto.includes(numero), `${tipo} debería mostrar ${numero}`);
  });
}

test("G-S1: el aviso de exceso muestra animales restantes y solicitados", async () => {
  const { t } = await enviarTipo("excede_animales", { ...CTX, restantes: 1, solicitados: 3 });
  const texto = t.enviados[0].html.replace(/<[^>]+>/g, " ");
  assert.match(texto, /restantes[^0-9]*1\b/i);
  assert.match(texto, /solicitad[^0-9]*3\b/i);
});

test("G-S3: sin CARNES_MAIL_PRELIQUIDACION (ni admin) se registra, no lanza y no se envía", async () => {
  const t = transporte();
  const log = silencio();
  const r = await notificarPreliquidacion("excede_animales", CTX, {
    enviar: t.enviar,
    destinatarios: () => destinatariosPreliquidacion({}),
    sandbox: () => false,
    log,
  });
  assert.equal(r.success, false);
  assert.equal(r.sinDestinatarios, true);
  assert.equal(t.enviados.length, 0);
  assert.match(log.llamadas.error.join(" "), /CARNES_MAIL_PRELIQUIDACION/);
});

test("el sandbox suprime el envío y lo informa como exitoso para no acumular backlog", async () => {
  const t = transporte();
  const r = await notificarPreliquidacion("cerrada", CTX, {
    enviar: t.enviar,
    destinatarios: () => ["ops@example.test"],
    sandbox: () => true,
    log: silencio(),
  });
  assert.deepEqual({ success: r.success, sandbox: r.sandbox }, { success: true, sandbox: true });
  assert.equal(t.enviados.length, 0);
});

test("el sandbox corta antes de mirar los destinatarios", async () => {
  const t = transporte();
  const r = await notificarPreliquidacion("cerrada", CTX, {
    enviar: t.enviar,
    destinatarios: () => [],
    sandbox: () => true,
    log: silencio(),
  });
  assert.equal(r.success, true);
  assert.equal(r.sinDestinatarios, undefined);
});

test("un transporte que falla o lanza devuelve success:false y no lanza", async () => {
  const falla = await enviarTipo("envio_error", CTX, { enviar: async () => ({ success: false, error: "smtp" }) });
  assert.equal(falla.r.success, false);
  const lanza = await enviarTipo("envio_error", CTX, { enviar: async () => { throw new Error("boom"); } });
  assert.equal(lanza.r.success, false);
  assert.match(lanza.r.error, /boom/);
});

test("un tipo desconocido o un contexto roto no lanzan", async () => {
  const desconocido = await enviarTipo("no_existe");
  assert.equal(desconocido.r.success, false);
  assert.equal(desconocido.t.enviados.length, 0);
  for (const ctx of [undefined, null, "texto", {}]) {
    const { r } = await enviarTipo("cerrada", ctx);
    assert.equal(typeof r.success, "boolean");
  }
});

test("el texto del usuario se escapa en el HTML", async () => {
  const { t } = await enviarTipo("utilidad_negativa", { ...CTX, sede_nombre: "<script>alert(1)</script>", error: "<b>x</b>" });
  assert.doesNotMatch(t.enviados[0].html, /<script>/);
  assert.match(t.enviados[0].html, /&lt;script&gt;/);
});

test("el correo no lleva emojis", async () => {
  for (const tipo of EVENTOS_ALERTA) {
    const { t } = await enviarTipo(tipo);
    const { subject, html } = t.enviados[0];
    assert.doesNotMatch(subject + html, /\p{Extended_Pictographic}/u, tipo);
  }
});

test("destinatariosPreliquidacion: lee la variable (varios, sin repetidos) y cae al admin", () => {
  assert.deepEqual(destinatariosPreliquidacion({ CARNES_MAIL_PRELIQUIDACION: "a@x.co; b@x.co, A@x.co", CARNES_MAIL_ADMIN: "z@x.co" }), ["a@x.co", "b@x.co"]);
  assert.deepEqual(destinatariosPreliquidacion({ CARNES_MAIL_ADMIN: "z@x.co" }), ["z@x.co"]);
  assert.deepEqual(destinatariosPreliquidacion({}), []);
});

test("sin inyectar destinatarios, los lee del entorno por llamada", async () => {
  const previo = process.env.CARNES_MAIL_PRELIQUIDACION;
  const previoSandbox = process.env.CARNES_SANDBOX;
  process.env.CARNES_MAIL_PRELIQUIDACION = "uno@example.test";
  delete process.env.CARNES_SANDBOX;
  try {
    const t = transporte();
    await notificarPreliquidacion("cerrada", CTX, { enviar: t.enviar, log: silencio() });
    assert.deepEqual(t.enviados[0].to, ["uno@example.test"]);
    process.env.CARNES_MAIL_PRELIQUIDACION = "dos@example.test";
    await notificarPreliquidacion("cerrada", CTX, { enviar: t.enviar, log: silencio() });
    assert.deepEqual(t.enviados[1].to, ["dos@example.test"]);
  } finally {
    if (previo === undefined) delete process.env.CARNES_MAIL_PRELIQUIDACION;
    else process.env.CARNES_MAIL_PRELIQUIDACION = previo;
    if (previoSandbox !== undefined) process.env.CARNES_SANDBOX = previoSandbox;
  }
});

test("ninguna dirección de correo está escrita en el código de la preliquidación", () => {
  const raiz = new URL("../src/", import.meta.url);
  const archivos = readdirSync(raiz, { recursive: true }).map(String).filter((f) => f.endsWith(".js"));
  for (const archivo of archivos) {
    const fuente = readFileSync(new URL(archivo, raiz), "utf8");
    assert.doesNotMatch(fuente, /auxoperaciones/i, archivo);
    assert.doesNotMatch(fuente, /merkahorrosas\.com/i, archivo);
  }
});
