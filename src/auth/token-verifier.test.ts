import type { Auth } from "firebase-admin/auth";
import { describe, expect, it, vi } from "vitest";
import {
  crearVerificadorFirebase,
  TokenInvalidoError,
} from "./token-verifier.js";

function authFalso(
  impl: (token: string, checkRevoked?: boolean) => Promise<unknown>,
) {
  const verifyIdToken = vi.fn(impl);
  return { auth: { verifyIdToken } as unknown as Auth, verifyIdToken };
}

describe("crearVerificadorFirebase", () => {
  it("verifica con checkRevoked=true y devuelve uid y correo", async () => {
    const { auth, verifyIdToken } = authFalso(async () => ({
      uid: "u1",
      email: "a@ejemplo.test",
      email_verified: true,
    }));
    await expect(
      crearVerificadorFirebase(auth).verificar("t"),
    ).resolves.toEqual({
      uid: "u1",
      correo: "a@ejemplo.test",
      correoVerificado: true,
    });
    expect(verifyIdToken).toHaveBeenCalledWith("t", true);
  });

  it.each([
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/invalid-id-token",
    "auth/argument-error",
    "auth/user-disabled",
  ])("%s → TokenInvalidoError", async (code) => {
    const { auth } = authFalso(async () => {
      throw Object.assign(new Error("x"), { code });
    });
    await expect(
      crearVerificadorFirebase(auth).verificar("t"),
    ).rejects.toBeInstanceOf(TokenInvalidoError);
  });

  it("otros errores se propagan (no son 401)", async () => {
    const { auth } = authFalso(async () => {
      throw Object.assign(new Error("red"), { code: "app/network-error" });
    });
    await expect(
      crearVerificadorFirebase(auth).verificar("t"),
    ).rejects.not.toBeInstanceOf(TokenInvalidoError);
  });
});
