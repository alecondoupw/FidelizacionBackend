import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Correlaciona cada petición con sus registros y su respuesta de error. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("X-Request-Id");
  req.requestId =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
};
