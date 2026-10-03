import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.js";

describe("loadConfig", () => {
  it("aplica valores locales por defecto sin Firebase", () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 4000,
      corsAllowedOrigins: ["http://localhost:3000"],
      firebaseProjectId: undefined,
    });
  });

  it("acepta varios orígenes separados por coma", () => {
    const config = loadConfig({
      CORS_ALLOWED_ORIGINS: "http://localhost:3000, http://127.0.0.1:3000",
    });
    expect(config.corsAllowedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
  });

  it("trata FIREBASE_PROJECT_ID vacío como ausente", () => {
    expect(loadConfig({ FIREBASE_PROJECT_ID: "  " }).firebaseProjectId).toBe(
      undefined,
    );
  });

  it.each([
    [{ PORT: "no-numero" }],
    [{ PORT: "70000" }],
    [{ NODE_ENV: "staging" }],
    [{ CORS_ALLOWED_ORIGINS: "http://localhost:3000/ruta" }],
    [{ CORS_ALLOWED_ORIGINS: "*" }],
  ])("rechaza configuración inválida %o", (env) => {
    expect(() => loadConfig(env)).toThrow(/Configuración de entorno inválida/);
  });
});
