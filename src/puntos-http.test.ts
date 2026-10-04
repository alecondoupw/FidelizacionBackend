import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { crearAlmacenEnMemoria } from "./almacen/memoria.js";
import { API_PREFIX, createApp } from "./app.js";
import { hashClave } from "./auth/integracion.js";
import {
  TokenInvalidoError,
  type TokenVerifier,
} from "./auth/token-verifier.js";
import { loadConfig } from "./config/env.js";
import type { Perfil } from "./dominio/tipos.js";
import { crearCuentasEnMemoria } from "./identidad/cuentas.js";
import { crearFuenteSintetica } from "./legacy/fuente-legacy.js";
import { R } from "./puntos/rutas.js";
import { huellaCorreo } from "./usuarios/correo.js";
import { crearPerfilesEnMemoria } from "./usuarios/perfiles.js";

const CLAVE = "clave-de-prueba-facturacion-0123456789";
const AHORA = new Date("2026-10-03T15:00:00.000Z");

const perfiles: Perfil[] = [
  {
    uid: "u-admin",
    correo: "admin@ejemplo.test",
    rol: "administrador",
    activo: true,
    marcas: [],
    vinculo: "no_vinculado",
    creadoEn: "",
  },
  {
    uid: "u-ana",
    correo: "ana@ejemplo.test",
    rol: "cliente",
    activo: true,
    marcas: ["zontes"],
    vinculo: "vinculado",
    creadoEn: "",
  },
];
const verifier: TokenVerifier = {
  async verificar(t) {
    const p = perfiles.find((x) => `tok-${x.uid}` === t);
    if (!p) throw new TokenInvalidoError("auth/argument-error");
    return { uid: p.uid, correo: p.correo, correoVerificado: true };
  },
};

async function montar(env: Record<string, string> = {}) {
  const repo = crearPerfilesEnMemoria();
  const almacen = crearAlmacenEnMemoria();
  for (const p of perfiles) {
    await repo.registrar(p, {
      accion: "cliente.registrado",
      actor: p.uid,
      objetivoUid: p.uid,
      en: "",
      datos: {},
    });
    await almacen.transaccion(async (tx) => {
      const { uid, ...datos } = p;
      tx.fijar(R.usuario(uid), datos);
      tx.fijar(R.correo(huellaCorreo(p.correo)), { uid });
    });
  }
  const config = loadConfig({ NODE_ENV: "test", ...env });
  return createApp(config, {
    tokenVerifier: verifier,
    perfiles: repo,
    cuentas: crearCuentasEnMemoria(),
    fuenteLegacy: crearFuenteSintetica(),
    almacen,
    reloj: () => AHORA,
  });
}

let app: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  app = await montar({
    INTEGRACION_CLAVES: `facturacion:${hashClave(CLAVE).toString("hex")}`,
  });
});

const admin = (m: "get" | "post" | "patch" | "put" | "delete", ruta: string) =>
  request(app)
    [m](`${API_PREFIX}${ruta}`)
    .set("Authorization", "Bearer tok-u-admin");
const cliente = (m: "get" | "post", ruta: string) =>
  request(app)
    [m](`${API_PREFIX}${ruta}`)
    .set("Authorization", "Bearer tok-u-ana");
const regla = { marca: "zontes", evento: "compra", puntos: 100, activa: true };

describe("F2 · rutas de administración", () => {
  it("un cliente no accede a ninguna ruta /admin", async () => {
    for (const [m, ruta] of [
      ["get", "/admin/reglas"],
      ["post", "/admin/asignaciones"],
    ] as const) {
      const res = await cliente(m === "get" ? "get" : "post", ruta).send({});
      expect(res.status).toBe(403);
    }
  });

  it("valida reglas: sin negativos, sin decimales, sin campo condición", async () => {
    for (const cuerpo of [
      { ...regla, puntos: -5 },
      { ...regla, puntos: 10.5 },
      { ...regla, condicion: "monto > 100" },
      { ...regla, evento: "cumpleanos" },
      { marca: "zontes" },
    ]) {
      const res = await admin("post", "/admin/reglas").send(cuerpo);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(res.body.error.details)).toBe(true);
    }
  });

  it("crea, filtra, edita y elimina reglas", async () => {
    expect((await admin("post", "/admin/reglas").send(regla)).status).toBe(201);
    expect(
      (await admin("post", "/admin/reglas").send(regla)).body.error.code,
    ).toBe("RULE_EXISTS");
    await admin("post", "/admin/reglas").send({
      ...regla,
      marca: "kiden",
      activa: false,
    });
    const activas = await admin("get", "/admin/reglas?activa=true");
    expect(activas.body.items.map((r: { id: string }) => r.id)).toEqual([
      "zontes__compra",
    ]);
    const editada = await admin("patch", "/admin/reglas/zontes__compra").send({
      puntos: 150,
    });
    expect(editada.body).toMatchObject({
      puntos: 150,
      actualizadoPor: "u-admin",
    });
    expect(
      (await admin("patch", "/admin/reglas/zontes__compra").send({})).status,
    ).toBe(422);
    expect((await admin("delete", "/admin/reglas/zontes__compra")).status).toBe(
      204,
    );
    expect((await admin("delete", "/admin/reglas/zontes__compra")).status).toBe(
      404,
    );
  });

  it("las rutas retiradas en F8 ya no existen (DEC-18/19)", async () => {
    for (const [m, ruta] of [
      ["post", "/admin/eventos"],
      ["post", "/admin/ajustes"],
      ["get", "/admin/vigencias"],
      ["put", "/admin/vigencias/zontes"],
      ["get", "/admin/vigencias/zontes/historial"],
      ["post", "/admin/vencimientos/procesar"],
      ["get", "/admin/reportes/tendencias"],
    ] as const) {
      const res = await admin(m, ruta).send({});
      expect([ruta, res.status]).toEqual([ruta, 404]);
    }
  });

  it("asignaciones: sólo suma, con motivo y vencimiento propio; 201 y 200 al repetir", async () => {
    const base = {
      idSolicitud: "panel-0001-abcd",
      marca: "zontes",
      correoCliente: " ANA@ejemplo.test ",
      puntos: 50,
      motivo: "Compra en tienda",
      vence: "2026-10-31",
    };
    for (const cambio of [
      { puntos: 0 },
      { puntos: -10 },
      { puntos: 1.5 },
      { motivo: "x" },
      { vence: undefined },
      { vence: "31/10/2026" },
      { vence: "2026-10-02" }, // ayer en Bolivia
      { vence: "2028-10-04" }, // más de 2 años
      { evento: "compra" },
    ]) {
      const res = await admin("post", "/admin/asignaciones").send({
        ...base,
        ...cambio,
      });
      expect([cambio, res.status, res.body.error?.code]).toEqual([
        cambio,
        422,
        "VALIDATION_ERROR",
      ]);
    }
    const r1 = await admin("post", "/admin/asignaciones").send(base);
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({
      movimientoId: expect.any(String),
      puntos: 50,
      venceEn: "2026-11-01T03:59:59.999Z",
      disponible: 50,
      repetido: false,
    });
    const r2 = await admin("post", "/admin/asignaciones").send(base);
    expect(r2.status).toBe(200);
    expect(r2.body.repetido).toBe(true);
    const hoy = await admin("post", "/admin/asignaciones").send({
      ...base,
      idSolicitud: "panel-0002-abcd",
      vence: "2026-10-03",
    });
    expect(hoy.status).toBe(201);
    const saldo = await cliente("get", "/me/saldo");
    expect(saldo.body.marcas[0]).toMatchObject({
      disponible: 100,
      proximoVencimiento: { fecha: "2026-10-04T03:59:59.999Z", puntos: 50 },
    });
    expect(
      (
        await admin("post", "/admin/asignaciones").send({
          ...base,
          idSolicitud: "panel-0003-abcd",
          marca: "kiden",
        })
      ).body.error.code,
    ).toBe("BRAND_NOT_LINKED");
  });
});

describe("F2 · API de integración (DEC-05)", () => {
  const cuerpo = {
    idExterno: "FAC-2026-000123",
    evento: "compra",
    marca: "zontes",
    correoCliente: "ana@ejemplo.test",
    vence: "2026-12-31",
  };

  it("sin claves configuradas responde 503", async () => {
    const sin = await montar();
    const res = await request(sin)
      .post(`${API_PREFIX}/integracion/eventos`)
      .set("X-Api-Key", CLAVE)
      .send(cuerpo);
    expect(res.status).toBe(503);
  });

  it("sin clave o con clave inválida → 401", async () => {
    expect(
      (
        await request(app)
          .post(`${API_PREFIX}/integracion/eventos`)
          .send(cuerpo)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(`${API_PREFIX}/integracion/eventos`)
          .set("X-Api-Key", "otra")
          .send(cuerpo)
      ).status,
    ).toBe(401);
  });

  it("un token de usuario no sirve como clave de integración", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/integracion/eventos`)
      .set("Authorization", "Bearer tok-u-admin")
      .send(cuerpo);
    expect(res.status).toBe(401);
  });

  it("clave válida registra el evento una sola vez", async () => {
    await admin("post", "/admin/reglas").send(regla);
    const r1 = await request(app)
      .post(`${API_PREFIX}/integracion/eventos`)
      .set("X-Api-Key", CLAVE)
      .send(cuerpo);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ resultado: "otorgado", puntos: 100 });
    const r2 = await request(app)
      .post(`${API_PREFIX}/integracion/eventos`)
      .set("X-Api-Key", CLAVE)
      .send(cuerpo);
    expect(r2.status).toBe(200);
    expect(r2.body.repetido).toBe(true);
    const saldo = await cliente("get", "/me/saldo");
    expect(saldo.body.total).toBe(100);
  });

  it("cada evento debe indicar su vencimiento (DEC-18)", async () => {
    const sinFecha = { ...cuerpo, vence: undefined };
    const res = await request(app)
      .post(`${API_PREFIX}/integracion/eventos`)
      .set("X-Api-Key", CLAVE)
      .send(sinFecha);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].campo).toBe("vence");
  });
});

describe("F2 · rutas del cliente (I-04)", () => {
  it("saldo y movimientos sólo de sus marcas", async () => {
    const saldo = await cliente("get", "/me/saldo");
    expect(saldo.status).toBe(200);
    expect(saldo.body).toEqual({
      total: 0,
      marcas: [{ marca: "zontes", disponible: 0, proximoVencimiento: null }],
    });
    expect((await cliente("get", "/me/movimientos?marca=kiden")).status).toBe(
      403,
    );
    expect((await cliente("get", "/me/movimientos?limite=500")).status).toBe(
      422,
    );
    expect((await cliente("get", "/me/movimientos?cursor=../x")).status).toBe(
      422,
    );
    expect((await cliente("get", "/me/movimientos")).body).toEqual({
      items: [],
      siguiente: null,
    });
  });

  it("reglas activas sólo de sus marcas, sin datos internos (SRC-06 p. 5)", async () => {
    await admin("post", "/admin/reglas").send(regla);
    await admin("post", "/admin/reglas").send({
      ...regla,
      evento: "referido",
      activa: false,
    });
    await admin("post", "/admin/reglas").send({ ...regla, marca: "kiden" });
    const r = await cliente("get", "/reglas");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      items: [{ marca: "zontes", evento: "compra", puntos: 100 }],
    });
    expect((await admin("get", "/reglas")).status).toBe(403);
  });

  it("un administrador no tiene saldo de cliente", async () => {
    expect((await admin("get", "/me/saldo")).status).toBe(403);
  });
});
