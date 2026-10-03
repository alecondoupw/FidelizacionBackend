import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { validar } from "../http/validar.js";
import {
  ajustarPuntos,
  procesarVencimientos,
  registrarEvento,
} from "../puntos/libro.js";
import {
  actualizarRegla,
  crearRegla,
  eliminarRegla,
  listarReglas,
} from "../puntos/reglas.js";
import { EVENTOS, UNIDADES } from "../puntos/tipos.js";
import {
  actualizarVigencia,
  historialVigencia,
  listarVigencias,
} from "../puntos/vigencias.js";

const marca = z.enum(MARCAS);
const evento = z.enum(EVENTOS);
/** Entero positivo; sin negativos ni decimales (SRC-02 p. 4, punto 12). */
const puntos = z
  .number()
  .int("Debe ser un número entero.")
  .min(1, "Debe ser mayor que cero.")
  .max(1_000_000);
const idExterno = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const correoCliente = z.email();

const LIMITE_VIGENCIA = { dias: 3650, meses: 120, anios: 10 } as const;

/** Rutas de administración del motor de puntos (F2-BE-01/02/03); sólo rol administrador. */
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

  router.get("/admin/vigencias", async (_req, res) => {
    res.json({ items: await listarVigencias(deps.almacen) });
  });

  router.put("/admin/vigencias/:marca", async (req, res) => {
    const m = validar(marca, req.params.marca);
    const datos = validar(
      z
        .object({
          activa: z.boolean(),
          cantidad: z.number().int().min(1),
          unidad: z.enum(UNIDADES),
        })
        .strict()
        .refine((d) => d.cantidad <= LIMITE_VIGENCIA[d.unidad], {
          path: ["cantidad"],
          message: "Periodo demasiado largo (máximo 10 años).",
        }),
      req.body,
    );
    res.json(
      await actualizarVigencia(
        deps.almacen,
        m,
        datos,
        req.auth!.uid,
        deps.reloj(),
      ),
    );
  });

  router.get("/admin/vigencias/:marca/historial", async (req, res) => {
    const m = validar(marca, req.params.marca);
    res.json({ items: await historialVigencia(deps.almacen, m) });
  });

  /** Registro manual de un evento por un administrador (DEC-05). */
  router.post("/admin/eventos", async (req, res) => {
    const datos = validar(
      z.object({ idExterno, evento, marca, correoCliente }).strict(),
      req.body,
    );
    const r = await registrarEvento(
      deps.almacen,
      { ...datos, origen: "panel", actor: req.auth!.uid },
      deps.reloj(),
    );
    res.status(r.repetido ? 200 : 201).json(r);
  });

  /** Ajuste con motivo (DEC-14). */
  router.post("/admin/ajustes", async (req, res) => {
    const datos = validar(
      z
        .object({
          idExterno,
          marca,
          correoCliente,
          puntos: z
            .number()
            .int()
            .min(-1_000_000)
            .max(1_000_000)
            .refine((p) => p !== 0, "No puede ser cero."),
          motivo: z
            .string()
            .trim()
            .min(5, "Describe el motivo (mínimo 5 caracteres).")
            .max(300),
        })
        .strict(),
      req.body,
    );
    const r = await ajustarPuntos(
      deps.almacen,
      { ...datos, actor: req.auth!.uid },
      deps.reloj(),
    );
    res.status(r.repetido ? 200 : 201).json(r);
  });

  router.post("/admin/vencimientos/procesar", async (_req, res) => {
    res.json(await procesarVencimientos(deps.almacen, deps.reloj()));
  });

  return router;
}
