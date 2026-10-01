import test from "node:test";
import assert from "node:assert/strict";

import {
  ESTADOS_EN_CURSO,
  ESTADOS_VIGENTES,
  armarRefrescoSnapshots,
  decidirEntradaAlFinalizar,
  decidirNotaCredito,
  decidirReintentoEntrada,
  enriquecerMovimientosProveedor,
  esTipoProveedor,
  hayDevoluciones,
  motivoEnvioVigente,
  notaCreditoParaFront,
  planearAnulacionEnvios,
  rechazoDeNotaCredito,
  resumirEnvios,
  siesaDeEnvios,
  siesaDeFila,
} from "../src/shared/siesaProveedorEnvio.js";
import {
  TIPO_ENVIO_PROVEEDOR,
  armarEntradaProveedor,
  armarNotaCreditoProveedor,
} from "../src/shared/siesaProveedor.js";
import { DOCUMENTO_CARNES, DOCUMENTO_NOTA_CREDITO_PROVEEDOR } from "../src/config/siesa.js";
import { validators } from "../src/middleware/validators.js";

const ENTRADA = TIPO_ENVIO_PROVEEDOR.ENTRADA;
const NC = TIPO_ENVIO_PROVEEDOR.NOTA_CREDITO;

let n = 0;
/** Un envío de prueba. `enviado_at` crece solo: el último creado es el más nuevo. */
function envio(tipo, estado, extra = {}) {
  n += 1;
  return {
    id: n,
    tipo,
    estado,
    referencia: tipo === ENTRADA ? "TC PRV R12" : "TC PRV N12",
    error: estado === "error" ? "SIESA respondió 400: algo" : null,
    enviado_at: new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString(),
    ...extra,
  };
}

const CON_DEVOLUCION = [
  { id: 1, cantidad: 100, cantidad_devuelta: 10 },
  { id: 2, cantidad: 5, cantidad_devuelta: 0 },
];
const SIN_DEVOLUCION = [{ id: 1, cantidad: 100, cantidad_devuelta: 0 }];

// ─── Tipos y lectura de envíos ─────────────────────────────────────────────

test("esTipoProveedor: solo los dos tipos de proveedor, nunca los de Talleres", () => {
  assert.equal(esTipoProveedor("entrada_proveedor"), true);
  assert.equal(esTipoProveedor("nc_proveedor"), true);
  for (const t of ["inicial", "oficial", "ajuste_visceras", "ajuste_faltante", "", undefined, null]) {
    assert.equal(esTipoProveedor(t), false, `no debería ser de proveedor: ${t}`);
  }
});

test("estados vigentes y en curso coinciden con los índices de sql/023", () => {
  assert.deepEqual(ESTADOS_VIGENTES, ["enviando", "ok", "sin_confirmar"]);
  assert.deepEqual(ESTADOS_EN_CURSO, ["enviando", "sin_confirmar"]);
});

test("resumirEnvios: separa por tipo y distingue ok, en curso, vigente y último", () => {
  const e1 = envio(ENTRADA, "error");
  const e2 = envio(ENTRADA, "ok");
  const nc1 = envio(NC, "error");
  const r = resumirEnvios([e1, nc1, e2], ENTRADA);
  assert.equal(r.total, 2);
  assert.equal(r.ok.id, e2.id);
  assert.equal(r.enCurso, null);
  assert.equal(r.vigente.id, e2.id);
  assert.equal(r.ultimo.id, e2.id);

  const n2 = resumirEnvios([e1, nc1, e2], NC);
  assert.equal(n2.total, 1);
  assert.equal(n2.ok, null);
  assert.equal(n2.vigente, null);
  assert.equal(n2.ultimo.id, nc1.id);
});

test("resumirEnvios: un enviando o sin_confirmar ocupa el lugar; error y anulado no", () => {
  assert.equal(resumirEnvios([envio(ENTRADA, "enviando")], ENTRADA).vigente.estado, "enviando");
  assert.equal(resumirEnvios([envio(ENTRADA, "sin_confirmar")], ENTRADA).enCurso.estado, "sin_confirmar");
  const libres = resumirEnvios([envio(ENTRADA, "error"), envio(ENTRADA, "anulado")], ENTRADA);
  assert.equal(libres.vigente, null);
  assert.equal(libres.total, 2);
});

test("resumirEnvios: tolera listas vacías o nulas", () => {
  for (const lista of [[], null, undefined]) {
    const r = resumirEnvios(lista, ENTRADA);
    assert.deepEqual(r, { total: 0, ok: null, enCurso: null, vigente: null, ultimo: null });
  }
});

test("motivoEnvioVigente: dice por qué no se puede mandar", () => {
  assert.match(motivoEnvioVigente(envio(ENTRADA, "ok")), /Ya está en SIESA \(TC PRV R12\)/);
  assert.match(motivoEnvioVigente(envio(ENTRADA, "enviando")), /envío en curso/);
  assert.match(motivoEnvioVigente(envio(ENTRADA, "sin_confirmar")), /sin confirmar.*panel de envíos/);
});

test("siesaDeFila / siesaDeEnvios: la forma que lee el front", () => {
  assert.deepEqual(siesaDeFila(null), { estado: "pendiente", referencia: null, error: null, envio_id: null });
  const ok = envio(ENTRADA, "ok");
  assert.deepEqual(siesaDeFila(ok), { estado: "ok", referencia: "TC PRV R12", error: null, envio_id: ok.id });

  assert.equal(siesaDeEnvios([]).estado, "pendiente");
  // El ok manda sobre un error anterior; sin ok ni en curso, el último intento.
  assert.equal(siesaDeEnvios([envio(ENTRADA, "error"), envio(ENTRADA, "ok")]).estado, "ok");
  const conError = siesaDeEnvios([envio(ENTRADA, "error")]);
  assert.equal(conError.estado, "error");
  assert.match(conError.error, /400/);
  // Un envío de nota crédito no es el estado de la entrada.
  assert.equal(siesaDeEnvios([envio(NC, "ok")]).estado, "pendiente");
});

test("hayDevoluciones: solo renglones recibidos con cantidad devuelta", () => {
  assert.equal(hayDevoluciones(CON_DEVOLUCION), true);
  assert.equal(hayDevoluciones(SIN_DEVOLUCION), false);
  assert.equal(hayDevoluciones([]), false);
  assert.equal(hayDevoluciones(null), false);
  // Una devolución sobre un renglón que no se recibió no cuenta (igual que el armador).
  assert.equal(hayDevoluciones([{ cantidad: 0, cantidad_devuelta: 3 }]), false);
});

// ─── Entrada al finalizar ──────────────────────────────────────────────────

test("finalizar: sin ningún envío de entrada y SIESA activo → enviar", () => {
  assert.deepEqual(decidirEntradaAlFinalizar({ estado: "Finalizada", envios: [], activo: true }), { accion: "enviar" });
});

test("finalizar: con SIESA apagado no se manda ni se anota nada", () => {
  assert.deepEqual(decidirEntradaAlFinalizar({ estado: "Finalizada", envios: [], activo: false }), {
    accion: "apagado",
  });
});

test("[J12] finalizar: un envío de entrada en CUALQUIER estado cierra el envío automático", () => {
  for (const estado of ["error", "ok", "enviando", "sin_confirmar", "anulado"]) {
    const d = decidirEntradaAlFinalizar({
      estado: "Finalizada",
      envios: [envio(ENTRADA, estado)],
      activo: true,
    });
    assert.equal(d.accion, "omitir", `con un envío ${estado} no se manda otro solo`);
  }
});

test("finalizar: un envío de nota crédito no cuenta como entrada", () => {
  const d = decidirEntradaAlFinalizar({ estado: "Finalizada", envios: [envio(NC, "error")], activo: true });
  assert.equal(d.accion, "enviar");
});

test("finalizar: solo una recepción Finalizada manda la entrada", () => {
  for (const estado of ["Borrador", "Enviada_SIESA", "Anulada"]) {
    assert.equal(decidirEntradaAlFinalizar({ estado, envios: [], activo: true }).accion, "omitir", estado);
  }
});

// ─── Reintento manual de la entrada ────────────────────────────────────────

test("reintentar: un borrador o una anulada se rechazan con 409", () => {
  const borrador = decidirReintentoEntrada({ estado: "Borrador", envios: [], activo: true });
  assert.equal(borrador.accion, "rechazar");
  assert.equal(borrador.status, 409);
  assert.equal(borrador.codigo, "RECEPCION_BORRADOR");

  const anulada = decidirReintentoEntrada({ estado: "Anulada", envios: [], activo: true });
  assert.equal(anulada.codigo, "RECEPCION_ANULADA");
  assert.equal(decidirReintentoEntrada({ estado: "Rara", envios: [], activo: true }).codigo, "ESTADO_DESCONOCIDO");
});

test("[J8] reintentar: con una entrada ok RECONCILIA, no manda otra (aunque SIESA esté apagado)", () => {
  for (const estado of ["Finalizada", "Enviada_SIESA"]) {
    for (const activo of [true, false]) {
      const ok = envio(ENTRADA, "ok");
      const d = decidirReintentoEntrada({ estado, envios: [envio(ENTRADA, "error"), ok], activo });
      assert.equal(d.accion, "reconciliar", `${estado} activo=${activo}`);
      assert.equal(d.envio.id, ok.id);
    }
  }
});

test("reintentar: con una entrada en curso o sin confirmar se pide resolverla", () => {
  for (const estado of ["enviando", "sin_confirmar"]) {
    const d = decidirReintentoEntrada({ estado: "Finalizada", envios: [envio(ENTRADA, estado)], activo: true });
    assert.equal(d.accion, "rechazar");
    assert.equal(d.codigo, "ENVIO_VIGENTE");
    assert.equal(d.status, 409);
  }
});

test("reintentar: tras un error (o un anulado) se vuelve a mandar", () => {
  for (const envios of [[], [envio(ENTRADA, "error")], [envio(ENTRADA, "anulado"), envio(ENTRADA, "error")]]) {
    assert.deepEqual(decidirReintentoEntrada({ estado: "Finalizada", envios, activo: true }), { accion: "enviar" });
  }
});

test("reintentar: con SIESA apagado se rechaza (409), salvo que solo haya que reconciliar", () => {
  const d = decidirReintentoEntrada({ estado: "Finalizada", envios: [envio(ENTRADA, "error")], activo: false });
  assert.equal(d.accion, "rechazar");
  assert.equal(d.codigo, "SIESA_APAGADO");
});

test("reintentar: Enviada_SIESA sin una entrada confirmada es un estado inconsistente: no se reenvía", () => {
  const d = decidirReintentoEntrada({ estado: "Enviada_SIESA", envios: [envio(ENTRADA, "anulado")], activo: true });
  assert.equal(d.accion, "rechazar");
  assert.equal(d.codigo, "ESTADO_INCONSISTENTE");
});

// ─── Nota crédito ──────────────────────────────────────────────────────────

const BASE_NC = { estado: "Enviada_SIESA", items: CON_DEVOLUCION, envios: [envio(ENTRADA, "ok")], activo: true };

test("nota crédito: sin renglones devueltos no es requerida", () => {
  const d = decidirNotaCredito({ ...BASE_NC, items: SIN_DEVOLUCION });
  assert.equal(d.accion, "no_requerida");
  assert.equal(notaCreditoParaFront(d).requerida, false);
});

test("nota crédito: una recepción sin firmar (borrador, anulada) no aplica", () => {
  for (const estado of ["Borrador", "Anulada"]) {
    const d = decidirNotaCredito({ ...BASE_NC, estado });
    assert.equal(d.accion, "no_aplica", estado);
    assert.equal(notaCreditoParaFront(d).requerida, true);
  }
});

test("nota crédito: espera a que la entrada esté ok", () => {
  for (const envios of [[], [envio(ENTRADA, "error")], [envio(ENTRADA, "sin_confirmar")], [envio(ENTRADA, "enviando")]]) {
    const d = decidirNotaCredito({ ...BASE_NC, estado: "Finalizada", envios });
    assert.equal(d.accion, "esperar");
    assert.equal(d.estado, "pendiente");
  }
});

test("nota crédito: se manda con la entrada ok, devoluciones, SIESA activo y sin bloqueos", () => {
  const d = decidirNotaCredito(BASE_NC);
  assert.equal(d.accion, "enviar");
  assert.equal(rechazoDeNotaCredito(d), null);
});

test("[J7] nota crédito: con el conector sin configurar BLOQUEA y no hay nada que anotar", () => {
  const bloqueos = ["Conector de nota crédito no configurado: falta idDocumento."];
  const d = decidirNotaCredito({ ...BASE_NC, bloqueos });
  assert.equal(d.accion, "bloquear");
  assert.equal(d.estado, "bloqueada");
  assert.match(d.bloqueo, /Conector de nota crédito no configurado/);
  // Cada disparo (finalizar, reconciliar, resolver) da la misma respuesta: nunca "enviar".
  for (let i = 0; i < 3; i++) {
    assert.equal(decidirNotaCredito({ ...BASE_NC, bloqueos }).accion, "bloquear");
  }
  const front = notaCreditoParaFront(d);
  assert.equal(front.estado, "bloqueada");
  assert.match(front.bloqueo, /no configurado/);
  assert.equal(front.requerida, true);
  // El endpoint manual devuelve el bloqueo como un 409, sin enviar.
  const rechazo = rechazoDeNotaCredito(d);
  assert.equal(rechazo.status, 409);
  assert.equal(rechazo.codigo, "NOTA_CREDITO_BLOQUEADA");
  assert.match(rechazo.mensaje, /no configurado/);
});

test("nota crédito: varios bloqueos se dicen juntos", () => {
  const d = decidirNotaCredito({ ...BASE_NC, bloqueos: ["Uno.", "Dos."] });
  assert.equal(d.bloqueo, "Uno. Dos.");
});

test("nota crédito: con SIESA apagado queda pendiente (gana sobre el bloqueo: no se manda nada)", () => {
  const d = decidirNotaCredito({ ...BASE_NC, activo: false, bloqueos: ["x"] });
  assert.equal(d.accion, "apagado");
  assert.equal(d.estado, "pendiente");
  assert.equal(rechazoDeNotaCredito(d).codigo, "SIESA_APAGADO");
});

test("nota crédito: una ok o una en curso no se vuelve a mandar", () => {
  const ok = envio(NC, "ok");
  assert.equal(decidirNotaCredito({ ...BASE_NC, envios: [envio(ENTRADA, "ok"), ok] }).estado, "ok");
  for (const estado of ["enviando", "sin_confirmar"]) {
    const d = decidirNotaCredito({ ...BASE_NC, envios: [envio(ENTRADA, "ok"), envio(NC, estado)], manual: true });
    assert.equal(d.accion, "omitir");
    assert.equal(d.estado, estado);
    assert.equal(rechazoDeNotaCredito(d).codigo, "NOTA_CREDITO_VIGENTE");
  }
});

test("nota crédito: tras un error el disparo automático no reintenta; el manual sí", () => {
  const envios = [envio(ENTRADA, "ok"), envio(NC, "error")];
  const auto = decidirNotaCredito({ ...BASE_NC, envios });
  assert.equal(auto.accion, "omitir");
  assert.equal(auto.estado, "error");
  assert.match(auto.motivo, /400/);

  const manual = decidirNotaCredito({ ...BASE_NC, envios, manual: true });
  assert.equal(manual.accion, "enviar");
});

test("notaCreditoParaFront: con el envío recién hecho informa su estado, referencia y error", () => {
  const decision = decidirNotaCredito(BASE_NC);
  const fila = envio(NC, "error");
  assert.deepEqual(notaCreditoParaFront(decision, fila), {
    requerida: true,
    estado: "error",
    bloqueo: null,
    referencia: "TC PRV N12",
    error: "SIESA respondió 400: algo",
  });
});

test("rechazoDeNotaCredito: cada decisión que no es enviar es un 409 con su código", () => {
  const casos = [
    [decidirNotaCredito({ ...BASE_NC, items: SIN_DEVOLUCION }), "SIN_DEVOLUCIONES"],
    [decidirNotaCredito({ ...BASE_NC, estado: "Borrador" }), "RECEPCION_NO_FIRMADA"],
    [decidirNotaCredito({ ...BASE_NC, envios: [] }), "ENTRADA_NO_ENVIADA"],
    [decidirNotaCredito({ ...BASE_NC, activo: false }), "SIESA_APAGADO"],
  ];
  for (const [decision, codigo] of casos) {
    const r = rechazoDeNotaCredito(decision);
    assert.equal(r.status, 409);
    assert.equal(r.codigo, codigo);
    assert.ok(r.mensaje.length > 5);
  }
});

// ─── Snapshots ─────────────────────────────────────────────────────────────

test("armarRefrescoSnapshots: solo lo que cambió en los maestros", () => {
  const recepcion = {
    proveedor_nit: "900123456",
    proveedor_sucursal: "001",
    proveedor_razon_social: "NUTRESA",
    bodega_siesa: "B07",
    codigo_co: "07",
  };
  assert.deepEqual(
    armarRefrescoSnapshots(recepcion, {
      proveedor: { nit: "900123456", sucursal: "001", razon_social: "NUTRESA" },
      sede: { bodega_siesa: "B07", codigo_co: "07" },
    }),
    {},
  );
  assert.deepEqual(
    armarRefrescoSnapshots(recepcion, {
      proveedor: { nit: "900123457", sucursal: "001", razon_social: "NUTRESA" },
      sede: { bodega_siesa: "B08", codigo_co: "07" },
    }),
    { proveedor_nit: "900123457", bodega_siesa: "B08" },
  );
});

test("armarRefrescoSnapshots: un maestro que ya no existe se deja como está", () => {
  const recepcion = { proveedor_nit: "9", bodega_siesa: "B1" };
  assert.deepEqual(armarRefrescoSnapshots(recepcion, { proveedor: null, sede: undefined }), {});
  assert.deepEqual(armarRefrescoSnapshots(recepcion), {});
});

test("armarRefrescoSnapshots: una bodega que el maestro dejó vacía se anota como null", () => {
  const cambios = armarRefrescoSnapshots(
    { bodega_siesa: "B1", codigo_co: "07" },
    { sede: { bodega_siesa: null, codigo_co: "07" } },
  );
  assert.deepEqual(cambios, { bodega_siesa: null });
});

// ─── Anulación ─────────────────────────────────────────────────────────────

test("anular: sin envíos o con solo errores no hay nada que marcar", () => {
  assert.deepEqual(planearAnulacionEnvios({ envios: [] }), { ok: true, aAnular: [] });
  const plan = planearAnulacionEnvios({ envios: [envio(ENTRADA, "error"), envio(ENTRADA, "anulado")] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.aAnular, []);
});

test("anular: un envío en curso o sin confirmar bloquea, aunque se confirme que se anuló en SIESA", () => {
  for (const estado of ["enviando", "sin_confirmar"]) {
    for (const anuladoEnSiesa of [false, true]) {
      const plan = planearAnulacionEnvios({ envios: [envio(ENTRADA, "ok"), envio(NC, estado)], anuladoEnSiesa });
      assert.equal(plan.ok, false, `${estado} anuladoEnSiesa=${anuladoEnSiesa}`);
      assert.equal(plan.status, 409);
      assert.equal(plan.codigo, "ENVIO_SIN_RESOLVER");
      assert.match(plan.mensaje, /TC PRV N12/);
    }
  }
});

test("anular: un envío ok exige confirmar que ya se anuló en SIESA", () => {
  const ok = envio(ENTRADA, "ok");
  const sin = planearAnulacionEnvios({ envios: [ok] });
  assert.equal(sin.ok, false);
  assert.equal(sin.codigo, "ANULAR_EN_SIESA");
  assert.match(sin.mensaje, /TC PRV R12/);

  const con = planearAnulacionEnvios({ envios: [ok, envio(NC, "ok"), envio(ENTRADA, "error")], anuladoEnSiesa: true });
  assert.equal(con.ok, true);
  assert.deepEqual(
    con.aAnular.map((e) => e.estado),
    ["ok", "ok"],
  );
});

// ─── Detalle de un envío ───────────────────────────────────────────────────

const RECEPCION = {
  id: 12,
  proveedor_nit: "900123456",
  proveedor_sucursal: "001",
  proveedor_razon_social: "NUTRESA S.A.S.",
  factura: "FE-00123",
  factura_siesa: null,
  bodega_siesa: "B07",
  codigo_co: "07",
  fecha_recepcion: "2026-09-30",
  sede_id: 9,
  sede: { id: 9, nombre: "Lopez" },
};
const ITEMS = [
  {
    id: 1,
    codigo_item: "15167",
    descripcion_item: "CARNE PARA MOLER",
    unidad: "KL",
    equivalencia: "Molida",
    cantidad: 100,
    valor_unitario: 20000,
    valor_total: 2000000,
    valor_fuente: "unitario",
    cantidad_devuelta: 10,
    motivo_devolucion: "Mal estado",
    orden: 1,
  },
  {
    id: 2,
    codigo_item: "20001",
    descripcion_item: "CHORIZO",
    unidad: "UND",
    equivalencia: "",
    cantidad: 20,
    valor_unitario: 5000,
    valor_total: 100000,
    valor_fuente: "unitario",
    cantidad_devuelta: 0,
    motivo_devolucion: null,
    orden: 2,
  },
];

test("detalle de la entrada: cada movimiento lleva su renglón, descripción, unidad y precio unitario", () => {
  const armado = armarEntradaProveedor({ recepcion: RECEPCION, items: ITEMS, config: DOCUMENTO_CARNES });
  assert.deepEqual(armado.bloqueos, []);
  const m = enriquecerMovimientosProveedor({
    tipo: ENTRADA,
    movimientos: armado.payload.Movimientos,
    items: ITEMS,
    sede: RECEPCION.sede,
  });
  assert.equal(m.length, 2);
  assert.equal(m[0].ITEM, "15167");
  assert.equal(m[0].sede, "Lopez");
  assert.equal(m[0].descripcion, "Molida");
  assert.equal(m[0].equivalencia, "Molida");
  assert.equal(m[0].unidad, "KL");
  assert.equal(m[0].cantidad, 100);
  assert.equal(m[0].valor_bruto, 2000000);
  assert.equal(m[0].precio_unitario, 20000);
  assert.equal(m[0].NRO_REGISTRO, "1");
  assert.equal(m[0].costo_base, null);
  assert.equal(m[0].costo_ajustado, null);
  // Sin equivalencia: la descripción de SIESA, y `equivalencia` queda null.
  assert.equal(m[1].descripcion, "CHORIZO");
  assert.equal(m[1].equivalencia, null);
  assert.equal(m[1].unidad, "UND");
});

test("detalle de la nota crédito: se empareja por la cantidad DEVUELTA", () => {
  const armado = armarNotaCreditoProveedor({
    recepcion: RECEPCION,
    items: ITEMS,
    config: { ...DOCUMENTO_NOTA_CREDITO_PROVEEDOR, idDocumento: "1", nombreDocumento: "NC", tipoDocto: "NCP" },
  });
  assert.deepEqual(armado.bloqueos, []);
  const m = enriquecerMovimientosProveedor({
    tipo: NC,
    movimientos: armado.payload.Movimientos,
    items: ITEMS,
    sede: RECEPCION.sede,
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].descripcion, "Molida");
  assert.equal(m[0].cantidad, 10);
  assert.equal(m[0].valor_bruto, 200000);
});

test("detalle: dos renglones con el mismo ítem se distinguen por la cantidad y cada uno se usa una vez", () => {
  const items = [
    { id: 1, codigo_item: "A", descripcion_item: "Uno", equivalencia: "", cantidad: 5, orden: 1 },
    { id: 2, codigo_item: "A", descripcion_item: "Dos", equivalencia: "", cantidad: 9, orden: 2 },
  ];
  const movimientos = [
    { ITEM: "A", CANTIDAD: "9.000", VALOR_BRUTO: "90", UNIDAD_MEDIDA: "KL" },
    { ITEM: "A", CANTIDAD: "5.000", VALOR_BRUTO: "50", UNIDAD_MEDIDA: "KL" },
  ];
  const m = enriquecerMovimientosProveedor({ tipo: ENTRADA, movimientos, items });
  assert.deepEqual(
    m.map((x) => x.descripcion),
    ["Dos", "Uno"],
  );
  assert.equal(m[0].sede, null);
});

test("detalle: un movimiento sin renglón (fila editada a mano) no rompe nada", () => {
  const m = enriquecerMovimientosProveedor({
    tipo: ENTRADA,
    movimientos: [{ ITEM: "ZZ", CANTIDAD: "2.000", VALOR_BRUTO: "10", UNIDAD_MEDIDA: "KL " }],
    items: ITEMS,
  });
  assert.equal(m[0].descripcion, null);
  assert.equal(m[0].unidad, "KL");
  assert.equal(m[0].precio_unitario, 5);
  assert.deepEqual(enriquecerMovimientosProveedor({ tipo: ENTRADA }), []);
});

// ─── Validación del cuerpo de los reintentos ───────────────────────────────

function correr(middleware, body) {
  const req = { body, params: { id: "12" } };
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

test("reintentarSiesaProveedor: pide el correo de quien reintenta", () => {
  assert.equal(correr(validators.reintentarSiesaProveedor, { por: "admin@merkahorro.com" }).error, undefined);
  for (const body of [{}, { por: "" }, { por: "no-es-correo" }, { por: 5 }]) {
    const { error } = correr(validators.reintentarSiesaProveedor, body);
    assert.ok(error, `debería rechazar ${JSON.stringify(body)}`);
    assert.equal(error.statusCode, 400);
  }
});
