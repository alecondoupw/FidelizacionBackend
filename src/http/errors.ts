import type { ErrorRequestHandler, RequestHandler } from "express";

/**
 * Sobre de error del contrato API v0 (Zontes-Core/02-Arquitectura/Contrato API v0 - F0.md):
 * { "error": { "code": string, "message": string, "requestId"?: string, "details"?: unknown } }
 * Los mensajes son aptos para mostrar; nunca incluyen trazas, tokens ni datos personales.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "INVALID_JSON"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "REGISTRATION_REQUIRED"
  | "EMAIL_NOT_VERIFIED"
  | "EMAIL_ALREADY_LINKED"
  | "ALREADY_REGISTERED"
  | "CLIENT_NOT_FOUND"
  | "CLIENT_INACTIVE"
  | "BRAND_NOT_LINKED"
  | "IDEMPOTENCY_CONFLICT"
  | "INSUFFICIENT_BALANCE"
  | "RULE_EXISTS"
  | "OUT_OF_STOCK"
  | "NOT_AVAILABLE_YET"
  | "INVALID_STATE"
  | "ALREADY_EXISTS"
  | "EMAIL_IN_USE"
  | "LAST_ADMIN"
  | "SELF_ACTION"
  | "RANGE_TOO_LARGE"
  | "TOO_MANY_ROWS"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "NOT_IMPLEMENTED"
  | "AUTH_NOT_CONFIGURED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", "Ruta no encontrada."));
};

interface BodyParserError {
  type?: string;
  status?: number;
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const parserError = error as BodyParserError;
  switch (parserError?.type) {
    case "entity.parse.failed":
      return new AppError(400, "INVALID_JSON", "El cuerpo JSON no es válido.");
    case "entity.too.large":
      return new AppError(
        413,
        "PAYLOAD_TOO_LARGE",
        "El cuerpo de la petición es demasiado grande.",
      );
    case "charset.unsupported":
    case "encoding.unsupported":
      return new AppError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Codificación no soportada.",
      );
  }
  return new AppError(500, "INTERNAL_ERROR", "Error interno del servidor.");
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const appError = toAppError(error);
  if (appError.status >= 500) {
    console.error(
      `[${req.requestId}] ${req.method} ${req.path} -> ${appError.status}`,
      error,
    );
  }
  const body: ErrorEnvelope = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.requestId,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };
  res.status(appError.status).json(body);
};
