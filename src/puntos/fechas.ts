import { tz } from "@date-fns/tz";
import { addDays, addMonths, addYears, endOfDay, format } from "date-fns";
import { AppError } from "../http/errors.js";

export type Unidad = "dias" | "meses" | "anios";

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

/** Fecha local de Bolivia (AAAA-MM-DD) de un instante. */
export const fechaLocal = (instante: Date) =>
  format(instante, "yyyy-MM-dd", { in: tz(ZONA) });

/** Máximo de años para el vencimiento elegido al asignar puntos (DEC-18). */
export const MAX_ANIOS_VENCIMIENTO = 2;

/**
 * Vencimiento elegido en cada asignación (DEC-18, SRC-06 p. 3): fecha local
 * AAAA-MM-DD desde hoy hasta 2 años, que vence a las 23:59:59.999 de ese día
 * en hora de Bolivia. Devuelve ISO 8601 UTC.
 */
export function vencimientoElegido(fecha: string, ahora: Date): string {
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(fecha);
  const opciones = { in: tz(ZONA) };
  const dia = m ? endOfDay(new Date(`${fecha}T12:00:00Z`), opciones) : null;
  if (!dia || Number.isNaN(dia.getTime()) || fechaLocal(dia) !== fecha) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Fecha de vencimiento inválida.",
      [{ campo: "vence", mensaje: "Usa una fecha válida AAAA-MM-DD." }],
    );
  }
  const hoy = fechaLocal(ahora);
  const maximo = fechaLocal(addYears(ahora, MAX_ANIOS_VENCIMIENTO, opciones));
  if (fecha < hoy || fecha > maximo) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "La fecha de vencimiento debe estar entre hoy y dentro de 2 años.",
      [
        {
          campo: "vence",
          mensaje: `Elige una fecha entre ${hoy} y ${maximo}.`,
        },
      ],
    );
  }
  return new Date(dia.getTime()).toISOString();
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
