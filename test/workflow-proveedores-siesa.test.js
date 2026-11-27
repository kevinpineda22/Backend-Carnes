// El workflow de GitHub Actions del barrido de proveedores sin SIESA: cada 15 minutos, solo
// secretos por nombre, permisos mínimos y falla ante un no 2xx.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../.github/workflows/proveedores-siesa.yml", import.meta.url), "utf8");
const sinComentarios = yml
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|\s)#.*$/, ""))
  .join("\n");

test("corre cada 15 minutos y se puede lanzar a mano", () => {
  assert.match(sinComentarios, /cron:\s*'\*\/15 \* \* \* \*'/);
  assert.ok(sinComentarios.includes("workflow_dispatch"));
});

test("llama al endpoint con CRON_SECRET y falla ante un no 2xx", () => {
  assert.ok(sinComentarios.includes("/api/cron/proveedores-siesa"));
  assert.ok(sinComentarios.includes("--fail-with-body"));
  assert.ok(sinComentarios.includes("secrets.CRON_SECRET"));
  assert.ok(sinComentarios.includes("secrets.PRELIQ_URL"));
  assert.ok(sinComentarios.includes("secrets.VERCEL_AUTOMATION_BYPASS_SECRET"));
  assert.match(sinComentarios, /exit 1/);
});

test("sin URLs ni secretos literales y con permisos mínimos", () => {
  assert.ok(!/https?:\/\//.test(sinComentarios), "no debe haber URLs literales");
  assert.ok(!/[A-Fa-f0-9]{32,}/.test(sinComentarios), "no debe haber secretos literales");
  assert.ok(!/set -x|xtrace/.test(sinComentarios));
  assert.match(sinComentarios, /permissions:\s*\n\s+contents:\s*read/);
});
