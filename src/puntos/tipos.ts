import type { Marca } from "../dominio/tipos.js";

/** Eventos de SRC-01 p. 1 y SRC-02 p. 4; sin campo de condición (RN-04). */
export const EVENTOS = [
  "compra",
  "referido",
  "mantenimiento",
  "asistencia",
] as const;
export type Evento = (typeof EVENTOS)[number];

export const UNIDADES = ["dias", "meses", "anios"] as const;
export type Unidad = (typeof UNIDADES)[number];

export interface Regla extends Record<string, unknown> {
  marca: Marca;
  evento: Evento;
  /** Entero positivo. */
  puntos: number;
  activa: boolean;
  creadoEn: string;
  actualizadoEn: string;
  actualizadoPor: string;
}

export interface Vigencia extends Record<string, unknown> {
  marca: Marca;
  activa: boolean;
  cantidad: number;
  unidad: Unidad;
  actualizadoEn: string | null;
  actualizadoPor: string | null;
}

export type TipoMovimiento =
  "otorgamiento" | "ajuste" | "vencimiento" | "canje";

/** Movimiento definitivo (DEC-14): nunca se edita ni se borra. */
export interface Movimiento extends Record<string, unknown> {
  tipo: TipoMovimiento;
  /** Con signo: positivo suma, negativo resta. */
  puntos: number;
  /** ISO 8601 UTC. */
  fecha: string;
  /** Sólo en movimientos que crean un lote. */
  venceEn: string | null;
  evento: Evento | null;
  origen: string | null;
  motivo: string | null;
  actor: string;
  /** Lotes afectados por una resta (vencimiento, ajuste negativo, canje). */
  lotes: { loteId: string; puntos: number }[];
}

/** Puntos de un mismo otorgamiento; su remanente es lo único que vence (DEC-06). */
export interface Lote extends Record<string, unknown> {
  otorgados: number;
  restante: number;
  otorgadoEn: string;
  venceEn: string | null;
  movimientoId: string;
}

export interface SaldoMarca extends Record<string, unknown> {
  disponible: number;
  actualizadoEn: string;
}
