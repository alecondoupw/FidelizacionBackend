import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { validar } from "../http/validar.js";
import { consultarSaldo, listarMovimientos } from "../puntos/libro.js";

/**
 * Saldo y movimientos del propietario (I-04, F2-BE-02). Sólo marcas vinculadas
 * del perfil; nunca datos de otra cuenta ni de otra marca (RN-09).
 */
export function puntosClienteRouter(deps: Dependencias): Router {
  const router = Router();
  const guardas = [
    requireAuth(deps.tokenVerifier, deps.perfiles),
    requireRole("cliente"),
  ];

  router.get("/me/saldo", ...guardas, async (req, res) => {
    const saldo = await consultarSaldo(
      deps.almacen,
      req.auth!.uid,
      req.auth!.marcas,
      deps.reloj(),
    );
    res.set("Cache-Control", "no-store").json(saldo);
  });

  router.get("/me/movimientos", ...guardas, async (req, res) => {
    const q = validar(
      z.object({
        marca: z.enum(MARCAS).optional(),
        tipo: z
          .enum(["otorgamiento", "ajuste", "vencimiento", "canje"])
          .optional(),
        limite: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .regex(/^[0-9TZ-]+[0-9A-Za-z]*$/)
          .max(64)
          .optional(),
      }),
      req.query,
    );
    if (q.marca && !req.auth!.marcas.includes(q.marca)) {
      throw new AppError(403, "FORBIDDEN", "No tienes esa marca vinculada.");
    }
    const r = await listarMovimientos(
      deps.almacen,
      req.auth!.uid,
      q.marca ? [q.marca] : req.auth!.marcas,
      { tipo: q.tipo, limite: q.limite, cursor: q.cursor },
    );
    res.set("Cache-Control", "no-store").json(r);
  });

  return router;
}
