# Anular una preliquidación ya enviada a SIESA (sql/046)

Caso: una preliquidación (cerrada o abierta) salió a SIESA con datos erróneos (p. ej. conteo de animales) y el
costo quedó mal. Las CEA oficiales ya se anularon A MANO en SIESA. Hay que liberar las recepciones para
vincularlas a otra preliquidación de la especie y reenviarlas con el costo correcto.

## Despliegue

1. Correr `sql/046_preliquidacion_anular_enviada.sql` en Supabase (tabla `carnes_preliquidacion_sedes_anuladas` + RPC
   `carnes_preliq_anular_enviada`). Precondición: 038-041 y 011. Reversión: `sql/046_rollback.sql` (no revierte datos).
2. Desplegar el backend.

## Endpoint (solo admin; escritura normal, respeta el interruptor del módulo)

`POST /api/preliquidaciones/:id/anular-enviada`

```json
{ "confirmo_anulacion_siesa": true, "motivo": "Conteo de animales erróneo (71 en vez de 74)" }
```

Cuerpo estricto: `confirmo_anulacion_siesa` debe ser `true` y `motivo` (3 a 500 caracteres) es obligatorio.
Respuesta: `{ ok, data: { resultado: "ok", preliquidacion_id, sedes_liberadas, recepciones, envios_anulados, saldos_reasignados, saldos_destino_id } }`.

Errores 409 `no_anulable` con `motivo`: `ya_anulada`, `sede_ambigua` (alguna sede o envío oficial `enviando` o
`sin_confirmar`: resuélvalo antes), `visceras_vigentes` (CEI de vísceras vigente: fuera de alcance),
`envio_compartido` (un oficial vigente cubre recepciones ajenas) y `saldo_aplicado`. Todo o nada.

## Qué hace (una transacción, bajo lock de cabecera, sedes y recepciones)

- Envíos oficiales `ok`/`duplicado` de las recepciones -> `anulado` (por, fecha, motivo): libera el candado de sql/010.
- Cada sede se copia entera (jsonb) a `carnes_preliquidacion_sedes_anuladas` y se borra (`recepcion_id` es UNIQUE).
- Cada recepción: `preliquidacion_id = NULL`, estado `Aprobado` (como una de talleres recién finalizada),
  `costeado_at`/`siesa_at` NULL y costos de renglones limpios. `inicial_omitida_*` y los envíos `inicial` no se tocan.
- Saldos como `carnes_preliq_anular`; avisos sin enviar borrados (no se manda ningún correo).
- Cabecera -> `anulada` (`anulada_at`, `anulada_por`, `motivo_anulacion`), sube `version` y `orden_version`.
- Jamás llama a SIESA.

Después: `POST /api/preliquidaciones/<nueva>/recepciones` con cada recepción liberada y el flujo normal de envío.
La compuerta de la inicial al enviar pasa por la inicial `ok` que ya existía o por `inicial_omitida_at`.
