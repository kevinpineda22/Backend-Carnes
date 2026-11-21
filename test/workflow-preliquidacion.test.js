// Prueba estática del workflow de GitHub Actions de la preliquidación (C15).
// Solo lee el YAML: no ejecuta nada ni toca la red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../.github/workflows/preliquidacion.yml", import.meta.url), "utf8");
const sinComentarios = yml
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|\s)#.*$/, ""))
  .join("\n");

test("no usa tabuladores (YAML válido)", () => {
  assert.ok(!yml.includes("\t"));
});

test("programa la corrida de las 21:30 Bogotá (02:30 UTC) y el barrido horario", () => {
  assert.match(sinComentarios, /schedule:/);
  assert.match(sinComentarios, /cron:\s*'30 2 \* \* \*'/);
  assert.match(sinComentarios, /cron:\s*'15 \* \* \* \*'/);
});

test("workflow_dispatch con especie (todas|res|cerdo) y dry_run", () => {
  assert.match(sinComentarios, /workflow_dispatch:/);
  assert.match(sinComentarios, /especie:[\s\S]*?type:\s*choice[\s\S]*?- todas[\s\S]*?- res[\s\S]*?- cerdo/);
  assert.match(sinComentarios, /dry_run:[\s\S]*?type:\s*boolean/);
});

test("concurrency preliquidacion sin cancelar la corrida en curso", () => {
  assert.match(sinComentarios, /concurrency:\s*\n\s+group:\s*preliquidacion\s*\n\s+cancel-in-progress:\s*false/);
});

test("curl con las banderas de la decisión y SIN --retry-all-errors", () => {
  for (const bandera of ["--fail-with-body", "--max-time 290", "--retry 2", "--retry-connrefused"]) {
    assert.ok(sinComentarios.includes(bandera), `falta ${bandera}`);
  }
  assert.ok(!sinComentarios.includes("--retry-all-errors"));
});

test("bucle de hasta 6 iteraciones que comparte el corrida_id y se detiene sin pendientes", () => {
  assert.match(sinComentarios, /for\s+\w+\s+in\s+1\s+2\s+3\s+4\s+5\s+6/);
  assert.match(sinComentarios, /\.corrida_id/);
  assert.match(sinComentarios, /\.pendientes/);
  assert.match(sinComentarios, /corrida_id/);
});

test("si el flag no es 'on' avisa con ::warning:: y termina sin error", () => {
  assert.match(sinComentarios, /\.flag/);
  assert.match(sinComentarios, /!=\s*"?on"?/);
  assert.match(sinComentarios, /::warning::preliquidacion flag is/);
});

test("falla (exit distinto de 0) ante 401/5xx o respuesta con ok falso", () => {
  assert.match(sinComentarios, /exit 1/);
  assert.match(sinComentarios, /::error::/);
  assert.match(sinComentarios, /\.ok/);
});

test("el origen se deriva del evento: schedule, sweep o dispatch", () => {
  assert.match(sinComentarios, /github\.event\.schedule/);
  for (const origen of ["schedule", "sweep", "dispatch"]) assert.ok(sinComentarios.includes(origen));
});

test("un dry_run no itera: una sola llamada", () => {
  assert.match(sinComentarios, /DRY_RUN/);
  assert.match(sinComentarios, /"\$DRY_RUN"\s*=\s*"true"[\s\S]*?break/);
});

test("secretos solo por nombre y cabecera de bypass para previews", () => {
  assert.ok(sinComentarios.includes("secrets.CRON_SECRET"));
  assert.ok(sinComentarios.includes("secrets.PRELIQ_URL"));
  assert.ok(sinComentarios.includes("secrets.VERCEL_AUTOMATION_BYPASS_SECRET"));
  assert.ok(sinComentarios.includes("x-vercel-protection-bypass"));
  assert.ok(!/https?:\/\//.test(sinComentarios), "no debe haber URLs literales");
  assert.ok(!/[A-Fa-f0-9]{32,}/.test(sinComentarios), "no debe haber secretos literales");
  assert.ok(!/set -x|xtrace/.test(sinComentarios), "set -x filtraría el token");
});

test("permisos mínimos y el workflow llama al endpoint del cron", () => {
  assert.match(sinComentarios, /permissions:\s*\n\s+contents:\s*read/);
  assert.ok(sinComentarios.includes("/api/cron/preliquidaciones"));
});
