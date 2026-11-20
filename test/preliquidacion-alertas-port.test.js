import test from "node:test";
import assert from "node:assert/strict";

import {
  encolarAlerta,
  despacharAlertas,
  EVENTOS_ALERTA,
} from "../src/services/preliquidacionAlertas.js";

function logger() {
  const llamadas = { info: [], warn: [], error: [] };
  return {
    llamadas,
    info: (...a) => llamadas.info.push(a.join(" ")),
    warn: (...a) => llamadas.warn.push(a.join(" ")),
    error: (...a) => llamadas.error.push(a.join(" ")),
  };
}

async function conEnv(valor, fn) {
  const previo = process.env.CARNES_MAIL_PRELIQUIDACION;
  if (valor === undefined) delete process.env.CARNES_MAIL_PRELIQUIDACION;
  else process.env.CARNES_MAIL_PRELIQUIDACION = valor;
  try {
    return await fn();
  } finally {
    if (previo === undefined) delete process.env.CARNES_MAIL_PRELIQUIDACION;
    else process.env.CARNES_MAIL_PRELIQUIDACION = previo;
  }
}

test("EVENTOS_ALERTA lista los 18 tipos del diseño", () => {
  assert.equal(EVENTOS_ALERTA.length, 18);
  for (const e of ["excede_animales", "servicio_tardio", "corrida_perdida", "cerrada", "inicial_pendiente"]) {
    assert.ok(EVENTOS_ALERTA.includes(e), e);
  }
});

test("encolarAlerta registra la alerta en el log y no escribe nada (no-op)", async () => {
  const log = logger();
  await conEnv("ops@example.test", async () => {
    const r = await encolarAlerta(
      { evento: "excede_animales", preliquidacionId: 3, sedeId: 8, ocurrencia: 2, detalle: { animales: 5 } },
      { log },
    );
    assert.deepEqual(r, { ok: true, noop: true });
  });
  assert.equal(log.llamadas.info.length, 1);
  assert.match(log.llamadas.info[0], /excede_animales/);
  assert.match(log.llamadas.info[0], /preliquidacion=3/);
  assert.match(log.llamadas.info[0], /sede=8/);
  assert.equal(log.llamadas.warn.length, 0);
});

test("G-S3: sin CARNES_MAIL_PRELIQUIDACION loguea el aviso y NO lanza", async () => {
  const log = logger();
  await conEnv(undefined, async () => {
    const r = await encolarAlerta({ evento: "utilidad_negativa", preliquidacionId: 1 }, { log });
    assert.equal(r.ok, true);
  });
  assert.equal(log.llamadas.warn.length, 1);
  assert.match(log.llamadas.warn[0], /CARNES_MAIL_PRELIQUIDACION/);
});

test("cadena vacía o con solo espacios cuenta como destinatario faltante", async () => {
  const log = logger();
  await conEnv("   ", async () => {
    await encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }, { log });
  });
  assert.equal(log.llamadas.warn.length, 1);
});

test("encolarAlerta nunca lanza, aun con entradas rotas", async () => {
  const log = logger();
  for (const entrada of [undefined, null, {}, { evento: 42 }, "texto", { evento: "no_existe" }]) {
    const r = await encolarAlerta(entrada, { log });
    assert.equal(r.ok, true);
    assert.equal(r.noop, true);
  }
});

test("un evento desconocido se loguea como advertencia pero no rompe", async () => {
  const log = logger();
  await conEnv("ops@example.test", async () => {
    await encolarAlerta({ evento: "no_existe", preliquidacionId: 1 }, { log });
  });
  assert.ok(log.llamadas.warn.some((m) => /no_existe/.test(m)));
});

test("un logger que falla tampoco rompe el flujo", async () => {
  const log = {
    info: () => {
      throw new Error("log roto");
    },
    warn: () => {
      throw new Error("log roto");
    },
    error: () => {},
  };
  const r = await conEnv(undefined, () => encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }, { log }));
  assert.equal(r.ok, true);
});

test("despacharAlertas es un no-op que no lanza y devuelve cero enviadas", async () => {
  const log = logger();
  const r = await despacharAlertas({}, { log });
  assert.deepEqual(r, { ok: true, noop: true, enviadas: 0 });
  const r2 = await despacharAlertas(undefined, { log });
  assert.equal(r2.enviadas, 0);
});

test("sin inyectar logger usa console y tampoco lanza", async () => {
  const r = await conEnv("ops@example.test", () => encolarAlerta({ evento: "cerrada", preliquidacionId: 1 }));
  assert.equal(r.ok, true);
});
