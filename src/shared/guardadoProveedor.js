/**
 * Plan del AUTOGUARDADO (PATCH) de una recepción de proveedor: dado el estado de
 * los renglones en la base y lo que mandó el cliente, decide QUÉ columnas de QUÉ
 * renglones se escriben y qué queda pendiente.
 *
 * Puro, sin Supabase: `RecepcionProveedor.model.js` ejecuta el plan y este módulo
 * lo calcula. El modelo no tiene tests (no hay mock de Supabase), así que toda la
 * regla vive acá donde sí se puede probar.
 *
 * ─── Reglas ────────────────────────────────────────────────────────────────
 *
 *   · Por renglón, en este orden: cantidad → valor → recálculo → devolución →
 *     confirmaciones. La cantidad se GUARDA ya ajustada a la unidad
 *     (`cantidadAlmacenada`), la misma que después viaja a SIESA.
 *   · El valor llega como TEXTO y se interpreta con `parsearPesos` (el punto es
 *     miles, la coma decimales). La plata que calcula el navegador no se usa.
 *   · El autoguardado NUNCA tira lo digitado por una regla de negocio: un valor
 *     que no se entiende se RECHAZA solo a él (queda el anterior) y el resto del
 *     guardado se aplica. Lo que el cliente necesita saber vuelve en `pendientes`
 *     con HTTP 200; finalizar es quien exige que todo esté en orden.
 *   · Solo se escribe lo que CAMBIA: un renglón idéntico a lo guardado no genera
 *     escritura (ni toca `updated_at` de la cabecera).
 *   · Confirmar más de 800 KL o un valor implausible guarda quién y cuándo, atado
 *     al valor exacto confirmado (ver `excesoConfirmado` / `valorConfirmado`).
 *
 * ─── Qué es `pendientes` ───────────────────────────────────────────────────
 *
 * Todo lo que impediría finalizar y que el cliente puede resolver, de TODA la
 * recepción (no solo de los renglones de esta petición): confirmaciones que
 * faltan (`exceso`, `valor`) y lo que esta petición no pudo aplicar
 * (`cantidad_invalida`, `valor_invalido`, `devolucion_invalida`,
 * `confirmacion_ignorada`, `conflicto`). Así "¿puedo abrir la firma?" se contesta con una sola
 * respuesta.
 */

import {
  LIMITE_CANTIDAD,
  MENSAJE_PESOS,
  cantidadAlmacenada,
  calcularValores,
  confirmacionesPendientes,
  excedeUmbral,
  excesoConfirmado,
  parsearPesos,
  valorConfirmado,
  valorPlausible,
} from "./proveedorValores.js";

/**
 * Largos máximos que ACEPTA el autoguardado por campo. Pasados estos, el campo
 * NO tumba la petición (el zod de `validators.js` solo corta a 10x esto, contra
 * abuso): se rechaza ese campo y vuelve en `pendientes`, y lo demás se guarda.
 * Un recibidor con el celular en la mano que pega un texto largo no puede perder
 * los otros 30 renglones que digitó.
 */
export const LARGO_MAX_VALOR = 25;
export const LARGO_MAX_CANTIDAD = 20;
export const LARGO_MAX_MOTIVO = 500;
export const LARGO_MAX_OBSERVACIONES = 2000;

/** Mensaje de un renglón que otro guardado modificó al mismo tiempo y no se pudo reconciliar. */
export const MENSAJE_CONFLICTO =
  "Otro guardado modificó este renglón al mismo tiempo; revisalo y volvé a escribirlo";

/** Decimales de cada columna numérica de los renglones (sql/022), para comparar sin ruido de coma flotante. */
const ESCALA = {
  cantidad: 3,
  valor_unitario: 4,
  valor_total: 2,
  cantidad_devuelta: 3,
  exceso_confirmado_cantidad: 3,
  valor_confirmado_unitario: 4,
};

function esVacio(valor) {
  return valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "");
}

/** ¿Es un texto más largo que `max`? (Un número JS no tiene largo: lo juzga su valor.) */
function demasiadoLargo(valor, max) {
  return typeof valor === "string" && valor.trim().length > max;
}

/**
 * Las observaciones se RECORTAN (no se rechazan): son texto libre de la cabecera
 * y no hay un valor "correcto" que proteger. Vacío -> null.
 */
export function normalizarObservaciones(texto) {
  if (texto === null || texto === undefined) return null;
  return String(texto).trim().slice(0, LARGO_MAX_OBSERVACIONES) || null;
}

function redondear(valor, n) {
  return Number(Number(valor).toFixed(n));
}

/**
 * Cantidad digitada → número, o `null` si no se entiende. Mismo criterio que
 * `aNumero` del front (`utils/cantidad.js`): coma o punto como decimal ("12,5"
 * es 12,5), nada de signos, letras ni separadores de miles. Un número JS pasa si
 * es finito y no negativo.
 *
 * El punto es DECIMAL acá y en los kilos — a diferencia de la plata
 * (`parsearPesos`), donde es de miles. Son dos campos distintos en pantalla.
 */
export function parsearCantidad(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) && valor >= 0 ? valor : null;
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(texto)) return null;
  const n = Number(texto.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** ¿Cambió la columna? Los números se comparan a la escala de su columna; el resto, con null = vacío. */
function cambio(columna, anterior, nuevo) {
  if (columna in ESCALA) {
    const a = esVacio(anterior) ? null : Number(anterior);
    const n = esVacio(nuevo) ? null : Number(nuevo);
    if (a === null || n === null) return a !== n;
    return redondear(a, ESCALA[columna]) !== redondear(n, ESCALA[columna]);
  }
  return (anterior ?? null) !== (nuevo ?? null);
}

/** Mensajes y tipos de un renglón, deduplicados por tipo. */
function agregar(mapa, itemId, tipo, mensaje) {
  const clave = String(itemId);
  const actual = mapa.get(clave) ?? { item_id: itemId, mensajes: [], tipos: [] };
  if (!actual.tipos.includes(tipo)) {
    actual.tipos.push(tipo);
    actual.mensajes.push(mensaje);
  }
  mapa.set(clave, actual);
}

/**
 * Todo lo que falta por resolver en la recepción: lo que rechazó esta petición
 * (`rechazos`) más las confirmaciones que les faltan a los renglones.
 *
 * @param {object[]} items   renglones tal como quedaron guardados
 * @param {{item_id: *, tipo: string, mensaje: string}[]} rechazos
 * @returns {{item_id: *, mensajes: string[], tipos: string[]}[]}
 */
export function calcularPendientes(items = [], rechazos = []) {
  const mapa = new Map();
  for (const r of rechazos) agregar(mapa, r.item_id, r.tipo, r.mensaje);
  for (const item of items) {
    for (const p of confirmacionesPendientes(item)) agregar(mapa, item.id, p.tipo, p.mensaje);
  }
  // En el orden de los renglones, no en el de llegada.
  const orden = new Map(items.map((i, n) => [String(i.id), n]));
  return [...mapa.values()].sort((a, b) => (orden.get(String(a.item_id)) ?? 0) - (orden.get(String(b.item_id)) ?? 0));
}

/**
 * @param {object} args
 * @param {object[]} args.items     renglones actuales de la base
 * @param {object[]} args.entradas  lo que mandó el cliente (ya validado por zod en su forma)
 * @param {string} args.por         correo de quien guarda (queda en las confirmaciones)
 * @param {string} [args.ahora]     timestamp ISO de las confirmaciones
 * @returns {{
 *   actualizaciones: {id: *, cambios: object, updated_at: string}[],
 *   ignorados: *[],
 *   rechazos: {item_id: *, tipo: string, mensaje: string}[],
 *   items: object[],
 *   pendientes: {item_id: *, mensajes: string[], tipos: string[]}[],
 * }}
 */
export function planearGuardado({ items = [], entradas = [], por, ahora = new Date().toISOString() } = {}) {
  // Estado de trabajo por renglón: si llegan dos entradas del mismo id, la
  // segunda parte de lo que dejó la primera.
  const trabajo = new Map(items.map((i) => [String(i.id), { ...i }]));
  const acumulado = new Map();
  const ignorados = [];
  const rechazos = [];

  for (const entrada of entradas) {
    const actual = trabajo.get(String(entrada.id));
    // Un id que no es de esta recepción se ignora en silencio: la lista del
    // cliente puede venir de una pantalla vieja, y rechazar todo el guardado por
    // un renglón de más le haría perder al recibidor lo que digitó.
    if (!actual) {
      ignorados.push(entrada.id);
      continue;
    }

    const rechazar = (tipo, mensaje) => rechazos.push({ item_id: actual.id, tipo, mensaje });
    const cambios = {};

    // ── 1. Cantidad ───────────────────────────────────────────────────────
    const cantidadAnterior = Number(actual.cantidad) || 0;
    let cantidad = cantidadAnterior;
    if (entrada.cantidad !== undefined && entrada.cantidad !== null) {
      // Vacío es 0 ("borró lo que había"): la columna no admite null.
      const digitada = esVacio(entrada.cantidad) ? 0 : parsearCantidad(entrada.cantidad);
      if (demasiadoLargo(entrada.cantidad, LARGO_MAX_CANTIDAD)) {
        rechazar("cantidad_invalida", "La cantidad es demasiado larga");
      } else if (digitada === null) {
        rechazar("cantidad_invalida", "La cantidad no es válida");
      } else {
        const guardada = cantidadAlmacenada(digitada, actual.unidad);
        if (guardada >= LIMITE_CANTIDAD) rechazar("cantidad_invalida", "La cantidad es demasiado grande");
        else cantidad = guardada;
      }
    }

    // ── 2. Valor ──────────────────────────────────────────────────────────
    let unitario = esVacio(actual.valor_unitario) ? null : Number(actual.valor_unitario);
    let total = esVacio(actual.valor_total) ? null : Number(actual.valor_total);
    let fuente = actual.valor_fuente ?? null;

    let recalcular = cantidad !== cantidadAnterior && fuente !== null;
    let base = null; // el número que el cliente digitó, ya interpretado
    let fuenteNueva = fuente;
    let borrarValor = false;

    if (entrada.valor !== undefined) {
      if (demasiadoLargo(entrada.valor, LARGO_MAX_VALOR)) {
        rechazar("valor_invalido", "El valor es demasiado largo");
      } else if (esVacio(entrada.valor)) {
        borrarValor = true;
      } else {
        const f = entrada.valor_fuente ?? fuente;
        if (f !== "unitario" && f !== "total") {
          rechazar("valor_invalido", "Falta indicar si el valor es unitario o total");
        } else {
          const n = parsearPesos(entrada.valor, { decimales: f === "unitario" ? 4 : 2 });
          if (n === null) {
            rechazar("valor_invalido", MENSAJE_PESOS);
          } else {
            base = n;
            fuenteNueva = f;
            recalcular = true;
          }
        }
      }
    }

    if (borrarValor) {
      unitario = null;
      total = null;
      fuente = null;
    } else if (recalcular) {
      // Sin valor nuevo, se recalcula desde el lado que digitó la persona.
      const valor = base !== null ? base : fuenteNueva === "unitario" ? unitario : total;
      const r = calcularValores({ cantidad, valor, fuente: fuenteNueva });
      if (r.error) {
        // La cantidad y el valor van juntos: si la combinación no cabe en las
        // columnas, no se aplica NINGUNA de las dos.
        rechazar("valor_invalido", r.error);
        cantidad = cantidadAnterior;
      } else if (valor !== null && valor !== undefined) {
        unitario = r.valor_unitario;
        total = r.valor_total;
        fuente = r.valor_fuente;
      }
    }

    if (cambio("cantidad", actual.cantidad, cantidad)) cambios.cantidad = cantidad;
    if (cambio("valor_unitario", actual.valor_unitario, unitario)) cambios.valor_unitario = unitario;
    if (cambio("valor_total", actual.valor_total, total)) cambios.valor_total = total;
    if (cambio("valor_fuente", actual.valor_fuente, fuente)) cambios.valor_fuente = fuente;

    // ── 3. Devolución ─────────────────────────────────────────────────────
    // Se tolera devuelta > cantidad (el autoguardado pasa por estados
    // intermedios); `validarRenglon` lo exige al finalizar.
    if (entrada.cantidad_devuelta !== undefined && entrada.cantidad_devuelta !== null) {
      const digitada = esVacio(entrada.cantidad_devuelta) ? 0 : parsearCantidad(entrada.cantidad_devuelta);
      if (demasiadoLargo(entrada.cantidad_devuelta, LARGO_MAX_CANTIDAD)) {
        rechazar("devolucion_invalida", "La cantidad devuelta es demasiado larga");
      } else if (digitada === null) {
        rechazar("devolucion_invalida", "La cantidad devuelta no es válida");
      } else {
        const guardada = cantidadAlmacenada(digitada, actual.unidad);
        if (guardada >= LIMITE_CANTIDAD) rechazar("devolucion_invalida", "La cantidad devuelta es demasiado grande");
        else if (cambio("cantidad_devuelta", actual.cantidad_devuelta, guardada)) cambios.cantidad_devuelta = guardada;
      }
    }
    if (entrada.motivo_devolucion !== undefined) {
      const motivo = String(entrada.motivo_devolucion ?? "").trim() || null;
      if (motivo !== null && motivo.length > LARGO_MAX_MOTIVO) {
        rechazar("devolucion_invalida", `El motivo es demasiado largo (máximo ${LARGO_MAX_MOTIVO} caracteres)`);
      } else if (cambio("motivo_devolucion", actual.motivo_devolucion || null, motivo)) {
        cambios.motivo_devolucion = motivo;
      }
    }

    // ── 4. Confirmaciones (sobre el estado que quedó tras los pasos de arriba) ─
    const despues = { ...actual, ...cambios };

    if (entrada.confirmar_exceso !== undefined && entrada.confirmar_exceso !== null) {
      // Solo tiene sentido si el renglón excede: confirmar de más no hace nada.
      if (excedeUmbral(despues)) {
        const digitada = parsearCantidad(entrada.confirmar_exceso);
        const confirmada = digitada === null ? null : cantidadAlmacenada(digitada, despues.unidad);
        if (confirmada !== null && redondear(confirmada, 3) === redondear(despues.cantidad, 3)) {
          // Ya confirmada con este mismo valor: no se reescribe quién ni cuándo.
          if (!excesoConfirmado(despues)) {
            cambios.exceso_confirmado_cantidad = redondear(despues.cantidad, 3);
            cambios.exceso_confirmado_por = por ?? null;
            cambios.exceso_confirmado_at = ahora;
          }
        } else {
          rechazar("confirmacion_ignorada", "La confirmación no coincide con la cantidad actual");
        }
      }
    }

    if (!esVacio(entrada.confirmar_valor)) {
      // Llega el unitario que la persona confirmó, COMO TEXTO de plata (mismo
      // formato que `valor`, hasta 4 decimales: "33.333,3333"). Solo vale si es
      // igual al unitario que quedó tras ESTA petición (el valor, si viaja, se
      // aplica primero): confirmar $20 y que el renglón haya quedado en $30 no
      // confirma nada. Sin valor o con valor plausible no hay qué confirmar.
      const { plausible } = valorPlausible({ unitario: despues.valor_unitario, unidad: despues.unidad });
      if (Number(despues.valor_total) > 0 && !plausible) {
        const digitado = parsearPesos(entrada.confirmar_valor, { decimales: 4 });
        if (digitado !== null && redondear(digitado, 4) === redondear(despues.valor_unitario, 4)) {
          // Ya confirmado con este mismo valor: no se reescribe quién ni cuándo.
          if (!valorConfirmado(despues)) {
            cambios.valor_confirmado_unitario = redondear(despues.valor_unitario, 4);
            cambios.valor_confirmado_por = por ?? null;
            cambios.valor_confirmado_at = ahora;
          }
        } else {
          rechazar("confirmacion_ignorada", "La confirmación no coincide con el valor unitario actual");
        }
      }
    }

    if (Object.keys(cambios).length) {
      Object.assign(actual, cambios);
      acumulado.set(String(actual.id), { ...(acumulado.get(String(actual.id)) ?? {}), ...cambios });
    }
  }

  const resultado = items.map((i) => trabajo.get(String(i.id)));
  return {
    // `updated_at` es el TEXTO crudo que se leyó de la base: el modelo lo usa
    // como condición del UPDATE (nunca pasa por un Date, que perdería los
    // microsegundos y haría que la condición no coincida jamás).
    actualizaciones: [...acumulado.entries()].map(([id, cambios]) => {
      const original = items.find((i) => String(i.id) === id);
      return { id: original.id, cambios, updated_at: original.updated_at };
    }),
    ignorados,
    rechazos,
    items: resultado,
    pendientes: calcularPendientes(resultado, rechazos),
  };
}

/**
 * Segunda vuelta de los renglones cuyo UPDATE no encontró fila porque otro
 * guardado los modificó entre la lectura y la escritura (el UPDATE va
 * condicionado al `updated_at` leído).
 *
 * Se vuelve a planear SOLO esos renglones, con sus mismas entradas, sobre lo que
 * hay ahora en la base: así la cantidad de un guardado y el valor del otro se
 * recalculan juntos y no quedan mezclados (cantidad de uno, total de otro).
 *
 * @param {object} args
 * @param {*[]} args.conflictos  ids de los renglones que no se pudieron escribir
 * @param {object[]} args.frescos renglones releídos (puede traer más que los conflictos)
 * @param {object[]} args.entradas todas las entradas de la petición
 * @returns {ReturnType<typeof planearGuardado>}
 */
export function planearReintento({ conflictos = [], frescos = [], entradas = [], por, ahora } = {}) {
  const ids = new Set(conflictos.map(String));
  return planearGuardado({
    items: frescos.filter((i) => ids.has(String(i.id))),
    entradas: entradas.filter((e) => ids.has(String(e.id))),
    por,
    ahora,
  });
}

/**
 * Los rechazos finales tras la segunda vuelta: los del primer plan de los
 * renglones que NO entraron en conflicto, los del reintento de los que sí, y un
 * `conflicto` por cada renglón que siguió chocando (se devuelve en `pendientes`
 * con 200: el resto del guardado ya está aplicado y no se tira por uno).
 *
 * @returns {{item_id: *, tipo: string, mensaje: string}[]}
 */
export function resolverRechazos({ rechazos = [], conflictos = [], reintento, conflictosFinales = [] } = {}) {
  const reintentados = new Set(conflictos.map(String));
  return [
    ...rechazos.filter((r) => !reintentados.has(String(r.item_id))),
    ...(reintento?.rechazos ?? []),
    ...conflictosFinales.map((id) => ({ item_id: id, tipo: "conflicto", mensaje: MENSAJE_CONFLICTO })),
  ];
}
