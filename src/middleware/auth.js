import crypto from "node:crypto";
import { createError } from "./errorHandler.js";

/**
 * Autenticación de la API de Carnes — con interruptor.
 *
 * ─── Por qué existe ───────────────────────────────────────────────────────
 *
 * Hasta ahora la API confiaba en que quien la llamaba venía del front. CORS
 * (config/cors.js) frena a otras PESTAÑAS del navegador, no a `curl`. Esto
 * agrega identidad de verdad: el front manda el JWT de la sesión de Supabase
 * (la misma con la que el empleado inicia sesión en la app) y el backend lo
 * verifica.
 *
 * ─── Modos: `CARNES_AUTH` ─────────────────────────────────────────────────
 *
 *   off       (por defecto, y cualquier valor desconocido) No hace NADA: ni
 *             siquiera verifica. El comportamiento es el de antes, idéntico.
 *   reportar  Verifica si viene token y deja `req.usuario`, pero NUNCA bloquea.
 *             Cuenta cada anomalía (sin token, token inválido, sin perfil,
 *             proveedor caído) y escribe un resumen periódico por instancia más
 *             una línea de detalle muestreada por tipo. Sirve para ver qué se
 *             rompería antes de exigir.
 *   exigir    Bloquea: 401 sin token o con token inválido/vencido, 403 si el
 *             usuario no tiene perfil, 503 si no se puede verificar (proveedor
 *             de autenticación caído o lento).
 *
 * Volver atrás en cualquier paso es poner `CARNES_AUTH=off`. Ver
 * docs/VARIABLES_DE_ENTORNO.md para el plan de despliegue.
 *
 * ─── Códigos de error estables (`codigo`) ─────────────────────────────────
 *
 * El front los mapea a mensajes (Carnes/utils/erroresAuth.js); no cambiarlos:
 *   AUTH_REQUERIDA (401), AUTH_INVALIDA (401), AUTH_NO_DISPONIBLE (503),
 *   AUTH_SIN_PERFIL (403), AUTH_SIN_PERMISO (403).
 *
 * ─── Por qué módulo puro ──────────────────────────────────────────────────
 *
 * No importa el cliente de Supabase: la verificación entra por parámetro
 * (`verificar`, `existePerfil`). Así los tests corren sin red ni variables de
 * entorno. El cableado real vive en `authCarnes.js` / `authSupabase.js`.
 *
 * ─── Estado por instancia ─────────────────────────────────────────────────
 *
 * Cachés, deduplicación y contadores viven en memoria de cada instancia de la
 * función (Vercel puede tener varias). Nada se comparte entre ellas.
 */

const MODOS = ["off", "reportar", "exigir"];

/** Cuánto se recuerda un resultado positivo (token válido con perfil, o admin permitido). */
const TTL_MS = 60_000;
/** Un "no" (sin perfil, sin permiso) se recuerda poco: si el admin acaba de dar el permiso, no debe esperar. */
const TTL_NEGATIVO_MS = 15_000;
/** Un token inválido se recuerda poco para que un bucle de basura no le pegue a Supabase en cada pedido. */
const TTL_INVALIDO_MS = 10_000;
/** Tope de espera a Supabase (getUser / permisos). Pasado esto es "proveedor no disponible". */
const TIMEOUT_PROVEEDOR_MS = 2_500;
/** Entradas máximas por caché (se descarta la más vieja al llenarse). */
const MAX_CACHE = 500;
/** Un JWT real mide ~1 KB; más de esto no es un token. */
const MAX_TOKEN = 4096;
/** Verificaciones simultáneas deduplicadas; pasado esto se verifica sin deduplicar. */
const MAX_EN_VUELO = 200;
/** Cada cuánto se escribe la línea de resumen por instancia. */
const INTERVALO_RESUMEN_MS = 5 * 60_000;
/** O cada tantos eventos, lo que ocurra primero. */
const MAX_EVENTOS_RESUMEN = 1_000;
/** A lo sumo una línea de detalle por tipo de anomalía en este intervalo. */
const INTERVALO_DETALLE_MS = 60_000;
/** Largo del hash corto con el que se identifica un correo en los logs. */
const LARGO_HASH_CORTO = 8;
/** Largo máximo del `Origin` que se copia al log. */
const MAX_ORIGEN_LOG = 100;
/** Un JWT son tres segmentos base64url separados por puntos. */
const FORMA_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Contadores que siempre salen en el resumen, aunque estén en cero. */
const CONTADORES_RESUMEN = [
  "ok",
  "sin_token",
  "token_invalido",
  "sin_perfil",
  "proveedor_no_disponible",
  "admin_denegaria",
  "admin_denegado",
  "identidad_distinta",
];

let valorInvalidoAvisado = null;

/** Lee `CARNES_AUTH`. Cualquier cosa que no sea un modo conocido es `off`. */
export function modoAuth(env = process.env) {
  const crudo = String(env.CARNES_AUTH || "").trim().toLowerCase();
  if (MODOS.includes(crudo)) return crudo;
  // Un typo ("exigr") deja la API abierta sin que nadie lo note: se avisa una vez.
  if (crudo && valorInvalidoAvisado !== crudo) {
    valorInvalidoAvisado = crudo;
    console.warn(
      `⚠️  CARNES_AUTH="${crudo}" no es un modo válido (off | reportar | exigir). Se usa "off".`,
    );
  }
  return "off";
}

// ─── Utilidades internas ────────────────────────────────────────────────────

/** Caché en memoria con vencimiento por entrada y tamaño acotado. */
function crearCache({ max = MAX_CACHE, ahora = Date.now } = {}) {
  const mapa = new Map();
  return {
    get(clave) {
      const entrada = mapa.get(clave);
      if (!entrada) return undefined;
      if (entrada.vence <= ahora()) {
        mapa.delete(clave);
        return undefined;
      }
      return entrada.valor;
    },
    set(clave, valor, vence) {
      if (mapa.size >= max && !mapa.has(clave)) {
        const t = ahora();
        for (const [k, e] of mapa) if (e.vence <= t) mapa.delete(k);
        // Sigue lleno: se descarta la más vieja (el Map conserva el orden de inserción).
        if (mapa.size >= max) mapa.delete(mapa.keys().next().value);
      }
      mapa.set(clave, { valor, vence });
    },
    get size() {
      return mapa.size;
    },
  };
}

const hashDe = (texto) => crypto.createHash("sha256").update(texto).digest("hex");
const hashCorto = (texto) => hashDe(String(texto)).slice(0, LARGO_HASH_CORTO);

/**
 * Corre `fabrica` con un tope de tiempo. Si vence, rechaza con `timeout`.
 * Acepta funciones síncronas que lancen. La llamada original no se cancela
 * (supabase-js no recibe `AbortSignal` en `getUser`): solo se deja de esperarla,
 * y su resultado tardío se descarta sin errores sin atender.
 */
function conLimite(fabrica, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error("timeout")), ms);
  });
  const trabajo = Promise.resolve().then(fabrica);
  return Promise.race([trabajo, limite]).finally(() => clearTimeout(temporizador));
}

/**
 * Si ya hay una llamada en curso con la misma clave, comparte su promesa. Evita
 * que cien pedidos con el mismo token (o del mismo usuario) hagan cien consultas.
 */
function deduplicar(enVuelo, clave, fabrica) {
  const previa = enVuelo.get(clave);
  if (previa) return previa;
  if (enVuelo.size >= MAX_EN_VUELO) return fabrica();
  const promesa = Promise.resolve()
    .then(fabrica)
    .finally(() => enVuelo.delete(clave));
  enVuelo.set(clave, promesa);
  return promesa;
}

/** `Authorization: Bearer <jwt>` → el jwt, o null. */
function extraerToken(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers?.authorization || ""));
  return m ? m[1] : null;
}

/** Filtro barato antes de molestar a Supabase: largo razonable y forma de JWT. */
const pareceJwt = (token) => token.length <= MAX_TOKEN && FORMA_JWT.test(token);

/**
 * Vencimiento declarado en el JWT (ms), solo para NO cachear más allá de él.
 * No se confía en esto para autenticar: la verificación la hace el proveedor.
 */
function vencimientoDelToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Rutas que NO se autentican con sesión de usuario:
 *  - `/health*`: la usa el monitoreo, que no tiene sesión.
 *  - Los dos endpoints de tokens de QR: se llaman desde una terminal o Postman,
 *    sin sesión, y ya están cerrados por `X-Admin-Key` (middleware/adminKey.js),
 *    que falla cerrado. Exigirles además un JWT los dejaría inutilizables.
 */
const RUTAS_SIN_SESION = [
  /^(\/api)?\/health(\/|$)/i,
  /^(\/api)?\/sedes\/tokens\/?$/i,
  /^(\/api)?\/sedes\/\d+\/regenerar-token\/?$/i,
];

function esRutaPublica(req) {
  const ruta = req.path || req.url || "";
  return RUTAS_SIN_SESION.some((re) => re.test(ruta));
}

/** Ruta sin query y con los ids numéricos tapados, para que el log no filtre datos. */
function rutaParaLog(req) {
  return String(req.originalUrl || req.url || "")
    .split("?")[0]
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

function registrar(evento) {
  console.warn(`[carnes-auth] ${JSON.stringify(evento)}`);
}

function contexto(req) {
  const origen = req.headers?.origin;
  return {
    metodo: req.method,
    ruta: rutaParaLog(req),
    origen: origen ? String(origen).slice(0, MAX_ORIGEN_LOG) : null,
  };
}

// ─── Bitácora: resumen periódico + detalle muestreado ───────────────────────

/**
 * En vez de una línea por cada pedido anómalo (con `reportar` activo durante
 * días eso es ruido y costo de logs), cuenta por tipo y escribe:
 *   a) UNA línea `auth_resumen` por instancia cada `intervaloMs` o cada
 *      `maxEventos` eventos, lo que ocurra primero;
 *   b) a lo sumo una línea de detalle por tipo cada `detalleCadaMs`.
 *
 * No usa temporizadores (en serverless no hay proceso largo): el resumen se
 * escribe cuando llega el siguiente evento tras vencer la ventana, así que lo
 * último de una instancia que se apaga puede perderse.
 */
export function crearBitacora({
  escribir = registrar,
  ahora = Date.now,
  intervaloMs = INTERVALO_RESUMEN_MS,
  maxEventos = MAX_EVENTOS_RESUMEN,
  detalleCadaMs = INTERVALO_DETALLE_MS,
} = {}) {
  let conteos = {};
  let total = 0;
  let desde = ahora();
  const ultimoDetalle = new Map();

  function volcar() {
    if (total === 0) return;
    const ahoraMs = ahora();
    escribir({
      evento: "auth_resumen",
      ventana_s: Math.round((ahoraMs - desde) / 1000),
      ...Object.fromEntries(CONTADORES_RESUMEN.map((k) => [k, 0])),
      ...conteos,
    });
    conteos = {};
    total = 0;
  }

  function contar(tipo) {
    if (total > 0 && ahora() - desde >= intervaloMs) volcar();
    if (total === 0) desde = ahora();
    conteos[tipo] = (conteos[tipo] || 0) + 1;
    total += 1;
    if (total >= maxEventos) volcar();
  }

  return {
    /** Un pedido que pasó sin novedad. */
    ok() {
      contar("ok");
    },
    /** Una anomalía: se cuenta siempre y se detalla solo si toca por el muestreo. */
    anomalia(tipo, linea) {
      contar(tipo);
      const t = ahora();
      const previo = ultimoDetalle.get(tipo);
      if (previo === undefined || t - previo >= detalleCadaMs) {
        ultimoDetalle.set(tipo, t);
        escribir(linea);
      }
    },
    volcar,
  };
}

/** Bitácora compartida por la autenticación, el guard de admin y `quienHace`. */
export const bitacoraAuth = crearBitacora();

// ─── Autenticación ──────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {(token: string) => Promise<{id: string, email?: string} | null>} opts.verificar
 *        Devuelve el usuario si el token es válido, `null` si es inválido o
 *        venció, y LANZA si el proveedor no responde.
 * @param {(usuarioId: string) => Promise<boolean>} [opts.existePerfil]
 *        ¿El usuario tiene fila en `profiles`? (solo el personal la tiene). Si no
 *        se pasa, no se exige perfil. Lanza si no puede consultarlo.
 * @param {number} [opts.timeoutMs]  Tope de espera a `verificar` + `existePerfil`.
 */
export function crearAutenticar({
  verificar,
  existePerfil = null,
  modo = modoAuth,
  ahora = Date.now,
  log = registrar,
  ttlMs = TTL_MS,
  ttlInvalidoMs = TTL_INVALIDO_MS,
  timeoutMs = TIMEOUT_PROVEEDOR_MS,
  max = MAX_CACHE,
  bitacora = crearBitacora({ escribir: log, ahora }),
}) {
  const cache = crearCache({ max, ahora });
  const invalidos = crearCache({ max, ahora });
  const enVuelo = new Map();

  /** Verifica y comprueba el perfil. Nunca lanza: devuelve `{ usuario?, motivo? }`. */
  async function verificarYCachear(token, clave) {
    try {
      const u = await verificar(token);
      if (!u?.id) {
        invalidos.set(clave, true, ahora() + ttlInvalidoMs);
        return { motivo: "token_invalido" };
      }
      const usuario = Object.freeze({
        id: u.id,
        correo: String(u.email || "").trim().toLowerCase(),
      });
      const sinPerfil = existePerfil ? !(await existePerfil(u.id)) : false;
      const resultado = sinPerfil ? { usuario, motivo: "sin_perfil" } : { usuario };
      const ttl = sinPerfil ? Math.min(ttlMs, TTL_NEGATIVO_MS) : ttlMs;
      cache.set(clave, resultado, Math.min(ahora() + ttl, vencimientoDelToken(token) ?? Infinity));
      return resultado;
    } catch {
      // Los fallos NO se cachean: un corte de red de dos segundos no debe dejar
      // a nadie afuera un minuto.
      return { motivo: "proveedor_no_disponible" };
    }
  }

  async function resolver(token) {
    if (!pareceJwt(token)) return { motivo: "token_invalido" };

    const clave = hashDe(token);
    const guardado = cache.get(clave);
    if (guardado) return guardado;
    if (invalidos.get(clave)) return { motivo: "token_invalido" };

    return deduplicar(enVuelo, clave, () =>
      conLimite(() => verificarYCachear(token, clave), timeoutMs).catch(() => ({
        motivo: "proveedor_no_disponible",
      })),
    );
  }

  return async function autenticar(req, _res, next) {
    const m = modo();
    if (m === "off") return next();
    if (req.method === "OPTIONS" || esRutaPublica(req)) return next();

    let resultado;
    try {
      const token = extraerToken(req);
      resultado = token ? await resolver(token) : { motivo: "sin_token" };
    } catch {
      resultado = { motivo: "proveedor_no_disponible" };
    }

    if (resultado.usuario) req.usuario = resultado.usuario;
    if (!resultado.motivo) {
      bitacora.ok();
      return next();
    }

    bitacora.anomalia(resultado.motivo, {
      evento: "auth_anomalia",
      modo: m,
      motivo: resultado.motivo,
      usuario: resultado.usuario?.id ?? null,
      ...contexto(req),
    });
    if (m === "reportar") return next();

    switch (resultado.motivo) {
      case "proveedor_no_disponible":
        return next(
          createError(503, "No se pudo verificar la sesión. Intenta de nuevo en unos segundos.", "AUTH_NO_DISPONIBLE"),
        );
      case "sin_perfil":
        return next(createError(403, "Tu usuario no tiene perfil en el sistema.", "AUTH_SIN_PERFIL"));
      case "sin_token":
        return next(createError(401, "Debes iniciar sesión para usar esta función.", "AUTH_REQUERIDA"));
      default:
        return next(createError(401, "Tu sesión no es válida o venció. Inicia sesión de nuevo.", "AUTH_INVALIDA"));
    }
  };
}

// ─── Autorización de admin ──────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {(usuarioId: string) => Promise<boolean>} opts.puedeAdministrar
 *        ¿Este usuario puede abrir `/carnes/admin`? Lanza si no puede consultarlo.
 * @param {number} [opts.timeoutMs]  Tope de espera a `puedeAdministrar`.
 */
export function crearRequireAdmin({
  puedeAdministrar,
  modo = modoAuth,
  ahora = Date.now,
  log = registrar,
  ttlMs = TTL_MS,
  timeoutMs = TIMEOUT_PROVEEDOR_MS,
  max = MAX_CACHE,
  bitacora = crearBitacora({ escribir: log, ahora }),
}) {
  const cache = crearCache({ max, ahora });
  const enVuelo = new Map();

  async function consultar(usuarioId) {
    const permitido = Boolean(await conLimite(() => puedeAdministrar(usuarioId), timeoutMs));
    cache.set(usuarioId, permitido, ahora() + (permitido ? ttlMs : Math.min(ttlMs, TTL_NEGATIVO_MS)));
    return permitido;
  }

  return async function requireAdminCarnes(req, _res, next) {
    const m = modo();
    if (m === "off") return next();
    if (req.method === "OPTIONS") return next();

    let motivo;
    const usuario = req.usuario;
    if (!usuario) {
      motivo = "sin_usuario";
    } else {
      try {
        let permitido = cache.get(usuario.id);
        if (permitido === undefined) {
          permitido = await deduplicar(enVuelo, usuario.id, () => consultar(usuario.id));
        }
        if (permitido) {
          bitacora.ok();
          return next();
        }
        motivo = "sin_permiso_admin";
      } catch {
        motivo = "proveedor_no_disponible";
      }
    }

    const evento = m === "reportar" ? "admin_denegaria" : "admin_denegado";
    bitacora.anomalia(motivo === "proveedor_no_disponible" ? motivo : evento, {
      evento,
      modo: m,
      motivo,
      usuario: usuario?.id ?? null,
      ...contexto(req),
    });
    if (m === "reportar") return next();

    if (motivo === "sin_usuario") {
      return next(createError(401, "Debes iniciar sesión para usar esta función.", "AUTH_REQUERIDA"));
    }
    if (motivo === "proveedor_no_disponible") {
      return next(
        createError(503, "No se pudieron verificar tus permisos. Intenta de nuevo en unos segundos.", "AUTH_NO_DISPONIBLE"),
      );
    }
    return next(createError(403, "No tienes permiso para esta acción.", "AUTH_SIN_PERMISO"));
  };
}

// ─── Identidad para la auditoría ────────────────────────────────────────────

const normalizar = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Quién hizo la acción, para los campos `por` / `recibido_por` / `editado_por`…
 *
 * Hoy esos correos los manda el cliente en el body: cualquiera puede escribir
 * el de otro. Con `exigir`, el correo sale del TOKEN y el del body se ignora.
 *
 * En `off` y `reportar` devuelve SIEMPRE el valor del body — el comportamiento
 * no cambia —; en `reportar` además cuenta (y muestrea en el log) los casos en
 * que el body y el token no coinciden, para ver si el front manda algo distinto
 * antes de exigir. El log lleva el id del usuario y un hash corto del correo del
 * body, nunca correos en claro.
 *
 * En `exigir`, si hay usuario pero sin correo, LANZA 403: caer al body dejaría
 * escribir cualquier identidad justo en el caso en que el token no la aporta.
 * Quien llama debe invocarlo dentro de su `try` para que el error llegue a `next`.
 *
 * @param {{ modo?: "off"|"reportar"|"exigir", bitacora?: ReturnType<typeof crearBitacora> }} [opciones]
 *        Inyectables para tests; por defecto, `CARNES_AUTH` y la bitácora compartida.
 */
export function quienHace(req, valorBody, campo = null, { modo = modoAuth(), bitacora = bitacoraAuth } = {}) {
  if (modo === "off") return valorBody;

  const usuario = req.usuario;
  if (!usuario) return valorBody;

  if (!usuario.correo) {
    if (modo === "exigir") {
      throw createError(
        403,
        "Tu usuario no tiene un correo asociado: no se puede registrar quién hizo la acción.",
        "AUTH_SIN_PERMISO",
      );
    }
    return valorBody;
  }

  if (modo === "exigir") return usuario.correo;

  if (valorBody != null && normalizar(valorBody) !== usuario.correo) {
    bitacora.anomalia("identidad_distinta", {
      evento: "identidad_distinta",
      campo,
      usuario: usuario.id ?? null,
      body_hash: hashCorto(normalizar(valorBody)),
      ...contexto(req),
    });
  }
  return valorBody;
}

/**
 * `quienHace` aplicado a los campos de un body. Si nada cambia devuelve el MISMO
 * objeto (`off` y `reportar` siempre), así que el flujo actual no se toca.
 */
export function conQuienHace(req, body, ...campos) {
  let copia = null;
  for (const campo of campos) {
    const original = body?.[campo];
    const valor = quienHace(req, original, campo);
    if (valor !== original) {
      copia = copia || { ...body };
      copia[campo] = valor;
    }
  }
  return copia || body;
}
