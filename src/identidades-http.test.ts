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
import { R } from "./puntos/rutas.js";
import { huellaCorreo } from "./usuarios/correo.js";
import { crearPerfilesAlmacen } from "./usuarios/perfiles-almacen.js";

const AHORA = new Date("2026-10-03T15:00:00.000Z");

/** Perfiles y F4 sobre el mismo almacén, como en producción. */
async function montar() {
  const almacen = crearAlmacenEnMemoria();
  const cuentas = crearCuentasEnMemoria();
  const uids: Record<string, string> = {};
  for (const [n, rol, marcas] of [
    ["admin", "administrador", []],
    ["admin2", "administrador", []],
    ["ana", "cliente", ["zontes"]],
  ] as const) {
    const correo = `${n}@ejemplo.test`;
    const { uid } = await cuentas.crear({ correo, nombre: n });
    uids[n] = uid;
    await almacen.transaccion(async (tx) => {
      tx.fijar(R.usuario(uid), {
        correo,
        rol,
        activo: true,
        marcas: [...marcas],
        vinculo: marcas.length ? "vinculado" : "no_vinculado",
        creadoEn: AHORA.toISOString(),
      });
      tx.fijar(R.correo(huellaCorreo(correo)), { uid });
    });
  }
  // El token refleja lo que Firebase Auth sabe del correo en este momento.
  const verifier: TokenVerifier = {
    async verificar(t) {
      const c = cuentas.cuentas.get(t.replace("tok-", ""));
      if (!c) throw new TokenInvalidoError("auth/user-not-found");
      return {
        uid: c.uid,
        correo: c.correo ?? undefined,
        correoVerificado: c.correoVerificado,
      };
    },
  };
  for (const c of cuentas.cuentas.values()) c.correoVerificado = true;
  const app = createApp(loadConfig({ NODE_ENV: "test" }), {
    tokenVerifier: verifier,
    perfiles: crearPerfilesAlmacen(almacen),
    cuentas,
    fuenteLegacy: crearFuenteSintetica(),
    almacen,
    reloj: () => AHORA,
  });
  const como =
    (quien: string) => (m: "get" | "post" | "patch" | "delete", ruta: string) =>
      request(app)
        [m](`${API_PREFIX}${ruta}`)
        .set("Authorization", `Bearer tok-${uids[quien]}`);
  return { app, cuentas, uids, como };
}

let ctx: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  ctx = await montar();
});

describe("F4 · frontera de autorización", () => {
  it("un cliente recibe 403 en toda ruta de gestión de identidades", async () => {
    const cliente = ctx.como("ana");
    const admin2 = ctx.uids.admin2!;
    for (const [m, ruta] of [
      ["get", "/admin/administradores"],
      ["post", "/admin/administradores"],
      ["patch", `/admin/administradores/${admin2}`],
      ["delete", `/admin/administradores/${admin2}`],
      ["get", "/admin/clientes"],
      ["get", `/admin/clientes/${ctx.uids.ana}`],
      ["patch", `/admin/clientes/${ctx.uids.ana}`],
      ["delete", `/admin/clientes/${ctx.uids.ana}`],
      ["get", `/admin/auditoria?objetivo=${ctx.uids.ana}`],
    ] as const) {
      const res = await cliente(m, ruta).send({ activo: true });
      expect(res.status, `${m} ${ruta}`).toBe(403);
    }
    // Un cliente nunca se promueve: ni por su perfil ni creando un admin.
    expect(ctx.cuentas.cuentas.size).toBe(3);
  });

  it("sin token responde 401", async () => {
    const res = await request(ctx.app).get(`${API_PREFIX}/admin/clientes`);
    expect(res.status).toBe(401);
  });

  it("valida cuerpos estrictos: campos no permitidos, correo y nombre", async () => {
    const admin = ctx.como("admin");
    for (const [m, ruta, cuerpo] of [
      [
        "post",
        "/admin/administradores",
        { nombre: "A", apellido: "B", correo: "x@ejemplo.test" },
      ],
      [
        "post",
        "/admin/administradores",
        { nombre: "Ana", apellido: "Bo", correo: "no-es-correo" },
      ],
      [
        "post",
        "/admin/administradores",
        {
          nombre: "Ana",
          apellido: "Bo",
          correo: "a@ejemplo.test",
          rol: "administrador",
        },
      ],
      [
        "patch",
        `/admin/administradores/${ctx.uids.admin2}`,
        { correo: "nuevo@ejemplo.test" },
      ],
      ["patch", `/admin/clientes/${ctx.uids.ana}`, { rol: "administrador" }],
      ["patch", `/admin/clientes/${ctx.uids.ana}`, { marcas: ["kiden"] }],
      ["patch", "/me", { correo: "otro@ejemplo.test" }],
    ] as const) {
      const res = await admin(m, ruta).send(cuerpo);
      expect(res.status, JSON.stringify(cuerpo)).toBe(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("F4 · administradores", () => {
  it("crea por invitación, lista y elimina con confirmación del backend", async () => {
    const admin = ctx.como("admin");
    const creado = await admin("post", "/admin/administradores").send({
      nombre: "Rosa",
      apellido: "Pérez",
      correo: "Rosa@Ejemplo.test",
    });
    expect(creado.status).toBe(201);
    expect(creado.body).toMatchObject({
      nombre: "Rosa Pérez",
      correo: "rosa@ejemplo.test",
      invitacionPendiente: true,
    });
    const lista = await admin("get", "/admin/administradores");
    expect(lista.body.items).toHaveLength(3);

    expect(
      (await admin("delete", `/admin/administradores/${creado.body.uid}`))
        .status,
    ).toBe(204);
    expect(
      (await admin("get", "/admin/administradores")).body.items,
    ).toHaveLength(2);
  });

  it("rechaza desactivarse a sí mismo y dejar cero administradores activos", async () => {
    const admin = ctx.como("admin");
    const yo = await admin(
      "patch",
      `/admin/administradores/${ctx.uids.admin}`,
    ).send({
      activo: false,
    });
    expect([yo.status, yo.body.error.code]).toEqual([409, "SELF_ACTION"]);
    expect(
      (
        await admin("patch", `/admin/administradores/${ctx.uids.admin2}`).send({
          activo: false,
        })
      ).status,
    ).toBe(200);
    // admin2 desactivado ya no entra al panel.
    const fuera = await ctx.como("admin2")("get", "/admin/clientes");
    expect([fuera.status, fuera.body.error.code]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("F4 · clientes y perfil propio", () => {
  it("tras cambiar el correo el cliente debe verificarlo antes de seguir", async () => {
    const admin = ctx.como("admin");
    const ana = ctx.como("ana");
    expect((await ana("get", "/me")).status).toBe(200);

    const r = await admin("patch", `/admin/clientes/${ctx.uids.ana}`).send({
      correo: "cliente.kiden.niu@ejemplo.test",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      marcas: ["kiden", "niu"],
      vinculo: "vinculado",
      verificacionPendiente: true,
    });
    expect(ctx.cuentas.revocadas).toEqual([ctx.uids.ana]);

    const bloqueado = await ana("get", "/me");
    expect([bloqueado.status, bloqueado.body.error.code]).toEqual([
      403,
      "EMAIL_NOT_VERIFIED",
    ]);
    ctx.cuentas.cuentas.get(ctx.uids.ana!)!.correoVerificado = true;
    const me = await ana("get", "/me");
    expect(me.status).toBe(200);
    expect(me.body.marcas).toEqual(["kiden", "niu"]);
  });

  it("detalle con saldos e historial; filtros por query", async () => {
    const admin = ctx.como("admin");
    const d = await admin("get", `/admin/clientes/${ctx.uids.ana}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      nombre: "ana",
      saldos: [{ marca: "zontes", disponible: 0, vinculada: true }],
      historial: [],
    });
    const f = await admin(
      "get",
      "/admin/clientes?marca=zontes&activo=true&vinculo=vinculado&limite=5",
    );
    expect(f.body.items.map((c: { uid: string }) => c.uid)).toEqual([
      ctx.uids.ana,
    ]);
    expect((await admin("get", "/admin/clientes?activo=si")).status).toBe(422);
    expect((await admin("get", "/admin/clientes/no-existe")).status).toBe(404);
  });

  it("eliminar un cliente cierra su acceso y su correo puede registrarse de nuevo", async () => {
    const admin = ctx.como("admin");
    expect(
      (await admin("delete", `/admin/clientes/${ctx.uids.ana}`)).status,
    ).toBe(204);
    expect((await ctx.como("ana")("get", "/me")).status).toBe(401);
    const h = await admin("get", `/admin/auditoria?objetivo=${ctx.uids.ana}`);
    expect(h.body.items.map((e: { accion: string }) => e.accion)).toEqual([
      "cliente.eliminado",
    ]);
  });

  it("cada persona cambia sólo su propio nombre", async () => {
    const res = await ctx.como("ana")("patch", "/me").send({
      nombre: "  Ana María  ",
    });
    expect(res.status).toBe(204);
    expect(ctx.cuentas.cuentas.get(ctx.uids.ana!)?.nombre).toBe("Ana María");
    expect(ctx.cuentas.cuentas.get(ctx.uids.admin!)?.nombre).toBe("admin");
  });
});
