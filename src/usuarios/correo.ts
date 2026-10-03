import { createHash } from "node:crypto";

/**
 * Normalización aprobada para el vínculo (contrato v1 §5, ADR-04): recortar
 * espacios y pasar a minúsculas. Ninguna otra transformación (alias, puntos)
 * se aplica sin decisión de Paulo.
 */
export function normalizarCorreo(correo: string): string {
  return correo.trim().toLowerCase();
}

/** Identificador estable para indexar un correo sin guardarlo como ID de documento. */
export function huellaCorreo(correoNormalizado: string): string {
  return createHash("sha256").update(correoNormalizado, "utf8").digest("hex");
}
