/**
 * Interruptor de pruebas.
 *
 * Con `CARNES_SANDBOX=true` no sale ni un correo. Existe porque este módulo le
 * avisa al admin cada vez que un recibidor cierra una recepción, y probar el
 * flujo en local sin este freno significa mandarle correos de mentira a una
 * persona real hasta que aprende a ignorarlos — que es justo el día en que el
 * correo que importa no lo va a leer.
 *
 * Se lee en cada llamada, no se cachea en el módulo: en Vercel el proceso se
 * reutiliza entre invocaciones y un cache dejaría el sandbox pegado al valor que
 * tenía cuando arrancó el lambda.
 */
export function sandboxOn() {
  return String(process.env.CARNES_SANDBOX || "").toLowerCase() === "true";
}
