import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import {
  anularCanje,
  canjear,
  entregarCanje,
  listarCanjes,
  obtenerCanje,
} from "../canjes/canjes.js";
import {
  actualizarBeneficio,
  crearBeneficio,
  listarBeneficiosAdmin,
  listarCatalogo,
  obtenerBeneficioCliente,
} from "../canjes/catalogo.js";
import { generarComprobante } from "../canjes/comprobante.js";
import { CODIGO_VALIDO } from "../canjes/disponibilidad.js";
import { CATEGORIAS } from "../canjes/tipos.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { validar } from "../http/validar.js";

const marca = z.enum(MARCAS);
const codigo = z
  .string()
  .trim()
  .toUpperCase()
  .regex(CODIGO_VALIDO, "Código de canje inválido.");
const idBeneficio = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Entrada de administración de un beneficio (UI-25 propuesta, DEC-07). */
export const esquemaBeneficio = z
  .object({
    marca,
    nombre: z.string().trim().min(3).max(80),
    descripcion: z.string().trim().max(500).default(""),
    categoria: z.enum(CATEGORIAS),
    puntos: z.number().int().min(1).max(1_000_000),
    activo: z.boolean(),
    disponibleDesde: z.iso.datetime().nullable().default(null),
    vigenciaCuponDias: z.number().int().min(1).max(365),
    caracteristicas: z
      .array(z.string().trim().min(1).max(80))
      .max(10)
      .default([]),
    variantes: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z0-9-]{1,32}$/, "Usa minúsculas, dígitos y guiones."),
            nombre: z.string().trim().min(1).max(40),
            stock: z.number().int().min(0).max(1_000_000).nullable(),
          })
          .strict(),
      )
      .min(1, "Agrega al menos una opción.")
      .max(20),
  })
  .strict();

/** Catálogo y canjes del cliente (F3-BE-01/02/03) y gestión admin (DEC-07). */
export function canjesRouter(deps: Dependencias): Router {
  const router = Router();
  const cliente = [
    requireAuth(deps.tokenVerifier, deps.perfiles),
    requireRole("cliente"),
  ];

  router.get("/catalogo", ...cliente, async (req, res) => {
    const q = validar(
      z.object({
        marca: marca.optional(),
        categoria: z.enum(CATEGORIAS).optional(),
        q: z.string().max(80).optional(),
      }),
      req.query,
    );
    if (q.marca && !req.auth!.marcas.includes(q.marca)) {
      throw new AppError(403, "FORBIDDEN", "No tienes esa marca vinculada.");
    }
    const items = await listarCatalogo(
      deps.almacen,
      req.auth!.marcas,
      q,
      deps.reloj(),
    );
    res.set("Cache-Control", "no-store").json({ items });
  });

  router.get("/catalogo/:id", ...cliente, async (req, res) => {
    const id = validar(idBeneficio, req.params.id);
    res
      .set("Cache-Control", "no-store")
      .json(
        await obtenerBeneficioCliente(
          deps.almacen,
          id,
          req.auth!.marcas,
          deps.reloj(),
        ),
      );
  });

  router.post("/canjes", ...cliente, async (req, res) => {
    const datos = validar(
      z
        .object({
          beneficioId: idBeneficio,
          varianteId: z.string().regex(/^[a-z0-9-]{1,32}$/),
          idSolicitud: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
        })
        .strict(),
      req.body,
    );
    const r = await canjear(
      deps.almacen,
      { ...datos, uid: req.auth!.uid, marcasCliente: req.auth!.marcas },
      deps.reloj(),
    );
    res.status(r.repetido ? 200 : 201).json(r);
  });

  router.get("/me/canjes", ...cliente, async (req, res) => {
    const q = validar(
      z.object({
        marca: marca.optional(),
        limite: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .regex(/^[0-9A-Za-z-]{1,64}$/)
          .optional(),
      }),
      req.query,
    );
    res
      .set("Cache-Control", "no-store")
      .json(await listarCanjes(deps.almacen, req.auth!.uid, q, deps.reloj()));
  });

  router.get("/me/canjes/:codigo", ...cliente, async (req, res) => {
    const c = validar(codigo, req.params.codigo);
    const { vista } = await obtenerCanje(
      deps.almacen,
      c,
      deps.reloj(),
      req.auth!.uid,
    );
    res.set("Cache-Control", "no-store").json(vista);
  });

  router.get("/me/canjes/:codigo/comprobante", ...cliente, async (req, res) => {
    const c = validar(codigo, req.params.codigo);
    const ahora = deps.reloj();
    const { vista } = await obtenerCanje(deps.almacen, c, ahora, req.auth!.uid);
    const pdf = await generarComprobante(vista, ahora);
    res
      .set("Cache-Control", "no-store")
      .type("application/pdf")
      .attachment(`comprobante-${vista.codigo}.pdf`)
      .send(pdf);
  });

  /** QR del código en SVG para mostrarlo en pantalla (C04); sólo el propietario. */
  router.get("/me/canjes/:codigo/qr.svg", ...cliente, async (req, res) => {
    const c = validar(codigo, req.params.codigo);
    const { vista } = await obtenerCanje(
      deps.almacen,
      c,
      deps.reloj(),
      req.auth!.uid,
    );
    const svg = await QRCode.toString(vista.codigo, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
    });
    res.set("Cache-Control", "no-store").type("image/svg+xml").send(svg);
  });

  // ── Administración ──────────────────────────────────────────────────
  const admin = [
    requireAuth(deps.tokenVerifier, deps.perfiles),
    requireRole("administrador"),
  ];

  router.get("/admin/beneficios", ...admin, async (_req, res) => {
    res.json({ items: await listarBeneficiosAdmin(deps.almacen) });
  });

  router.post("/admin/beneficios", ...admin, async (req, res) => {
    const datos = validar(esquemaBeneficio, req.body);
    res
      .status(201)
      .json(
        await crearBeneficio(deps.almacen, datos, req.auth!.uid, deps.reloj()),
      );
  });

  router.put("/admin/beneficios/:id", ...admin, async (req, res) => {
    const id = validar(idBeneficio, req.params.id);
    const datos = validar(esquemaBeneficio, req.body);
    res.json(
      await actualizarBeneficio(
        deps.almacen,
        id,
        datos,
        req.auth!.uid,
        deps.reloj(),
      ),
    );
  });

  router.get("/admin/canjes/:codigo", ...admin, async (req, res) => {
    const c = validar(codigo, req.params.codigo);
    const { vista } = await obtenerCanje(deps.almacen, c, deps.reloj());
    res.set("Cache-Control", "no-store").json(vista);
  });

  router.post("/admin/canjes/:codigo/entregar", ...admin, async (req, res) => {
    const c = validar(codigo, req.params.codigo);
    res.json(await entregarCanje(deps.almacen, c, req.auth!.uid, deps.reloj()));
  });

  router.post("/admin/canjes/:codigo/anular", ...admin, async (req, res) => {
    const c = validar(codigo, req.params.codigo);
    const { motivo } = validar(
      z
        .object({
          motivo: z
            .string()
            .trim()
            .min(5, "Describe el motivo (mínimo 5 caracteres).")
            .max(300),
        })
        .strict(),
      req.body,
    );
    res.json(
      await anularCanje(deps.almacen, c, motivo, req.auth!.uid, deps.reloj()),
    );
  });

  return router;
}
