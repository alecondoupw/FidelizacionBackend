import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { API_PREFIX, createApp } from "../app.js";
import { loadConfig } from "../config/env.js";
import { crearDependencias } from "../dependencias.js";
import { errorHandler } from "./errors.js";
import { limitarPeticiones } from "./limite.js";
import { medir, observabilidad } from "./observabilidad.js";
import { requestId } from "./request-id.js";

const FE = "http://localhost:3000";

describe("F7 · registro de peticiones y Server-Timing", () => {
  const montar = () => {
    const lineas: string[] = [];
    const app = express();
    app.use(requestId);
    app.use(
      observabilidad({ origenes: [FE], escribir: (l) => lineas.push(l) }),
    );
    app.get("/api/v1/health", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/api/v1/lento", async (_req, res) => {
      await medir(res, "token", () => new Promise((r) => setTimeout(r, 5)));
      res.json({ ok: true });
    });
    app.get("/api/v1/falla", () => {
      throw new Error("detalle interno");
    });
    app.use(errorHandler);
    return { app, lineas };
  };

  it("expone las fases medidas y el total a los orígenes permitidos", async () => {
    const { app } = montar();
    const res = await request(app).get("/api/v1/lento");
    expect(res.headers["server-timing"]).toMatch(
      /^token;dur=\d+\.\d, total;dur=\d+\.\d$/,
    );
    expect(res.headers["timing-allow-origin"]).toBe(FE);
  });

  it("registra una línea JSON sin consulta ni datos personales", async () => {
    const { app, lineas } = montar();
    const res = await request(app)
      .get("/api/v1/lento?correo=ana@ejemplo.test")
      .set("Authorization", "Bearer secreto");
    await new Promise((r) => setImmediate(r));
    expect(lineas).toHaveLength(1);
    const linea = JSON.parse(lineas[0]!);
    expect(linea).toEqual({
      nivel: "info",
      momento: expect.stringMatching(/Z$/),
      requestId: res.headers["x-request-id"],
      metodo: "GET",
      ruta: "/api/v1/lento",
      estado: 200,
      ms: expect.any(Number),
    });
    expect(lineas[0]).not.toMatch(/ejemplo\.test|secreto/);
  });

  it("omite la salud correcta y marca los 5xx como error", async () => {
    const { app, lineas } = montar();
    await request(app).get("/api/v1/health");
    await request(app).get("/api/v1/falla");
    await new Promise((r) => setImmediate(r));
    expect(lineas.map((l) => JSON.parse(l).nivel)).toEqual(["error"]);
  });
});

describe("F7 · límite de peticiones", () => {
  it("responde 429 con Retry-After al superar el máximo y se reinicia con la ventana", async () => {
    let t = 0;
    const app = express();
    app.use(requestId);
    app.use(
      limitarPeticiones({
        ventanaMs: 60_000,
        maximo: 2,
        clave: (req) => req.get("X-Cliente") ?? "",
        ahora: () => t,
      }),
    );
    app.get("/x", (_req, res) => {
      res.sendStatus(204);
    });
    app.use(errorHandler);

    const pedir = (cliente = "a") =>
      request(app).get("/x").set("X-Cliente", cliente);
    expect((await pedir()).status).toBe(204);
    expect((await pedir()).status).toBe(204);
    t = 45_000;
    const r = await pedir();
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("15");
    expect(r.body.error.code).toBe("RATE_LIMITED");
    expect((await pedir("b")).status).toBe(204);
    t = 60_000;
    expect((await pedir()).status).toBe(204);
  });

  it("en la API el 429 conserva CORS y, tras un proxy de confianza, cuenta por IP real", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CORS_ALLOWED_ORIGINS: FE,
      LIMITE_POR_MINUTO: "10",
      TRUST_PROXY: "1",
    });
    const app = createApp(config, crearDependencias(config));
    const salud = (ip: string) =>
      request(app)
        .get(`${API_PREFIX}/health`)
        .set("Origin", FE)
        .set("X-Forwarded-For", ip);
    for (let i = 0; i < 10; i++)
      expect((await salud("1.1.1.1")).status).toBe(200);
    const r = await salud("1.1.1.1");
    expect(r.status).toBe(429);
    expect(r.headers["access-control-allow-origin"]).toBe(FE);
    expect((await salud("2.2.2.2")).status).toBe(200);
  });

  it("limita el registro de clientes a 20 intentos cada 15 minutos por IP", async () => {
    const config = loadConfig({ NODE_ENV: "test", CORS_ALLOWED_ORIGINS: FE });
    const app = createApp(config, crearDependencias(config));
    const estados: number[] = [];
    for (let i = 0; i < 21; i++) {
      estados.push(
        (await request(app).post(`${API_PREFIX}/clientes/registro`).send({}))
          .status,
      );
    }
    expect(estados.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(estados[20]).toBe(429);
  });
});
