import { z } from "zod";
import { createError } from "./errorHandler.js";

/* =============================================
   Validación de entrada con zod.

   Todo lo que llega del cliente pasa por acá antes de tocar un modelo. La regla
   de este archivo: los números llegan como STRING cuando vienen de un `<input>`
   o de la URL, así que se usa `coerce` en vez de exigir que el front convierta.
   Un `costo_base: "26215"` es lo normal, no un error del cliente.
   ============================================= */

const ESPECIES = ["res", "cerdo"];
const CATALOGOS = ["items", "viceras", "conceptos"];

/**
 * Código de SIESA (`f120_id`). Llega como número desde una grilla y como string
 * desde un `<input>`, así que hay que aceptar los dos.
 *
 * NO se usa `z.coerce.string()` acá, y esto es una trampa que ya mordió: `coerce`
 * hace `String(valor)`, y `String(undefined)` es `"undefined"` — un string de
 * nueve caracteres que pasa cualquier `.min(1)`. O sea que un campo AUSENTE
 * validaba bien y se guardaba en la base el texto literal "undefined" como código
 * de producto. Sin error, sin log: el renglón viajaba a SIESA con un código
 * inventado.
 *
 * La unión rechaza `undefined` antes de convertir nada.
 */
const codigoSiesa = (mensaje) =>
  z
    .union([z.string(), z.number()], {
      required_error: mensaje,
      invalid_type_error: mensaje,
    })
    .transform((v) => String(v).trim())
    .refine((v) => v.length > 0, mensaje);

/** Middleware genérico: valida `req[fuente]` contra un esquema y lo reemplaza. */
function validar(esquema, fuente = "body") {
  return (req, _res, next) => {
    const resultado = esquema.safeParse(req[fuente]);
    if (!resultado.success) {
      // Se manda el primer error, no los 38 de una grilla completa: un toast con
      // treinta líneas no se lee. El campo va incluido para poder resaltarlo.
      const primero = resultado.error.issues[0];
      const donde = primero.path.join(".");
      return next(
        createError(400, donde ? `${donde}: ${primero.message}` : primero.message),
      );
    }
    // `req.params` y `req.query` son getters en Express 5; solo se pisa el body.
    if (fuente === "body") req.body = resultado.data;
    else req.datosValidados = resultado.data;
    next();
  };
}

/** Valida `:especie` en la URL. Cualquier otra cosa es 400, no un 500 de Postgres. */
export function validarEspecie(req, _res, next) {
  if (!ESPECIES.includes(req.params.especie)) {
    return next(createError(400, `Especie inválida. Debe ser: ${ESPECIES.join(" o ")}.`));
  }
  next();
}

/** Valida `:catalogo` en la URL. */
export function validarCatalogo(req, _res, next) {
  if (!CATALOGOS.includes(req.params.catalogo)) {
    return next(
      createError(400, `Catálogo inválido. Debe ser: ${CATALOGOS.join(", ")}.`),
    );
  }
  next();
}

// ─── Esquemas ──────────────────────────────────────────────────────────────

// Los mensajes de este esquema los lee un recibidor con el celular en la mano,
// no un desarrollador leyendo un log. El default de zod para un campo ausente que
// pasa por `coerce` es "Expected number, received nan", que no le dice a nadie
// que le falta elegir la sede.
const verificarSedeSchema = z.object({
  sede_id: z.coerce
    .number({ invalid_type_error: "Elegí primero la sede en la que estás." })
    .int()
    .positive("Elegí primero la sede en la que estás."),
  // Mínimo 8 para descartar un escaneo trunco antes de ir a la base. Los tokens
  // reales son de 32 caracteres hexadecimales.
  // `required_error` y `invalid_type_error` cubren casos distintos: el primero es
  // la clave ausente, el segundo un valor del tipo equivocado. Poner solo uno
  // deja al otro con el texto por defecto de zod ("Required").
  qr_token: z
    .string({
      required_error: "Escaneá el código QR de la sede.",
      invalid_type_error: "Escaneá el código QR de la sede.",
    })
    .trim()
    .min(8, "El código quedó incompleto. Volvé a escanear.")
    .max(64),
});

/** Fila de la plantilla de cortes. */
const itemSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  codigo_tabla: z.coerce.number().int().nonnegative(),
  codigo_item: codigoSiesa("El código de SIESA es obligatorio"),
  descripcion: z.string().trim().min(1, "La descripción es obligatoria"),
  costo_base: z.coerce.number().nonnegative().default(0),
  orden: z.coerce.number().int().nonnegative().default(0),
  activo: z.coerce.boolean().default(true),
  // Cómo se llama este corte en el PDF del frigorífico. Vacío = sin mapear, y
  // el cruce lo reporta como tal en vez de darlo por cuadrado. Se guarda "" como
  // null para que la columna tenga un solo valor para "no configurado".
  nombre_desposte: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
});

const viceraSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  bloque: z.enum(["bonificacion", "informativo"]),
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  precio: z.coerce.number().nonnegative().default(0),
  orden: z.coerce.number().int().nonnegative().default(0),
  activo: z.coerce.boolean().default(true),
});

const conceptoSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  // Solo 1 o -1: es lo que decide si un concepto SUMA o RESTA del costo real.
  // Un 0 o un 2 acá desvía toda la plata del prorrateo.
  signo: z.coerce.number().refine((n) => n === 1 || n === -1, "El signo debe ser 1 o -1").default(1),
  orden: z.coerce.number().int().nonnegative().default(0),
  activo: z.coerce.boolean().default(true),
});

const SCHEMAS_POR_CATALOGO = {
  items: itemSchema,
  viceras: viceraSchema,
  conceptos: conceptoSchema,
};

/**
 * Valida el body contra el esquema del catálogo que dice la URL.
 *
 * Se resuelve en tiempo de request y no al montar la ruta porque el catálogo
 * viene en `:catalogo`. Un solo endpoint sirve a los tres, cada uno con sus
 * propias reglas.
 *
 * @param {"fila"|"lote"} forma
 */
export function validarCatalogoBody(forma) {
  return (req, res, next) => {
    const base = SCHEMAS_POR_CATALOGO[req.params.catalogo];
    if (!base) return next(createError(400, "Catálogo inválido."));

    const esquema =
      forma === "lote"
        ? z.object({ filas: z.array(base) })
        : base.partial({ activo: true, orden: true });

    return validar(esquema)(req, res, next);
  };
}

/**
 * Correo de quien opera. Es la trazabilidad: sin esto no se sabe quién recibió
 * ni quién aprobó.
 *
 * El mismo mensaje cubre los tres casos (ausente, tipo equivocado, formato malo)
 * porque para quien lo lee son el mismo problema: el correo no sirve. El default
 * de zod para la clave ausente es "Required", que en pantalla no dice nada.
 */
const correo = (mensaje) =>
  z
    .string({ required_error: mensaje, invalid_type_error: mensaje })
    .trim()
    .email(mensaje)
    .max(150);

const abrirRecepcionSchema = z.object({
  especie: z.enum(ESPECIES, { errorMap: () => ({ message: "Elegí Res o Cerdo." }) }),
  // Opcional: la sede sale del QR, que es único por sede. Se sigue aceptando
  // para el front viejo, que la hacía elegir en una lista antes de escanear.
  sede_id: z.coerce
    .number({ invalid_type_error: "La sede no es válida." })
    .int()
    .positive("La sede no es válida.")
    .optional(),
  qr_token: z
    .string({
      required_error: "Escaneá el código QR de la sede.",
      invalid_type_error: "Escaneá el código QR de la sede.",
    })
    .trim()
    .min(8, "El código quedó incompleto. Volvé a escanear.")
    .max(64),
  recibido_por: correo("El correo del recibidor no es válido."),
  // `YYYY-MM-DD`. Se acepta que venga del cliente para poder cargar una entrega
  // de ayer, pero el default lo pone el servidor: la fecha del celular puede
  // estar mal y nadie lo nota hasta que un documento cae en el mes equivocado.
  fecha_ingreso: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")
    .optional(),
  novillos: z.coerce.number().nonnegative().default(0),
});

const guardarBorradorSchema = z.object({
  novillos: z.coerce.number().nonnegative().optional(),
  observaciones: z.string().trim().max(2000).nullable().optional(),
  items: z
    .array(
      z.object({
        id: z.coerce.number().int().positive(),
        // Kilos: decimales SIEMPRE. Negativo no — una cantidad negativa restaría
        // del total y dejaría el prorrateo repartiendo plata que no existe.
        cantidad: z.coerce
          .number({ invalid_type_error: "La cantidad debe ser un número." })
          .nonnegative("La cantidad no puede ser negativa."),
      }),
    )
    .default([]),
});

export const validators = {
  verificarSede: validar(verificarSedeSchema),

  abrirRecepcion: validar(abrirRecepcionSchema),
  guardarBorrador: validar(guardarBorradorSchema),

  agregarAdicional: validar(
    z.object({
      descripcion: z
        .string({ required_error: "Escribí qué llegó." })
        .trim()
        .min(2, "Escribí qué llegó.")
        .max(200),
      cantidad: z.coerce.number().nonnegative("La cantidad no puede ser negativa.").default(0),
    }),
  ),

  finalizar: validar(
    z.object({ recibido_por: correo("El correo del recibidor no es válido.").optional() }),
  ),

  // El costo base es obligatorio y POSITIVO: un adicional homologado con costo 0
  // entra a SIESA valiendo cero y deja el margen de ese producto en 100%. Sube
  // sin error, así que no lo descubre nadie.
  homologarAdicional: validar(
    z.object({
      codigo_item: codigoSiesa("Falta el código de SIESA."),
      codigo_tabla: z.coerce.number().int().nonnegative().optional(),
      descripcion: z.string().trim().min(1).max(200).optional(),
      costo_base: z.coerce
        .number({ required_error: "Falta el costo base." })
        .positive("El costo base tiene que ser mayor a 0."),
    }),
  ),

  // Corrección del admin sobre un renglón cerrado. Todo opcional: se manda
  // solo lo que cambió. `editado_por` sí es obligatorio — sin él la corrección
  // queda anónima, y el rastro es la mitad del punto de este endpoint.
  editarItem: validar(
    z.object({
      cantidad: z.coerce
        .number({ invalid_type_error: "La cantidad debe ser un número." })
        .nonnegative("La cantidad no puede ser negativa.")
        .optional(),
      costo_base: z.coerce
        .number({ invalid_type_error: "El costo base debe ser un número." })
        .nonnegative("El costo base no puede ser negativo.")
        .optional(),
      codigo_item: z.union([z.string(), z.number()]).transform((x) => String(x).trim()).optional(),
      descripcion: z.string().trim().min(1, "La descripción no puede quedar vacía.").max(200).optional(),
      editado_por: correo("Falta el correo de quien edita."),
    }),
  ),

  // Beneficiarios de una liquidación. El nombre y la cuenta se escriben a mano
  // —no hay maestro de terceros acá—; lo que importa es que la suma cuadre con
  // los gastos, y eso se valida al costear, no al guardar.
  guardarPagos: validar(
    z.object({
      filas: z
        .array(
          z.object({
            id: z.coerce.number().int().positive().optional(),
            nombre: z.string().trim().min(1, "El beneficiario necesita un nombre.").max(120),
            cuenta: z.string().trim().max(80).nullable().optional(),
            valor: z.coerce
              .number({ invalid_type_error: "El valor debe ser un número." })
              .nonnegative("El valor no puede ser negativo."),
            orden: z.coerce.number().int().nonnegative().optional(),
          }),
        )
        .default([]),
    }),
  ),

  crearLiquidacion: validar(
    z.object({
      especie: z.enum(ESPECIES, { errorMap: () => ({ message: "Elegí Res o Cerdo." }) }),
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")
        .optional(),
      proveedor: z.string().trim().max(120).nullable().optional(),
      viceras_bonificacion: z.coerce.boolean().default(false),
    }),
  ),

  actualizarLiquidacion: validar(
    z.object({
      fecha: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")
        .optional(),
      proveedor: z.string().trim().max(120).nullable().optional(),
      viceras_bonificacion: z.coerce.boolean().optional(),
      observaciones: z.string().trim().max(2000).nullable().optional(),
    }),
  ),

  guardarGastos: validar(
    z.object({
      filas: z
        .array(
          z.object({
            id: z.coerce.number().int().positive().optional(),
            concepto_id: z.coerce.number().int().positive().nullable().optional(),
            concepto: z.string().trim().min(1, "El concepto es obligatorio").max(80),
            // Solo 1 o -1 — ver `carnes_conceptos_gasto.signo`. Un 0 acá anularía
            // el gasto sin que nada lo diga.
            signo: z.coerce
              .number()
              .refine((n) => n === 1 || n === -1, "El signo debe ser 1 o -1")
              .default(1),
            // Se permite negativo: así es como el admin carga hoy las retomas de
            // res, que en el Excel suman con el valor en negativo.
            valor: z.coerce.number({ invalid_type_error: "El valor debe ser un número." }),
            observaciones: z.string().trim().max(500).nullable().optional(),
          }),
        )
        .default([]),
    }),
  ),

  vincularRecepciones: validar(
    z.object({
      recepcion_ids: z
        .array(z.coerce.number().int().positive())
        .min(1, "Elegí al menos una recepción."),
    }),
  ),

  reordenar: validar(
    z.object({
      orden: z
        .array(
          z.object({
            id: z.coerce.number().int().positive(),
            orden: z.coerce.number().int().nonnegative(),
          }),
        )
        .min(1, "No hay nada que reordenar"),
    }),
  ),

  actualizarSede: validar(
    z.object({
      codigo_co: z.string().trim().max(10).nullable().optional(),
      nombre: z.string().trim().min(1).max(80).optional(),
      activo: z.coerce.boolean().optional(),
      // Cadena "Sub Cliente" del informe de desposte, ej. "MK - 380 - BARRIO
      // LOPEZ". Es lo que permite detectar que el admin adjuntó el PDF de otra
      // sede sin que nadie lo lea a ojo.
      subcliente_desposte: z
        .string()
        .trim()
        .max(120)
        .nullable()
        .optional()
        .transform((v) => (v ? v : null)),
    }),
  ),
};
