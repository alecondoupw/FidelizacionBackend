import express from "express";
import { getApps } from "firebase-admin/app";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { API_PREFIX, createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { crearDependencias } from "./dependencias.js";
import { getFirebaseAdminApp } from "./firebase/admin.js";
import { errorHandler } from "./http/errors.js";
import { requestId } from "./http/request-id.js";

const FE_ORIGIN = "http://localhost:3000";
const config = loadConfig({
  NODE_ENV: "test",
  CORS_ALLOWED_ORIGINS: FE_ORIGIN,
});
const app = createApp(config, crearDependencias(config));

function expectErrorEnvelope(body: unknown, code: string) {
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
      requestId: expect.any(String),
    },
  });
}

describe("GET /api/v1/health", () => {
  it("responde 200 con el contrato de salud y hora UTC", async () => {
    const res = await request(app).get(`${API_PREFIX}/health`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      status: "ok",
      service: "fidelizacion-backend",
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it("devuelve X-Request-Id y no expone x-powered-by", async () => {
    const res = await request(app).get(`${API_PREFIX}/health`);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("respeta un X-Request-Id seguro y reemplaza uno inseguro", async () => {
    const ok = await request(app)
      .get(`${API_PREFIX}/health`)
      .set("X-Request-Id", "prueba-12345");
    expect(ok.headers["x-request-id"]).toBe("prueba-12345");
    const bad = await request(app)
      .get(`${API_PREFIX}/health`)
      .set("X-Request-Id", "<script>");
    expect(bad.headers["x-request-id"]).not.toBe("<script>");
  });

  it("no inicializa Firebase Admin para responder", async () => {
    await request(app).get(`${API_PREFIX}/health`);
    expect(getApps()).toHaveLength(0);
  });
});

describe("CORS", () => {
  it("autoriza el origen configurado del frontend", async () => {
    const res = await request(app)
      .get(`${API_PREFIX}/health`)
      .set("Origin", FE_ORIGIN);
    expect(res.headers["access-control-allow-origin"]).toBe(FE_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("no autoriza un origen ajeno", async () => {
    const res = await request(app)
      .get(`${API_PREFIX}/health`)
      .set("Origin", "http://otro-origen.test");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("responde el preflight con Authorization permitido", async () => {
    const res = await request(app)
      .options(`${API_PREFIX}/health`)
      .set("Origin", FE_ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toMatch(
      /Authorization/,
    );
  });
});

describe("errores con sobre consistente", () => {
  it("404 para una ruta inexistente", async () => {
    const res = await request(app).get(`${API_PREFIX}/no-existe`);
    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, "NOT_FOUND");
  });

  it("400 para JSON mal formado", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/health`)
      .set("Content-Type", "application/json")
      .send("{malo");
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "INVALID_JSON");
  });

  it("413 para un cuerpo demasiado grande", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/health`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ relleno: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
    expectErrorEnvelope(res.body, "PAYLOAD_TOO_LARGE");
  });

  it("500 sin filtrar el detalle interno", async () => {
    const failing = express();
    failing.use(requestId);
    failing.get("/boom", () => {
      throw new Error("detalle interno secreto");
    });
    failing.use(errorHandler);
    const original = console.error;
    console.error = () => {};
    try {
      const res = await request(failing).get("/boom");
      expect(res.status).toBe(500);
      expectErrorEnvelope(res.body, "INTERNAL_ERROR");
      expect(JSON.stringify(res.body)).not.toContain("secreto");
    } finally {
      console.error = original;
    }
  });
});

describe("rutas protegidas sin Firebase configurado", () => {
  it("401 sin token, antes de tocar Firebase", async () => {
    const res = await request(app).get(`${API_PREFIX}/me`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "UNAUTHENTICATED");
  });

  it("503 AUTH_NOT_CONFIGURED con token, sin inicializar Admin SDK", async () => {
    const res = await request(app)
      .get(`${API_PREFIX}/me`)
      .set("Authorization", "Bearer token.de.prueba");
    expect(res.status).toBe(503);
    expectErrorEnvelope(res.body, "AUTH_NOT_CONFIGURED");
    expect(getApps()).toHaveLength(0);
  });
});

describe("Firebase Admin SDK", () => {
  it("falla con AUTH_NOT_CONFIGURED si no hay proyecto (sin tocar credenciales)", () => {
    expect(() => getFirebaseAdminApp(config)).toThrowError(
      expect.objectContaining({ status: 503, code: "AUTH_NOT_CONFIGURED" }),
    );
    expect(getApps()).toHaveLength(0);
  });
});
