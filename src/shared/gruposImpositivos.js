/**
 * Grupos impositivos de SIESA: de dónde sale el IVA de cada renglón.
 *
 * Puro, sin Supabase ni red, como `aperturaProveedor.js`: `models/GrupoImpositivo.model.js`
 * lee y escribe, `services/connekta.service.js` hace el GET, y ESTE módulo decide
 * (normalizar códigos, consolidar lo que trae Connekta, juzgar si el traído está
 * completo y qué snapshot lleva cada renglón).
 *
 * ─── Cadena ────────────────────────────────────────────────────────────────
 *
 *   ítem (codigo_item) --Connekta--> grupo impositivo (4 caracteres)
 *                      --tabla carnes_grupos_impositivos--> iva_pct
 *
 * El renglón de la recepción guarda ESE resultado al abrirse (`grupo_impositivo`,
 * `iva_pct`). Un ítem sin grupo, o con un grupo que la tabla no conoce, queda con
 * `iva_pct` NULL: "sin dato", que no es lo mismo que 0 % y nunca bloquea.
 *
 * Solo IVA. Las banderas IPCU / ICO / IBUA se guardan en la tabla de grupos pero
 * no se calculan todavía.
 */

/** Connekta LIMITA `tamPag` a 1000 (devuelve 400 si se pasa). */
export const TAM_PAGINA_CONNEKTA = 1000;

/** Nombre de la consulta registrada en Connekta que devuelve el catálogo de ítems con su grupo. */
export const CONSULTA_ITEMS_GRUPO = "merkahorro_items_dev_recibo_machado";

/** Filas por upsert a Supabase. */
export const LOTE_UPSERT = 1000;

/**
 * Qué fracción de las filas que Connekta DECLARA (`total_registros`) tiene que
 * llegar, contadas como filas DISTINTAS, para dar la sincronización por buena. La
 * consulta no garantiza un orden estable: al paginar, una página puede repetir filas
 * de otra y saltarse otras, y las repetidas compensan el conteo bruto.
 */
export const UMBRAL_COMPLETITUD = 0.99;

/** Tope de la sincronización en una función serverless (el límite de Vercel es 300 s). */
export const PRESUPUESTO_MS = 270_000;

const texto = (v) => String(v ?? "").trim();

// ─── Normalización ─────────────────────────────────────────────────────────

/**
 * '7', '007 ' y 7 → '0007'. Vacío o fuera de forma (más de 4 caracteres, símbolos)
 * → null: un código raro no se adivina.
 */
export function normalizarCodigoGrupo(valor) {
  const t = texto(valor);
  if (!/^[0-9A-Za-z]{1,4}$/.test(t)) return null;
  return t.toUpperCase().padStart(4, "0");
}

/** Connekta manda `CodigoItem` como NÚMERO; nuestras columnas son texto. 90 → '90'. */
export function normalizarCodigoItem(valor) {
  const t = texto(valor);
  if (!t || t.length > 20) return null;
  return t;
}

/** Una fila cruda de la consulta → la fila de `carnes_items_grupo_impositivo`, o null si no sirve. */
export function filaDesdeConnekta(cruda) {
  if (!cruda || typeof cruda !== "object") return null;
  const codigo_item = normalizarCodigoItem(cruda.CodigoItem);
  if (!codigo_item) return null;
  const descripcion = texto(cruda.DescItem).slice(0, 160);
  return {
    codigo_item,
    grupo_impositivo: normalizarCodigoGrupo(cruda.IdGrupoImpositivo),
    descripcion_item: descripcion || null,
  };
}

/**
 * Huella de una fila cruda para contar filas DISTINTAS (todas las columnas, ordenadas).
 * Dos huellas iguales son dos filas indistinguibles.
 */
export function huellaFila(fila) {
  if (fila == null || typeof fila !== "object") return String(fila);
  return Object.keys(fila)
    .sort()
    .map((k) => `${k}=${fila[k] == null ? "" : String(fila[k]).trim()}`)
    .join("|");
}

// ─── Consolidar lo traído ──────────────────────────────────────────────────

/**
 * Deja UNA fila por `codigo_item` (la llave primaria: un upsert con dos filas de la
 * misma llave en el mismo lote falla en Postgres).
 *
 * Si el mismo ítem aparece con grupos distintos NO se elige a ciegas: gana el primero
 * que traiga grupo y el conflicto se cuenta para que el admin lo vea. Una fila sin
 * grupo nunca pisa a una que sí lo tiene.
 *
 * @returns {{filas: object[], invalidas: number, repetidas: number, conflictos: number}}
 */
export function consolidarItems(crudas = []) {
  const porItem = new Map();
  let invalidas = 0;
  let repetidas = 0;
  let conflictos = 0;
  for (const cruda of crudas) {
    const fila = filaDesdeConnekta(cruda);
    if (!fila) {
      invalidas += 1;
      continue;
    }
    const previa = porItem.get(fila.codigo_item);
    if (!previa) {
      porItem.set(fila.codigo_item, fila);
      continue;
    }
    repetidas += 1;
    if (previa.grupo_impositivo && fila.grupo_impositivo && previa.grupo_impositivo !== fila.grupo_impositivo) {
      conflictos += 1;
    } else if (!previa.grupo_impositivo && fila.grupo_impositivo) {
      porItem.set(fila.codigo_item, fila);
    }
  }
  return { filas: [...porItem.values()], invalidas, repetidas, conflictos };
}

/**
 * ¿Lo traído alcanza para escribir? Compara las filas DISTINTAS contra el total que
 * declaró Connekta. Sin total declarado (0) no hay contra qué comparar: se acepta.
 *
 * @returns {{ok: boolean, completitud: number, mensaje: string|null}}
 */
export function evaluarCompletitud({ totalDeclarado = 0, distintas = 0, umbral = UMBRAL_COMPLETITUD } = {}) {
  const total = Number(totalDeclarado) || 0;
  if (total <= 0) {
    const hay = distintas > 0;
    return { ok: hay, completitud: hay ? 1 : 0, mensaje: hay ? null : "Connekta no devolvió ninguna fila." };
  }
  const completitud = distintas / total;
  if (completitud >= umbral) return { ok: true, completitud, mensaje: null };
  return {
    ok: false,
    completitud,
    mensaje:
      `Connekta declaró ${total} filas pero solo llegaron ${distintas} distintas ` +
      `(${Math.round(completitud * 100)} %). Eso es paginación sin orden estable o páginas perdidas; ` +
      "no se escribió nada.",
  };
}

// ─── Snapshot del renglón ──────────────────────────────────────────────────

const aNumeroONull = (v) => {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Para cada código de ítem pedido, el snapshot `{grupo_impositivo, iva_pct}` que
 * lleva el renglón al crearse. Siempre devuelve una entrada por código:
 *
 *   · ítem sin fila en la sincronización → `{null, null}`
 *   · ítem con grupo desconocido para la tabla de tarifas → grupo guardado, `iva_pct` null
 *   · todo bien → grupo y tarifa
 *
 * @param {string[]} codigos
 * @param {{codigo_item: string, grupo_impositivo: string|null}[]} filasItems
 * @param {{codigo: string, iva_pct: *}[]} filasGrupos
 * @returns {Map<string, {grupo_impositivo: string|null, iva_pct: number|null}>}
 */
export function construirSnapshots(codigos = [], filasItems = [], filasGrupos = []) {
  const grupoDe = new Map(filasItems.map((f) => [texto(f.codigo_item), normalizarCodigoGrupo(f.grupo_impositivo)]));
  const tarifaDe = new Map(filasGrupos.map((g) => [normalizarCodigoGrupo(g.codigo), aNumeroONull(g.iva_pct)]));
  const snapshots = new Map();
  for (const crudo of codigos) {
    const codigo = texto(crudo);
    const grupo = grupoDe.get(codigo) ?? null;
    snapshots.set(codigo, { grupo_impositivo: grupo, iva_pct: grupo ? (tarifaDe.get(grupo) ?? null) : null });
  }
  return snapshots;
}

/** Los renglones a insertar, con el snapshot de IVA de su ítem (sin dato si no hay). */
export function conSnapshotIva(filas = [], snapshots = new Map()) {
  return filas.map((fila) => {
    const s = snapshots.get(texto(fila.codigo_item));
    return { ...fila, grupo_impositivo: s?.grupo_impositivo ?? null, iva_pct: s?.iva_pct ?? null };
  });
}

/**
 * Renglones de un borrador reanudado que siguen sin dato y para los que la
 * sincronización YA tiene respuesta (se abrieron antes de sincronizar, o antes de esta
 * migración). Agrupa por (grupo, tarifa) para actualizar en pocas consultas.
 *
 * Un renglón con dato —aunque sea 0 %— no se toca: el snapshot no se re-evalúa.
 *
 * @returns {{grupo_impositivo: string, iva_pct: number|null, ids: *[]}[]}
 */
export function planearRefrescoIva(items = [], snapshots = new Map()) {
  const grupos = new Map();
  for (const item of items) {
    if (item?.grupo_impositivo || aNumeroONull(item?.iva_pct) !== null) continue;
    const s = snapshots.get(texto(item.codigo_item));
    if (!s?.grupo_impositivo) continue;
    const clave = `${s.grupo_impositivo}|${s.iva_pct ?? ""}`;
    if (!grupos.has(clave)) grupos.set(clave, { grupo_impositivo: s.grupo_impositivo, iva_pct: s.iva_pct, ids: [] });
    grupos.get(clave).ids.push(item.id);
  }
  return [...grupos.values()];
}
