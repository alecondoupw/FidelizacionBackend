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
import { crearFuenteImportacion } from "./importacion/importacion.js";
import { R } from "./puntos/rutas.js";
import { huellaCorreo } from "./usuarios/correo.js";
import { crearPerfilesAlmacen } from "./usuarios/perfiles-almacen.js";

const AHORA = new Date("2026-10-04T15:00:00.000Z");

async function montar() {
  const almacen = crearAlmacenEnMemoria();
  for (const [uid, rol, correo] of [
    ["u-admin", "administrador", "admin@ejemplo.test"],
    ["u-ana", "cliente", "ana@ejemplo.test"],
  ] as const) {
    await almacen.transaccion(async (tx) => {
      tx.fijar(R.usuario(uid), {
        correo,
        rol,
        activo: true,
        marcas: [],
        vinculo: "no_vinculado",
        creadoEn: "",
      });
      tx.fijar(R.correo(huellaCorreo(correo)), { uid });
    });
  }
  const verifier: TokenVerifier = {
    async verificar(t) {
      if (!t.startsWith("tok-"))
        throw new TokenInvalidoError("auth/argument-error");
      return { uid: t.slice(4), correo: undefined, correoVerificado: true };
    },
  };
  const app = createApp(loadConfig({ NODE_ENV: "test" }), {
    tokenVerifier: verifier,
    perfiles: crearPerfilesAlmacen(almacen),
    cuentas: crearCuentasEnMemoria(),
    fuenteLegacy: crearFuenteImportacion(almacen),
    almacen,
    reloj: () => AHORA,
  });
  return { app, almacen };
}

let ctx: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  ctx = await montar();
});
const como = (uid: string) => ({
  post: (ruta: string) =>
    request(ctx.app)
      .post(`${API_PREFIX}${ruta}`)
      .set("Authorization", `Bearer tok-${uid}`),
  get: (ruta: string) =>
    request(ctx.app)
      .get(`${API_PREFIX}${ruta}`)
      .set("Authorization", `Bearer tok-${uid}`),
});
const admin = como("u-admin");
const CSV = Buffer.from(
  "Nombre;Correo\r\nAna Pérez;ana@ejemplo.test\r\nCarla Ruiz;carla@ejemplo.test\r\nMal;x\r\n",
);

describe("F8 · rutas de importación (UI-23, A02)", () => {
  it("sólo administradores: un cliente recibe 403 en todas", async () => {
    const ana = como("u-ana");
    for (const r of [
      ana.post("/admin/importaciones/vista-previa?marca=zontes").send(CSV),
      ana.post(
        "/admin/importaciones?marca=zontes&archivo=a.csv&idImportacion=imp-00000001",
      ),
      ana.get("/admin/importaciones"),
      ana.get("/admin/importados"),
      ana.get("/admin/importaciones/imp-00000001/reporte"),
    ]) {
      expect((await r).status).toBe(403);
    }
  });

  it("vista previa con el archivo como cuerpo, sin escribir", async () => {
    const res = await admin
      .post("/admin/importaciones/vista-previa?marca=zontes")
      .set("Content-Type", "text/csv")
      .send(CSV);
    expect(res.status).toBe(200);
    expect(res.body.resumen).toMatchObject({
      filas: 3,
      importados: 2,
      vinculados: 1,
      pendientes: 1,
      errores: 1,
    });
    expect((await admin.get("/admin/importaciones")).body.items).toEqual([]);
    expect(
      (
        await admin
          .post("/admin/importaciones/vista-previa?marca=otra")
          .send(CSV)
      ).status,
    ).toBe(422);
    expect(
      (
        await admin
          .post("/admin/importaciones/vista-previa?marca=zontes")
          .set("Content-Type", "text/csv")
      ).status,
    ).toBe(422);
  });

  it("confirma 201, repite 200, lista, descarga el reporte y muestra pendientes", async () => {
    const ruta =
      "/admin/importaciones?marca=zontes&archivo=clientes.csv&idImportacion=imp-00000001";
    const r1 = await admin.post(ruta).set("Content-Type", "text/csv").send(CSV);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ id: "imp-00000001", repetido: false });
    const r2 = await admin.post(ruta).set("Content-Type", "text/csv").send(CSV);
    expect(r2.status).toBe(200);
    expect(r2.body.repetido).toBe(true);

    const lista = await admin.get("/admin/importaciones");
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0]).toMatchObject({
      marca: "zontes",
      archivo: "clientes.csv",
    });

    const csv = await admin.get("/admin/importaciones/imp-00000001/reporte");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toContain(
      "importacion-zontes-2026-10-04.csv",
    );
    const xlsx = await admin
      .get("/admin/importaciones/imp-00000001/reporte?formato=xlsx")
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on("data", (c: Buffer) => partes.push(c));
        res.on("end", () => cb(null, Buffer.concat(partes)));
      });
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");

    const pendientes = await admin.get("/admin/importados?marca=zontes");
    expect(
      pendientes.body.items.map((p: { correo: string }) => p.correo),
    ).toEqual(["carla@ejemplo.test"]);
    // El detalle del cliente vinculado muestra la marca importada.
    const detalle = await admin.get("/admin/clientes/u-ana");
    expect(detalle.body).toMatchObject({
      marcas: ["zontes"],
      vinculo: "vinculado",
      importadas: [{ marca: "zontes", nombre: "Ana Pérez" }],
    });
  });

  it("valida nombre de archivo, id y tamaño máximo", async () => {
    for (const q of [
      "marca=zontes&archivo=a.csv&idImportacion=x",
      "marca=zontes&archivo=..%2Fa.csv&idImportacion=imp-00000002",
      "marca=zontes&idImportacion=imp-00000002",
    ]) {
      expect(
        (await admin.post(`/admin/importaciones?${q}`).send(CSV)).status,
      ).toBe(422);
    }
    const grande = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    expect(
      (
        await admin
          .post("/admin/importaciones/vista-previa?marca=zontes")
          .set("Content-Type", "application/octet-stream")
          .send(grande)
      ).status,
    ).toBe(413);
  });
});
