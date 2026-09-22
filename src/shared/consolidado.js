import { calcularCosteo, repartirPorSede } from "./costeo.js";

/**
 * Consolidado de una liquidación: reparte los gastos entre las sedes y costea
 * cada recepción.
 *
 * Módulo PURO, como `costeo.js`. Nada de Supabase acá.
 *
 * ─── El punto que hay que entender ────────────────────────────────────────
 *
 * El factor de ajuste NO es global: **cada sede calcula el suyo**. En el Excel
 * de res cada hoja de sede tiene su propio `H8`, y no es un descuido.
 *
 * La razón es que las dos mitades del factor se arman distinto:
 *
 *   · el costo REAL de una sede es proporcional a sus KILOS
 *     (`costo_promedio_kilo × kilos_sede`, que es lo mismo que
 *     `total_gastos × % participación`),
 *   · el costo TEÓRICO de una sede depende de su MEZCLA DE CORTES.
 *
 * Y la mezcla cambia por sede. Villahermosa recibió 388,22 kg que valen
 * $11.380.294 de lista; Parque recibió 260,79 kg que valen $7.588.379. No es la
 * misma proporción, porque a una le tocó más solomito y a la otra más costilla.
 * Un factor global le cobraría a Parque el desvío de Villahermosa.
 *
 * ─── Cómo se arma cada sede ───────────────────────────────────────────────
 *
 *   kilos_sede    = Σ cantidad de los renglones de carne (las vísceras NO cuentan:
 *                   en `Datos `!F41 la suma va de la fila 3 a la 40, y las
 *                   vísceras viven de la 44 para abajo)
 *   participación = kilos_sede / kilos_totales
 *   valor_factura = total_gastos × participación          → `Datos `!P25:P33 y hoja de sede F5
 *   vísceras      = Σ cantidad × precio (si el toggle está en SI)  → hoja de sede F6
 *   costo_real    = valor_factura − vísceras                       → hoja de sede F7
 *
 * y de ahí sale el prorrateo normal de `calcularCosteo`.
 */

/** Renglones que son producto y suman kilos: la carne y lo que llegó de más. */
const ES_PRODUCTO = (i) => i.tipo === "carne" || i.tipo === "adicional";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} entrada
 * @param {object[]} entrada.recepciones  cada una con `items`, `sede_id`, `estado`
 * @param {object[]} [entrada.gastos]     `{ concepto, valor, signo }`
 * @param {boolean}  [entrada.bonificacionViceras]
 */
/**
 * Tolerancia del cuadre entre gastos y pagos.
 *
 * Un peso: los dos lados son plata en pesos colombianos, sin centavos. Más que
 * eso no es redondeo, es un renglón que falta.
 */
export const TOLERANCIA_CUADRE = 1;

/**
 * ¿La plata que se gira coincide con la que costó la entrega?
 *
 * Son dos vistas del mismo dinero: `totalGastos` es lo que costó (y es lo que
 * se reparte entre las sedes); los pagos son a quién se le gira. Si no dan
 * igual, o falta un pago o falta un gasto — y costear con esa diferencia
 * reparte entre las sedes una plata que no coincide con la que salió del banco.
 *
 * Sin pagos cargados NO se reporta diferencia: es el estado inicial de toda
 * liquidación, no un error.
 */
export function cuadrarPagos(totalGastos, pagos = []) {
  const total = pagos.reduce((acc, p) => acc + num(p.valor), 0);
  const diferencia = Number((total - num(totalGastos)).toFixed(2));
  return {
    totalPagos: Number(total.toFixed(2)),
    totalGastos: Number(num(totalGastos).toFixed(2)),
    diferencia,
    cuadra: pagos.length === 0 || Math.abs(diferencia) <= TOLERANCIA_CUADRE,
    sinPagos: pagos.length === 0,
  };
}

export function consolidarLiquidacion({
  recepciones = [],
  gastos = [],
  bonificacionViceras = false,
  pagos = [],
} = {}) {
  const advertencias = [];

  const totalGastos = gastos.reduce(
    (acc, g) => acc + num(g.valor) * (num(g.signo) === -1 ? -1 : 1),
    0,
  );

  // Kilos por recepción — solo producto.
  const kilosPorRecepcion = recepciones.map((r) => ({
    sede_id: r.sede_id,
    cantidad: (r.items || []).filter(ES_PRODUCTO).reduce((a, i) => a + num(i.cantidad), 0),
  }));

  const totalKilos = kilosPorRecepcion.reduce((a, r) => a + r.cantidad, 0);
  const reparto = repartirPorSede(kilosPorRecepcion, totalGastos);

  const sedes = recepciones.map((recepcion, idx) => {
    const items = recepcion.items || [];
    const productos = items.filter(ES_PRODUCTO);
    const viceras = items
      .filter((i) => i.tipo === "vicera")
      .map((i) => ({ nombre: i.descripcion, cantidad: i.cantidad, precio: i.costo_base }));

    // `valor_factura` entra como el único gasto de esta sede, y las vísceras se
    // pasan tal cual para que `calcularCosteo` las reste igual que el Excel.
    const costeo = calcularCosteo({
      items: productos,
      gastos: [{ concepto: "Valor de la carne", valor: reparto[idx].valorFactura }],
      viceras,
      bonificacionViceras,
    });

    return {
      recepcion_id: recepcion.id,
      sede_id: recepcion.sede_id,
      sede: recepcion.sede || null,
      estado: recepcion.estado,
      // Van al consolidado para que la vista "hoja de sede" pueda replicar el
      // encabezado del Excel (D4 y D6) sin tener que volver a pedir la recepción.
      novillos: recepcion.novillos ?? null,
      fecha_ingreso: recepcion.fecha_ingreso ?? null,
      kilos: reparto[idx].cantidad,
      participacion: reparto[idx].participacion,
      valorFactura: reparto[idx].valorFactura,
      costeo,
    };
  });

  // ─── Señales que el admin tiene que ver ANTES de cerrar ─────────────────

  if (recepciones.length === 0) {
    advertencias.push({
      codigo: "sin_recepciones",
      mensaje: "La liquidación no tiene ninguna recepción vinculada.",
    });
  }

  const cuadre = cuadrarPagos(totalGastos, pagos);
  if (!cuadre.cuadra) {
    const sobra = cuadre.diferencia > 0;
    advertencias.push({
      codigo: "pagos_no_cuadran",
      mensaje:
        `Los pagos suman ${cuadre.totalPagos} y los gastos ${cuadre.totalGastos}: ` +
        `${sobra ? "sobran" : "faltan"} ${Math.abs(cuadre.diferencia)} en los pagos. ` +
        "Los dos son la misma plata vista de dos maneras y tienen que dar igual.",
    });
  }

  if (totalGastos === 0) {
    advertencias.push({
      codigo: "sin_gastos",
      mensaje:
        "No hay gastos cargados. El costo de cada corte quedaría en cero. " +
        "Cargá la factura, los fletes, el sacrificio y el desposte antes de costear.",
    });
  }

  if (totalKilos === 0) {
    advertencias.push({
      codigo: "sin_kilos",
      mensaje: "Ninguna recepción tiene cantidades. No hay nada que repartir.",
    });
  }

  // Adicionales sin homologar: el recibidor escribió el nombre, pero sin código
  // de SIESA ese renglón NO puede subir. Se cuenta acá y no dentro de cada sede
  // porque lo que el admin necesita saber es "¿me falta homologar algo?", una
  // sola vez, no ocho veces.
  const sinCodigo = [];
  const sinCosto = [];
  for (const r of recepciones) {
    for (const i of r.items || []) {
      if (i.tipo !== "adicional") continue;
      if (!i.codigo_item) sinCodigo.push({ recepcion_id: r.id, item_id: i.id, descripcion: i.descripcion });
      else if (num(i.costo_base) === 0) {
        sinCosto.push({ recepcion_id: r.id, item_id: i.id, descripcion: i.descripcion });
      }
    }
  }

  if (sinCodigo.length) {
    advertencias.push({
      codigo: "adicionales_sin_codigo",
      mensaje:
        `${sinCodigo.length} ítem(s) agregados por el recibidor no tienen código ` +
        "de SIESA. Hay que homologarlos antes de subir el documento.",
      detalle: sinCodigo,
    });
  }

  if (sinCosto.length) {
    // Un adicional con código pero sin costo base entra al ERP valiendo CERO, y
    // eso deja el margen de ese producto en 100%. Pasa desapercibido porque el
    // documento sube sin error.
    advertencias.push({
      codigo: "adicionales_sin_costo",
      mensaje:
        `${sinCosto.length} ítem(s) agregados tienen código pero costo base en 0. ` +
        "Subirían a SIESA con costo cero.",
      detalle: sinCosto,
    });
  }

  // Se suben acá las advertencias de cada sede, con el nombre adelante. Si se
  // quedaran adentro del costeo de cada una, el admin tendría que abrir sede por
  // sede para descubrir que a una le dio el factor en 1.
  for (const s of sedes) {
    for (const a of s.costeo.advertencias) {
      advertencias.push({
        codigo: a.codigo,
        sede_id: s.sede_id,
        mensaje: `${s.sede?.nombre || `Sede ${s.sede_id}`}: ${a.mensaje}`,
      });
    }
  }

  const totalCosteado = sedes.reduce((a, s) => a + s.costeo.totalCosteado, 0);

  return {
    totalGastos: Number(totalGastos.toFixed(2)),
    cuadre,
    totalKilos: Number(totalKilos.toFixed(3)),
    costoPromedioKilo: totalKilos > 0 ? Number((totalGastos / totalKilos).toFixed(4)) : 0,
    totalCosteado: Number(totalCosteado.toFixed(2)),
    sedes,
    advertencias,
  };
}

/**
 * ¿Se puede cerrar el costeo?
 *
 * Separado de `consolidarLiquidacion` a propósito: previsualizar tiene que
 * MOSTRAR todos los problemas, y cerrar tiene que BLOQUEAR solo los que hacen
 * que el documento sea inválido. Si fueran la misma función, o el admin no ve
 * nada hasta que arregla todo, o cierra con un documento roto.
 *
 * Bloquean:
 *   · no hay gastos → todos los costos darían cero
 *   · no hay kilos  → no hay nada que repartir
 *   · hay adicionales sin código → no pueden subir a SIESA de todos modos
 *   · alguna recepción no está aprobada → el admin todavía no validó esas
 *     cantidades, y costear sobre números sin aprobar es costear sobre nada
 *
 * NO bloquean (avisan): factor negativo, residuo alto, adicionales con costo 0.
 *
 * @returns {{ok: boolean, bloqueos: object[]}}
 */
export function puedeCerrarCosteo(consolidado, { estadosAprobados = ["Aprobado", "Costeado"] } = {}) {
  const BLOQUEANTES = new Set([
    "sin_recepciones",
    "sin_gastos",
    "sin_kilos",
    "adicionales_sin_codigo",
    "factor_anula_costos",
    // Costear con los pagos descuadrados reparte entre las sedes una plata que
    // no es la que se giró. Se congela mal y después hay que reabrir.
    "pagos_no_cuadran",
  ]);

  const bloqueos = consolidado.advertencias.filter((a) => BLOQUEANTES.has(a.codigo));

  for (const s of consolidado.sedes) {
    if (!estadosAprobados.includes(s.estado)) {
      bloqueos.push({
        codigo: "recepcion_no_aprobada",
        sede_id: s.sede_id,
        mensaje:
          `${s.sede?.nombre || `Sede ${s.sede_id}`}: la recepción está en ` +
          `"${s.estado}". Aprobala antes de costear.`,
      });
    }
  }

  return { ok: bloqueos.length === 0, bloqueos };
}
