/**
 * Columnas de `carnes_recepciones` que pueden salir en una lectura corriente.
 *
 * Es una lista EXPLÍCITA (no `*`) a propósito: desde sql/027 la tabla guarda la
 * firma del recibidor (`firma_data`, un PNG en base64 que puede pesar decenas de
 * KB) y su cédula (`recibidor_cedula`, dato personal). Con `*` esas dos viajarían
 * en cada listado, en `GET /recepciones/:id` (que lee el recibidor desde su
 * celular) y dentro de las liquidaciones. Solo la lectura del admin las pide, por
 * `COLUMNAS_FIRMA_RECIBIDOR`.
 *
 * Si se agrega una columna a la tabla y la pantalla la necesita, se agrega acá.
 */
export const COLUMNAS_RECEPCION = [
  "id",
  "liquidacion_id",
  "especie",
  "sede_id",
  "fecha_ingreso",
  "novillos",
  "estado",
  "recibido_por",
  "recibido_at",
  "sede_verificada",
  "sede_verificada_at",
  "aprobado_por",
  "aprobado_at",
  "motivo_rechazo",
  "costeado_at",
  "siesa_at",
  "siesa_documento",
  "observaciones",
  "iniciado_at",
  "created_at",
  "updated_at",
].join(", ");

/** Lo que agrega sql/027: SOLO para el detalle del admin. */
export const COLUMNAS_FIRMA_RECIBIDOR =
  "recibidor_id, recibidor_cedula, recibidor_nombre, recibidor_otro, firma_data";
