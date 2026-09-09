/**
 * Middleware centralizado de manejo de errores.
 * Atrapa cualquier error lanzado en los controladores y devuelve una respuesta
 * JSON consistente.
 */
export function errorHandler(err, req, res, _next) {
  console.error("🔴 Error:", err.message);

  const statusCode = err.statusCode || 500;
  const mensaje = err.expose ? err.message : "Error interno del servidor";

  res.status(statusCode).json({
    ok: false,
    error: mensaje,
    ...(err.codigo && { codigo: err.codigo }),
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}

/**
 * Helper para crear errores con código HTTP.
 *
 * `expose` marca el mensaje como apto para el cliente. Un error sin `expose`
 * sale como "Error interno": los mensajes de Postgres traen nombres de tablas y
 * columnas, y eso no se le manda a un navegador.
 *
 * `codigo` es opcional y es para el CÓDIGO del front, no para la persona: le
 * permite distinguir "sede equivocada" de "lote repetido" sin leer el texto del
 * mensaje. Sin él, el front termina haciendo `/otra sede/.test(mensaje)` — y esa
 * condición se rompe en silencio el día que alguien reescriba una frase, que es
 * algo que va a pasar porque estos mensajes están escritos para que se entiendan.
 */
export function createError(statusCode, message, codigo) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  if (codigo) error.codigo = codigo;
  return error;
}
