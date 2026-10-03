import { Router } from "express";
import { z } from "zod";
import { requireClaveIntegracion } from "../auth/integracion.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { validar } from "../http/validar.js";
import { registrarEvento } from "../puntos/libro.js";
import { EVENTOS } from "../puntos/tipos.js";

/**
 * API de integración (DEC-05, REQ-21): facturación/CRM registran eventos con
 * su propio identificador; repetirlo nunca otorga dos veces.
 */
export function integracionRouter(
  deps: Dependencias,
  claves: ReadonlyMap<string, string>,
): Router {
  const router = Router();
  router.post(
    "/integracion/eventos",
    requireClaveIntegracion(claves),
    async (req, res) => {
      const datos = validar(
        z
          .object({
            idExterno: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9._:-]+$/),
            evento: z.enum(EVENTOS),
            marca: z.enum(MARCAS),
            correoCliente: z.email(),
          })
          .strict(),
        req.body,
      );
      const sistema = req.integracion!;
      const r = await registrarEvento(
        deps.almacen,
        { ...datos, origen: `api:${sistema}`, actor: `api:${sistema}` },
        deps.reloj(),
      );
      res.status(r.repetido ? 200 : 201).json(r);
    },
  );
  return router;
}
