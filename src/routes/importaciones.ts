import express, { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { MAX_BYTES_IMPORTACION } from "../importacion/archivo.js";
import {
  confirmarImportacion,
  listarImportaciones,
  listarPendientes,
  reporteImportacion,
  vistaPrevia,
} from "../importacion/importacion.js";
import { AppError } from "../http/errors.js";
import { validar } from "../http/validar.js";

const marca = z.enum(MARCAS);
const archivo = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (s) => !/[/\\<>:"|?*]/.test(s) && [...s].every((c) => c >= " "),
    "Nombre de archivo inválido.",
  );
const idImportacion = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** El cuerpo es el archivo tal cual (CSV o XLSX), hasta 5 MB (DEC-17). */
const cuerpoArchivo = express.raw({
  type: () => true,
  limit: MAX_BYTES_IMPORTACION,
});
const archivoDe = (body: unknown) => {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Adjunta el archivo CSV o XLSX.",
    );
  }
  return body;
};

/** Importación y vinculación de clientes por marca (F8, SRC-06 pp. 1–2). */
export function importacionesRouter(deps: Dependencias): Router {
  const router = Router();
  const admin = [
    requireAuth(deps.tokenVerifier, deps.perfiles),
    requireRole("administrador"),
  ];
  const sinCache = { "Cache-Control": "no-store" };

  router.post(
    "/admin/importaciones/vista-previa",
    ...admin,
    cuerpoArchivo,
    async (req, res) => {
      const q = validar(z.object({ marca }), req.query);
      res
        .set(sinCache)
        .json(await vistaPrevia(deps.almacen, q.marca, archivoDe(req.body)));
    },
  );

  router.post(
    "/admin/importaciones",
    ...admin,
    cuerpoArchivo,
    async (req, res) => {
      const q = validar(z.object({ marca, archivo, idImportacion }), req.query);
      const r = await confirmarImportacion(
        deps.almacen,
        {
          idImportacion: q.idImportacion,
          marca: q.marca,
          archivo: q.archivo,
          datos: archivoDe(req.body),
          actor: req.auth!.uid,
        },
        deps.reloj(),
      );
      res.status(r.repetido ? 200 : 201).json(r);
    },
  );

  router.get("/admin/importaciones", ...admin, async (_req, res) => {
    res
      .set(sinCache)
      .json({ items: await listarImportaciones(deps.almacen, deps.reloj()) });
  });

  router.get("/admin/importaciones/:id/reporte", ...admin, async (req, res) => {
    const id = validar(idImportacion, req.params.id);
    const { formato } = validar(
      z.object({ formato: z.enum(["csv", "xlsx"]).default("csv") }),
      req.query,
    );
    const { lote, archivo: datos } = await reporteImportacion(
      deps.almacen,
      id,
      formato,
      deps.reloj(),
    );
    res
      .set(sinCache)
      .type(
        formato === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
      )
      .attachment(
        `importacion-${lote.marca}-${lote.creadoEn.slice(0, 10)}.${formato}`,
      )
      .send(datos);
  });

  /** Importados sin cuenta todavía: pendientes de registro y verificación. */
  router.get("/admin/importados", ...admin, async (req, res) => {
    const q = validar(
      z.object({
        marca: marca.optional(),
        correo: z.string().trim().pipe(z.email()).optional(),
        limite: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
      req.query,
    );
    res.set(sinCache).json(await listarPendientes(deps.almacen, q));
  });

  return router;
}
