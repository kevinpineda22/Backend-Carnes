import test from "node:test";
import assert from "node:assert/strict";

import {
  LARGO_MAX_FIRMA,
  MENSAJE_CAMBIO_AL_FINALIZAR,
  PREFIJO_FIRMA,
  armarActualizacionFinalizar,
  armarRecibidor,
  debeEnviarEntrada,
  decidirFinalizar,
  idRecibidorListado,
  normalizarCedula,
  normalizarNombre,
  notaCreditoRequerida,
  armarFirmaProveedor,
  firmaProveedorRequerida,
  validarCedula,
  validarFirma,
  validarNombre,
  validarPersona,
} from "../src/shared/finalizarProveedor.js";
import { ESTADOS } from "../src/shared/estadosProveedor.js";

// ─── Firma ─────────────────────────────────────────────────────────────────

/** Un PNG mínimo VÁLIDO: firma de 8 bytes + chunk IHDR completo (33 bytes). */
function pngMinimo() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
    Buffer.alloc(13),
    Buffer.alloc(4),
  ]);
}
const dataUrl = (bytes) => PREFIJO_FIRMA + bytes.toString("base64");
const FIRMA_OK = dataUrl(pngMinimo());

test("firma: un PNG en data URL válido pasa", () => {
  const r = validarFirma(FIRMA_OK);
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 33);
});

test("firma: ausente, vacía o no-string -> FIRMA_REQUERIDA", () => {
  for (const f of [undefined, null, "", "   ", 123, {}]) {
    const r = validarFirma(f);
    assert.equal(r.ok, false, String(f));
    assert.equal(r.codigo, "FIRMA_REQUERIDA");
  }
});

test("firma: solo se acepta data:image/png;base64", () => {
  const casos = [
    "data:image/jpeg;base64," + pngMinimo().toString("base64"),
    "data:image/png;base64" + pngMinimo().toString("base64"), // sin coma
    "image/png;base64," + pngMinimo().toString("base64"),
    "DATA:image/png;base64," + pngMinimo().toString("base64"),
    "https://ejemplo.com/firma.png",
  ];
  for (const f of casos) {
    const r = validarFirma(f);
    assert.equal(r.ok, false, f.slice(0, 40));
    assert.equal(r.codigo, "FIRMA_INVALIDA");
  }
});

test("firma: base64 mal formado se rechaza (alfabeto, relleno, largo)", () => {
  // 34 bytes -> 48 caracteres con relleno "==" al final (los 33 bytes del PNG mínimo no llevan relleno).
  const bueno = Buffer.concat([pngMinimo(), Buffer.from([1])]).toString("base64");
  assert.ok(bueno.endsWith("=="));
  assert.equal(validarFirma(PREFIJO_FIRMA + bueno).ok, true); // el control: bien formado pasa
  const casos = [
    PREFIJO_FIRMA, // cuerpo vacío
    PREFIJO_FIRMA + "hola mundo!!", // alfabeto
    PREFIJO_FIRMA + "@@@@",
    PREFIJO_FIRMA + bueno.slice(0, -1), // largo no múltiplo de 4
    PREFIJO_FIRMA + "=" + bueno.slice(1), // relleno al principio
    PREFIJO_FIRMA + bueno + "AAAA", // relleno en el medio (después de él no puede haber más datos)
  ];
  for (const f of casos) {
    const r = validarFirma(f);
    assert.equal(r.ok, false, f.slice(22, 60));
    assert.equal(r.codigo, "FIRMA_INVALIDA");
  }
});

test("firma: base64 decodificable que NO es un PNG se rechaza", () => {
  const casos = [
    Buffer.from("esto no es una imagen, es texto plano de más de treinta y tres bytes"),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(1)]), // JPEG
    pngMinimo().subarray(0, 20), // PNG truncado antes del IHDR completo
  ];
  for (const bytes of casos) {
    const r = validarFirma(dataUrl(bytes));
    assert.equal(r.ok, false);
    assert.equal(r.codigo, "FIRMA_INVALIDA");
  }
  // Firma PNG correcta pero el primer chunk no es IHDR.
  const sinIhdr = pngMinimo();
  sinIhdr.write("IDAT", 12, "latin1");
  assert.equal(validarFirma(dataUrl(sinIhdr)).ok, false);
});

test("firma: el tope es 500.000 caracteres del data URL completo", () => {
  // Relleno válido de base64 detrás de un PNG correcto: el largo manda antes que el contenido.
  const justo = PREFIJO_FIRMA + pngMinimo().toString("base64");
  assert.equal(validarFirma(justo).ok, true);

  const grande = PREFIJO_FIRMA + "A".repeat(LARGO_MAX_FIRMA - PREFIJO_FIRMA.length + 4);
  assert.ok(grande.length > LARGO_MAX_FIRMA);
  const r = validarFirma(grande);
  assert.equal(r.ok, false);
  assert.equal(r.codigo, "FIRMA_GRANDE");

  // Exactamente en el tope no es "grande" (puede fallar por otra razón, no por tamaño).
  const enElTope = PREFIJO_FIRMA + "A".repeat(LARGO_MAX_FIRMA - PREFIJO_FIRMA.length);
  assert.notEqual(validarFirma(enElTope).codigo, "FIRMA_GRANDE");
});

// ─── Personas ──────────────────────────────────────────────────────────────

test("normalizar: nombre colapsa espacios y cédula quita puntos y espacios", () => {
  assert.equal(normalizarNombre("  Juan   Pérez \n Gómez "), "Juan Pérez Gómez");
  assert.equal(normalizarNombre(null), "");
  assert.equal(normalizarCedula(" 1.035.869.866 "), "1035869866");
  assert.equal(normalizarCedula(70139437), "70139437");
  assert.equal(normalizarCedula("12-345"), "12-345"); // el guion NO se borra: lo rechaza validarCedula
});

test("validarNombre: mínimo 3 letras, máximo 120, respeta tildes y mayúsculas", () => {
  assert.deepEqual(validarNombre("  Ana   Ñañez "), { ok: true, valor: "Ana Ñañez" });
  for (const malo of ["", "  ", "Al", "12345", "A 1 2", null, undefined]) {
    const r = validarNombre(malo);
    assert.equal(r.ok, false, String(malo));
    assert.equal(r.campo, "nombre");
  }
  assert.equal(validarNombre("A".repeat(120)).ok, true);
  assert.equal(validarNombre("A".repeat(121)).ok, false);
});

test("validarCedula: 5 a 12 dígitos; acepta puntos y número JS", () => {
  assert.deepEqual(validarCedula("1.035.869.866"), { ok: true, valor: "1035869866" });
  assert.deepEqual(validarCedula(6477871), { ok: true, valor: "6477871" });
  assert.equal(validarCedula("12345").ok, true);
  assert.equal(validarCedula("123456789012").ok, true);
  for (const mala of ["", "1234", "1234567890123", "12a456", "12-345", "-12345", "12 3", null, undefined, "1e10"]) {
    const r = validarCedula(mala);
    // "12 3" -> "123" son 3 dígitos: también inválida
    assert.equal(r.ok, false, String(mala));
    assert.equal(r.campo, "cedula");
  }
});

test("validarPersona: pide los dos y reporta el primero que falla", () => {
  assert.deepEqual(validarPersona({ nombre: "Ana Gómez", cedula: "1.000.000" }), {
    ok: true,
    nombre: "Ana Gómez",
    cedula: "1000000",
  });
  assert.equal(validarPersona({ nombre: "Ana Gómez" }).campo, "cedula");
  assert.equal(validarPersona({ cedula: "1000000" }).campo, "nombre");
  assert.equal(validarPersona().ok, false);
});

// ─── Recibidor ─────────────────────────────────────────────────────────────

const FILA = { id: 4, cedula: "43917420", nombre: "NARANJO ARIAS MARTHA LUCIA", activo: true };

test("idRecibidorListado: null para Otro, vacío o ausente", () => {
  assert.equal(idRecibidorListado({ id: 4 }), 4);
  assert.equal(idRecibidorListado({ id: "4" }), "4");
  assert.equal(idRecibidorListado({ otro: true, id: 4 }), null);
  assert.equal(idRecibidorListado({ id: null }), null);
  assert.equal(idRecibidorListado({ id: "" }), null);
  assert.equal(idRecibidorListado({}), null);
  assert.equal(idRecibidorListado(undefined), null);
});

test("recibidor de la lista: el snapshot sale de la FILA, no de lo que mande el cliente", () => {
  const r = armarRecibidor({
    // Un cliente alterado intenta firmar con otro nombre y otra cédula.
    recibidor: { id: 4, nombre: "NOMBRE FALSO", cedula: "999999999" },
    fila: FILA,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.valores, {
    recibidor_id: 4,
    recibidor_cedula: "43917420",
    recibidor_nombre: "NARANJO ARIAS MARTHA LUCIA",
    recibidor_otro: false,
  });
});

test("recibidor de la lista: inexistente o inactivo -> 409 RECIBIDOR_NO_DISPONIBLE", () => {
  for (const fila of [null, undefined, { ...FILA, activo: false }, { ...FILA, id: 5 }]) {
    const r = armarRecibidor({ recibidor: { id: 4 }, fila });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.codigo, "RECIBIDOR_NO_DISPONIBLE");
  }
});

test("Otro: exige nombre Y cédula, guarda snapshot normalizado y sin id", () => {
  const r = armarRecibidor({ recibidor: { otro: true, nombre: " Pedro   Pérez ", cedula: "1.020.304.050" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.valores, {
    recibidor_id: null,
    recibidor_cedula: "1020304050",
    recibidor_nombre: "Pedro Pérez",
    recibidor_otro: true,
  });

  for (const recibidor of [
    { otro: true },
    { otro: true, nombre: "Pedro Pérez" },
    { otro: true, cedula: "1020304050" },
    { otro: true, nombre: "  ", cedula: "1020304050" },
    { otro: true, nombre: "Pedro Pérez", cedula: "   " },
    { otro: true, nombre: "Pe", cedula: "1020304050" },
    { otro: true, nombre: "Pedro Pérez", cedula: "abc" },
  ]) {
    const mal = armarRecibidor({ recibidor });
    assert.equal(mal.ok, false, JSON.stringify(recibidor));
    assert.equal(mal.status, 400);
    assert.equal(mal.codigo, "RECIBIDOR_INVALIDO");
  }
});

test("recibidor: sin nada, o mezclando lista y Otro, es 400", () => {
  for (const recibidor of [undefined, null, {}, { id: null }, { otro: false }, "x"]) {
    const r = armarRecibidor({ recibidor, fila: FILA });
    assert.equal(r.ok, false, JSON.stringify(recibidor));
    assert.equal(r.status, 400);
    assert.equal(r.codigo, "RECIBIDOR_REQUERIDO");
  }
  const mezcla = armarRecibidor({ recibidor: { otro: true, id: 4, nombre: "Pedro Pérez", cedula: "1020304050" } });
  assert.equal(mezcla.ok, false);
  assert.equal(mezcla.codigo, "RECIBIDOR_AMBIGUO");
});

// ─── Decisión ──────────────────────────────────────────────────────────────

test("decidirFinalizar: Borrador firma; firmadas reintentan SIN firmar; Anulada se rechaza", () => {
  assert.deepEqual(decidirFinalizar(ESTADOS.BORRADOR), { accion: "finalizar" });
  assert.deepEqual(decidirFinalizar(ESTADOS.FINALIZADA), { accion: "reintento" });
  assert.deepEqual(decidirFinalizar(ESTADOS.ENVIADA_SIESA), { accion: "reintento" });

  const anulada = decidirFinalizar(ESTADOS.ANULADA);
  assert.equal(anulada.accion, "rechazar");
  assert.equal(anulada.status, 409);
  assert.equal(anulada.codigo, "RECEPCION_ANULADA");

  const rara = decidirFinalizar("Otra");
  assert.equal(rara.accion, "rechazar");
  assert.equal(rara.status, 409);
});

test("MENSAJE_CAMBIO_AL_FINALIZAR dice que hay que revisar y firmar de nuevo", () => {
  assert.match(MENSAJE_CAMBIO_AL_FINALIZAR, /cambió mientras finalizabas/);
  assert.match(MENSAJE_CAMBIO_AL_FINALIZAR, /firmá de nuevo/);
});

// ─── Actualización ─────────────────────────────────────────────────────────

const VALORES = {
  recibidor_id: 4,
  recibidor_cedula: "43917420",
  recibidor_nombre: "NARANJO ARIAS MARTHA LUCIA",
  recibidor_otro: false,
};

test("armarActualizacionFinalizar: todo en un solo objeto, con la fecha de Bogotá de AHORA", () => {
  // 2026-09-30 23:30 en Bogotá (UTC-5) = 2026-10-01T04:30Z: en UTC ya es "mañana".
  const ahora = new Date("2026-10-01T04:30:00Z");
  const cambios = armarActualizacionFinalizar({
    valores: VALORES,
    firma: FIRMA_OK,
    por: "recibidor@merkahorro.com",
    proveedor: { nit: "900123", sucursal: "001", razon_social: "NUTRESA S.A." },
    sede: { codigo_co: "003", bodega_siesa: "B01" },
    ahora,
  });
  assert.deepEqual(cambios, {
    estado: "Finalizada",
    fecha_recepcion: "2026-09-30", // NO "2026-10-01"
    finalizado_at: "2026-10-01T04:30:00.000Z",
    recibido_por: "recibidor@merkahorro.com",
    ...VALORES,
    firma_data: FIRMA_OK,
    proveedor_nit: "900123",
    proveedor_sucursal: "001",
    proveedor_razon_social: "NUTRESA S.A.",
    bodega_siesa: "B01",
    codigo_co: "003",
  });
});

test("armarActualizacionFinalizar: sin maestros deja los snapshots como están; un maestro vacío sí se refleja", () => {
  const ahora = new Date("2026-09-30T15:00:00Z");
  const sinMaestros = armarActualizacionFinalizar({ valores: VALORES, firma: FIRMA_OK, por: "a@b.co", ahora });
  for (const k of ["proveedor_nit", "proveedor_sucursal", "proveedor_razon_social", "bodega_siesa", "codigo_co"]) {
    assert.equal(k in sinMaestros, false, k);
  }
  // Si el admin vació la bodega del maestro, el snapshot refleja que ya no hay (el envío se bloqueará).
  const vacia = armarActualizacionFinalizar({
    valores: VALORES,
    firma: FIRMA_OK,
    por: "a@b.co",
    sede: { codigo_co: "003", bodega_siesa: null },
    ahora,
  });
  assert.equal(vacia.bodega_siesa, null);
  assert.equal(vacia.codigo_co, "003");
});

// ─── Después de firmar ─────────────────────────────────────────────────────

test("debeEnviarEntrada [J12]: solo Finalizada y SIN ningún envío de entrada", () => {
  assert.equal(debeEnviarEntrada({ estado: "Finalizada", enviosEntrada: [] }), true);
  assert.equal(debeEnviarEntrada({ estado: "Finalizada" }), true);
  // Un envío en CUALQUIER estado (incluido error) impide el reenvío automático.
  for (const estado of ["ok", "error", "enviando", "sin_confirmar", "anulado"]) {
    assert.equal(debeEnviarEntrada({ estado: "Finalizada", enviosEntrada: [{ estado }] }), false, estado);
  }
  assert.equal(debeEnviarEntrada({ estado: "Enviada_SIESA", enviosEntrada: [] }), false);
  assert.equal(debeEnviarEntrada({ estado: "Borrador", enviosEntrada: [] }), false);
  assert.equal(debeEnviarEntrada({ estado: "Anulada", enviosEntrada: [] }), false);
  assert.equal(debeEnviarEntrada(), false);
});

test("notaCreditoRequerida: solo si algún renglón tiene devolución", () => {
  assert.equal(notaCreditoRequerida({ renglones_con_devolucion: 1 }), true);
  assert.equal(notaCreditoRequerida({ renglones_con_devolucion: 0 }), false);
  assert.equal(notaCreditoRequerida({}), false);
  assert.equal(notaCreditoRequerida(undefined), false);
});

// ─── Firma del proveedor (devoluciones) ────────────────────────────────────

const CON_DEVOLUCION = { renglones_con_devolucion: 1 };
const SIN_DEVOLUCION = { renglones_con_devolucion: 0 };
const FIRMANTE = { nombre: "  Carlos   Gómez ", documento: "1.020.304.050", firma_data: FIRMA_OK };

test("firmaProveedorRequerida: solo con algún renglón devuelto", () => {
  assert.equal(firmaProveedorRequerida(CON_DEVOLUCION), true);
  assert.equal(firmaProveedorRequerida(SIN_DEVOLUCION), false);
  assert.equal(firmaProveedorRequerida(undefined), false);
});

test("armarFirmaProveedor: con devolución exige nombre, documento y firma, y guarda el snapshot normalizado", () => {
  const r = armarFirmaProveedor({ resumen: CON_DEVOLUCION, firmante: FIRMANTE });
  assert.deepEqual(r, {
    ok: true,
    valores: {
      proveedor_firma: FIRMA_OK,
      proveedor_firma_nombre: "Carlos Gómez",
      proveedor_firma_documento: "1020304050",
    },
  });
});

test("armarFirmaProveedor: sin devolución no se exige y se ignora lo que mande el cliente", () => {
  assert.deepEqual(armarFirmaProveedor({ resumen: SIN_DEVOLUCION }), { ok: true, valores: null });
  assert.deepEqual(armarFirmaProveedor({ resumen: SIN_DEVOLUCION, firmante: FIRMANTE }), { ok: true, valores: null });
});

test("armarFirmaProveedor: cada dato faltante tiene su código (400)", () => {
  const caso = (firmante) => armarFirmaProveedor({ resumen: CON_DEVOLUCION, firmante });
  const esperar = (r, codigo) => {
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.codigo, codigo);
  };
  esperar(caso(undefined), "FIRMA_PROVEEDOR_NOMBRE_REQUERIDO");
  esperar(caso({ ...FIRMANTE, nombre: "   " }), "FIRMA_PROVEEDOR_NOMBRE_REQUERIDO");
  esperar(caso({ ...FIRMANTE, nombre: "Al" }), "FIRMA_PROVEEDOR_NOMBRE_INVALIDO");
  esperar(caso({ ...FIRMANTE, documento: "" }), "FIRMA_PROVEEDOR_DOCUMENTO_REQUERIDO");
  esperar(caso({ ...FIRMANTE, documento: undefined }), "FIRMA_PROVEEDOR_DOCUMENTO_REQUERIDO");
  esperar(caso({ ...FIRMANTE, documento: "12ab" }), "FIRMA_PROVEEDOR_DOCUMENTO_INVALIDO");
  esperar(caso({ ...FIRMANTE, firma_data: undefined }), "FIRMA_PROVEEDOR_REQUERIDA");
  esperar(caso({ ...FIRMANTE, firma_data: " " }), "FIRMA_PROVEEDOR_REQUERIDA");
  esperar(caso({ ...FIRMANTE, firma_data: "data:image/png;base64,hola" }), "FIRMA_PROVEEDOR_INVALIDA");
  esperar(
    caso({ ...FIRMANTE, firma_data: PREFIJO_FIRMA + "A".repeat(LARGO_MAX_FIRMA) }),
    "FIRMA_PROVEEDOR_GRANDE",
  );
});

test("armarActualizacionFinalizar: las columnas del proveedor solo viajan si hay firma del proveedor", () => {
  const base = { valores: VALORES, firma: FIRMA_OK, por: "a@b.co", ahora: new Date("2026-09-30T15:00:00Z") };
  const sin = armarActualizacionFinalizar({ ...base, firmaProveedor: null });
  assert.equal("proveedor_firma" in sin, false);
  const firmaProveedor = {
    proveedor_firma: FIRMA_OK,
    proveedor_firma_nombre: "Carlos Gómez",
    proveedor_firma_documento: "1020304050",
  };
  assert.deepEqual(armarActualizacionFinalizar({ ...base, firmaProveedor }), { ...sin, ...firmaProveedor });
});
