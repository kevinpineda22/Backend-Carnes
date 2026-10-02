/**
 * Retomas de la liquidación de CERDO.
 *
 * Antes las pesaba el recibidor en cada sede (renglones tipo 'vicera'). Ahora las
 * carga el admin UNA vez por entrega, en la liquidación: kilos y precio KL de
 * cada retoma del catálogo. El total viaja a los gastos como el concepto
 * «Retomas» (que RESTA) — ver `Liquidacion.model.js#guardarRetomas`.
 *
 * Módulo PURO, mismo espíritu que `gastos.js` y `costeo.js`: entran objetos, salen
 * objetos, no depende de Supabase ni de Express.
 *
 * ─── Dinero ──────────────────────────────────────────────────────────────────
 *
 * `valor = kilos × precio` se calcula con `calcularValorGasto` —la MISMA función
 * que usa la grilla de gastos para Peso × Precio KL— para que las dos cuentas
 * redondeen igual (2 decimales) y no puedan diferir por un centavo. Se calcula
 * siempre acá, en el backend: el valor que muestre el navegador es solo una vista
 * previa.
 */

import { calcularValorGasto } from "./gastos.js";

/** Nombre del concepto de gasto al que se deriva el total (catálogo de cerdo). */
export const CONCEPTO_RETOMAS = "Retomas";

/** Valor de `carnes_liquidacion_gastos.origen` de la fila derivada. */
export const ORIGEN_RETOMAS = "retomas";

/** Cabe en NUMERIC(12,3) con margen: 999.999.999,999 kg ya es un error de tipeo. */
export const KILOS_MAXIMOS = 999_999_999;
/** Cabe en NUMERIC(16,2) con margen. */
export const PRECIO_MAXIMO = 99_999_999_999;
/**
 * Tope del VALOR (kilos × precio) de una fila y del TOTAL: es lo que se escribe en
 * `carnes_liquidacion_gastos.valor`, NUMERIC(16,2) → máximo 99.999.999.999.999,99.
 * Los topes por campo solos no alcanzan: 999.999.999 kg × 99.999.999.999 los
 * respeta y desborda la columna (500 de Postgres con escrituras ya hechas).
 */
export const VALOR_TOTAL_MAXIMO = 99_999_999_999_999;

const DECIMALES_KILOS = 3;
const DECIMALES_PRECIO = 2;

function redondear(valor, n) {
  if (!Number.isFinite(valor)) return 0;
  return Number(valor.toFixed(n));
}

/**
 * Convierte lo que llegue a número. `null`, `undefined` y `""` (un `<input>`
 * vacío) cuentan como 0: «no cargué nada». Cualquier otra cosa que no sea un
 * número finito devuelve `NaN` para que el validador la rechace — NO se vuelve 0
 * en silencio, porque un precio mal tipeado que se guarda como 0 resta menos
 * plata de la debida y nadie lo nota.
 */
export function leerNumero(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") {
    const limpio = v.trim();
    if (limpio === "") return 0;
    const n = Number(limpio);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  return Number.NaN;
}

/** Valor de una fila: kilos × precio, redondeado a 2 decimales. 0 si falta alguno. */
export function valorRetoma({ kilos, precio } = {}) {
  return calcularValorGasto({
    peso: leerNumero(kilos) || 0,
    precio_kilo: leerNumero(precio) || 0,
    valor: 0,
  });
}

/** Σ de los valores de las filas, a 2 decimales. */
export function totalRetomas(filas = []) {
  const suma = filas.reduce((acc, f) => acc + valorRetoma(f), 0);
  return redondear(suma, DECIMALES_PRECIO);
}

/** Σ de los kilos de las filas, a 3 decimales. */
export function totalKilosRetomas(filas = []) {
  const suma = filas.reduce((acc, f) => acc + (leerNumero(f.kilos) || 0), 0);
  return redondear(suma, DECIMALES_KILOS);
}

/**
 * Arma las filas del panel: el catálogo ACTIVO de retomas mezclado con lo que ya
 * se guardó para esta liquidación.
 *
 *   · Una retoma del catálogo sin nada guardado sale con 0 kilos y el precio KL
 *     del catálogo (editable).
 *   · Una guardada usa SU precio — el catálogo pudo cambiar después.
 *   · Una guardada cuyo ítem ya no está activo en el catálogo SIGUE saliendo
 *     (`activo: false`): si se escondiera, el total mostrado dejaría de coincidir
 *     con el gasto ya derivado y el admin no podría ni verla ni corregirla.
 *
 * `precio_catalogo` es contra lo que el panel compara para pintar «cambiado»: el
 * precio VIGENTE del catálogo mientras la liquidación se puede editar, y el que
 * se guardó (snapshot) cuando ya está congelada (`congelada = true`) — una
 * liquidación costeada no puede aparecer «cambiada» solo porque el catálogo
 * subió después.
 *
 * @param {object} p
 * @param {Array<{id:number,nombre:string,precio:number,unidad?:string,orden?:number}>} p.catalogo
 * @param {Array<object>} [p.guardadas]  filas de carnes_liquidacion_retomas
 * @param {boolean} [p.congelada]
 */
export function armarFilasRetomas({ catalogo = [], guardadas = [], congelada = false } = {}) {
  const porItem = new Map();
  for (const g of guardadas) {
    if (g.vicera_item_id !== null && g.vicera_item_id !== undefined) {
      porItem.set(String(g.vicera_item_id), g);
    }
  }

  const filas = [];
  const vistos = new Set();

  for (const c of catalogo) {
    const g = porItem.get(String(c.id));
    vistos.add(String(c.id));
    const precioCatalogoVigente = redondear(leerNumero(c.precio) || 0, DECIMALES_PRECIO);
    const kilos = g ? leerNumero(g.kilos) || 0 : 0;
    const precio = g ? leerNumero(g.precio) || 0 : precioCatalogoVigente;
    filas.push({
      vicera_item_id: c.id,
      nombre: c.nombre,
      unidad: c.unidad || "KL",
      kilos,
      precio,
      precio_catalogo:
        congelada && g ? leerNumero(g.precio_catalogo) || 0 : precioCatalogoVigente,
      valor: valorRetoma({ kilos, precio }),
      orden: c.orden ?? 0,
      guardada: Boolean(g),
      activo: true,
    });
  }

  // Guardadas que ya no están en el catálogo activo (dadas de baja o sin ítem).
  for (const g of guardadas) {
    const item = g.vicera_item_id;
    if (item !== null && item !== undefined && vistos.has(String(item))) continue;
    const kilos = leerNumero(g.kilos) || 0;
    const precio = leerNumero(g.precio) || 0;
    filas.push({
      vicera_item_id: item ?? null,
      nombre: g.nombre,
      unidad: g.unidad || "KL",
      kilos,
      precio,
      precio_catalogo: leerNumero(g.precio_catalogo) || 0,
      valor: valorRetoma({ kilos, precio }),
      orden: g.orden ?? 0,
      guardada: true,
      activo: false,
    });
  }

  return filas.sort((a, b) => a.orden - b.orden);
}

/**
 * Valida y normaliza lo que manda el cliente.
 *
 * Rechaza (no corrige): negativos, no-números, ids repetidos, ítems que no
 * pertenecen al catálogo ni a lo ya guardado, y topes que no caben en la columna.
 * Devuelve las filas ya normalizadas (kilos a 3 decimales, precio a 2).
 *
 * @param {Array<{vicera_item_id:any,kilos:any,precio:any}>} filas
 * @param {Set<string>|string[]} permitidos  ids de ítem que se pueden escribir
 * @returns {{ok:boolean, errores:string[], filas:Array<{vicera_item_id:number,kilos:number,precio:number}>}}
 */
export function validarFilasRetomas(filas, permitidos) {
  const errores = [];
  const limpias = [];
  const ok = new Set([...(permitidos || [])].map(String));
  const repetidos = new Set();

  if (!Array.isArray(filas)) {
    return { ok: false, errores: ["Las filas de retomas no son una lista."], filas: [] };
  }

  filas.forEach((f, i) => {
    const pos = `Fila ${i + 1}`;
    const id = Number(f?.vicera_item_id);
    if (!Number.isInteger(id) || id <= 0) {
      errores.push(`${pos}: falta la retoma.`);
      return;
    }
    if (!ok.has(String(id))) {
      errores.push(`${pos}: la retoma #${id} no es del catálogo de cerdo.`);
      return;
    }
    if (repetidos.has(String(id))) {
      errores.push(`${pos}: la retoma #${id} viene repetida.`);
      return;
    }
    repetidos.add(String(id));

    const kilos = leerNumero(f.kilos);
    const precio = leerNumero(f.precio);
    if (Number.isNaN(kilos)) {
      errores.push(`${pos}: los kilos no son un número.`);
      return;
    }
    if (Number.isNaN(precio)) {
      errores.push(`${pos}: el precio no es un número.`);
      return;
    }
    if (kilos < 0) {
      errores.push(`${pos}: los kilos no pueden ser negativos.`);
      return;
    }
    if (precio < 0) {
      errores.push(`${pos}: el precio no puede ser negativo.`);
      return;
    }
    if (kilos > KILOS_MAXIMOS || precio > PRECIO_MAXIMO) {
      errores.push(`${pos}: el valor está fuera de rango. Revisá los ceros.`);
      return;
    }
    limpias.push({
      vicera_item_id: id,
      kilos: redondear(kilos, DECIMALES_KILOS),
      precio: redondear(precio, DECIMALES_PRECIO),
    });
  });

  // Solo si lo demás está bien: el tope se mide sobre filas ya normalizadas.
  if (errores.length === 0 && totalRetomas(limpias) > VALOR_TOTAL_MAXIMO) {
    errores.push(
      "El total de las retomas es demasiado grande y no cabe en el gasto. Revisá los kilos y los precios.",
    );
  }

  return { ok: errores.length === 0, errores, filas: limpias };
}
