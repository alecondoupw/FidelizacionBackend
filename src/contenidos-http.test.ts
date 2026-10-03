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

async function montar() {
  const almacen = crearAlmacenEnMemoria();
  const cuentas = crearCuentasEnMemoria();
  const uids: Record<string, string> = {};
  for (const [n, rol, marcas] of [
    ["admin", "administrador", []],
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
  const como =
    (quien: string) =>
    (m: "get" | "post" | "put" | "patch" | "delete", ruta: string) =>
      request(app)
        [m](`${API_PREFIX}${ruta}`)
        .set("Authorization", `Bearer tok-${uids[quien]}`);
  return { como };
}

let ctx: Awaited<ReturnType<typeof montar>>;
beforeEach(async () => {
  ctx = await montar();
});
const pub = {
  marca: "zontes",
  categoria: "evento",
  titulo: "Rodada Zontes Adventure",
  texto: "Ruta La Paz – Coroico.",
  enlace: "https://ejemplo.test/rodada",
  destacada: true,
  activa: true,
  publicarDesde: "2026-09-29",
  publicarHasta: "2026-10-27",
};

describe("F6 · contenido por marca", () => {
  it("un cliente no gestiona contenido y un admin no usa la vista de cliente", async () => {
    const cliente = ctx.como("ana");
    for (const [m, ruta] of [
      ["get", "/admin/contenidos"],
      ["post", "/admin/contenidos"],
      ["put", "/admin/contenidos/x"],
      ["patch", "/admin/contenidos/x"],
      ["delete", "/admin/contenidos/x"],
    ] as const) {
      expect((await cliente(m, ruta).send(pub)).status, `${m} ${ruta}`).toBe(
        403,
      );
    }
    expect((await ctx.como("admin")("get", "/contenidos")).status).toBe(403);
  });

  it("valida el cuerpo: campos extra, enlace no https, categoría y fechas", async () => {
    const admin = ctx.como("admin");
    for (const cuerpo of [
      { ...pub, imagen: "foto.jpg" },
      { ...pub, enlace: "http://ejemplo.test" },
      { ...pub, enlace: "javascript:alert(1)" },
      { ...pub, categoria: "banner" },
      { ...pub, publicarDesde: "03/10/2026" },
      { ...pub, titulo: "ab" },
      { ...pub, publicarDesde: "2026-10-10", publicarHasta: "2026-10-01" },
    ]) {
      const res = await admin("post", "/admin/contenidos").send(cuerpo);
      expect(
        [res.status, res.body.error?.code],
        JSON.stringify(cuerpo),
      ).toEqual([422, "VALIDATION_ERROR"]);
    }
  });

  it("crea, el cliente la ve en su marca, se desactiva y desaparece", async () => {
    const admin = ctx.como("admin");
    const cliente = ctx.como("ana");
    const creada = await admin("post", "/admin/contenidos").send(pub);
    expect(creada.status).toBe(201);
    expect(creada.body).toMatchObject({ estado: "publicada", visible: true });
    await admin("post", "/admin/contenidos").send({
      ...pub,
      marca: "niu",
      titulo: "Sólo NIU",
    });

    const visto = await cliente("get", "/contenidos?destacadas=true");
    expect(visto.body.items.map((p: { titulo: string }) => p.titulo)).toEqual([
      "Rodada Zontes Adventure",
    ]);
    expect((await cliente("get", "/contenidos?marca=niu")).status).toBe(403);

    expect(
      (
        await admin("patch", `/admin/contenidos/${creada.body.id}`).send({
          activa: false,
        })
      ).body.visible,
    ).toBe(false);
    expect((await cliente("get", "/contenidos")).body.items).toEqual([]);
    expect(
      (
        await admin("patch", `/admin/contenidos/${creada.body.id}`).send({
          activa: false,
          titulo: "x",
        })
      ).status,
    ).toBe(422);
    expect(
      (await admin("delete", `/admin/contenidos/${creada.body.id}`)).status,
    ).toBe(204);
    expect(
      (await admin("get", "/admin/contenidos?marca=zontes")).body.items,
    ).toEqual([]);
  });
});
