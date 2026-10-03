import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.js";
import type { EventoAuditoria, Perfil } from "../dominio/tipos.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { crearPerfilesEnMemoria, type PerfilRepository } from "./perfiles.js";
import { crearAlmacenFirestore } from "../almacen/firestore.js";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { crearPerfilesAlmacen } from "./perfiles-almacen.js";

/**
 * Mismo contrato para la implementación en memoria (pruebas) y la de Firestore.
 * La de Firestore usa el proyecto de desarrollo (DEC-02) con un prefijo de
 * colecciones único y datos sintéticos, y se borra al terminar:
 *   FIRESTORE_INTEGRATION=1 npm run test:firebase
 */
function contrato(nombre: string, crear: () => PerfilRepository) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const perfil = (sufijo: string, extra: Partial<Perfil> = {}): Perfil => ({
    uid: `u-${id}-${sufijo}`,
    correo: `${sufijo}.${id}@ejemplo.test`,
    rol: "cliente",
    activo: true,
    marcas: ["zontes"],
    vinculo: "vinculado",
    creadoEn: "2026-10-03T12:00:00.000Z",
    ...extra,
  });
  const evento = (uid: string): EventoAuditoria => ({
    accion: "cliente.registrado",
    actor: uid,
    objetivoUid: uid,
    en: "2026-10-03T12:00:00.000Z",
    datos: {},
  });

  describe(`PerfilRepository · ${nombre}`, () => {
    let repo: PerfilRepository;
    beforeAll(() => {
      repo = crear();
    });

    it("registra y recupera el mismo perfil", async () => {
      const p = perfil("a");
      expect(await repo.registrar(p, evento(p.uid))).toBe("creado");
      expect(await repo.obtener(p.uid)).toEqual(p);
    });

    it("uid repetido → uid_existente", async () => {
      const p = perfil("b");
      await repo.registrar(p, evento(p.uid));
      expect(
        await repo.registrar(
          { ...p, correo: `otro.${id}@ejemplo.test` },
          evento(p.uid),
        ),
      ).toBe("uid_existente");
    });

    it("correo repetido con otro uid → correo_existente, sin crear el segundo perfil", async () => {
      const p = perfil("c");
      await repo.registrar(p, evento(p.uid));
      const otro = { ...p, uid: `${p.uid}-2` };
      expect(await repo.registrar(otro, evento(otro.uid))).toBe(
        "correo_existente",
      );
      expect(await repo.obtener(otro.uid)).toBeNull();
    });

    it("hayAdministradorActivo sólo cuenta administradores activos", async () => {
      const inactivo = perfil("d", { rol: "administrador", activo: false });
      await repo.registrar(inactivo, evento(inactivo.uid));
      const antes = await repo.hayAdministradorActivo();
      const activo = perfil("e", { rol: "administrador" });
      await repo.registrar(activo, evento(activo.uid));
      expect(await repo.hayAdministradorActivo()).toBe(true);
      if (nombre !== "firestore") expect(antes).toBe(false);
    });

    it("uid inexistente → null", async () => {
      expect(await repo.obtener(`u-${id}-nadie`)).toBeNull();
    });
  });
}

contrato("memoria", crearPerfilesEnMemoria);
contrato("almacén en memoria", () =>
  crearPerfilesAlmacen(crearAlmacenEnMemoria()),
);

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)(
  "integración Firestore (proyecto de desarrollo)",
  () => {
    const prefijo = `prueba_${Date.now().toString(36)}_`;
    const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));

    contrato("firestore", () =>
      crearPerfilesAlmacen(crearAlmacenFirestore(db(), prefijo)),
    );

    afterAll(async () => {
      for (const nombre of ["usuarios", "correos", "auditoria"]) {
        await db().recursiveDelete(db().collection(`${prefijo}${nombre}`));
      }
    });
  },
);
