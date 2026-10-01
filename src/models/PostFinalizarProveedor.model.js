import { notaCreditoRequerida } from "../shared/finalizarProveedor.js";
import * as SiesaEnvio from "./SiesaEnvio.model.js";

/* =============================================
   Lo que pasa DESPUÉS de firmar una recepción de proveedor: la entrada CEA a SIESA
   y, si hubo devoluciones, la nota crédito.

   Es la costura entre `finalizar` (que firma) y `SiesaEnvio.model.js` (que tiene el
   candado, el POST y las reglas). Acá solo se llama y se da forma a la respuesta:

     1. `SiesaEnvio.enviarEntradaProveedor` lee los envíos `entrada_proveedor` de la
        recepción y manda SOLO si no hay NINGUNO (ni uno con error: eso lo reintenta
        el admin). Con `CARNES_SIESA_ACTIVO` apagado no manda ni anota nada.
     2. Si el envío quedó ok: recepción Finalizada → Enviada_SIESA (+ `siesa_at`) y
        la nota crédito si hubo devoluciones (bloqueada mientras su conector no exista).
     3. Devuelve `siesa` / `notaCredito` con el estado REAL y, si cambió, las
        columnas nuevas de la recepción (`cambios`: estado, siesa_at).

   NUNCA lanza: la recepción YA está firmada y lo que falle acá se reporta en la
   respuesta, no como error de finalizar. Puede tardar: la espera a SIESA es de
   hasta 45 s por documento, por eso el front usa 120 s para este pedido.
   ============================================= */

/**
 * @param {object} p
 * @param {object} p.recepcion     la recepción ya finalizada (como la devuelve `obtener`)
 * @param {object} p.resumen       `resumenRecepcion(items)`
 * @param {boolean} p.yaFinalizada true si esta llamada fue un reintento sobre una recepción ya firmada
 * @returns {Promise<{siesa: {estado: string, referencia: ?string, error: ?string, envio_id: ?number},
 *   notaCredito: {requerida: boolean, estado: string, bloqueo: ?string, referencia?: ?string, error?: ?string},
 *   cambios: ?{estado: string, siesa_at: ?string}, aviso: ?string}>}
 *   `siesa.estado`: ok | error | apagado | enviando | sin_confirmar | pendiente.
 *   `notaCredito.estado`: no_requerida | pendiente | bloqueada | enviando |
 *   sin_confirmar | error | ok.
 */
export async function despuesDeFinalizar({ recepcion, resumen, yaFinalizada }) {
  const requerida = notaCreditoRequerida(resumen);
  try {
    const r = await SiesaEnvio.enviarEntradaProveedor(recepcion.id, recepcion.recibido_por);
    return {
      siesa: r.siesa,
      // Si el armado de la nota crédito falló no hay estado propio: "pendiente".
      notaCredito: r.notaCredito ?? { requerida, estado: "pendiente", bloqueo: null },
      cambios: r.cambios ?? null,
      aviso: r.aviso ?? null,
    };
  } catch (e) {
    // `enviarEntradaProveedor` no lanza; esto cubre solo lo que no se espera.
    console.error(`🔴 Post-finalizar proveedor #${recepcion?.id}: ${e?.message}`);
    return {
      siesa: { estado: "error", referencia: null, error: e?.message || "Error al enviar a SIESA.", envio_id: null },
      notaCredito: { requerida, estado: "pendiente", bloqueo: null },
      cambios: null,
      aviso: null,
    };
  }
}
