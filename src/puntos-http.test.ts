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
      ["post", "/admin/eventos"],
      ["get", "/admin/vigencias"],
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

  it("vigencia: límite de 10 años e historial", async () => {
    expect(
      (
        await admin("put", "/admin/vigencias/zontes").send({
          activa: true,
          cantidad: 11,
          unidad: "anios",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin("put", "/admin/vigencias/otra").send({
          activa: true,
          cantidad: 1,
          unidad: "anios",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin("put", "/admin/vigencias/zontes").send({
          activa: true,
          cantidad: 6,
          unidad: "meses",
        })
      ).status,
    ).toBe(200);
    const h = await admin("get", "/admin/vigencias/zontes/historial");
    expect(h.body.items[0]).toMatchObject({
      actor: "u-admin",
      despues: { cantidad: 6, unidad: "meses" },
    });
  });

  it("registro manual de eventos: 201 la primera vez, 200 al repetir", async () => {
    await admin("post", "/admin/reglas").send(regla);
    const cuerpo = {
      idExterno: "panel-0001-abcd",
      evento: "compra",
      marca: "zontes",
      correoCliente: "ANA@ejemplo.test",
    };
    const r1 = await admin("post", "/admin/eventos").send(cuerpo);
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      resultado: "otorgado",
      puntos: 100,
      repetido: false,
    });
    const r2 = await admin("post", "/admin/eventos").send(cuerpo);
    expect(r2.status).toBe(200);
    expect(r2.body.repetido).toBe(true);
    expect(
      (
        await admin("post", "/admin/eventos").send({
          ...cuerpo,
          idExterno: "x",
        })
      ).status,
    ).toBe(422);
  });

  it("ajustes: motivo obligatorio, no cero y nunca saldo negativo", async () => {
    const base = {
      idExterno: "ajuste-0001-abcd",
      marca: "zontes",
      correoCliente: "ana@ejemplo.test",
    };
    expect(
      (
        await admin("post", "/admin/ajustes").send({
          ...base,
          puntos: 0,
          motivo: "Motivo válido",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin("post", "/admin/ajustes").send({
          ...base,
          puntos: 10,
          motivo: "x",
        })
      ).status,
    ).toBe(422);
    const r = await admin("post", "/admin/ajustes").send({
      ...base,
      puntos: -10,
      motivo: "Corrección",
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("INSUFFICIENT_BALANCE");
  });
});

describe("F2 · API de integración (DEC-05)", () => {
  const cuerpo = {
    idExterno: "FAC-2026-000123",
    evento: "compra",
    marca: "zontes",
    correoCliente: "ana@ejemplo.test",
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

  it("un administrador no tiene saldo de cliente", async () => {
    expect((await admin("get", "/me/saldo")).status).toBe(403);
  });
});
