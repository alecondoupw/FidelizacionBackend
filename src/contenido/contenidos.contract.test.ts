import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Almacen } from "../almacen/almacen.js";
import { crearAlmacenFirestore } from "../almacen/firestore.js";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { loadConfig } from "../config/env.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { AppError } from "../http/errors.js";
import {
  actualizarContenido,
  contenidosCliente,
  crearContenido,
  eliminarContenido,
  estadoPublicacion,
  listarContenidosAdmin,
  type DatosPublicacion,
} from "./contenidos.js";

/**
 * Especificación de F6 (DEC-10, RN-09) sobre memoria y, con
 * FIRESTORE_INTEGRATION=1, sobre el proyecto de desarrollo.
 */
function especificacion(nombre: string, crear: () => Almacen) {
  describe(`Contenido por marca · ${nombre}`, () => {
    let a: Almacen;
    const ADMIN = "admin-1";
    // 3 oct 2026, 11:00 en Bolivia.
    const AHORA = new Date("2026-10-03T15:00:00.000Z");
    const pub = (extra: Partial<DatosPublicacion> = {}): DatosPublicacion => ({
      marca: "zontes",
      categoria: "noticia",
      titulo: "Nueva Zontes 350T",
      texto: "Conoce la nueva touring.",
      enlace: null,
      destacada: false,
      activa: true,
      publicarDesde: null,
      publicarHasta: null,
      ...extra,
    });
    const codigo = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        if (e instanceof AppError) return e.code;
        throw e;
      }
      return "OK";
    };

    beforeEach(() => {
      a = crear();
    });

    it("estado temporal en hora de Bolivia con ambos días incluidos", () => {
      const v = (desde: string | null, hasta: string | null, iso: string) =>
        estadoPublicacion(
          { publicarDesde: desde, publicarHasta: hasta },
          new Date(iso),
        );
      expect(v("2026-10-03", null, "2026-10-03T03:59:59.999Z")).toBe(
        "programada",
      );
      expect(v("2026-10-03", null, "2026-10-03T04:00:00.000Z")).toBe(
        "publicada",
      );
      expect(v(null, "2026-10-03", "2026-10-04T03:59:59.999Z")).toBe(
        "publicada",
      );
      expect(v(null, "2026-10-03", "2026-10-04T04:00:00.000Z")).toBe(
        "finalizada",
      );
      expect(v(null, null, "2030-01-01T00:00:00.000Z")).toBe("publicada");
    });

    it("crea, lista por marca y audita sin datos personales", async () => {
      const p = await crearContenido(a, pub(), ADMIN, AHORA);
      expect(p).toMatchObject({
        estado: "publicada",
        visible: true,
        actualizadoPor: ADMIN,
      });
      await crearContenido(
        a,
        pub({ marca: "kiden", titulo: "Kiden en ruta" }),
        ADMIN,
        AHORA,
      );
      expect(
        (await listarContenidosAdmin(a, AHORA, "zontes")).map((x) => x.titulo),
      ).toEqual(["Nueva Zontes 350T"]);
      expect(await listarContenidosAdmin(a, AHORA)).toHaveLength(2);
      const auditoria = await a.consultar({ coleccion: "auditoria" });
      expect(auditoria.map((d) => d.datos.accion)).toEqual([
        "contenido.creado",
        "contenido.creado",
      ]);
    });

    it("rechaza una ventana invertida o fechas inexistentes", async () => {
      expect(
        await codigo(
          crearContenido(
            a,
            pub({ publicarDesde: "2026-10-10", publicarHasta: "2026-10-01" }),
            ADMIN,
            AHORA,
          ),
        ),
      ).toBe("VALIDATION_ERROR");
      expect(
        await codigo(
          crearContenido(a, pub({ publicarDesde: "2026-02-30" }), ADMIN, AHORA),
        ),
      ).toBe("VALIDATION_ERROR");
      const p = await crearContenido(a, pub(), ADMIN, AHORA);
      expect(
        await codigo(
          actualizarContenido(
            a,
            p.id,
            { publicarDesde: "2026-11-01", publicarHasta: "2026-10-01" },
            ADMIN,
            AHORA,
          ),
        ),
      ).toBe("VALIDATION_ERROR");
    });

    it("el cliente sólo recibe publicaciones activas, vigentes y de sus marcas", async () => {
      await crearContenido(
        a,
        pub({
          titulo: "Vigente",
          destacada: true,
          publicarDesde: "2026-09-29",
        }),
        ADMIN,
        AHORA,
      );
      await crearContenido(
        a,
        pub({ titulo: "Inactiva", activa: false }),
        ADMIN,
        AHORA,
      );
      await crearContenido(
        a,
        pub({ titulo: "Programada", publicarDesde: "2026-10-12" }),
        ADMIN,
        AHORA,
      );
      await crearContenido(
        a,
        pub({ titulo: "Finalizada", publicarHasta: "2026-10-02" }),
        ADMIN,
        AHORA,
      );
      await crearContenido(
        a,
        pub({ titulo: "Otra marca", marca: "niu" }),
        ADMIN,
        AHORA,
      );
      await crearContenido(
        a,
        pub({
          titulo: "Kiden",
          marca: "kiden",
          categoria: "evento",
          publicarDesde: "2026-10-01",
        }),
        ADMIN,
        AHORA,
      );

      const todas = await contenidosCliente(a, ["zontes", "kiden"], AHORA, {
        limite: 20,
      });
      expect(todas.map((p) => p.titulo)).toEqual(["Kiden", "Vigente"]);
      expect(Object.keys(todas[0]!).sort()).toEqual(
        [
          "categoria",
          "destacada",
          "enlace",
          "id",
          "marca",
          "publicarDesde",
          "texto",
          "titulo",
        ].sort(),
      );
      const destacadas = await contenidosCliente(
        a,
        ["zontes", "kiden"],
        AHORA,
        { destacadas: true, limite: 20 },
      );
      expect(destacadas.map((p) => p.titulo)).toEqual(["Vigente"]);
      expect(
        (
          await contenidosCliente(a, ["zontes", "kiden"], AHORA, {
            marca: "kiden",
            limite: 20,
          })
        ).map((p) => p.titulo),
      ).toEqual(["Kiden"]);
      // Sin marcas vinculadas no hay contenido.
      expect(await contenidosCliente(a, [], AHORA, { limite: 20 })).toEqual([]);
      // Al llegar la fecha, la programada aparece sin cambiar nada.
      const despues = await contenidosCliente(
        a,
        ["zontes"],
        new Date("2026-10-12T04:00:00.000Z"),
        { limite: 20 },
      );
      expect(despues.map((p) => p.titulo)).toContain("Programada");
    });

    it("activa, edita sólo lo que cambió y elimina con auditoría", async () => {
      const p = await crearContenido(a, pub({ activa: false }), ADMIN, AHORA);
      const activada = await actualizarContenido(
        a,
        p.id,
        { activa: true },
        ADMIN,
        AHORA,
      );
      expect(activada.visible).toBe(true);
      await actualizarContenido(a, p.id, { activa: true }, ADMIN, AHORA); // sin cambios
      await actualizarContenido(
        a,
        p.id,
        { ...pub(), titulo: "Título nuevo" },
        ADMIN,
        AHORA,
      );
      await eliminarContenido(a, p.id, ADMIN, AHORA);
      expect(await codigo(eliminarContenido(a, p.id, ADMIN, AHORA))).toBe(
        "NOT_FOUND",
      );
      expect(
        await codigo(
          actualizarContenido(a, p.id, { activa: false }, ADMIN, AHORA),
        ),
      ).toBe("NOT_FOUND");
      const eventos = (await a.consultar({ coleccion: "auditoria" })).map(
        (d) => d.datos,
      );
      expect(
        eventos.map((e) => [
          e.accion,
          (e.datos as { campos?: string[] }).campos,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["contenido.creado", undefined],
          ["contenido.actualizado", ["activa"]],
          ["contenido.actualizado", ["titulo"]],
          ["contenido.eliminado", undefined],
        ]),
      );
      expect(eventos).toHaveLength(4);
    });
  });
}

especificacion("memoria", crearAlmacenEnMemoria);

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · contenido", () => {
  const prefijos: string[] = [];
  const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));
  especificacion("firestore", () => {
    const prefijo = `prueba_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}_`;
    prefijos.push(prefijo);
    return crearAlmacenFirestore(db(), prefijo);
  });
  afterAll(async () => {
    for (const p of prefijos) {
      for (const c of ["contenidos", "auditoria"]) {
        await db().recursiveDelete(db().collection(`${p}${c}`));
      }
    }
  }, 120_000);
});
