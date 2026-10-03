import { beforeEach, describe, expect, it } from "vitest";
import { crearPerfilesEnMemoria } from "../usuarios/perfiles.js";
import {
  BootstrapRechazado,
  bootstrapAdministrador,
  type CuentasAuth,
} from "./bootstrap.js";

function crearCuentasFalsas() {
  const cuentas = new Map<string, string>();
  let siguiente = 1;
  const api: CuentasAuth & { creadas: string[] } = {
    creadas: [],
    async buscarPorCorreo(correo) {
      const uid = cuentas.get(correo);
      return uid ? { uid } : null;
    },
    async crear(correo) {
      const uid = `uid-${siguiente++}`;
      cuentas.set(correo, uid);
      api.creadas.push(correo);
      return { uid };
    },
    async enlaceDefinirContrasena(correo) {
      return `https://enlace.test/${encodeURIComponent(correo)}`;
    },
  };
  return { api, cuentas };
}

let perfiles: ReturnType<typeof crearPerfilesEnMemoria>;
let falsas: ReturnType<typeof crearCuentasFalsas>;
const reloj = () => new Date("2026-10-03T12:00:00.000Z");
const ejecutar = (correo: string) =>
  bootstrapAdministrador({ cuentas: falsas.api, perfiles, reloj }, correo);

beforeEach(() => {
  perfiles = crearPerfilesEnMemoria();
  falsas = crearCuentasFalsas();
});

describe("F1-BE-02 · bootstrap del administrador inicial", () => {
  it("crea cuenta, perfil administrador activo, auditoría y enlace", async () => {
    const r = await ejecutar("  Admin@Ejemplo.test ");
    expect(r).toEqual({
      estado: "creado",
      uid: "uid-1",
      enlace: "https://enlace.test/admin%40ejemplo.test",
    });
    expect(await perfiles.obtener("uid-1")).toMatchObject({
      rol: "administrador",
      activo: true,
      correo: "admin@ejemplo.test",
    });
    expect(perfiles.auditoria).toEqual([
      expect.objectContaining({
        accion: "administrador.bootstrap",
        actor: "bootstrap",
        objetivoUid: "uid-1",
      }),
    ]);
  });

  it("es idempotente: repetir con el mismo correo no duplica", async () => {
    await ejecutar("admin@ejemplo.test");
    const r = await ejecutar("admin@ejemplo.test");
    expect(r).toEqual({ estado: "ya_era_administrador", uid: "uid-1" });
    expect(falsas.api.creadas).toHaveLength(1);
    expect(perfiles.auditoria).toHaveLength(1);
  });

  it("se niega si ya existe otro administrador activo", async () => {
    await ejecutar("admin@ejemplo.test");
    await expect(ejecutar("otro@ejemplo.test")).rejects.toBeInstanceOf(
      BootstrapRechazado,
    );
    expect(falsas.api.creadas).toEqual(["admin@ejemplo.test"]);
  });

  it("nunca promueve a un cliente", async () => {
    falsas.cuentas.set("cliente@ejemplo.test", "u-cliente");
    await perfiles.registrar(
      {
        uid: "u-cliente",
        correo: "cliente@ejemplo.test",
        rol: "cliente",
        activo: true,
        marcas: [],
        vinculo: "no_vinculado",
        creadoEn: "",
      },
      {
        accion: "cliente.registrado",
        actor: "u-cliente",
        objetivoUid: "u-cliente",
        en: "",
        datos: {},
      },
    );
    await expect(ejecutar("cliente@ejemplo.test")).rejects.toThrow(/cliente/);
    expect((await perfiles.obtener("u-cliente"))?.rol).toBe("cliente");
  });

  it("reutiliza una cuenta de Firebase existente sin perfil", async () => {
    falsas.cuentas.set("admin@ejemplo.test", "u-existente");
    const r = await ejecutar("admin@ejemplo.test");
    expect(r).toMatchObject({ estado: "creado", uid: "u-existente" });
    expect(falsas.api.creadas).toHaveLength(0);
  });

  it("rechaza un correo inválido", async () => {
    await expect(ejecutar("no-es-correo")).rejects.toBeInstanceOf(
      BootstrapRechazado,
    );
  });
});
