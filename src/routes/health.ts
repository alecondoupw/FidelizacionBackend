import { createRequire } from "node:module";
import { Router } from "express";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { name: string; version: string };

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  /** Hora del servidor en ISO 8601 UTC. */
  time: string;
}

/** Salud técnica pública: sin token, sin datos de negocio ni personales. */
export function healthRouter(): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      service: pkg.name,
      version: pkg.version,
      time: new Date().toISOString(),
    };
    res.set("Cache-Control", "no-store").json(body);
  });
  return router;
}
