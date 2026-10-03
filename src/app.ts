import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { AppConfig } from "./config/env.js";
import type { Dependencias } from "./dependencias.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { requestId } from "./http/request-id.js";
import { canjesRouter } from "./routes/canjes.js";
import { healthRouter } from "./routes/health.js";
import { identidadesRouter } from "./routes/identidades.js";
import { integracionRouter } from "./routes/integracion.js";
import { puntosAdminRouter } from "./routes/puntos-admin.js";
import { puntosClienteRouter } from "./routes/puntos-cliente.js";
import { meRouter } from "./routes/me.js";
import { registroRouter } from "./routes/registro.js";

export const API_PREFIX = "/api/v1";

/** Construye la aplicación sin abrir puertos; Firebase sólo se toca al usar una ruta protegida. */
export function createApp(config: AppConfig, deps: Dependencias): Express {
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
  app.use(API_PREFIX, meRouter(deps));
  app.use(API_PREFIX, registroRouter(deps));
  app.use(API_PREFIX, puntosClienteRouter(deps));
  app.use(API_PREFIX, puntosAdminRouter(deps));
  app.use(API_PREFIX, canjesRouter(deps));
  app.use(API_PREFIX, identidadesRouter(deps));
  app.use(API_PREFIX, integracionRouter(deps, config.integracionClaves));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
