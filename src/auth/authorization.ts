import type { RequestHandler } from "express";
import type { Marca, Perfil, Rol } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { medir } from "../http/observabilidad.js";
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
    /** Perfil leído por requireAuth; evita leerlo otra vez en la ruta. */
    perfil?: Perfil;
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

/**
 * `sub` del JWT **sin verificar**: sólo sirve para adelantar la lectura del
 * perfil mientras se verifica el token. Nunca autoriza nada por sí mismo.
 */
export function uidSinVerificar(token: string): string | null {
  const carga = token.split(".")[1];
  if (!carga) return null;
  try {
    const sub: unknown = JSON.parse(
      Buffer.from(carga, "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sub)
      ? sub
      : null;
  } catch {
    return null;
  }
}

export function requireToken(verifier: TokenVerifier): RequestHandler {
  return async (req, res, next) => {
    req.token = await medir(res, "token", () =>
      verificarBearer(req.get("Authorization"), verifier),
    );
    next();
  };
}

export function requireAuth(
  verifier: TokenVerifier,
  perfiles: PerfilRepository,
): RequestHandler {
  return async (req, res, next) => {
    const cabecera = req.get("Authorization");
    // El perfil se lee en paralelo con la verificación (F7, rendimiento
    // medido) y sólo se usa si el token verificado es del mismo uid.
    const bearer = extractBearerToken(cabecera);
    const uidAdelantado = bearer ? uidSinVerificar(bearer) : null;
    const adelantado = uidAdelantado
      ? medir(res, "perfil", () => perfiles.obtener(uidAdelantado))
      : null;
    adelantado?.catch(() => undefined);
    const token = await medir(res, "token", () =>
      verificarBearer(cabecera, verifier),
    );
    req.token = token;
    const perfil =
      adelantado && uidAdelantado === token.uid
        ? await adelantado
        : await medir(res, "perfil", () => perfiles.obtener(token.uid));
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
    // Tras un cambio de correo (DEC-04) se exige verificar el nuevo.
    if (perfil.verificarCorreo && !req.token.correoVerificado) {
      throw new AppError(
        403,
        "EMAIL_NOT_VERIFIED",
        "Verifica tu nuevo correo para continuar.",
      );
    }
    req.perfil = perfil;
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
