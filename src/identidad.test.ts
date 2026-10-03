import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { API_PREFIX, createApp } from "./app.js";
import { requireAuth, requireRole } from "./auth/authorization.js";
import {
  TokenInvalidoError,
  type TokenVerificado,
  type TokenVerifier,
} from "./auth/token-verifier.js";
import { loadConfig } from "./config/env.js";
import type { Dependencias } from "./dependencias.js";
import type { Perfil } from "./dominio/tipos.js";
import { errorHandler } from "./http/errors.js";
import { requestId } from "./http/request-id.js";
import { crearAlmacenEnMemoria } from "./almacen/memoria.js";
import { crearFuenteSintetica } from "./legacy/fuente-legacy.js";
import { crearPerfilesEnMemoria } from "./usuarios/perfiles.js";

/** Tokens de prueba: cada cadena representa un ID token ya verificado por Firebase. */
const TOKENS: Record<string, TokenVerificado> = {
  "tok-cliente": {
    uid: "u-cliente",
    correo: "cliente.zontes@ejemplo.test",
    correoVerificado: true,
  },
  "tok-admin": {
    uid: "u-admin",
    correo: "admin@ejemplo.test",
    correoVerificado: true,
  },
  "tok-inactivo": {
    uid: "u-inactivo",
    correo: "inactivo@ejemplo.test",
    correoVerificado: true,
  },
  "tok-nuevo-multi": {
    uid: "u-nuevo",
    correo: "  Cliente.MultiMarca@Ejemplo.TEST ",
    correoVerificado: true,
  },
  "tok-sin-legacy": {
    uid: "u-sin",
    correo: "persona@ejemplo.test",
    correoVerificado: true,
  },
  "tok-no-verificado": {
    uid: "u-nv",
    correo: "cliente.zontes@ejemplo.test",
    correoVerificado: false,
  },
  "tok-sin-correo": {
    uid: "u-anon",
    correo: undefined,
    correoVerificado: false,
  },
  "tok-mismo-correo": {
    uid: "u-otro",
    correo: "cliente.multimarca@ejemplo.test",
    correoVerificado: true,
  },
};

const verifier: TokenVerifier = {
  async verificar(token) {
    if (token === "tok-expirado")
      throw new TokenInvalidoError("auth/id-token-expired");
    if (token === "tok-revocado")
      throw new TokenInvalidoError("auth/id-token-revoked");
    if (token === "tok-caida") throw new Error("Firebase no responde");
    const t = TOKENS[token];
    if (!t) throw new TokenInvalidoError("auth/argument-error");
    return t;
  },
};

const perfil = (
  p: Partial<Perfil> & Pick<Perfil, "uid" | "correo" | "rol">,
): Perfil => ({
  activo: true,
  marcas: [],
  vinculo: "no_vinculado",
  creadoEn: "2026-10-03T00:00:00.000Z",
  ...p,
});

const config = loadConfig({ NODE_ENV: "test" });
let perfiles: ReturnType<typeof crearPerfilesEnMemoria>;
let deps: Dependencias;
let app: express.Express;

beforeEach(async () => {
  perfiles = crearPerfilesEnMemoria();
  const evento = {
    accion: "cliente.registrado",
    actor: "x",
    objetivoUid: "x",
    en: "",
    datos: {},
  } as const;
  await perfiles.registrar(
    perfil({
      uid: "u-cliente",
      correo: "cliente.zontes@ejemplo.test",
      rol: "cliente",
      marcas: ["zontes"],
      vinculo: "vinculado",
    }),
    evento,
  );
  await perfiles.registrar(
    perfil({
      uid: "u-admin",
      correo: "admin@ejemplo.test",
      rol: "administrador",
    }),
    evento,
  );
  await perfiles.registrar(
    perfil({
      uid: "u-inactivo",
      correo: "inactivo@ejemplo.test",
      rol: "cliente",
      activo: false,
    }),
    evento,
  );
  perfiles.auditoria.length = 0;
  deps = {
    tokenVerifier: verifier,
    perfiles,
    fuenteLegacy: crearFuenteSintetica(),
    almacen: crearAlmacenEnMemoria(),
    reloj: () => new Date("2026-10-03T12:00:00.000Z"),
  };
  app = createApp(config, deps);
});

const me = (token?: string) => {
  const r = request(app).get(`${API_PREFIX}/me`);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
const registro = (token: string) =>
  request(app)
    .post(`${API_PREFIX}/clientes/registro`)
    .set("Authorization", `Bearer ${token}`);

describe("F1-BE-01 · GET /api/v1/me", () => {
  it("cliente registrado → 200 con el contrato I-01", async () => {
    const res = await me("tok-cliente");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      uid: "u-cliente",
      rol: "cliente",
      activo: true,
      marcas: ["zontes"],
      vinculo: "vinculado",
    });
  });

  it("administrador → rol administrador", async () => {
    const res = await me("tok-admin");
    expect(res.status).toBe(200);
    expect(res.body.rol).toBe("administrador");
  });

  it.each([
    ["sin cabecera", undefined],
    ["token desconocido o malformado", "tok-basura"],
    ["token expirado", "tok-expirado"],
    ["token revocado", "tok-revocado"],
  ])("401 UNAUTHENTICATED: %s", async (_caso, token) => {
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("401 con esquema distinto de Bearer", async () => {
    const res = await request(app)
      .get(`${API_PREFIX}/me`)
      .set("Authorization", "Basic abc");
    expect(res.status).toBe(401);
  });

  it("usuario desactivado → 403 aunque el token sea válido", async () => {
    const res = await me("tok-inactivo");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("usuario de Firebase sin perfil → 403 REGISTRATION_REQUIRED", async () => {
    const res = await me("tok-sin-legacy");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REGISTRATION_REQUIRED");
  });

  it("fallo de infraestructura al verificar → 500, no se disfraza de 401", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const res = await me("tok-caida");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
    } finally {
      console.error = original;
    }
  });
});

describe("F1-BE-01 · requireRole", () => {
  const appConRol = () => {
    const a = express();
    a.use(requestId);
    a.get(
      "/admin/prueba",
      requireAuth(verifier, perfiles),
      requireRole("administrador"),
      (_req, res) => {
        res.json({ alcanzado: true });
      },
    );
    a.use(errorHandler);
    return a;
  };

  it("cliente en ruta de administrador → 403 y nunca alcanza el handler", async () => {
    const res = await request(appConRol())
      .get("/admin/prueba")
      .set("Authorization", "Bearer tok-cliente");
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty("alcanzado");
  });

  it("administrador → alcanza el handler", async () => {
    const res = await request(appConRol())
      .get("/admin/prueba")
      .set("Authorization", "Bearer tok-admin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alcanzado: true });
  });
});

describe("F1-BE-03 · POST /api/v1/clientes/registro", () => {
  it("correo con mayúsculas y espacios coincide tras normalizar → vinculado con sus marcas", async () => {
    const res = await registro("tok-nuevo-multi");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      vinculo: "vinculado",
      marcas: ["zontes", "kiden", "niu"],
    });
    expect(await perfiles.obtener("u-nuevo")).toMatchObject({
      correo: "cliente.multimarca@ejemplo.test",
      rol: "cliente",
      activo: true,
    });
  });

  it("sin coincidencia en la fuente → no_vinculado y sin marcas", async () => {
    const res = await registro("tok-sin-legacy");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ vinculo: "no_vinculado", marcas: [] });
  });

  it("tras registrarse, /me responde con el perfil nuevo", async () => {
    await registro("tok-nuevo-multi");
    const res = await me("tok-nuevo-multi");
    expect(res.status).toBe(200);
    expect(res.body.vinculo).toBe("vinculado");
  });

  it("correo no verificado → 403 EMAIL_NOT_VERIFIED y no se crea perfil", async () => {
    const res = await registro("tok-no-verificado");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect(await perfiles.obtener("u-nv")).toBeNull();
  });

  it("cuenta sin correo → 422", async () => {
    const res = await registro("tok-sin-correo");
    expect(res.status).toBe(422);
  });

  it("mismo usuario dos veces → 409 ALREADY_REGISTERED", async () => {
    await registro("tok-nuevo-multi");
    const res = await registro("tok-nuevo-multi");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REGISTERED");
  });

  it("otra cuenta con el mismo correo → 409 EMAIL_ALREADY_LINKED", async () => {
    await registro("tok-nuevo-multi");
    const res = await registro("tok-mismo-correo");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_LINKED");
    expect(await perfiles.obtener("u-otro")).toBeNull();
  });

  it("el correo del cuerpo se ignora: sólo cuenta el del token verificado", async () => {
    const res = await registro("tok-sin-legacy").send({
      correo: "cliente.multimarca@ejemplo.test",
    });
    expect(res.status).toBe(201);
    expect(res.body.vinculo).toBe("no_vinculado");
  });

  it("deja un evento de auditoría sin correo", async () => {
    await registro("tok-nuevo-multi");
    expect(perfiles.auditoria).toEqual([
      {
        accion: "cliente.registrado",
        actor: "u-nuevo",
        objetivoUid: "u-nuevo",
        en: "2026-10-03T12:00:00.000Z",
        datos: { vinculo: "vinculado", marcas: ["zontes", "kiden", "niu"] },
      },
    ]);
    expect(JSON.stringify(perfiles.auditoria)).not.toContain("@");
  });

  it("sin token → 401", async () => {
    const res = await request(app).post(`${API_PREFIX}/clientes/registro`);
    expect(res.status).toBe(401);
  });
});
