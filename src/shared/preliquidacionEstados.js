/**
 * Tabla de transiciones de las sedes de la preliquidación (`transicionSede`).
 *
 * Única fuente de las decisiones de estado: las RPC solo validan la versión y
 * escriben el resultado (`carnes_preliq_transicionar_sede`, `congelar_sede`,
 * `cerrar_envio`). Una fila de la tabla del diseño = una rama de este módulo =
 * un test en test/preliquidacion-estados.test.js.
 *
 * `transicionSede(estado, evento, ctx)` devuelve `{estado, campos, efectos}` o
 * lanza `transición inválida`:
 *   - `campos`: parche snake_case de la fila de la sede (incluye `estado`).
 *   - `efectos`: lo que el llamador ejecuta después, en orden:
 *       {tipo:'recepcion', estado}      estado de la recepción vinculada
 *       {tipo:'alerta', evento}         encola una alerta deduplicada
 *       {tipo:'borrar_alertas'}         borra las alertas no enviadas obsoletas
 *       {tipo:'avisar_anulacion'}        correo para anular la inicial (solo en el envío real)
 *       {tipo:'intentar_autocierre'}      evalúa el cierre automático de la preliquidación
 *
 * Contexto (`ctx`), todo opcional salvo donde se indica:
 *   origen         'admin' | 'recalcular' | 'schedule' | 'sweep' | 'dispatch' | 'inmediato'
 *   motivoBloqueo  motivo actual de la sede si está `bloqueada`
 *   liberada       true si `liberada_at` está puesto
 *   siesaActivo    boolean
 *   intentos, errorTipo, ultimaCorrida, corridaId, envioId
 *   motivo, detalle  datos del evento `costeo_bloqueado`
 *   ahora          Date | string (obligatorio en `liberada`)
 *
 * Puro: sin Supabase ni Express.
 */

export const ESTADOS_SEDE = Object.freeze([
  "vinculada",
  "bloqueada",
  "lista_para_enviar",
  "calculada",
  "enviando",
  "enviada",
  "error",
  "sin_confirmar",
  "anulada",
  "simulada",
]);

export const MOTIVOS_BLOQUEO = Object.freeze([
  "excede_animales",
  "utilidad_negativa",
  "costeo_invalido",
  "armado_invalido",
  "servicio_cero",
]);

/** Motivos que puede producir el costeo (excede_animales nace en la vinculación). */
const MOTIVOS_COSTEO = ["utilidad_negativa", "costeo_invalido", "armado_invalido", "servicio_cero"];
/** Motivos que se corrigen volviendo a `vinculada` (R13). */
const MOTIVOS_CORREGIBLES = ["servicio_cero", "armado_invalido", "costeo_invalido"];

const LIMITE_INTENTOS = 3;

class TransicionInvalida extends Error {
  constructor(estado, evento, motivo) {
    super(`transición inválida: ${estado} + ${evento}${motivo ? ` (${motivo})` : ""}`);
    this.name = "TransicionInvalida";
    this.estado = estado;
    this.evento = evento;
  }
}

const invalida = (estado, evento, motivo) => {
  throw new TransicionInvalida(estado, evento, motivo);
};

const limpiaBloqueo = () => ({ motivo_bloqueo: null, detalle_bloqueo: null, liberada_at: null });

const aISO = (ahora) => (ahora instanceof Date ? ahora.toISOString() : String(ahora));

const resultado = (estado, campos = {}, efectos = []) => ({
  estado,
  campos: { estado, ...campos },
  efectos,
});

const efectoRecepcion = (estado) => ({ tipo: "recepcion", estado });
const efectoAlerta = (evento) => ({ tipo: "alerta", evento });
const efectoBorrarAlertas = () => ({ tipo: "borrar_alertas" });

// ─── Parte A: costeo y bloqueos ────────────────────────────────────────────

const PARTE_A = {
  costeo_ok(estado, ctx) {
    switch (estado) {
      case "vinculada":
        return resultado("calculada", {}, [efectoRecepcion("Costeado")]);
      case "calculada":
        return resultado("calculada");
      case "error":
        // Solo el admin o recalcular rescatan un error; las corridas automáticas no.
        if (ctx.origen !== "admin" && ctx.origen !== "recalcular") return invalida(estado, "costeo_ok", "origen");
        return resultado("calculada", { intentos: 0, error_tipo: null, motivo_pendiente: null });
      case "lista_para_enviar":
        return resultado("lista_para_enviar");
      case "anulada":
        return resultado("lista_para_enviar");
      case "simulada":
        return resultado(ctx.siesaActivo ? "calculada" : "simulada");
      case "bloqueada": {
        const m = ctx.motivoBloqueo;
        if (MOTIVOS_CORREGIBLES.includes(m)) {
          return resultado("calculada", limpiaBloqueo(), [efectoBorrarAlertas(), efectoRecepcion("Costeado")]);
        }
        if (m === "utilidad_negativa") {
          return resultado("lista_para_enviar", limpiaBloqueo(), [efectoBorrarAlertas(), efectoRecepcion("Costeado")]);
        }
        if (m === "excede_animales") {
          // Una sede en desborde nunca se costea a `lista_para_enviar` sin haber sido liberada.
          if (!ctx.liberada) return invalida(estado, "costeo_ok", "no_liberada");
          return resultado("lista_para_enviar", limpiaBloqueo(), [efectoBorrarAlertas(), efectoRecepcion("Costeado")]);
        }
        return invalida(estado, "costeo_ok", "motivo de bloqueo desconocido");
      }
      default:
        return invalida(estado, "costeo_ok");
    }
  },

  costeo_bloqueado(estado, ctx) {
    if (!MOTIVOS_COSTEO.includes(ctx.motivo)) {
      throw new Error(`costeo_bloqueado requiere un motivo válido (${MOTIVOS_COSTEO.join(", ")}): ${String(ctx.motivo)}`);
    }
    const origenes = ["vinculada", "calculada", "error", "lista_para_enviar", "anulada", "simulada", "bloqueada"];
    if (!origenes.includes(estado)) return invalida(estado, "costeo_bloqueado");
    return resultado(
      "bloqueada",
      { motivo_bloqueo: ctx.motivo, detalle_bloqueo: ctx.detalle ?? null, liberada_at: null },
      [efectoAlerta(ctx.motivo)],
    );
  },

  excede(estado) {
    if (estado !== "vinculada") return invalida(estado, "excede");
    return resultado("bloqueada", { motivo_bloqueo: "excede_animales", liberada_at: null }, [efectoAlerta("excede_animales")]);
  },

  liberada(estado, ctx) {
    if (estado !== "bloqueada" || ctx.motivoBloqueo !== "excede_animales" || ctx.liberada) {
      return invalida(estado, "liberada");
    }
    if (ctx.ahora == null) throw new Error("liberada requiere ctx.ahora");
    // Sigue bloqueada(excede_animales): ahora consume animales y entra a la cola de costeo,
    // pero solo llega a lista_para_enviar por un costeo.
    return resultado("bloqueada", { liberada_at: aISO(ctx.ahora) });
  },

  corregida(estado, ctx) {
    if (estado !== "bloqueada" || !MOTIVOS_CORREGIBLES.includes(ctx.motivoBloqueo)) {
      return invalida(estado, "corregida");
    }
    return resultado("vinculada", limpiaBloqueo(), [efectoBorrarAlertas()]);
  },

  reclamada(estado, ctx) {
    const intentos = Number(ctx.intentos ?? 0);
    switch (estado) {
      case "calculada":
        return resultado("enviando", { intentos: intentos + 1 });
      case "simulada":
        if (!ctx.siesaActivo) return invalida(estado, "reclamada", "siesa_apagado");
        return resultado("enviando", { intentos: intentos + 1 });
      case "error": {
        const otraCorrida = ctx.ultimaCorrida == null || ctx.ultimaCorrida !== ctx.corridaId;
        if (ctx.errorTipo !== "transitorio" || intentos >= LIMITE_INTENTOS || !otraCorrida) {
          return invalida(estado, "reclamada");
        }
        return resultado("enviando", { intentos: intentos + 1 });
      }
      case "enviando":
        // Solo un `enviando` abandonado: sin fila de SIESA todavía.
        if (ctx.envioId != null) return invalida(estado, "reclamada", "envio_id");
        return resultado("enviando", { intentos: intentos + 1 });
      default:
        return invalida(estado, "reclamada");
    }
  },

  reclamada_admin(estado) {
    if (!["lista_para_enviar", "error", "simulada"].includes(estado)) return invalida(estado, "reclamada_admin");
    // Los intentos se reinician a 0 y esta tentativa cuenta.
    return resultado("enviando", { intentos: 1, error_tipo: null, motivo_pendiente: null });
  },

  inicial_no_ok(estado) {
    if (estado !== "calculada") return invalida(estado, "inicial_no_ok");
    return resultado("calculada", { motivo_pendiente: "inicial_pendiente" }, [efectoAlerta("inicial_pendiente")]);
  },

  siesa_apagado(estado) {
    if (estado !== "calculada") return invalida(estado, "siesa_apagado");
    return resultado("simulada");
  },
};

// ─── Parte B: envío y cierre ───────────────────────────────────────────────

const conEnvioId = (ctx) => (ctx.envioId != null ? { envio_id: ctx.envioId } : {});
const efectoBorrarAlertasCorreccion = () => ({ tipo: "borrar_alertas", evento: "requiere_correccion" });

/**
 * Cierre exitoso: la sede queda `enviada`. T6: `requiere_correccion` se limpia al
 * reenviar con éxito. El refinamiento de M2 (no limpiarlo si el CEA llevó montos
 * anteriores al recálculo) se aplica en la tarea 2.6.
 */
function aEnviada(ctx, { avisarAnulacion }) {
  const efectos = [efectoRecepcion("Enviado_SIESA")];
  if (avisarAnulacion) efectos.push({ tipo: "avisar_anulacion" });
  efectos.push(efectoBorrarAlertasCorreccion(), { tipo: "intentar_autocierre" });
  return resultado("enviada", { ...conEnvioId(ctx), requiere_correccion: false }, efectos);
}

const PARTE_B = {
  envio_ok(estado, ctx) {
    if (estado !== "enviando") return invalida(estado, "envio_ok");
    return aEnviada(ctx, { avisarAnulacion: true });
  },

  envio_repetido_ok(estado, ctx) {
    if (estado !== "enviando") return invalida(estado, "envio_repetido_ok");
    // El aviso de anulación ya salió con el primer envío.
    return aEnviada(ctx, { avisarAnulacion: false });
  },

  envio_repetido_enviando(estado, ctx) {
    if (estado !== "enviando") return invalida(estado, "envio_repetido_enviando");
    // Otra instancia tiene el envío en vuelo: queda `enviando` con su envio_id, que ya no se reclama.
    return resultado("enviando", conEnvioId(ctx), [efectoAlerta("envio_en_vuelo")]);
  },

  envio_sin_confirmar(estado, ctx) {
    if (estado !== "enviando") return invalida(estado, "envio_sin_confirmar");
    return resultado("sin_confirmar", conEnvioId(ctx), [efectoAlerta("sin_confirmar")]);
  },

  envio_error(estado, ctx) {
    if (estado !== "enviando") return invalida(estado, "envio_error");
    if (ctx.errorTipo !== "transitorio" && ctx.errorTipo !== "permanente") {
      throw new Error(`envio_error requiere errorTipo 'transitorio' o 'permanente': ${String(ctx.errorTipo)}`);
    }
    const campos = { error_tipo: ctx.errorTipo, ...conEnvioId(ctx) };
    if (ctx.errorTipo === "permanente") return resultado("error", campos, [efectoAlerta("envio_error")]);
    if (Number(ctx.intentos ?? 0) >= LIMITE_INTENTOS) {
      return resultado("error", { ...campos, motivo_pendiente: "reintentos_agotados" }, [efectoAlerta("reintentos_agotados")]);
    }
    return resultado("error", campos);
  },

  armado_bloqueado(estado, ctx) {
    if (estado !== "enviando") return invalida(estado, "armado_bloqueado");
    return resultado(
      "bloqueada",
      { motivo_bloqueo: "armado_invalido", detalle_bloqueo: ctx.detalle ?? null, liberada_at: null },
      [efectoAlerta("armado_invalido")],
    );
  },

  resuelto_ok(estado, ctx) {
    if (estado !== "enviando" && estado !== "sin_confirmar") return invalida(estado, "resuelto_ok");
    // El correo de anulación lo manda el resolver(); aquí solo se sincroniza la sede.
    return aEnviada(ctx, { avisarAnulacion: false });
  },

  resuelto_error(estado) {
    if (estado !== "enviando" && estado !== "sin_confirmar") return invalida(estado, "resuelto_error");
    // Una persona confirmó que no llegó: permanente, solo el admin lo reenvía.
    return resultado("error", { error_tipo: "permanente" });
  },

  anulacion_confirmada(estado) {
    if (estado !== "enviada") return invalida(estado, "anulacion_confirmada");
    return resultado("anulada", {}, [efectoRecepcion("Costeado")]);
  },

  recalcular_no_enviadas(estado) {
    if (!["enviando", "enviada", "sin_confirmar"].includes(estado)) return invalida(estado, "recalcular_no_enviadas");
    return resultado(estado, { requiere_correccion: true }, [efectoAlerta("requiere_correccion")]);
  },

  correccion_descartada(estado, ctx) {
    if (!ctx.requiereCorreccion) return invalida(estado, "correccion_descartada", "sin requiere_correccion");
    return resultado(estado, { requiere_correccion: false }, [efectoBorrarAlertasCorreccion()]);
  },
};

const MANEJADORES = { ...PARTE_A, ...PARTE_B };

const esEstadoRechazo = (httpStatus) => httpStatus != null && httpStatus >= 400 && httpStatus < 500;

/**
 * Traduce lo que devuelve `registrarYEnviar` al evento de `transicionSede`.
 *
 * - `armadoBloqueos` no vacío: el documento no salió por una validación propia
 *   (p. ej. renglón sin código SIESA); es `armado_bloqueado`, nunca `error`.
 * - `error`: rechazo de SIESA (4xx, o 200 con rechazo en el cuerpo) = permanente;
 *   sin respuesta (no conectó) o 5xx = transitorio. Los timeouts y 502/503/504 ya
 *   llegan como `sin_confirmar`.
 *
 * @param {{estado: string, repetido?: boolean, id?: *, http_status?: number|null}} fila
 * @param {{armadoBloqueos?: string[]}} [opciones]
 * @returns {{evento: string, ctx: object}}
 */
export function mapearEnvio(fila, { armadoBloqueos = [] } = {}) {
  if (!fila || typeof fila !== "object") throw new Error("fila de envío no mapeable");
  if (armadoBloqueos.length) {
    return { evento: "armado_bloqueado", ctx: { detalle: armadoBloqueos.join(" ") } };
  }
  const ctx = { envioId: fila.id };

  if (fila.repetido) {
    if (fila.estado === "ok") return { evento: "envio_repetido_ok", ctx };
    if (fila.estado === "enviando") return { evento: "envio_repetido_enviando", ctx };
    if (fila.estado === "sin_confirmar") return { evento: "envio_sin_confirmar", ctx };
    throw new Error(`fila de envío repetida no mapeable (estado ${String(fila.estado)})`);
  }
  if (fila.estado === "ok") return { evento: "envio_ok", ctx };
  if (fila.estado === "sin_confirmar") return { evento: "envio_sin_confirmar", ctx };
  if (fila.estado === "error") {
    const permanente = fila.http_status === 200 || esEstadoRechazo(fila.http_status);
    return { evento: "envio_error", ctx: { ...ctx, errorTipo: permanente ? "permanente" : "transitorio" } };
  }
  throw new Error(`fila de envío no mapeable (estado ${String(fila.estado)})`);
}

/**
 * @param {string} estado estado actual de la sede
 * @param {string} evento
 * @param {object} [ctx]
 * @returns {{estado: string, campos: object, efectos: object[]}}
 */
export function transicionSede(estado, evento, ctx = {}) {
  if (!ESTADOS_SEDE.includes(estado)) throw new Error(`estado desconocido: ${String(estado)}`);
  const manejador = MANEJADORES[evento];
  if (!manejador) throw new Error(`evento desconocido: ${String(evento)}`);
  return manejador(estado, ctx);
}
