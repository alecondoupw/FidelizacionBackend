import type { RequestHandler, Response } from "express";

/**
 * Observabilidad mínima (F7-BE-01) sin dependencias:
 *   - una línea JSON por petición en stdout (Render la conserva en sus logs):
 *     requestId, método, ruta sin consulta, estado y duración; nunca cuerpos,
 *     tokens, correos ni parámetros de consulta;
 *   - cabecera Server-Timing con las fases medidas (token, perfil) y el total,
 *     visible desde el navegador para medir el rendimiento real.
 */
interface Fase {
  nombre: string;
  ms: number;
}

const fasesDe = (res: Response): Fase[] =>
  ((res.locals.fases as Fase[] | undefined) ??= []);

/** Mide una fase de la petición para Server-Timing. */
export async function medir<T>(
  res: Response,
  nombre: string,
  fn: () => Promise<T>,
): Promise<T> {
  const inicio = performance.now();
  try {
    return await fn();
  } finally {
    fasesDe(res).push({ nombre, ms: performance.now() - inicio });
  }
}

export type Escritor = (linea: string) => void;

export function observabilidad(opciones: {
  /** Orígenes que pueden leer los tiempos (Timing-Allow-Origin). */
  origenes: string[];
  /** null: sin registro (pruebas). */
  escribir: Escritor | null;
}): RequestHandler {
  const permitidos = opciones.origenes.join(", ");
  return (req, res, next) => {
    const inicio = performance.now();
    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: unknown[]) {
      if (!res.headersSent) {
        const total = performance.now() - inicio;
        const fases = fasesDe(res).map(
          (f) => `${f.nombre};dur=${f.ms.toFixed(1)}`,
        );
        res.setHeader(
          "Server-Timing",
          [...fases, `total;dur=${total.toFixed(1)}`].join(", "),
        );
        if (permitidos) res.setHeader("Timing-Allow-Origin", permitidos);
      }
      return (writeHead as (...a: unknown[]) => Response).apply(this, args);
    } as Response["writeHead"];

    if (opciones.escribir) {
      const escribir = opciones.escribir;
      res.on("finish", () => {
        const ruta = req.originalUrl.split("?")[0]!;
        if (ruta.endsWith("/health") && res.statusCode < 400) return;
        escribir(
          JSON.stringify({
            nivel:
              res.statusCode >= 500
                ? "error"
                : res.statusCode >= 400
                  ? "aviso"
                  : "info",
            momento: new Date().toISOString(),
            requestId: req.requestId,
            metodo: req.method,
            ruta,
            estado: res.statusCode,
            ms: Math.round(performance.now() - inicio),
            ...(req.auth ? { rol: req.auth.rol } : {}),
          }),
        );
      });
    }
    next();
  };
}
