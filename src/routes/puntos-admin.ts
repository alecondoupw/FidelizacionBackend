import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { validar } from "../http/validar.js";
import { asignarPuntos } from "../puntos/libro.js";
import {
  actualizarRegla,
  crearRegla,
  eliminarRegla,
  listarReglas,
} from "../puntos/reglas.js";
import { EVENTOS } from "../puntos/tipos.js";

const marca = z.enum(MARCAS);
const evento = z.enum(EVENTOS);
/** Entero positivo; sin negativos ni decimales (SRC-02 p. 4, punto 12). */
const puntos = z
  .number()
  .int("Debe ser un número entero.")
  .min(1, "Debe ser mayor que cero.")
  .max(1_000_000);
const idSolicitud = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** Correo del cliente: se recortan los espacios antes de validar (SRC-06 p. 1). */
export const correoCliente = z.string().trim().pipe(z.email());
/** AAAA-MM-DD; el rango (hoy a 2 años) se valida en el libro (DEC-18). */
export const fechaVencimiento = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Usa AAAA-MM-DD.");

/**
 * Rutas de administración del motor de puntos; sólo rol administrador.
 * F8 (DEC-18): el panel sólo suma puntos con vencimiento propio; se retiraron
 * eventos manuales, ajustes negativos, vigencias por marca y «Procesar ahora».
 */
export function puntosAdminRouter(deps: Dependencias): Router {
  const router = Router();
  router.use(
    "/admin",
    requireAuth(deps.tokenVerifier, deps.perfiles),
    requireRole("administrador"),
  );

  router.get("/admin/reglas", async (req, res) => {
    const filtros = validar(
      z.object({
        marca: marca.optional(),
        evento: evento.optional(),
        activa: z.enum(["true", "false"]).optional(),
      }),
      req.query,
    );
    const items = (await listarReglas(deps.almacen)).filter(
      (r) =>
        (!filtros.marca || r.marca === filtros.marca) &&
        (!filtros.evento || r.evento === filtros.evento) &&
        (!filtros.activa || String(r.activa) === filtros.activa),
    );
    res.json({ items });
  });

  router.post("/admin/reglas", async (req, res) => {
    const datos = validar(
      z.object({ marca, evento, puntos, activa: z.boolean() }).strict(),
      req.body,
    );
    res
      .status(201)
      .json(await crearRegla(deps.almacen, datos, req.auth!.uid, deps.reloj()));
  });

  router.patch("/admin/reglas/:id", async (req, res) => {
    const cambios = validar(
      z
        .object({
          marca: marca.optional(),
          puntos: puntos.optional(),
          activa: z.boolean().optional(),
        })
        .strict()
        .refine((c) => Object.keys(c).length > 0, "Indica al menos un cambio."),
      req.body,
    );
    res.json(
      await actualizarRegla(
        deps.almacen,
        String(req.params.id),
        cambios,
        req.auth!.uid,
        deps.reloj(),
      ),
    );
  });

  router.delete("/admin/reglas/:id", async (req, res) => {
    await eliminarRegla(
      deps.almacen,
      String(req.params.id),
      req.auth!.uid,
      deps.reloj(),
    );
    res.status(204).end();
  });

  /** Suma manual con motivo y fecha de vencimiento (SRC-06 p. 3). */
  router.post("/admin/asignaciones", async (req, res) => {
    const datos = validar(
      z
        .object({
          idSolicitud,
          marca,
          correoCliente,
          puntos,
          motivo: z
            .string()
            .trim()
            .min(5, "Describe el motivo (mínimo 5 caracteres).")
            .max(300),
          vence: fechaVencimiento,
        })
        .strict(),
      req.body,
    );
    const r = await asignarPuntos(
      deps.almacen,
      { ...datos, actor: req.auth!.uid },
      deps.reloj(),
    );
    res.status(r.repetido ? 200 : 201).json(r);
  });

  return router;
}
