import type { RequestHandler } from "express";
import { AppError } from "../http/errors.js";

/**
 * Frontera de autorización de Express (I-01, SRC-02 pp. 14–15).
 *
 * Toda ruta protegida se monta detrás de `requireAuth` y, después, de los
 * guardas de recurso. Orden previsto, en este único lugar:
 *   1. Extraer `Authorization: Bearer <ID token>` (implementado: falla cerrado).
 *   2. Verificar el ID token con Firebase Admin SDK, incluida revocación — F1-BE-01.
 *   3. Cargar el perfil: rol (cliente | administrador) y estado activo — F1-BE-01/02.
 *   4. Autorizar rol, propietario del recurso y marca — cada lote F1–F6.
 * Ninguna regla de negocio se decide en el frontend.
 *
 * Los tipos siguientes son la forma propuesta en F0; se fijan con DEC-03/04 en F1.
 */
export type Rol = "cliente" | "administrador";
export type Marca = "zontes" | "kiden" | "niu";

export interface AuthContext {
  uid: string;
  rol: Rol;
  activo: boolean;
  marcas: Marca[];
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

export function extractBearerToken(header: string | undefined): string | null {
  const match = header ? BEARER.exec(header) : null;
  return match?.[1] ?? null;
}

/**
 * F0: falla cerrado. Sin token → 401; con token → 501 hasta implementar la
 * verificación en F1-BE-01. No se monta todavía en ninguna ruta de producto.
 */
export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearerToken(req.get("Authorization"));
    if (!token) {
      next(new AppError(401, "UNAUTHENTICATED", "Se requiere autenticación."));
      return;
    }
    next(
      new AppError(
        501,
        "NOT_IMPLEMENTED",
        "La verificación de identidad se implementa en F1.",
      ),
    );
  };
}
