import { tz } from "@date-fns/tz";
import { addDays, addMonths, addYears, endOfDay } from "date-fns";
import type { Unidad } from "./tipos.js";

/** Zona oficial de cálculo (DEC-06). */
export const ZONA = "America/La_Paz";

/**
 * Vencimiento de un otorgamiento (DEC-06): fecha local de Bolivia del
 * otorgamiento + periodo, a las 23:59:59.999 hora de Bolivia. date-fns ajusta
 * al último día del mes cuando el día no existe (31 ene + 1 mes = 28/29 feb).
 * Devuelve ISO 8601 UTC, o null si la marca no tiene vencimiento activo.
 */
export function calcularVencimiento(
  otorgadoEn: Date,
  vigencia: { activa: boolean; cantidad: number; unidad: Unidad } | null,
): string | null {
  if (!vigencia?.activa) return null;
  const opciones = { in: tz(ZONA) };
  const sumar = { dias: addDays, meses: addMonths, anios: addYears }[
    vigencia.unidad
  ];
  const fin = endOfDay(
    sumar(otorgadoEn, vigencia.cantidad, opciones),
    opciones,
  );
  return new Date(fin.getTime()).toISOString();
}

/** Un lote está vencido cuando el instante actual supera su vencimiento. */
export function estaVencido(venceEn: string | null, ahora: Date): boolean {
  return venceEn !== null && venceEn < ahora.toISOString();
}

const MAX_MS = 9_999_999_999_999;

/**
 * Identificador de movimiento con la fecha invertida: el orden ascendente por
 * id (el único sin índice adicional en Firestore) devuelve primero lo más
 * reciente. Dentro del mismo milisegundo, la secuencia mayor va antes.
 */
export function idMovimiento(
  fecha: Date,
  secuencia: number,
  aleatorio: string,
): string {
  const invertido = String(MAX_MS - fecha.getTime()).padStart(13, "0");
  const secuenciaInvertida = String(99 - secuencia).padStart(2, "0");
  return `${invertido}-${secuenciaInvertida}${aleatorio.slice(0, 8)}`;
}
