import type { Request, RequestHandler } from "express";
import { AppError } from "./errors.js";

/**
 * Límite de peticiones por ventana fija y por clave (IP por defecto), en
 * memoria del proceso (F7-BE-01). Basta para una instancia; con varias
 * instancias cada una cuenta por separado. Detrás de un proxy, la IP real
 * depende de TRUST_PROXY.
 */
export function limitarPeticiones(opciones: {
  ventanaMs: number;
  maximo: number;
  clave?: (req: Request) => string;
  ahora?: () => number;
}): RequestHandler {
  const { ventanaMs, maximo } = opciones;
  const clave = opciones.clave ?? ((req) => req.ip ?? "desconocida");
  const ahora = opciones.ahora ?? Date.now;
  const cuentas = new Map<string, { desde: number; n: number }>();

  return (req, res, next) => {
    const t = ahora();
    if (cuentas.size > 10_000) {
      for (const [k, v] of cuentas)
        if (t - v.desde >= ventanaMs) cuentas.delete(k);
    }
    const k = clave(req);
    let c = cuentas.get(k);
    if (!c || t - c.desde >= ventanaMs) {
      c = { desde: t, n: 0 };
      cuentas.set(k, c);
    }
    c.n++;
    if (c.n > maximo) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil((c.desde + ventanaMs - t) / 1000)),
      );
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.",
      );
    }
    next();
  };
}
