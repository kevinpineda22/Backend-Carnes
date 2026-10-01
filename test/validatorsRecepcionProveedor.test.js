import test from "node:test";
import assert from "node:assert/strict";

import { validators } from "../src/middleware/validators.js";

// La FORMA de lo que acepta el abrir y el autoguardado de la recepción de
// proveedor. Las reglas de negocio están en shared/ (con sus propios tests); acá
// se comprueba que un valor que el plan sabe manejar no muera antes en un 400, y
// que lo imposible sí.

const CORREO = "recibidor@merkahorro.com";

/** Corre un middleware de validación y devuelve `{ error, body }`. */
function correr(middleware, body) {
  const req = { body };
  let error;
  middleware(req, {}, (e) => {
    error = e;
  });
  return { error, body: req.body };
}

const abrirValido = { proveedor_id: "12", factura: "  fe-100 ", qr_token: "a".repeat(32), recibido_por: CORREO };

test("abrir: acepta el caso feliz y normaliza tipos", () => {
  const { error, body } = correr(validators.abrirRecepcionProveedor, abrirValido);
  assert.equal(error, undefined);
  assert.equal(body.proveedor_id, 12);
  assert.equal(body.factura, "fe-100"); // la normalización fuerte (mayúsculas, clave) la hace el modelo
});

test("abrir: rechaza lo que falta o está mal, con mensaje legible", () => {
  const casos = [
    [{ ...abrirValido, proveedor_id: undefined }, /proveedor/i],
    [{ ...abrirValido, proveedor_id: "0" }, /proveedor/i],
    [{ ...abrirValido, proveedor_id: "abc" }, /proveedor/i],
    [{ ...abrirValido, factura: undefined }, /factura/i],
    [{ ...abrirValido, factura: "   " }, /factura/i],
    [{ ...abrirValido, factura: "X".repeat(41) }, /40/],
    [{ ...abrirValido, qr_token: undefined }, /QR/],
    [{ ...abrirValido, qr_token: "corto" }, /incompleto/],
    [{ ...abrirValido, recibido_por: "no-es-correo" }, /correo/i],
  ];
  for (const [body, patron] of casos) {
    const { error } = correr(validators.abrirRecepcionProveedor, body);
    assert.equal(error?.statusCode, 400, JSON.stringify(body));
    assert.match(error.message, patron);
  }
});

const guardarValido = { editado_por: CORREO, items: [] };

test("guardar: acepta cantidades como texto con coma, número o vacío", () => {
  const { error, body } = correr(validators.guardarRecepcionProveedor, {
    ...guardarValido,
    observaciones: "  llegó tarde ",
    items: [
      { id: "5", cantidad: "12,5", valor: "20.000", valor_fuente: "unitario" },
      { id: 6, cantidad: 3, cantidad_devuelta: "", motivo_devolucion: null },
      { id: 7, cantidad: "", valor: null, valor_fuente: null },
      { id: 8, cantidad: "900", confirmar_exceso: "900" },
      { id: 9, valor: "20", valor_fuente: "unitario", confirmar_valor: "20" },
    ],
  });
  assert.equal(error, undefined);
  assert.equal(body.observaciones, "  llegó tarde "); // se recorta y limpia en el modelo (normalizarObservaciones)
  assert.equal(body.items[0].id, 5);
  assert.equal(body.items[0].cantidad, "12,5"); // no se convierte acá
  assert.equal(body.items[0].valor, "20.000"); // la plata viaja como texto
});

test("guardar: items es opcional (solo observaciones)", () => {
  const { error, body } = correr(validators.guardarRecepcionProveedor, {
    editado_por: CORREO,
    observaciones: "algo",
  });
  assert.equal(error, undefined);
  assert.deepEqual(body.items, []);
});

test("guardar: la plata como NÚMERO es 400 (el navegador no manda dinero calculado)", () => {
  const { error } = correr(validators.guardarRecepcionProveedor, {
    ...guardarValido,
    items: [{ id: 1, valor: 20000, valor_fuente: "unitario" }],
  });
  assert.equal(error?.statusCode, 400);
});

test("guardar: rechaza fuente desconocida, id inválido, editor sin correo y demasiados renglones", () => {
  const malos = [
    { ...guardarValido, items: [{ id: 1, valor: "1", valor_fuente: "otra" }] },
    { ...guardarValido, items: [{ id: 0 }] },
    { ...guardarValido, items: [{ id: "x" }] },
    { items: [] },
    { ...guardarValido, editado_por: "yo" },
    { ...guardarValido, items: Array.from({ length: 301 }, (_, i) => ({ id: i + 1 })) },
    // confirmar_valor es TEXTO de plata: un booleano ya no se acepta.
    { ...guardarValido, items: [{ id: 1, confirmar_valor: true }] },
    // Tope duro contra abuso (10x los largos de negocio).
    { ...guardarValido, items: [{ id: 1, valor: "9".repeat(251), valor_fuente: "total" }] },
    { ...guardarValido, items: [{ id: 1, cantidad: "9".repeat(201) }] },
    { ...guardarValido, items: [{ id: 1, motivo_devolucion: "x".repeat(5001) }] },
    { ...guardarValido, observaciones: "x".repeat(20001) },
  ];
  for (const body of malos) {
    const { error } = correr(validators.guardarRecepcionProveedor, body);
    assert.equal(error?.statusCode, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("guardar: campos pasados del largo de negocio NO dan 400 (el plan los manda a pendientes / recorta)", () => {
  const { error, body } = correr(validators.guardarRecepcionProveedor, {
    ...guardarValido,
    observaciones: "x".repeat(2500),
    items: [
      {
        id: 1,
        valor: "9".repeat(26),
        valor_fuente: "total",
        cantidad: "1".repeat(21),
        cantidad_devuelta: "1".repeat(21),
        motivo_devolucion: "m".repeat(501),
      },
    ],
  });
  assert.equal(error, undefined);
  assert.equal(body.observaciones.length, 2500); // el recorte a 2000 lo hace el modelo
});
