import { tz, TZDate } from "@date-fns/tz";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
} from "date-fns";
import { AppError } from "../http/errors.js";
import { ZONA } from "../puntos/fechas.js";

/**
 * Periodos de reporte (DEC-09): fechas locales de Bolivia, `desde` y `hasta`
 * incluidos, hasta 12 meses. `inicio` y `fin` son instantes UTC; `fin` es el
 * inicio del día siguiente a `hasta` (exclusivo).
 */
export interface Periodo {
  desde: string;
  hasta: string;
  inicio: Date;
  fin: Date;
  dias: number;
}

export type Granularidad = "dia" | "semana" | "mes";

export const MAX_DIAS = 366;
const EN = { in: tz(ZONA) };
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Instante UTC del inicio de una fecha local de Bolivia (AAAA-MM-DD). */
export function inicioDelDia(fecha: string): Date {
  const m = FECHA.exec(fecha);
  if (!m) throw new AppError(422, "VALIDATION_ERROR", "Fecha inválida.");
  const d = new TZDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), ZONA);
  if (format(d, "yyyy-MM-dd", EN) !== fecha) {
    throw new AppError(422, "VALIDATION_ERROR", "Fecha inválida.");
  }
  return new Date(d.getTime());
}

/** Fecha local (YYYY-MM-DD) de un instante. */
export const fechaLocal = (instante: Date | string) =>
  format(new Date(instante), "yyyy-MM-dd", EN);

export function periodo(desde: string, hasta: string): Periodo {
  const inicio = inicioDelDia(desde);
  const fin = addDays(inicioDelDia(hasta), 1, EN);
  const dias = differenceInCalendarDays(fin, inicio, EN);
  if (dias < 1) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "La fecha inicial debe ser anterior o igual a la final.",
    );
  }
  if (dias > MAX_DIAS) {
    throw new AppError(
      422,
      "RANGE_TOO_LARGE",
      "El periodo puede abarcar como máximo 12 meses.",
    );
  }
  return { desde, hasta, inicio, fin: new Date(fin.getTime()), dias };
}

/** Los últimos `dias` días locales terminando hoy (presets de DEC-09). */
export function ultimosDias(dias: number, ahora: Date): Periodo {
  const hoy = fechaLocal(ahora);
  return periodo(fechaLocal(subDays(inicioDelDia(hoy), dias - 1, EN)), hoy);
}

/** Los últimos `meses` meses calendario completos hasta hoy (dashboard, A13). */
export function ultimosMeses(meses: number, ahora: Date): Periodo {
  const hoy = fechaLocal(ahora);
  const inicio = startOfMonth(subMonths(inicioDelDia(hoy), meses - 1, EN), EN);
  return periodo(fechaLocal(inicio), hoy);
}

/** Periodo anterior de igual duración, inmediatamente antes (A11). */
export function anterior(p: Periodo): Periodo {
  const hasta = fechaLocal(subDays(p.inicio, 1, EN));
  const desde = fechaLocal(subDays(p.inicio, p.dias, EN));
  return periodo(desde, hasta);
}

function inicioCubeta(instante: Date, g: Granularidad): Date {
  if (g === "dia") return startOfDay(instante, EN);
  if (g === "semana") return startOfWeek(instante, { ...EN, weekStartsOn: 1 });
  return startOfMonth(instante, EN);
}

/** Clave de la cubeta de un instante; la primera se recorta al inicio del periodo. */
export function claveCubeta(
  instante: Date | string,
  g: Granularidad,
  p: Periodo,
): string {
  const i = inicioCubeta(new Date(instante), g);
  return fechaLocal(i.getTime() < p.inicio.getTime() ? p.inicio : i);
}

/** Claves ordenadas de todas las cubetas del periodo, incluidas las vacías. */
export function cubetas(p: Periodo, g: Granularidad): string[] {
  const claves: string[] = [];
  let cursor: Date = p.inicio;
  while (cursor.getTime() < p.fin.getTime()) {
    claves.push(claveCubeta(cursor, g, p));
    const base = inicioCubeta(cursor, g);
    cursor =
      g === "dia"
        ? addDays(base, 1, EN)
        : g === "semana"
          ? addWeeks(base, 1, EN)
          : addMonths(base, 1, EN);
  }
  return claves;
}
