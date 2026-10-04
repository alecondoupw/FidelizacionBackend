import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { crearAlmacenEnMemoria } from "./almacen/memoria.js";
import { API_PREFIX, createApp } from "./app.js";
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
  {
    uid: "u-beto",
    correo: "beto@ejemplo.test",
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

const beneficio = {
  marca: "zontes",
  nombre: "Casco de prueba",
  descripcion: "Sólo para pruebas",
  categoria: "accesorios",
  puntos: 100,
  activo: true,
  disponibleDesde: null,
  vigenciaCuponDias: 10,
  caracteristicas: ["Dato de prueba"],
  variantes: [{ id: "m", nombre: "Talla M", stock: 2 }],
};

let app: ReturnType<typeof createApp>;
beforeEach(async () => {
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
  app = createApp(loadConfig({ NODE_ENV: "test" }), {
    tokenVerifier: verifier,
    perfiles: repo,
    cuentas: crearCuentasEnMemoria(),
    fuenteLegacy: crearFuenteSintetica(),
    almacen,
    reloj: () => AHORA,
  });
});

const como = (uid: string) => ({
  get: (r: string) =>
    request(app)
      .get(`${API_PREFIX}${r}`)
      .set("Authorization", `Bearer tok-${uid}`),
  post: (r: string) =>
    request(app)
      .post(`${API_PREFIX}${r}`)
      .set("Authorization", `Bearer tok-${uid}`),
  put: (r: string) =>
    request(app)
      .put(`${API_PREFIX}${r}`)
      .set("Authorization", `Bearer tok-${uid}`),
});
const admin = como("u-admin");
const ana = como("u-ana");
const beto = como("u-beto");

async function prepararCanje() {
  const b = await admin.post("/admin/beneficios").send(beneficio);
  await admin.post("/admin/asignaciones").send({
    idSolicitud: "asignacion-ana-0001",
    marca: "zontes",
    correoCliente: "ana@ejemplo.test",
    puntos: 150,
    motivo: "Compra en tienda",
    vence: "2027-10-03",
  });
  const c = await ana.post("/canjes").send({
    beneficioId: b.body.id,
    varianteId: "m",
    idSolicitud: "solicitud-0001",
  });
  return {
    beneficioId: b.body.id as string,
    codigo: c.body.canje.codigo as string,
    respuesta: c,
  };
}

describe("F3 · administración de beneficios (UI-25 propuesta)", () => {
  it("sólo administradores; validación estricta de beneficios", async () => {
    expect((await ana.get("/admin/beneficios")).status).toBe(403);
    for (const cuerpo of [
      { ...beneficio, puntos: 0 },
      { ...beneficio, variantes: [] },
      {
        ...beneficio,
        variantes: [{ id: "M mayúscula", nombre: "x", stock: 1 }],
      },
      { ...beneficio, categoria: "motos" },
      { ...beneficio, precio: 10 },
      { ...beneficio, vigenciaCuponDias: 400 },
    ]) {
      expect((await admin.post("/admin/beneficios").send(cuerpo)).status).toBe(
        422,
      );
    }
    const creado = await admin.post("/admin/beneficios").send(beneficio);
    expect(creado.status).toBe(201);
    const editado = await admin
      .put(`/admin/beneficios/${creado.body.id}`)
      .send({ ...beneficio, activo: false });
    expect(editado.body).toMatchObject({
      activo: false,
      actualizadoPor: "u-admin",
    });
  });
});

describe("F3 · catálogo y canje del cliente", () => {
  it("el administrador no usa rutas de cliente y el cliente no ve marcas ajenas", async () => {
    expect((await admin.get("/catalogo")).status).toBe(403);
    expect((await ana.get("/catalogo?marca=kiden")).status).toBe(403);
  });

  it("canje 201, repetición 200 y saldo actualizado", async () => {
    const { respuesta, beneficioId } = await prepararCanje();
    expect(respuesta.status).toBe(201);
    expect(respuesta.body).toMatchObject({
      disponible: 50,
      repetido: false,
      canje: { estado: "emitido", puntos: 100 },
    });
    const otra = await ana
      .post("/canjes")
      .send({ beneficioId, varianteId: "m", idSolicitud: "solicitud-0001" });
    expect(otra.status).toBe(200);
    expect(otra.body.repetido).toBe(true);
    expect((await ana.get("/me/saldo")).body.total).toBe(50);
  });

  it("valida la solicitud de canje", async () => {
    expect(
      (await ana.post("/canjes").send({ beneficioId: "x", varianteId: "m" }))
        .status,
    ).toBe(422);
    expect(
      (
        await ana.post("/canjes").send({
          beneficioId: "../x",
          varianteId: "m",
          idSolicitud: "solicitud-0002",
        })
      ).status,
    ).toBe(422);
  });

  it("el comprobante es un PDF descargable sólo por su propietario", async () => {
    const { codigo } = await prepararCanje();
    const pdf = await ana
      .get(`/me/canjes/${codigo}/comprobante`)
      .buffer(true)
      .parse((res, fin) => {
        const partes: Buffer[] = [];
        res.on("data", (p: Buffer) => partes.push(p));
        res.on("end", () => fin(null, Buffer.concat(partes)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain(
      `comprobante-${codigo}.pdf`,
    );
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await beto.get(`/me/canjes/${codigo}`)).status).toBe(404);
    expect((await beto.get(`/me/canjes/${codigo}/comprobante`)).status).toBe(
      404,
    );
    expect((await ana.get(`/me/canjes/${codigo.toLowerCase()}`)).status).toBe(
      200,
    );
    expect((await ana.get("/me/canjes/NO-ES-UN-CODIGO")).status).toBe(422);
    const qr = await ana.get(`/me/canjes/${codigo}/qr.svg`).buffer(true);
    expect(qr.status).toBe(200);
    expect(qr.headers["content-type"]).toContain("image/svg+xml");
    expect((await beto.get(`/me/canjes/${codigo}/qr.svg`)).status).toBe(404);
  });
});

describe("F3 · entrega y anulación por administración (DEC-07)", () => {
  it("anular exige motivo; un cliente no puede anular ni entregar", async () => {
    const { codigo } = await prepararCanje();
    expect(
      (
        await ana
          .post(`/admin/canjes/${codigo}/anular`)
          .send({ motivo: "Quiero mis puntos" })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin
          .post(`/admin/canjes/${codigo}/anular`)
          .send({ motivo: "no" })
      ).status,
    ).toBe(422);
    const r = await admin
      .post(`/admin/canjes/${codigo}/anular`)
      .send({ motivo: "Producto dañado" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      canje: { estado: "anulado" },
      disponible: 150,
    });
    expect(
      (await admin.post(`/admin/canjes/${codigo}/entregar`)).body.error.code,
    ).toBe("INVALID_STATE");
  });

  it("el administrador busca por código y entrega", async () => {
    const { codigo } = await prepararCanje();
    expect((await admin.get(`/admin/canjes/${codigo}`)).body.estado).toBe(
      "emitido",
    );
    expect(
      (await admin.post(`/admin/canjes/${codigo}/entregar`)).body.estado,
    ).toBe("entregado");
    expect((await ana.get(`/me/canjes/${codigo}`)).body.estado).toBe(
      "entregado",
    );
  });
});
