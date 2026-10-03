import { describe, expect, it } from "vitest";
import { AppError } from "../http/errors.js";
import {
  anterior,
  claveCubeta,
  cubetas,
  fechaLocal,
  granularidad,
  periodo,
  ultimosDias,
} from "./periodo.js";

const codigo = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : "otro";
  }
  return "OK";
};

describe("Periodos de reporte en hora de Bolivia (DEC-09)", () => {
  it("convierte fechas locales a instantes UTC con fin exclusivo", () => {
    const p = periodo("2026-10-01", "2026-10-03");
    expect(p.inicio.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(p.fin.toISOString()).toBe("2026-10-04T04:00:00.000Z");
    expect(p.dias).toBe(3);
    // 23:30 del 3 de octubre en Bolivia es 4 de octubre en UTC, pero cuenta como día 3.
    expect(fechaLocal("2026-10-04T03:30:00.000Z")).toBe("2026-10-03");
  });

  it("valida orden, formato y el máximo de 12 meses", () => {
    expect(codigo(() => periodo("2026-10-03", "2026-10-01"))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codigo(() => periodo("2026-02-30", "2026-03-01"))).toBe(
      "VALIDATION_ERROR",
    );
    expect(codigo(() => periodo("2025-10-01", "2026-09-30"))).toBe("OK");
    expect(codigo(() => periodo("2025-01-01", "2026-01-02"))).toBe(
      "RANGE_TOO_LARGE",
    );
  });

  it("presets y periodo anterior de igual duración", () => {
    const ahora = new Date("2026-10-03T02:00:00.000Z"); // 2 oct, 22:00 en Bolivia
    const p = ultimosDias(30, ahora);
    expect([p.desde, p.hasta, p.dias]).toEqual([
      "2026-09-03",
      "2026-10-02",
      30,
    ]);
    const a = anterior(p);
    expect([a.desde, a.hasta, a.dias]).toEqual([
      "2026-08-04",
      "2026-09-02",
      30,
    ]);
    expect(ultimosDias(1, ahora).desde).toBe("2026-10-02");
  });

  it("granularidad diaria, semanal y mensual con cubetas vacías incluidas", () => {
    expect(granularidad(31)).toBe("dia");
    expect(granularidad(32)).toBe("semana");
    expect(granularidad(184)).toBe("semana");
    expect(granularidad(185)).toBe("mes");

    const dias = periodo("2026-09-29", "2026-10-02");
    expect(cubetas(dias, "dia")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    // Semanas desde el lunes; la primera se recorta al inicio del periodo.
    const semanas = periodo("2026-09-03", "2026-09-20");
    expect(cubetas(semanas, "semana")).toEqual([
      "2026-09-03",
      "2026-09-07",
      "2026-09-14",
    ]);
    expect(claveCubeta("2026-09-10T15:00:00.000Z", "semana", semanas)).toBe(
      "2026-09-07",
    );
    expect(claveCubeta("2026-09-04T15:00:00.000Z", "semana", semanas)).toBe(
      "2026-09-03",
    );
    const meses = periodo("2026-04-15", "2026-10-03");
    expect(cubetas(meses, "mes")).toEqual([
      "2026-04-15",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    // Último milisegundo del 31 de mayo en Bolivia sigue en mayo.
    expect(claveCubeta("2026-06-01T03:59:59.999Z", "mes", meses)).toBe(
      "2026-05-01",
    );
  });
});
