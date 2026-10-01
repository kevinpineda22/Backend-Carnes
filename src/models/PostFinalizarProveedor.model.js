import { notaCreditoRequerida } from "../shared/finalizarProveedor.js";

/* =============================================
   Lo que pasa DESPUÉS de firmar una recepción de proveedor: la entrada CEA a SIESA
   y, si hubo devoluciones, la nota crédito.

   ─── ESTE ARCHIVO ES UN SEAM (costura) ────────────────────────────────────
   En este corte NO se manda nada a SIESA: `finalizar` firma y devuelve, y este
   módulo contesta "pendiente" para que el front ya tenga la forma de la respuesta.
   El envío llega con el corte de SIESA (sql/023 + `SiesaEnvio.model.js`), que
   reemplaza el cuerpo de `despuesDeFinalizar`:

     1. Leer los envíos `entrada_proveedor` de la recepción.
     2. Solo si `debeEnviarEntrada({ estado, enviosEntrada })` es true, llamar
        `SiesaEnvio.enviarEntradaProveedor` (nunca lanza; no-op "apagado" si
        `CARNES_SIESA_ACTIVO` está apagado). Es la regla de los reintentos de
        `finalizar`: SOLO se envía si no hay NINGÚN envío de entrada, ni siquiera
        uno con error (eso lo reintenta el admin).
     3. Si el envío quedó ok: recepción Finalizada → Enviada_SIESA (+ `siesa_at`) y
        `dispararNotaCreditoSiCorresponde`.
     4. Devolver la misma forma de abajo con los valores reales.

   Nunca debe lanzar: la recepción YA está firmada y lo que falle acá se reporta
   en la respuesta, no como error de finalizar.
   ============================================= */

/**
 * @param {object} p
 * @param {object} p.recepcion     la recepción ya finalizada (como la devuelve `obtener`)
 * @param {object} p.resumen       `resumenRecepcion(items)`
 * @param {boolean} p.yaFinalizada true si esta llamada fue un reintento sobre una recepción ya firmada
 * @returns {Promise<{siesa: {estado: string, referencia: ?string, error: ?string},
 *   notaCredito: {requerida: boolean, estado: string, bloqueo: ?string}}>}
 */
export async function despuesDeFinalizar({ recepcion, resumen, yaFinalizada }) {
  return {
    // Valores previstos cuando el envío exista: "ok" | "error" | "apagado" |
    // "sin_confirmar" | "bloqueado". Mientras tanto SIEMPRE "pendiente".
    siesa: { estado: "pendiente", referencia: null, error: null },
    notaCredito: {
      requerida: notaCreditoRequerida(resumen),
      estado: "pendiente",
      bloqueo: null,
    },
  };
}
