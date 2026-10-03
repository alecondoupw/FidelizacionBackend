import type { z } from "zod";
import { AppError } from "./errors.js";

/** Valida entrada con Zod; Express repite la validación del FE (SRC-03 p. 13, obs. 10). */
export function validar<T>(esquema: z.ZodType<T>, entrada: unknown): T {
  const r = esquema.safeParse(entrada);
  if (!r.success) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Los datos enviados no son válidos.",
      r.error.issues.map((i) => ({
        campo: i.path.join("."),
        mensaje: i.message,
      })),
    );
  }
  return r.data;
}
