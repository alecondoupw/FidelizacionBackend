import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { AppConfig } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { requestId } from "./http/request-id.js";
import { healthRouter } from "./routes/health.js";

export const API_PREFIX = "/api/v1";

/** Construye la aplicación sin abrir puertos ni inicializar Firebase. */
export function createApp(config: AppConfig): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsAllowedOrigins,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  app.use(API_PREFIX, healthRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
