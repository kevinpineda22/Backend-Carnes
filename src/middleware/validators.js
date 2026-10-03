import { z } from "zod";
import { createError } from "./errorHandler.js";
import { ESTADOS as ESTADOS_PROVEEDOR } from "../shared/estadosProveedor.js";
import { normalizarFactura } from "../shared/proveedorValores.js";
import { LIMITE_LISTA_DEFECTO, LIMITE_LISTA_MAX } from "../shared/adminProveedor.js";
import { TOPE_COLUMNAS_CARGA, TOPE_FILAS_CARGA } from "../shared/plantillaProveedor.js";

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
  // OPCIONAL, a diferencia del de `items`: Viceras y Entrañita no tienen
  // homólogo en SIESA y eso no tiene que bloquear el catálogo — ver
  // `vaASiesa` en `shared/visceras.js`. "" o ausente → null.
  codigo_item: z
    .union([z.string(), z.number()])
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined ? null : String(v).trim() || null)),
  unidad: z.enum(["KL", "UND"], { errorMap: () => ({ message: "La unidad debe ser KL o UND." }) }).default("KL"),
  // NULL = el recibidor la pesa/cuenta a mano. Con valor: se calcula sola como
  // `factor_novillo × recepcion.novillos` (`shared/visceras.js`).
  factor_novillo: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number({ invalid_type_error: "El factor por novillo debe ser un número." }).nonnegative().nullable(),
  ).optional(),
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

/**
 * Número opcional y no negativo, para campos donde "no cargado" tiene que
 * quedar en `null` y no en `0` (Peso y Precio KL de un gasto, ver
 * `guardarGastos`). `""` es lo que manda un `<input type="number">` vacío, y
 * `z.coerce.number()` lo convierte en `0` en vez de fallar — por eso el
 * `preprocess` intercepta la cadena vacía ANTES de que `coerce` la toque.
 */
const numeroOpcionalNoNegativo = (mensaje) =>
  z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number({ invalid_type_error: mensaje }).nonnegative(mensaje).nullable(),
  ).optional();

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

// ─── Proveedores (recibidor de facturas) ───────────────────────────────────

/** `:id` de la URL. Sin esto, "abc" llega a Postgres y vuelve como un 500. */
const idParamSchema = z.object({
  id: z.coerce
    .number({ invalid_type_error: "El id no es válido." })
    .int("El id no es válido.")
    .positive("El id no es válido.")
    .safe("El id no es válido."),
});

// `con_plantilla=1` es la forma en que lo manda el front; "true" se acepta porque
// es lo que escribiría cualquiera probando la URL a mano.
const listarProveedoresQuerySchema = z.object({
  con_plantilla: z
    // Solo `errorMap`: zod lanza si se combina con `invalid_type_error`.
    .enum(["1", "true", "0", "false"], {
      errorMap: () => ({ message: "con_plantilla debe ser 1 o 0." }),
    })
    .optional(),
});

// ─── Plantilla de un proveedor: carga desde el admin ───────────────────────

/**
 * Una celda de la hoja tal como la deja `sheet_to_json({ header: 1 })`: texto,
 * número, booleano o `null` (celda vacía). Nada de objetos ni arreglos anidados.
 */
const celdaDeHoja = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()], {
  errorMap: () => ({ message: "La hoja trae una celda que no es válida." }),
});

/**
 * PUT /proveedores/:id/plantilla. `filas` es la hoja COMPLETA, encabezado incluido
 * (el normalizador busca los nombres de columna). `aplicar` es un booleano de
 * verdad y por defecto `false`: sin él la petición es solo una vista previa y no
 * escribe nada. "true" como texto es 400 — una carga que se aplica por un valor
 * que se coló como string sería el peor error posible acá.
 */
const cargarPlantillaProveedorSchema = z.object({
  por: correo("El correo de quien carga la plantilla no es válido."),
  filas: z
    .array(
      z
        .array(celdaDeHoja, { invalid_type_error: "La hoja trae una fila que no es válida." })
        .max(TOPE_COLUMNAS_CARGA, `La hoja trae filas con más de ${TOPE_COLUMNAS_CARGA} columnas.`),
      {
        required_error: "Falta la hoja con la plantilla.",
        invalid_type_error: "Las filas de la hoja no son válidas.",
      },
    )
    .min(1, "La hoja está vacía.")
    .max(
      TOPE_FILAS_CARGA,
      `La hoja trae más de ${TOPE_FILAS_CARGA} filas. Dejá solo la plantilla del proveedor.`,
    ),
  aplicar: z.boolean({ invalid_type_error: "debe ser true o false." }).default(false),
});

// ─── Recepción de proveedor: abrir y autoguardar ───────────────────────────

const abrirRecepcionProveedorSchema = z.object({
  proveedor_id: z.coerce
    .number({ invalid_type_error: "Elegí el proveedor." })
    .int("Elegí el proveedor.")
    .positive("Elegí el proveedor.")
    .safe("Elegí el proveedor."),
  // La factura se normaliza en el modelo (mayúsculas, espacios, clave). Acá solo
  // que exista y que quepa en VARCHAR(40); una clave vacía (solo símbolos) la
  // rechaza el modelo con su propio mensaje.
  factura: z
    .string({
      required_error: "Escribí el número de factura.",
      invalid_type_error: "Escribí el número de factura.",
    })
    .trim()
    .min(1, "Escribí el número de factura.")
    .max(40, "El número de factura no puede pasar de 40 caracteres."),
  qr_token: z
    .string({
      required_error: "Escaneá el código QR de la sede.",
      invalid_type_error: "Escaneá el código QR de la sede.",
    })
    .trim()
    .min(8, "El código quedó incompleto. Volvé a escanear.")
    .max(64),
  recibido_por: correo("El correo del recibidor no es válido."),
});

/**
 * Campos del autoguardado de proveedor: los topes de ACÁ son un tope duro de
 * 10x contra abuso, no la regla de negocio. Los largos que de verdad aplican
 * (valor 25, cantidad 20, motivo 500, observaciones 2000) los decide el plan del
 * guardado (`shared/guardadoProveedor.js`): un campo largo se rechaza SOLO a
 * él y vuelve en `pendientes`, o (observaciones) se recorta — no tumba el
 * autoguardado entero con un 400.
 *
 * Los números pueden llegar como texto ("12,5") o como número; no se convierten
 * acá: un valor que no se entiende es un `pendiente`, no un 400.
 */
const numeroOTexto = z.union([z.string().max(200), z.number()]);

const guardarRecepcionProveedorSchema = z.object({
  editado_por: correo("El correo de quien edita no es válido."),
  observaciones: z.string().max(20000).nullable().optional(),
  items: z
    .array(
      z.object({
        id: z.coerce.number().int().positive(),
        cantidad: numeroOTexto.nullish(),
        // La plata viaja SIEMPRE como texto: el navegador no calcula dinero que
        // el backend crea. Se interpreta con `parsearPesos`.
        valor: z.string().max(250).nullable().optional(),
        valor_fuente: z.enum(["unitario", "total"]).nullish(),
        cantidad_devuelta: numeroOTexto.nullish(),
        motivo_devolucion: z.string().max(5000).nullable().optional(),
        // La cantidad que el recibidor confirmó (mismo formato que `cantidad`).
        confirmar_exceso: numeroOTexto.nullish(),
        // El unitario que confirmó, como texto de plata con hasta 4 decimales
        // ("33.333,3333"); debe coincidir con el unitario resultante.
        confirmar_valor: z.string().max(250).nullish(),
      }),
    )
    .max(300, "Demasiados renglones en un solo guardado.")
    .default([]),
});

// ─── Recepción de proveedor: finalizar (firmar) ────────────────────────────

/**
 * Solo la FORMA. `recibidor` y `firma_data` son opcionales a propósito: solo hacen
 * falta cuando la recepción sigue en Borrador, y un reintento sobre una recepción
 * ya firmada los ignora (no se vuelve a firmar). Si faltan en un Borrador, las
 * reglas de `shared/finalizarProveedor.js` contestan 400 con su propio mensaje.
 * El contenido (largo de nombre, formato de cédula, que la firma sea un PNG) se
 * valida ahí, no acá, para que haya una sola copia de cada regla.
 *
 * Aunque llegue un `nombre` junto con un `id` de la lista, se ignora: cédula y
 * nombre de un recibidor de la lista salen de la base.
 */
const finalizarRecepcionProveedorSchema = z.object({
  recibido_por: correo("El correo de quien finaliza no es válido."),
  recibidor: z
    .object({
      id: z.coerce
        .number({ invalid_type_error: "El recibidor no es válido." })
        .int("El recibidor no es válido.")
        .positive("El recibidor no es válido.")
        .safe("El recibidor no es válido.")
        .nullish(),
      otro: z.boolean({ invalid_type_error: "El recibidor no es válido." }).nullish(),
      nombre: z.string().max(300).nullish(),
      cedula: z.union([z.string().max(50), z.number()]).nullish(),
    })
    .nullish(),
  firma_data: z.string({ invalid_type_error: "La firma no es válida." }).nullish(),
  // Quien firma por el proveedor cuando hay devoluciones. Solo la forma: que sea
  // obligatorio lo decide `armarFirmaProveedor` sobre los renglones de la base.
  proveedor_firmante: z
    .object({
      nombre: z.string().max(300).nullish(),
      documento: z.union([z.string().max(50), z.number()]).nullish(),
      firma_data: z.string({ invalid_type_error: "La firma del proveedor no es válida." }).nullish(),
    })
    .nullish(),
});

/**
 * Reintentos de SIESA de una recepción de proveedor (entrada y nota crédito): solo
 * piden quién los hace. Lo demás (estado, envíos) lo decide el modelo leyendo la base.
 */
const reintentarSiesaProveedorSchema = z.object({
  por: correo("El correo de quien reintenta no es válido."),
});

// ─── Recepciones de proveedor: lado del admin ──────────────────────────────

// Un filtro vacío (`?estado=`) es "sin filtro", no un valor inválido: así lo manda
// un `<select>` en "Todos".
const vacioASinFiltro = (v) => (v === "" || v === null ? undefined : v);

const idFiltro = (mensaje) =>
  z.preprocess(
    vacioASinFiltro,
    z.coerce
      .number({ invalid_type_error: mensaje })
      .int(mensaje)
      .positive(mensaje)
      .safe(mensaje)
      .optional(),
  );

/** `YYYY-MM-DD` que además sea un día del calendario (no "2026-02-31"). */
const fechaFiltro = (mensaje) =>
  z.preprocess(
    vacioASinFiltro,
    z
      .string({ invalid_type_error: mensaje })
      .regex(/^\d{4}-\d{2}-\d{2}$/, mensaje)
      .refine((v) => {
        const [a, m, d] = v.split("-").map(Number);
        const fecha = new Date(Date.UTC(a, m - 1, d));
        return fecha.getUTCFullYear() === a && fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d;
      }, mensaje)
      .optional(),
  );

const listarRecepcionesProveedorQuerySchema = z
  .object({
    estado: z.preprocess(
      vacioASinFiltro,
      z
        .enum(Object.values(ESTADOS_PROVEEDOR), {
          errorMap: () => ({ message: `debe ser uno de: ${Object.values(ESTADOS_PROVEEDOR).join(", ")}.` }),
        })
        .optional(),
    ),
    proveedor_id: idFiltro("no es válido."),
    sede_id: idFiltro("no es válido."),
    desde: fechaFiltro("debe ser una fecha AAAA-MM-DD."),
    hasta: fechaFiltro("debe ser una fecha AAAA-MM-DD."),
    // Fragmento de la factura: se busca por su clave (solo letras y números).
    factura: z.preprocess(
      vacioASinFiltro,
      z
        .string({ invalid_type_error: "no es válida." })
        .trim()
        .max(40, "no puede pasar de 40 caracteres.")
        .refine((v) => normalizarFactura(v).clave.length > 0, "tiene que tener letras o números.")
        .optional(),
    ),
    limite: z.preprocess(
      vacioASinFiltro,
      z.coerce
        .number({ invalid_type_error: "no es válido." })
        .int("no es válido.")
        .min(1, "no es válido.")
        .max(LIMITE_LISTA_MAX, `no puede pasar de ${LIMITE_LISTA_MAX}.`)
        .default(LIMITE_LISTA_DEFECTO),
    ),
  })
  .refine((v) => !v.desde || !v.hasta || v.desde <= v.hasta, {
    message: "desde no puede ser posterior a hasta.",
  });

/** Corregir la referencia de factura para SIESA: quién y la referencia nueva (el formato lo valida el modelo puro). */
const corregirFacturaSiesaProveedorSchema = z.object({
  por: correo("El correo de quien corrige no es válido."),
  factura_siesa: z
    .string({
      required_error: "Escribí la referencia para SIESA.",
      invalid_type_error: "La referencia para SIESA no es válida.",
    })
    .trim()
    .min(1, "Escribí la referencia para SIESA.")
    .max(40, "La referencia para SIESA no puede pasar de 40 caracteres."),
});

/**
 * Anular: quién, por qué (obligatorio: queda como trazabilidad) y, si la recepción
 * ya está en SIESA, que alguien ya anuló el documento allá (`anulado_en_siesa`,
 * booleano de verdad: un "true" de texto se rechaza para que un descuido no
 * confirme algo que nadie confirmó).
 */
const anularRecepcionProveedorSchema = z.object({
  por: correo("El correo de quien anula no es válido."),
  motivo: z
    .string({
      required_error: "Escribí el motivo de la anulación.",
      invalid_type_error: "El motivo no es válido.",
    })
    .trim()
    .min(3, "Escribí el motivo de la anulación.")
    .max(500, "El motivo no puede pasar de 500 caracteres."),
  anulado_en_siesa: z.boolean({ invalid_type_error: "anulado_en_siesa debe ser true o false." }).optional(),
});

// ─── Recibidores (gestión del admin) ───────────────────────────────────────

const cedulaRecibidor = z.union([z.string().max(50), z.number()], {
  required_error: "Escribí la cédula.",
  invalid_type_error: "La cédula no es válida.",
});
const nombreRecibidor = z
  .string({ required_error: "Escribí el nombre.", invalid_type_error: "El nombre no es válido." })
  .max(300);
const ordenRecibidor = z.coerce
  .number({ invalid_type_error: "El orden no es válido." })
  .int("El orden no es válido.")
  .min(0, "El orden no es válido.")
  .max(1_000_000, "El orden no es válido.")
  .nullish();

const crearRecibidorSchema = z.object({
  cedula: cedulaRecibidor,
  nombre: nombreRecibidor,
  orden: ordenRecibidor,
});

const actualizarRecibidorSchema = z
  .object({
    cedula: cedulaRecibidor.optional(),
    nombre: nombreRecibidor.optional(),
    activo: z.boolean({ invalid_type_error: "activo debe ser true o false." }).optional(),
    orden: ordenRecibidor,
  })
  .refine(
    (v) => v.cedula !== undefined || v.nombre !== undefined || v.activo !== undefined || (v.orden ?? undefined) !== undefined,
    { message: "No hay nada para cambiar." },
  );

/**
 * Reenviar vísceras a SIESA desde la liquidación. `eliminado_en_siesa` es un
 * booleano de verdad (un "true" de texto se rechaza para que un descuido no
 * confirme algo que nadie confirmó); si hace falta, lo exige el modelo según el
 * estado de cada recepción.
 */
const reenviarViscerasSchema = z.object({
  recepcion_ids: z
    .array(
      z.coerce
        .number({ invalid_type_error: "Una recepción no es válida." })
        .int("Una recepción no es válida.")
        .positive("Una recepción no es válida.")
        .safe("Una recepción no es válida."),
      { required_error: "Indicá qué recepciones reenviar.", invalid_type_error: "Indicá qué recepciones reenviar." },
    )
    .min(1, "Indicá qué recepciones reenviar.")
    .max(100, "Son demasiadas recepciones."),
  eliminado_en_siesa: z
    .boolean({ invalid_type_error: "eliminado_en_siesa debe ser true o false." })
    .optional(),
  por: z.string({ invalid_type_error: "Quién reenvía no es válido." }).trim().max(150).optional(),
  motivo: z
    .string({ invalid_type_error: "El motivo no es válido." })
    .trim()
    .max(500, "El motivo no puede pasar de 500 caracteres.")
    .optional(),
});

export const validators = {
  verificarSede: validar(verificarSedeSchema),
  reenviarVisceras: validar(reenviarViscerasSchema),

  listarProveedores: validar(listarProveedoresQuerySchema, "query"),
  idParam: validar(idParamSchema, "params"),
  cargarPlantillaProveedor: validar(cargarPlantillaProveedorSchema),

  abrirRecepcionProveedor: validar(abrirRecepcionProveedorSchema),
  guardarRecepcionProveedor: validar(guardarRecepcionProveedorSchema),
  finalizarRecepcionProveedor: validar(finalizarRecepcionProveedorSchema),
  reintentarSiesaProveedor: validar(reintentarSiesaProveedorSchema),
  listarRecepcionesProveedor: validar(listarRecepcionesProveedorQuerySchema, "query"),
  corregirFacturaSiesaProveedor: validar(corregirFacturaSiesaProveedorSchema),
  anularRecepcionProveedor: validar(anularRecepcionProveedorSchema),

  crearRecibidor: validar(crearRecibidorSchema),
  actualizarRecibidor: validar(actualizarRecibidorSchema),

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

  // El ADMIN agrega un corte fuera de plantilla sobre una recepción ya
  // cerrada. A diferencia de `agregarAdicional` (el del recibidor), acá
  // código y costo son OBLIGATORIOS: el admin ya sabe qué es, y este endpoint
  // existe justamente para no dejar el renglón pendiente de homologar.
  agregarRenglonAdmin: validar(
    z.object({
      codigo_item: codigoSiesa("El código de SIESA es obligatorio."),
      descripcion: z
        .string({ required_error: "La descripción es obligatoria." })
        .trim()
        .min(1, "La descripción es obligatoria."),
      cantidad: z.coerce
        .number({ required_error: "Falta la cantidad.", invalid_type_error: "La cantidad debe ser un número." })
        .positive("La cantidad tiene que ser mayor a 0."),
      // Mismo criterio que `homologarAdicional`: un costo base en 0 entra a
      // SIESA valiendo cero y deja el margen de ese producto en 100%.
      costo_base: z.coerce
        .number({ required_error: "Falta el costo base.", invalid_type_error: "El costo base debe ser un número." })
        .positive("El costo base tiene que ser mayor a 0."),
      agregado_por: correo("El correo de quien agrega no es válido.").optional(),
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

  // El admin corrige los novillos (o canales, en cerdo) de una recepción ya
  // cerrada. Dispara el recálculo de las vísceras que se cuentan por novillo
  // (`shared/visceras.js`) — ver `editarNovillos` en `Recepcion.model.js`.
  editarNovillos: validar(
    z.object({
      novillos: z.coerce
        .number({
          required_error: "Falta la cantidad.",
          invalid_type_error: "La cantidad debe ser un número.",
        })
        .nonnegative("La cantidad no puede ser negativa."),
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
            // Peso y Precio KL son OPCIONALES: cuando ambos vienen cargados, el
            // modelo recalcula `valor` a partir de ellos (ver `shared/gastos.js`)
            // y le gana a lo que haya tipeado el cliente. "" o ausente → null,
            // no 0 — un 0 sí dispararía el cálculo si el otro campo también
            // viniera en 0, y acá lo que se pide es "no cargado".
            peso: numeroOpcionalNoNegativo("El peso no puede ser negativo."),
            precio_kilo: numeroOpcionalNoNegativo("El precio por kilo no puede ser negativo."),
            observaciones: z.string().trim().max(500).nullable().optional(),
          }),
        )
        .default([]),
    }),
  ),

  // Retomas de la entrega (cerdo). Acá solo la FORMA; las reglas (negativos,
  // repetidos, ítems del catálogo, topes) las aplica `validarFilasRetomas` en el
  // modelo, que es la misma función que prueban los tests. `""` (un input vacío)
  // llega como está: `leerNumero` lo cuenta como 0 y todo lo que no sea número lo
  // rechaza — no se coacciona acá para que un "abc" no se vuelva 0 en silencio.
  guardarRetomas: validar(
    z.object({
      por: z.string().trim().max(150).nullable().optional(),
      filas: z
        .array(
          z.object({
            vicera_item_id: z.coerce
              .number({ invalid_type_error: "La retoma no es válida." })
              .int()
              .positive("La retoma no es válida."),
            kilos: z.union([z.number(), z.string()]).nullable().optional(),
            precio: z.union([z.number(), z.string()]).nullable().optional(),
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
