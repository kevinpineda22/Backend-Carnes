/**
 * Reglas puras de la APERTURA de una recepción de proveedor: qué hacer cuando ya
 * existe algo con la misma factura, qué se le dice a la persona y cómo se
 * materializan los renglones desde la plantilla.
 *
 * Puro, sin Supabase ni Express, como `verificacionQr.js`: `RecepcionProveedor.model.js`
 * lee la base y ESTE módulo decide. Así la regla que más plata protege (no recibir
 * dos veces la misma factura) se puede testear sin base de datos.
 *
 * ─── Qué pasa al abrir (P + factura) ───────────────────────────────────────
 *
 *   · Hay una Finalizada / Enviada_SIESA → se BLOQUEA: "Esta factura ya se recibió
 *     el {fecha} en {sede}". Una factura recibida dos veces es una compra doble en
 *     SIESA y un pago doble.
 *   · Hay un Borrador de ESTA sede → se REANUDA. El recibidor trabaja en un
 *     celular, recargar es lo más normal, y no puede quedar fuera de su propio
 *     borrador.
 *   · Hay un Borrador de OTRA sede → se bloquea, diciendo desde cuándo (y cuántos
 *     días lleva) para que se vea si quedó abierto por error.
 *   · Nada → se crea.
 *
 * "Hay" se mira contra las dos llaves únicas de sql/022 (la factura original y la
 * referencia corregida por el admin): ver `RecepcionProveedor.model.js`.
 */

import { ESTADOS } from "./estadosProveedor.js";
import { hoyBogota, LARGO_FACTURA_SIESA, facturaCabeEnSiesa } from "./proveedorValores.js";

/**
 * Un borrador de OTRA sede con más días que esto ya huele a abandonado: el mensaje
 * le avisa a quien choca con él que un administrador lo puede descartar.
 */
export const DIAS_BORRADOR_VIEJO = 3;

// ─── Fechas ────────────────────────────────────────────────────────────────

/**
 * `YYYY-MM-DD` del calendario de Bogotá para lo que venga de la base: un DATE
 * ("2026-09-28", se respeta tal cual, sin pasarlo por zona horaria) o un
 * timestamptz (se convierte a Bogotá). Vacío o inválido → null.
 */
function fechaBogotaISO(valor) {
  if (!valor) return null;
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) return null;
  return hoyBogota(fecha);
}

/** dd/mm/aaaa en hora de Bogotá, como lo lee el recibidor. Vacío si no hay fecha. */
export function formatearFechaBogota(valor) {
  const iso = fechaBogotaISO(valor);
  if (!iso) return "";
  const [anio, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${anio}`;
}

/**
 * Días de calendario (Bogotá) entre `valor` y `ahora`, nunca negativos. Se cuenta
 * por DÍA y no por 24 horas: un borrador abierto ayer a las 11 p. m. "tiene un
 * día" a las 8 a. m., no 9 horas.
 */
export function diasDesde(valor, ahora = new Date()) {
  const desde = fechaBogotaISO(valor);
  const hasta = fechaBogotaISO(ahora);
  if (!desde || !hasta) return 0;
  const aMs = (iso) => {
    const [a, m, d] = iso.split("-").map(Number);
    return Date.UTC(a, m - 1, d);
  };
  return Math.max(0, Math.round((aMs(hasta) - aMs(desde)) / 86_400_000));
}

// ─── Mensajes ──────────────────────────────────────────────────────────────

function nombreSede(candidata) {
  return candidata?.sede?.nombre || "otra sede";
}

/**
 * Texto para una persona a partir del resultado de `Sede.verificarQr`. Es el
 * mismo texto que `mensajeVerificacion` de `Recepcion.model.js` (Talleres): se
 * repite acá porque ese es privado y no se toca Talleres en este corte.
 */
export function mensajeVerificacionQr({ estado, sede } = {}) {
  if (estado === "desconocido") {
    return (
      "Ese código QR no está registrado. Verificá que sea el de la zona de " +
      "recibo y no otro adhesivo."
    );
  }
  if (estado === "sede_inactiva") {
    return `El QR corresponde a ${sede?.nombre}, que está inactiva. Avisale al administrador.`;
  }
  return (
    `El QR que escaneaste es de ${sede?.nombre}. Cambiá la sede seleccionada ` +
    "o escaneá el código de la sede donde estás."
  );
}

/**
 * La factura ya fue recibida (Finalizada o Enviada_SIESA). La fecha es la de la
 * firma, en Bogotá; sin ella (no debería pasar) la de la recepción.
 */
export function mensajeFacturaRecibida(candidata) {
  const fecha = formatearFechaBogota(candidata?.finalizado_at || candidata?.fecha_recepcion);
  return `Esta factura ya se recibió el ${fecha} en ${nombreSede(candidata)}`;
}

/**
 * La factura está abierta en OTRA sede. Dice desde cuándo y, si ya pasaron días,
 * cuántos: un borrador de hace una semana casi seguro quedó abierto por error, y
 * quien choca con él tiene que saber que un administrador lo puede descartar.
 */
export function mensajeFacturaEnRecepcion(candidata, ahora = new Date()) {
  const fecha = formatearFechaBogota(candidata?.abierto_at || candidata?.fecha_recepcion);
  const dias = diasDesde(candidata?.abierto_at || candidata?.fecha_recepcion, ahora);

  let texto = `Esta factura está en recepción desde el ${fecha} en ${nombreSede(candidata)}`;
  if (dias >= 1) texto += ` (hace ${dias} ${dias === 1 ? "día" : "días"})`;
  if (dias >= DIAS_BORRADOR_VIEJO) {
    texto += ". Si quedó abierta por error, un administrador puede descartar el borrador";
  }
  return texto;
}

// ─── Decisión ──────────────────────────────────────────────────────────────

/**
 * Qué hacer con las recepciones vivas que ya usan esta factura.
 *
 * `candidatas`: filas de `carnes_proveedor_recepciones` de ESE proveedor que
 * chocan con la factura (por la factura original o por la referencia corregida),
 * con `{ id, estado, sede_id, abierto_at, finalizado_at, fecha_recepcion, sede }`.
 * Las Anuladas no cuentan: anular es el camino legítimo para volver a recibir.
 *
 * Precedencia: una ya recibida bloquea aunque haya un borrador propio (recibir
 * dos veces es lo que hay que impedir); después el borrador de esta sede se
 * reanuda; por último el de otra sede bloquea.
 *
 * @returns {{accion: "crear"}
 *   | {accion: "reanudar", id: *}
 *   | {accion: "bloquear", codigo: string, mensaje: string}}
 */
export function decidirApertura(candidatas = [], sedeId, ahora = new Date()) {
  const vivas = (candidatas || []).filter((c) => c && c.estado !== ESTADOS.ANULADA);

  const recibida = vivas.find((c) => c.estado !== ESTADOS.BORRADOR);
  if (recibida) {
    return {
      accion: "bloquear",
      codigo: "FACTURA_YA_RECIBIDA",
      mensaje: mensajeFacturaRecibida(recibida),
    };
  }

  const borradores = vivas.filter((c) => c.estado === ESTADOS.BORRADOR);
  const propio = borradores.find((c) => String(c.sede_id) === String(sedeId));
  if (propio) return { accion: "reanudar", id: propio.id };

  const ajeno = borradores[0];
  if (ajeno) {
    return {
      accion: "bloquear",
      codigo: "FACTURA_EN_RECEPCION",
      mensaje: mensajeFacturaEnRecepcion(ajeno, ahora),
    };
  }

  return { accion: "crear" };
}

// ─── Avisos y renglones ────────────────────────────────────────────────────

/**
 * Avisos NO bloqueantes al abrir. Una factura de más de 12 caracteres se puede
 * recibir (la mercancía ya llegó), pero no cabe en el PENDIENTE de SIESA: el
 * bloqueo real es al ENVIAR, nunca acá, y nunca se recorta.
 *
 * @returns {{tipo: string, mensaje: string}[]}
 */
export function avisosDeFactura(factura) {
  if (facturaCabeEnSiesa(factura)) return [];
  return [
    {
      tipo: "factura_larga",
      mensaje:
        `La factura tiene más de ${LARGO_FACTURA_SIESA} caracteres: se puede recibir, ` +
        "pero no se enviará a SIESA hasta que un administrador corrija la referencia.",
    },
  ];
}

/**
 * Los renglones de una recepción nueva: uno por fila de la plantilla, con todo lo
 * que identifica el ítem COPIADO (snapshot). Editar la plantilla después no
 * cambia una recepción ya abierta. `equivalencia_id` solo dice de dónde salió.
 */
export function renglonesDesdePlantilla(equivalencias = [], recepcionId) {
  return equivalencias.map((e) => ({
    recepcion_id: recepcionId,
    equivalencia_id: e.id,
    codigo_item: e.codigo_item,
    descripcion_item: e.descripcion_item ?? null,
    unidad: e.unidad,
    equivalencia: e.equivalencia ?? "",
    orden: e.orden ?? 0,
  }));
}

// ─── Errores de la base ────────────────────────────────────────────────────

/** 23505: otra petición ganó la carrera por la llave única de la factura. */
export function esViolacionUnica(error) {
  return error?.code === "23505";
}

/**
 * El guardián de renglones de sql/022 (SQLSTATE 'PV409') rechazó la escritura
 * porque la recepción ya salió de Borrador. Se mira también el texto por si el
 * código no viajara.
 */
export function esRecepcionNoBorrador(error) {
  return error?.code === "PV409" || /ya no está en borrador/i.test(String(error?.message || ""));
}

/**
 * 40P01 (deadlock_detected) o 40001 (serialization_failure): dos peticiones se
 * cruzaron sobre la misma recepción (típico: descartar vs autoguardado, que
 * bloquean cabecera y renglones en orden distinto). Postgres ya eligió una
 * víctima y cancelar y reintentar es la respuesta correcta, no un error 500.
 */
export function esConflictoReintentable(error) {
  return error?.code === "40P01" || error?.code === "40001";
}
