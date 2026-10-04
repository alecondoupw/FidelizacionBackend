import type { Auth } from "firebase-admin/auth";

export interface TokenVerificado {
  uid: string;
  correo: string | undefined;
  correoVerificado: boolean;
}

/** Token ausente de validez: expirado, revocado, malformado o de usuario deshabilitado. */
export class TokenInvalidoError extends Error {
  constructor(readonly motivo: string) {
    super(`Token inválido: ${motivo}`);
    this.name = "TokenInvalidoError";
  }
}

export interface TokenVerifier {
  verificar(idToken: string): Promise<TokenVerificado>;
}

/**
 * Comparte la verificación en curso entre peticiones simultáneas con el mismo
 * token (una página pide varias rutas a la vez). No guarda resultados: cuando
 * termina, la siguiente petición vuelve a verificar, incluida la revocación.
 */
export function compartirEnCurso(verifier: TokenVerifier): TokenVerifier {
  const enCurso = new Map<string, Promise<TokenVerificado>>();
  return {
    verificar(idToken) {
      let p = enCurso.get(idToken);
      if (!p) {
        p = verifier.verificar(idToken).finally(() => enCurso.delete(idToken));
        enCurso.set(idToken, p);
      }
      return p;
    },
  };
}

const CODIGOS_TOKEN_INVALIDO = new Set([
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/argument-error",
  "auth/user-disabled",
  "auth/user-not-found",
]);

/**
 * Verificación con Firebase Admin SDK, incluida revocación (checkRevoked).
 * Los errores de infraestructura no se disfrazan de 401: se propagan como 5xx.
 */
export function crearVerificadorFirebase(auth: Auth): TokenVerifier {
  return {
    async verificar(idToken) {
      try {
        const decoded = await auth.verifyIdToken(idToken, true);
        return {
          uid: decoded.uid,
          correo: decoded.email,
          correoVerificado: decoded.email_verified === true,
        };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && CODIGOS_TOKEN_INVALIDO.has(code)) {
          throw new TokenInvalidoError(code);
        }
        throw error;
      }
    },
  };
}
