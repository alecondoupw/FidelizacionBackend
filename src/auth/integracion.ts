import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { AppError } from "../http/errors.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Sistema externo autenticado por clave de servicio (DEC-05). */
    integracion?: string;
  }
}

export const hashClave = (clave: string) =>
  createHash("sha256").update(clave, "utf8").digest();

/**
 * Autentica sistemas externos (facturación, CRM) con `X-Api-Key`. El servidor
 * sólo conoce el SHA-256 de cada clave (INTEGRACION_CLAVES=sistema:hash,…) y
 * compara en tiempo constante. Sin claves configuradas, la ruta responde 503.
 */
export function requireClaveIntegracion(
  claves: ReadonlyMap<string, string>,
): RequestHandler {
  const hashes = [...claves].map(([hex, sistema]) => ({
    hash: Buffer.from(hex, "hex"),
    sistema,
  }));
  return (req, _res, next) => {
    if (hashes.length === 0) {
      throw new AppError(
        503,
        "AUTH_NOT_CONFIGURED",
        "La integración no está configurada en este entorno.",
      );
    }
    const clave = req.get("X-Api-Key");
    if (!clave) {
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Se requiere una clave de integración.",
      );
    }
    const recibido = hashClave(clave);
    const coincidencia = hashes.find((h) => timingSafeEqual(h.hash, recibido));
    if (!coincidencia) {
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Clave de integración inválida.",
      );
    }
    req.integracion = coincidencia.sistema;
    next();
  };
}
