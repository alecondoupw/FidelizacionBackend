import type { RequestHandler } from "express";
import type { Marca, Rol } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import type { PerfilRepository } from "../usuarios/perfiles.js";
import {
  TokenInvalidoError,
  type TokenVerificado,
  type TokenVerifier,
} from "./token-verifier.js";

/**
 * Frontera de autorización de Express (I-01, SRC-02 pp. 14–15). Único lugar
 * donde se verifica identidad; ninguna regla de negocio se decide en el FE.
 *   requireToken  → ID token válido (registro de un usuario recién creado).
 *   requireAuth   → token + perfil registrado y activo (rol, marcas).
 *   requireRole   → rol exigido; propietario y marca se autorizan por recurso.
 */
export interface AuthContext {
  uid: string;
  rol: Rol;
  activo: boolean;
  marcas: Marca[];
}

declare module "express-serve-static-core" {
  interface Request {
    token?: TokenVerificado;
    auth?: AuthContext;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

export function extractBearerToken(header: string | undefined): string | null {
  const match = header ? BEARER.exec(header) : null;
  return match?.[1] ?? null;
}

const noAutenticado = () =>
  new AppError(401, "UNAUTHENTICATED", "Se requiere autenticación.");

async function verificarBearer(
  header: string | undefined,
  verifier: TokenVerifier,
): Promise<TokenVerificado> {
  const token = extractBearerToken(header);
  if (!token) throw noAutenticado();
  try {
    return await verifier.verificar(token);
  } catch (error) {
    if (error instanceof TokenInvalidoError) throw noAutenticado();
    throw error;
  }
}

export function requireToken(verifier: TokenVerifier): RequestHandler {
  return async (req, _res, next) => {
    req.token = await verificarBearer(req.get("Authorization"), verifier);
    next();
  };
}

export function requireAuth(
  verifier: TokenVerifier,
  perfiles: PerfilRepository,
): RequestHandler {
  return async (req, _res, next) => {
    req.token = await verificarBearer(req.get("Authorization"), verifier);
    const perfil = await perfiles.obtener(req.token.uid);
    if (!perfil) {
      throw new AppError(
        403,
        "REGISTRATION_REQUIRED",
        "Completa el registro para continuar.",
      );
    }
    if (!perfil.activo) {
      throw new AppError(403, "FORBIDDEN", "La cuenta está desactivada.");
    }
    req.auth = {
      uid: perfil.uid,
      rol: perfil.rol,
      activo: perfil.activo,
      marcas: perfil.marcas,
    };
    next();
  };
}

export function requireRole(rol: Rol): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw noAutenticado();
    if (req.auth.rol !== rol) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "No tienes permiso para esta acción.",
      );
    }
    next();
  };
}
