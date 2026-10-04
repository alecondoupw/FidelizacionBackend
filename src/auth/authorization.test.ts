import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Perfil } from "../dominio/tipos.js";
import { errorHandler } from "../http/errors.js";
import { requestId } from "../http/request-id.js";
import type { PerfilRepository } from "../usuarios/perfiles.js";
import { requireAuth, uidSinVerificar } from "./authorization.js";
import {
  compartirEnCurso,
  TokenInvalidoError,
  type TokenVerifier,
} from "./token-verifier.js";

/** JWT de forma válida con el `sub` indicado (la firma la juzga el verificador). */
const jwt = (sub: string) =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ sub })).toString("base64url"),
    "firma",
  ].join(".");

const perfil = (uid: string, rol: Perfil["rol"]): Perfil => ({
  uid,
  correo: `${uid}@ejemplo.test`,
  rol,
  activo: true,
  marcas: [],
  vinculo: "no_vinculado",
  creadoEn: "2026-10-03T12:00:00.000Z",
});

function montar(verifier: TokenVerifier, perfiles: Record<string, Perfil>) {
  const obtener = vi.fn(async (uid: string) => perfiles[uid] ?? null);
  const repo = { obtener } as unknown as PerfilRepository;
  const app = express();
  app.use(requestId);
  app.get("/x", requireAuth(verifier, repo), (req, res) => {
    res.json({ uid: req.auth!.uid, rol: req.auth!.rol });
  });
  app.use(errorHandler);
  return { app, obtener };
}

describe("F7 · requireAuth con perfil adelantado", () => {
  it("lee el perfil en paralelo y una sola vez cuando el token es del mismo uid", async () => {
    const verifier: TokenVerifier = {
      verificar: async () => ({
        uid: "u1",
        correo: undefined,
        correoVerificado: true,
      }),
    };
    const { app, obtener } = montar(verifier, { u1: perfil("u1", "cliente") });
    const res = await request(app)
      .get("/x")
      .set("Authorization", `Bearer ${jwt("u1")}`);
    expect(res.body).toEqual({ uid: "u1", rol: "cliente" });
    expect(obtener.mock.calls).toEqual([["u1"]]);
  });

  it("si el sub sin verificar no coincide, descarta lo adelantado y usa el uid verificado", async () => {
    const verifier: TokenVerifier = {
      verificar: async () => ({
        uid: "u2",
        correo: undefined,
        correoVerificado: true,
      }),
    };
    const { app, obtener } = montar(verifier, {
      admin: perfil("admin", "administrador"),
      u2: perfil("u2", "cliente"),
    });
    const res = await request(app)
      .get("/x")
      .set("Authorization", `Bearer ${jwt("admin")}`);
    expect(res.body).toEqual({ uid: "u2", rol: "cliente" });
    expect(obtener.mock.calls).toEqual([["admin"], ["u2"]]);
  });

  it("un token inválido responde 401 aunque la lectura adelantada falle", async () => {
    const verifier: TokenVerifier = {
      verificar: async () => {
        throw new TokenInvalidoError("auth/id-token-revoked");
      },
    };
    const obtener = vi.fn(async () => {
      throw new Error("Firestore caído");
    });
    const app = express();
    app.use(requestId);
    app.get(
      "/x",
      requireAuth(verifier, { obtener } as unknown as PerfilRepository),
      (_req, res) => {
        res.sendStatus(204);
      },
    );
    app.use(errorHandler);
    const res = await request(app)
      .get("/x")
      .set("Authorization", `Bearer ${jwt("u1")}`);
    expect(res.status).toBe(401);
  });

  it("uidSinVerificar sólo acepta un sub con forma de uid", () => {
    expect(uidSinVerificar(jwt("abc_DEF-1"))).toBe("abc_DEF-1");
    expect(uidSinVerificar(jwt("../usuarios"))).toBeNull();
    expect(uidSinVerificar("sin-puntos")).toBeNull();
    expect(uidSinVerificar("a.@@@.c")).toBeNull();
  });
});

describe("F7 · compartirEnCurso", () => {
  it("una verificación para peticiones simultáneas con el mismo token y otra al terminar", async () => {
    let soltar!: () => void;
    const verificar = vi.fn(
      () =>
        new Promise<{
          uid: string;
          correo: undefined;
          correoVerificado: boolean;
        }>((r) => {
          soltar = () =>
            r({ uid: "u1", correo: undefined, correoVerificado: true });
        }),
    );
    const v = compartirEnCurso({ verificar });
    const a = v.verificar("t");
    const b = v.verificar("t");
    soltar();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(verificar).toHaveBeenCalledTimes(1);
    const c = v.verificar("t");
    soltar();
    await c;
    expect(verificar).toHaveBeenCalledTimes(2);
  });

  it("un rechazo también se comparte y no queda guardado", async () => {
    const verificar = vi
      .fn()
      .mockRejectedValueOnce(new TokenInvalidoError("auth/id-token-expired"))
      .mockResolvedValueOnce({
        uid: "u1",
        correo: undefined,
        correoVerificado: true,
      });
    const v = compartirEnCurso({ verificar });
    await expect(
      Promise.all([v.verificar("t"), v.verificar("t")]),
    ).rejects.toBeInstanceOf(TokenInvalidoError);
    await expect(v.verificar("t")).resolves.toMatchObject({ uid: "u1" });
    expect(verificar).toHaveBeenCalledTimes(2);
  });
});
