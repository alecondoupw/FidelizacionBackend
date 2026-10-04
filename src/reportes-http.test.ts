import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { crearAlmacenEnMemoria } from "./almacen/memoria.js";
import { API_PREFIX, createApp } from "./app.js";
import {
  TokenInvalidoError,
  type TokenVerifier,
} from "./auth/token-verifier.js";
import { loadConfig } from "./config/env.js";
import { crearCuentasEnMemoria } from "./identidad/cuentas.js";
import { crearFuenteSintetica } from "./legacy/fuente-legacy.js";
import { idMovimiento } from "./puntos/fechas.js";
import { R } from "./puntos/rutas.js";
import { huellaCorreo } from "./usuarios/correo.js";
import { crearPerfilesAlmacen } from "./usuarios/perfiles-almacen.js";

const AHORA = new Date("2026-10-03T15:00:00.000Z");

async function montar() {
  const almacen = crearAlmacenEnMemoria();
  const cuentas = crearCuentasEnMemoria();
  const uids: Record<string, string> = {};
  for (const [n, rol] of [
    ["admin", "administrador"],
    ["ana", "cliente"],
  ] as const) {
    const correo = `${n}@ejemplo.test`;
    const { uid } = await cuentas.crear({ correo, nombre: n });
    uids[n] = uid;
    await almacen.transaccion(async (tx) => {
      tx.fijar(R.usuario(uid), {
        correo,
        rol,
        activo: true,
        marcas: rol === "cliente" ? ["zontes"] : [],
        vinculo: rol === "cliente" ? "vinculado" : "no_vinculado",
        creadoEn: "2026-09-10T15:00:00.000Z",
      });
      tx.fijar(R.correo(huellaCorreo(correo)), { uid });
    });
  }
  await almacen.transaccion(async (tx) => {
    const fecha = new Date("2026-09-12T15:00:00.000Z");
    tx.fijar(R.asiento(idMovimiento(fecha, 0, "prueba01")), {
      uid: uids.ana,
      marca: "zontes",
      tipo: "otorgamiento",
      puntos: 100,
      fecha: "2026-09-12T15:00:00.000Z",
      evento: "compra",
      origen: "panel",
      motivo: "=cmd|calc",
      actor: uids.admin,
    });
  });
  const verifier: TokenVerifier = {
    async verificar(t) {
      const c = cuentas.cuentas.get(t.replace("tok-", ""));
      if (!c) throw new TokenInvalidoError("auth/user-not-found");
      return {
        uid: c.uid,
        correo: c.correo ?? undefined,
        correoVerificado: true,
      };
    },
  };
  const app = createApp(loadConfig({ NODE_ENV: "test" }), {
    tokenVerifier: verifier,
    perfiles: crearPerfilesAlmacen(almacen),
    cuentas,
    fuenteLegacy: crearFuenteSintetica(),
    almacen,
    reloj: () => AHORA,
  });
  const como = (quien: string) => (ruta: string) =>
    request(app)
      .get(`${API_PREFIX}${ruta}`)
      .set("Authorization", `Bearer tok-${uids[quien]}`);
  return { almacen, como };
}

let ctx: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  ctx = await montar();
});

const SEP = "desde=2026-09-01&hasta=2026-09-30";

describe("F5 · frontera de autorización y validación", () => {
  it("un cliente recibe 403 en reportes, movimientos y exportaciones", async () => {
    const cliente = ctx.como("ana");
    for (const ruta of [
      "/admin/reportes/resumen",
      `/admin/reportes/actividad?${SEP}`,
      `/admin/reportes/canjes?${SEP}`,
      `/admin/movimientos?${SEP}`,
      `/admin/exportaciones/movimientos/vista-previa?${SEP}`,
      `/admin/exportaciones/movimientos?${SEP}`,
    ]) {
      expect((await cliente(ruta)).status, ruta).toBe(403);
    }
  });

  it("valida fechas, rango de 12 meses, métricas y tipos", async () => {
    const admin = ctx.como("admin");
    const casos: [string, string][] = [
      [
        "/admin/reportes/actividad?desde=2026-9-1&hasta=2026-09-30",
        "VALIDATION_ERROR",
      ],
      [
        "/admin/reportes/actividad?desde=2026-09-30&hasta=2026-09-01",
        "VALIDATION_ERROR",
      ],
      [
        "/admin/reportes/actividad?desde=2025-01-01&hasta=2026-09-30",
        "RANGE_TOO_LARGE",
      ],
      [`/admin/movimientos?${SEP}&tipo=regalo`, "VALIDATION_ERROR"],
      [`/admin/exportaciones/auditoria?${SEP}`, "VALIDATION_ERROR"],
      [
        `/admin/exportaciones/movimientos?${SEP}&formato=pdf`,
        "VALIDATION_ERROR",
      ],
      ["/admin/exportaciones/movimientos?formato=csv", "VALIDATION_ERROR"],
    ];
    for (const [ruta, code] of casos) {
      const res = await admin(ruta);
      expect([res.status, res.body.error?.code], ruta).toEqual([422, code]);
    }
  });
});

describe("F5 · reportes y exportaciones", () => {
  it("responde los reportes sin caché", async () => {
    const res = await ctx.como("admin")(`/admin/reportes/actividad?${SEP}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.puntosGenerados).toBe(100);
    const mov = await ctx.como("admin")(`/admin/movimientos?${SEP}`);
    expect(mov.body.items[0]).toMatchObject({
      cliente: { nombre: "ana", correo: "ana@ejemplo.test" },
      puntos: 100,
    });
  });

  it("vista previa y descarga CSV y Excel, auditadas con filtros y filas", async () => {
    const admin = ctx.como("admin");
    const previa = await admin(
      `/admin/exportaciones/movimientos/vista-previa?${SEP}&marca=zontes`,
    );
    expect(previa.body).toEqual({
      filas: 1,
      columnas: [
        "Fecha",
        "Cliente",
        "Correo",
        "Marca",
        "Tipo",
        "Evento",
        "Puntos",
        "Detalle",
      ],
      maximo: 10000,
    });

    const csv = await admin(
      `/admin/exportaciones/movimientos?${SEP}&marca=zontes`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toBe(
      'attachment; filename="movimientos-2026-09-01_2026-09-30.csv"',
    );
    // El motivo con «=» llega neutralizado.
    expect(csv.text).toContain(
      ";ana;ana@ejemplo.test;Zontes;Otorgamiento;Compra;100;'=cmd|calc",
    );

    const xlsx = await admin(`/admin/exportaciones/clientes?formato=xlsx`)
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on("data", (c: Buffer) => partes.push(c));
        res.on("end", () => cb(null, Buffer.concat(partes)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");

    const auditoria = (
      await ctx.almacen.consultar({ coleccion: "auditoria" })
    ).map((d) => d.datos);
    expect(auditoria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accion: "exportacion.generada",
          objetivo: "movimientos",
          datos: {
            formato: "csv",
            filas: 1,
            filtros: {
              desde: "2026-09-01",
              hasta: "2026-09-30",
              marca: "zontes",
            },
          },
        }),
        expect.objectContaining({
          accion: "exportacion.generada",
          objetivo: "clientes",
          datos: { formato: "xlsx", filas: 1, filtros: {} },
        }),
      ]),
    );
    expect(JSON.stringify(auditoria)).not.toContain("@");
  });
});
