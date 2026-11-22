// Reglas puras de cierre de la preliquidación: auto-cierre D3 (con I5) y cierre manual.
import test from "node:test";
import assert from "node:assert/strict";

const { decidirAutocierre, decidirCierreManual, montoNoAsignado } = await import("../src/shared/preliquidacionCierre.js");

const cabecera = (extra = {}) => ({
  id: 1, estado: "abierta", liquidada_at: "2026-11-24T02:31:00Z", restantes: 0, gasto_total_aplicado: "1000000.00", orden_version: 7, ...extra,
});
const sede = (extra = {}) => ({ id: 1, estado: "enviada", gasto_sede: "400000.00", requiere_correccion: false, ...extra });

test("D3: sin animales restantes y todas las sedes enviadas -> cierra con el monto no asignado", () => {
  const r = decidirAutocierre({ cabecera: cabecera(), sedes: [sede(), sede({ id: 2, gasto_sede: "599999.99" })] });
  assert.equal(r.cerrar, true);
  assert.equal(r.montoNoAsignado, "0.01");
});

test("D3: con animales restantes no cierra (llegarán más sedes)", () => {
  const r = decidirAutocierre({ cabecera: cabecera({ restantes: 2 }), sedes: [sede()] });
  assert.deepEqual({ cerrar: r.cerrar, motivo: r.motivo }, { cerrar: false, motivo: "restantes" });
});

test("D3: una sede que no está enviada impide el cierre (en curso, simulada, bloqueada...)", () => {
  for (const estado of ["enviando", "sin_confirmar", "calculada", "simulada", "bloqueada", "error", "lista_para_enviar", "vinculada", "anulada"]) {
    const r = decidirAutocierre({ cabecera: cabecera(), sedes: [sede(), sede({ id: 2, estado })] });
    assert.equal(r.cerrar, false, estado);
    assert.equal(r.motivo, "sedes_pendientes", estado);
  }
});

test("I5: no cierra mientras alguna sede tenga requiere_correccion", () => {
  const r = decidirAutocierre({ cabecera: cabecera(), sedes: [sede({ requiere_correccion: true })] });
  assert.deepEqual({ cerrar: r.cerrar, motivo: r.motivo }, { cerrar: false, motivo: "requiere_correccion" });
});

test("no cierra si no está abierta, no se liquidó o no hay sedes", () => {
  assert.equal(decidirAutocierre({ cabecera: cabecera({ estado: "cerrada" }), sedes: [sede()] }).motivo, "no_abierta");
  assert.equal(decidirAutocierre({ cabecera: cabecera({ liquidada_at: null }), sedes: [sede()] }).motivo, "no_liquidada");
  assert.equal(decidirAutocierre({ cabecera: cabecera(), sedes: [] }).motivo, "sin_sedes");
});

test("montoNoAsignado: gasto total aplicado menos lo de las sedes enviadas, en centavos exactos", () => {
  assert.equal(montoNoAsignado({ cabecera: cabecera(), sedes: [sede({ gasto_sede: "250000.10" }), sede({ id: 2, estado: "calculada", gasto_sede: "999999.00" })] }), "749999.90");
  assert.equal(montoNoAsignado({ cabecera: cabecera({ gasto_total_aplicado: "10000001.00" }), sedes: [sede({ gasto_sede: "3333334.00" }), sede({ id: 2, gasto_sede: "3333334.00" }), sede({ id: 3, gasto_sede: "3333333.00" })] }), "0.00");
});

test("cierre manual: permitido con bloqueadas, pero no con trabajo pendiente ni en vuelo", () => {
  const ok = decidirCierreManual({ cabecera: cabecera({ restantes: 4 }), sedes: [sede(), sede({ id: 2, estado: "bloqueada" })] });
  assert.equal(ok.cerrar, true);
  for (const estado of ["enviando", "sin_confirmar", "calculada", "lista_para_enviar", "error", "simulada", "vinculada", "anulada"]) {
    const r = decidirCierreManual({ cabecera: cabecera({ restantes: 4 }), sedes: [sede({ estado })] });
    assert.equal(r.cerrar, false, estado);
    assert.equal(r.motivo, "sedes_pendientes", estado);
  }
  assert.equal(decidirCierreManual({ cabecera: cabecera(), sedes: [sede({ requiere_correccion: true })] }).motivo, "requiere_correccion");
  assert.equal(decidirCierreManual({ cabecera: cabecera({ liquidada_at: null }), sedes: [] }).motivo, "no_liquidada");
});

test("cierre manual sin sedes de una preliquidación liquidada es válido (se acaba la ventana)", () => {
  const r = decidirCierreManual({ cabecera: cabecera({ restantes: 10 }), sedes: [] });
  assert.equal(r.cerrar, true);
  assert.equal(r.montoNoAsignado, "1000000.00");
});
