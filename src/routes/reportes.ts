import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/authorization.js";
import { ESTADOS_CANJE } from "../canjes/tipos.js";
import type { Dependencias } from "../dependencias.js";
import { MARCAS } from "../dominio/tipos.js";
import { validar } from "../http/validar.js";
import { auditar } from "../puntos/auditoria.js";
import { EVENTOS } from "../puntos/tipos.js";
import {
  aCsv,
  aXlsx,
  FORMATOS,
  MAX_FILAS,
  seleccionar,
  TIPOS_EXPORTACION,
} from "../reportes/exportaciones.js";
import { periodo } from "../reportes/periodo.js";
import {
  listarLibro,
  METRICAS,
  reporteActividad,
  reporteCanjes,
  reporteTendencias,
  resumen,
} from "../reportes/reportes.js";

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa AAAA-MM-DD.");
const rango = { desde: fecha, hasta: fecha };
const marca = z.enum(MARCAS).optional();
const limite = z.coerce.number().int().min(1).max(100).default(20);
const cursor = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .optional();
const TIPOS_MOVIMIENTO = [
  "otorgamiento",
  "ajuste",
  "canje",
  "vencimiento",
] as const;
const booleano = z.enum(["true", "false"]).transform((v) => v === "true");

/** Reportes, movimientos y exportaciones (F5, SRC-02 pp. 5–7, DEC-09). */
export function reportesRouter(deps: Dependencias): Router {
  const router = Router();
  const admin = [
    requireAuth(deps.tokenVerifier, deps.perfiles),
    requireRole("administrador"),
  ];
  const sinCache = { "Cache-Control": "no-store" };

  router.get("/admin/reportes/resumen", ...admin, async (_req, res) => {
    res.set(sinCache).json(await resumen(deps, deps.reloj()));
  });

  router.get("/admin/reportes/actividad", ...admin, async (req, res) => {
    const q = validar(z.object({ ...rango, marca }), req.query);
    res
      .set(sinCache)
      .json(await reporteActividad(deps, periodo(q.desde, q.hasta), q.marca));
  });

  router.get("/admin/reportes/tendencias", ...admin, async (req, res) => {
    const q = validar(
      z.object({ ...rango, marca, metrica: z.enum(METRICAS) }),
      req.query,
    );
    res
      .set(sinCache)
      .json(
        await reporteTendencias(
          deps,
          q.metrica,
          periodo(q.desde, q.hasta),
          q.marca,
        ),
      );
  });

  router.get("/admin/reportes/canjes", ...admin, async (req, res) => {
    const q = validar(
      z.object({
        ...rango,
        marca,
        estado: z.enum(ESTADOS_CANJE).optional(),
        correo: z.email().max(254).optional(),
        limite,
        cursor,
      }),
      req.query,
    );
    const { desde, hasta, ...filtros } = q;
    res
      .set(sinCache)
      .json(
        await reporteCanjes(deps, periodo(desde, hasta), filtros, deps.reloj()),
      );
  });

  router.get("/admin/movimientos", ...admin, async (req, res) => {
    const q = validar(
      z.object({
        ...rango,
        marca,
        tipo: z.enum(TIPOS_MOVIMIENTO).optional(),
        evento: z.enum(EVENTOS).optional(),
        limite,
        cursor,
      }),
      req.query,
    );
    const { desde, hasta, ...filtros } = q;
    res
      .set(sinCache)
      .json(await listarLibro(deps, periodo(desde, hasta), filtros));
  });

  // ── Exportaciones (A12, DEC-09) ──────────────────────────────────────
  const filtrosExportacion = z.object({
    desde: fecha.optional(),
    hasta: fecha.optional(),
    marca,
    activo: booleano.optional(),
    vinculo: z.enum(["vinculado", "no_vinculado"]).optional(),
    tipo: z.enum(TIPOS_MOVIMIENTO).optional(),
    evento: z.enum(EVENTOS).optional(),
    estado: z.enum(ESTADOS_CANJE).optional(),
  });
  const leerExportacion = (params: unknown, query: unknown) => {
    const { tipo } = validar(
      z.object({ tipo: z.enum(TIPOS_EXPORTACION) }),
      params,
    );
    const {
      desde,
      hasta,
      tipo: tipoMovimiento,
      ...resto
    } = validar(
      filtrosExportacion.extend({ formato: z.enum(FORMATOS).default("csv") }),
      query,
    );
    const p =
      desde && hasta
        ? periodo(desde, hasta)
        : desde || hasta
          ? periodo(desde ?? hasta!, hasta ?? desde!)
          : undefined;
    return {
      tipo,
      filtros: { ...resto, tipo: tipoMovimiento, periodo: p },
      registro: { desde, hasta, tipo: tipoMovimiento, ...resto },
    };
  };

  router.get(
    "/admin/exportaciones/:tipo/vista-previa",
    ...admin,
    async (req, res) => {
      const { tipo, filtros } = leerExportacion(req.params, req.query);
      const s = await seleccionar(deps, tipo, filtros, deps.reloj());
      res
        .set(sinCache)
        .json({ filas: s.filas, columnas: s.columnas, maximo: MAX_FILAS });
    },
  );

  router.get("/admin/exportaciones/:tipo", ...admin, async (req, res) => {
    const { tipo, filtros, registro } = leerExportacion(req.params, req.query);
    const { formato, ...filtrosAuditados } = registro;
    const ahora = deps.reloj();
    const s = await seleccionar(deps, tipo, filtros, ahora);
    const filas = await s.construir();
    const archivo =
      formato === "xlsx"
        ? await aXlsx(s.columnas, filas, tipo)
        : aCsv(s.columnas, filas);
    // Cada exportación queda en la auditoría con sus filtros y filas (DEC-09).
    await deps.almacen.transaccion(async (tx) => {
      auditar(tx, deps.almacen.nuevoId(), {
        accion: "exportacion.generada",
        actor: req.auth!.uid,
        objetivo: tipo,
        en: ahora.toISOString(),
        datos: {
          formato,
          filas: s.filas,
          filtros: Object.fromEntries(
            Object.entries(filtrosAuditados).filter(([, v]) => v !== undefined),
          ),
        },
      });
    });
    const sufijo = filtros.periodo
      ? `${filtros.periodo.desde}_${filtros.periodo.hasta}`
      : ahora.toISOString().slice(0, 10);
    res
      .set(sinCache)
      .type(
        formato === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
      )
      .attachment(`${tipo}-${sufijo}.${formato}`)
      .send(archivo);
  });

  return router;
}
