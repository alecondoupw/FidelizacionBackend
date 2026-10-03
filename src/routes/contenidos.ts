import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import {
  actualizarContenido,
  CATEGORIAS_CONTENIDO,
  contenidosCliente,
  crearContenido,
  eliminarContenido,
  listarContenidosAdmin,
} from "../contenido/contenidos.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { validar } from "../http/validar.js";

const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Usa AAAA-MM-DD.")
  .nullable();
const idContenido = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Publicación por marca (UI-12, DEC-10); cuerpo estricto. */
export const esquemaPublicacion = z
  .object({
    marca: z.enum(MARCAS),
    categoria: z.enum(CATEGORIAS_CONTENIDO),
    titulo: z.string().trim().min(3, "Mínimo 3 caracteres.").max(90),
    texto: z.string().trim().max(600).default(""),
    enlace: z
      .url({ protocol: /^https$/, error: "Usa un enlace https completo." })
      .max(500)
      .nullable()
      .default(null),
    destacada: z.boolean().default(false),
    activa: z.boolean(),
    publicarDesde: fecha.default(null),
    publicarHasta: fecha.default(null),
  })
  .strict();

/** Contenido por marca (F6, SRC-02 p. 7, RN-09). */
export function contenidosRouter(deps: Dependencias): Router {
  const router = Router();
  const auth = requireAuth(deps.tokenVerifier, deps.perfiles);
  const admin = [auth, requireRole("administrador")];
  const cliente = [auth, requireRole("cliente")];

  router.get("/contenidos", ...cliente, async (req, res) => {
    const q = validar(
      z.object({
        marca: z.enum(MARCAS).optional(),
        destacadas: z
          .enum(["true", "false"])
          .transform((v) => v === "true")
          .optional(),
        limite: z.coerce.number().int().min(1).max(50).default(20),
      }),
      req.query,
    );
    if (q.marca && !req.auth!.marcas.includes(q.marca)) {
      throw new AppError(403, "FORBIDDEN", "No tienes esa marca vinculada.");
    }
    res.set("Cache-Control", "no-store").json({
      items: await contenidosCliente(
        deps.almacen,
        req.auth!.marcas,
        deps.reloj(),
        q,
      ),
    });
  });

  router.get("/admin/contenidos", ...admin, async (req, res) => {
    const q = validar(
      z.object({ marca: z.enum(MARCAS).optional() }),
      req.query,
    );
    res.set("Cache-Control", "no-store").json({
      items: await listarContenidosAdmin(deps.almacen, deps.reloj(), q.marca),
    });
  });

  router.post("/admin/contenidos", ...admin, async (req, res) => {
    const datos = validar(esquemaPublicacion, req.body);
    res
      .status(201)
      .json(
        await crearContenido(deps.almacen, datos, req.auth!.uid, deps.reloj()),
      );
  });

  router.put("/admin/contenidos/:id", ...admin, async (req, res) => {
    const id = validar(idContenido, req.params.id);
    const datos = validar(esquemaPublicacion, req.body);
    res.json(
      await actualizarContenido(
        deps.almacen,
        id,
        datos,
        req.auth!.uid,
        deps.reloj(),
      ),
    );
  });

  router.patch("/admin/contenidos/:id", ...admin, async (req, res) => {
    const id = validar(idContenido, req.params.id);
    const { activa } = validar(
      z.object({ activa: z.boolean() }).strict(),
      req.body,
    );
    res.json(
      await actualizarContenido(
        deps.almacen,
        id,
        { activa },
        req.auth!.uid,
        deps.reloj(),
      ),
    );
  });

  router.delete("/admin/contenidos/:id", ...admin, async (req, res) => {
    const id = validar(idContenido, req.params.id);
    await eliminarContenido(deps.almacen, id, req.auth!.uid, deps.reloj());
    res.status(204).end();
  });

  return router;
}
