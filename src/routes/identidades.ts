import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { validar } from "../http/validar.js";
import {
  actualizarAdministrador,
  crearAdministrador,
  eliminarAdministrador,
  listarAdministradores,
} from "../identidad/administradores.js";
import {
  actualizarCliente,
  actualizarNombrePropio,
  detalleCliente,
  eliminarCliente,
  historialDe,
  listarClientes,
} from "../identidad/clientes.js";

const uid = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "Identificador inválido.");
const nombre = z.string().trim().min(2, "Ingresa el nombre.").max(80);
const correo = z.email("Correo inválido.").max(254);
const booleano = z.enum(["true", "false"]).transform((v) => v === "true");

/** Gestión de identidades (F4, SRC-02 pp. 2–3; DEC-03/04/08). */
export function identidadesRouter(deps: Dependencias): Router {
  const router = Router();
  const autenticado = requireAuth(deps.tokenVerifier, deps.perfiles);
  const admin = [autenticado, requireRole("administrador")];

  // ── Perfil propio (UI-18/UI-22): sólo el nombre (DEC-08) ─────────────
  router.patch("/me", autenticado, async (req, res) => {
    const datos = validar(z.object({ nombre }).strict(), req.body);
    await actualizarNombrePropio(
      deps,
      req.auth!.uid,
      datos.nombre,
      deps.reloj(),
    );
    res.status(204).end();
  });

  // ── Administradores (UI-06) ──────────────────────────────────────────
  router.get("/admin/administradores", ...admin, async (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json({ items: await listarAdministradores(deps) });
  });

  router.post("/admin/administradores", ...admin, async (req, res) => {
    const d = validar(
      z.object({ nombre, apellido: nombre, correo }).strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        await crearAdministrador(
          deps,
          { nombre: `${d.nombre} ${d.apellido}`, correo: d.correo },
          req.auth!.uid,
          deps.reloj(),
        ),
      );
  });

  router.patch("/admin/administradores/:uid", ...admin, async (req, res) => {
    const id = validar(uid, req.params.uid);
    const cambios = validar(
      z
        .object({ nombre: nombre.optional(), activo: z.boolean().optional() })
        .strict(),
      req.body,
    );
    res.json(
      await actualizarAdministrador(
        deps,
        id,
        cambios,
        req.auth!.uid,
        deps.reloj(),
      ),
    );
  });

  router.delete("/admin/administradores/:uid", ...admin, async (req, res) => {
    const id = validar(uid, req.params.uid);
    await eliminarAdministrador(deps, id, req.auth!.uid, deps.reloj());
    res.status(204).end();
  });

  // ── Clientes (UI-07) ─────────────────────────────────────────────────
  router.get("/admin/clientes", ...admin, async (req, res) => {
    const q = validar(
      z.object({
        correo: correo.optional(),
        marca: z.enum(MARCAS).optional(),
        activo: booleano.optional(),
        vinculo: z.enum(["vinculado", "no_vinculado"]).optional(),
        limite: z.coerce.number().int().min(1).max(100).default(20),
        cursor: uid.optional(),
      }),
      req.query,
    );
    res.set("Cache-Control", "no-store").json(await listarClientes(deps, q));
  });

  router.get("/admin/clientes/:uid", ...admin, async (req, res) => {
    const id = validar(uid, req.params.uid);
    res.set("Cache-Control", "no-store").json(await detalleCliente(deps, id));
  });

  router.patch("/admin/clientes/:uid", ...admin, async (req, res) => {
    const id = validar(uid, req.params.uid);
    const cambios = validar(
      z
        .object({
          nombre: nombre.optional(),
          correo: correo.optional(),
          activo: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    res.json(
      await actualizarCliente(deps, id, cambios, req.auth!.uid, deps.reloj()),
    );
  });

  router.delete("/admin/clientes/:uid", ...admin, async (req, res) => {
    const id = validar(uid, req.params.uid);
    await eliminarCliente(deps, id, req.auth!.uid, deps.reloj());
    res.status(204).end();
  });

  // ── Auditoría por persona (F4-BE-03) ─────────────────────────────────
  router.get("/admin/auditoria", ...admin, async (req, res) => {
    const q = validar(z.object({ objetivo: uid }), req.query);
    res
      .set("Cache-Control", "no-store")
      .json({ items: await historialDe(deps, q.objetivo) });
  });

  return router;
}
