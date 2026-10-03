import { describe, expect, it } from "vitest";
import { calcularVencimiento, estaVencido, idMovimiento } from "./fechas.js";
import { planificar } from "./planificador.js";
import type { Lote } from "./tipos.js";

const vig = (cantidad: number, unidad: "dias" | "meses" | "anios") => ({
  activa: true,
  cantidad,
  unidad,
});

describe("DEC-06 · calcularVencimiento (America/La_Paz, fin de día)", () => {
  it.each([
    [
      "31 ene + 1 mes → 28 feb 23:59:59 BO",
      "2026-01-31T14:00:00Z",
      vig(1, "meses"),
      "2026-03-01T03:59:59.999Z",
    ],
    [
      "29 feb 2028 + 1 año → 28 feb 2029",
      "2028-02-29T14:00:00Z",
      vig(1, "anios"),
      "2029-03-01T03:59:59.999Z",
    ],
    [
      "23:30 BO cuenta el día local, no el UTC",
      "2026-10-04T03:30:00Z",
      vig(30, "dias"),
      "2026-11-03T03:59:59.999Z",
    ],
    [
      "1 día después, al final del día",
      "2026-10-03T12:00:00Z",
      vig(1, "dias"),
      "2026-10-05T03:59:59.999Z",
    ],
  ])("%s", (_caso, otorgado, vigencia, esperado) => {
    expect(calcularVencimiento(new Date(otorgado), vigencia)).toBe(esperado);
  });

  it("sin vigencia activa no vence", () => {
    expect(calcularVencimiento(new Date(), null)).toBeNull();
    expect(
      calcularVencimiento(new Date(), { ...vig(1, "meses"), activa: false }),
    ).toBeNull();
  });

  it("vence sólo después del último milisegundo del día", () => {
    const vence = "2026-10-05T03:59:59.999Z";
    expect(estaVencido(vence, new Date("2026-10-05T03:59:59.999Z"))).toBe(
      false,
    );
    expect(estaVencido(vence, new Date("2026-10-05T04:00:00.000Z"))).toBe(true);
    expect(estaVencido(null, new Date("2999-01-01T00:00:00Z"))).toBe(false);
  });

  it("en orden ascendente de id, lo más reciente va primero", () => {
    const a = idMovimiento(new Date("2026-10-03T09:59:59.999Z"), 0, "zzzzzzzz");
    const b = idMovimiento(new Date("2026-10-03T10:00:00.000Z"), 0, "aaaaaaaa");
    const c = idMovimiento(new Date("2026-10-03T10:00:00.000Z"), 1, "aaaaaaaa");
    expect([a, b, c].sort()).toEqual([c, b, a]);
  });
});

const lote = (
  id: string,
  restante: number,
  venceEn: string | null,
  otorgadoEn = "2026-01-01T00:00:00Z",
) => ({
  id,
  datos: {
    otorgados: restante,
    restante,
    otorgadoEn,
    venceEn,
    movimientoId: `m-${id}`,
  } satisfies Lote,
});

describe("DEC-06 · planificar (lotes, vencimiento más próximo primero)", () => {
  const ahora = new Date("2026-06-01T12:00:00Z");

  it("consume primero el lote que vence antes y deja los sin vencimiento al final", () => {
    const plan = planificar(
      [
        lote("sin", 100, null),
        lote("tarde", 100, "2026-12-31T03:59:59.999Z"),
        lote("pronto", 100, "2026-07-01T03:59:59.999Z"),
      ],
      ahora,
      150,
    );
    expect(plan.consumos).toEqual([
      { loteId: "pronto", puntos: 100 },
      { loteId: "tarde", puntos: 50 },
    ]);
    expect(plan.disponibleFinal).toBe(150);
    expect(plan.faltante).toBe(0);
  });

  it("vence sólo el remanente de lotes caducados y no lo consume", () => {
    const plan = planificar(
      [
        lote("viejo", 30, "2026-05-01T03:59:59.999Z"),
        lote("vigente", 50, null),
      ],
      ahora,
      40,
    );
    expect(plan.vencidos).toEqual([{ loteId: "viejo", puntos: 30 }]);
    expect(plan.consumos).toEqual([{ loteId: "vigente", puntos: 40 }]);
    expect(plan.restantes.get("viejo")).toBe(0);
    expect(plan.disponibleFinal).toBe(10);
  });

  it("informa el faltante sin dejar saldo negativo", () => {
    const plan = planificar([lote("a", 20, null)], ahora, 50);
    expect(plan.faltante).toBe(30);
  });

  it("a igual vencimiento, consume primero el más antiguo", () => {
    const vence = "2026-12-01T03:59:59.999Z";
    const plan = planificar(
      [
        lote("nuevo", 10, vence, "2026-03-01T00:00:00Z"),
        lote("antiguo", 10, vence, "2026-02-01T00:00:00Z"),
      ],
      ahora,
      10,
    );
    expect(plan.consumos).toEqual([{ loteId: "antiguo", puntos: 10 }]);
  });
});
