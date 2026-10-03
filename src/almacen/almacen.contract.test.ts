import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import type { Almacen } from "./almacen.js";
import { DocumentoExistenteError } from "./almacen.js";
import { crearAlmacenFirestore } from "./firestore.js";
import { crearAlmacenEnMemoria } from "./memoria.js";

function contrato(nombre: string, crear: () => Almacen) {
  describe(`Almacen · ${nombre}`, () => {
    let a: Almacen;
    beforeAll(() => {
      a = crear();
    });

    it("crea, lee y fija documentos en una transacción", async () => {
      await a.transaccion(async (tx) => {
        tx.crear("pruebas/uno", { n: 1 });
      });
      expect(await a.leer("pruebas/uno")).toEqual({ n: 1 });
      await a.transaccion(async (tx) => {
        const actual = await tx.leer<{ n: number }>("pruebas/uno");
        tx.fijar("pruebas/uno", { n: actual!.n + 1 });
      });
      expect(await a.leer("pruebas/uno")).toEqual({ n: 2 });
    });

    it("crear sobre un documento existente falla y no aplica nada", async () => {
      await expect(
        a.transaccion(async (tx) => {
          tx.fijar("pruebas/dos", { n: 1 });
          tx.crear("pruebas/uno", { n: 99 });
        }),
      ).rejects.toBeInstanceOf(DocumentoExistenteError);
      expect(await a.leer("pruebas/dos")).toBeNull();
      expect(await a.leer("pruebas/uno")).toEqual({ n: 2 });
    });

    it("un error dentro de la transacción no deja escrituras parciales", async () => {
      await expect(
        a.transaccion(async (tx) => {
          tx.fijar("pruebas/tres", { n: 3 });
          throw new Error("abortar");
        }),
      ).rejects.toThrow("abortar");
      expect(await a.leer("pruebas/tres")).toBeNull();
    });

    it("consulta con filtros, orden por id, cursor y límite", async () => {
      await a.transaccion(async (tx) => {
        for (const [id, n] of [
          ["c", 3],
          ["a", 1],
          ["d", 4],
          ["b", 2],
        ] as const) {
          tx.fijar(`lista/${id}`, { n, par: n % 2 === 0 });
        }
      });
      const primera = await a.consultar({
        coleccion: "lista",
        ordenId: "asc",
        limite: 2,
      });
      expect(primera.map((d) => d.id)).toEqual(["a", "b"]);
      const siguiente = await a.consultar({
        coleccion: "lista",
        ordenId: "asc",
        despuesDeId: "b",
        limite: 2,
      });
      expect(siguiente.map((d) => d.id)).toEqual(["c", "d"]);
      const pares = await a.consultar<{ n: number }>({
        coleccion: "lista",
        donde: [["par", "==", true]],
      });
      expect(pares.map((d) => d.datos.n).sort()).toEqual([2, 4]);
      const mayores = await a.consultar<{ n: number }>({
        coleccion: "lista",
        donde: [["n", ">", 2]],
      });
      expect(mayores.map((d) => d.datos.n).sort()).toEqual([3, 4]);
    });

    it("rechaza combinar rango con orden por id", async () => {
      await expect(
        a.consultar({
          coleccion: "lista",
          donde: [["n", ">", 1]],
          ordenId: "asc",
        }),
      ).rejects.toThrow(/rango/);
    });

    it("array-contains se combina con igualdades, orden por id y cursor", async () => {
      await a.transaccion(async (tx) => {
        tx.fijar("personas/p1", { rol: "c", marcas: ["zontes"], activo: true });
        tx.fijar("personas/p2", {
          rol: "c",
          marcas: ["kiden", "zontes"],
          activo: true,
        });
        tx.fijar("personas/p3", {
          rol: "c",
          marcas: ["zontes"],
          activo: false,
        });
        tx.fijar("personas/p4", { rol: "c", marcas: [], activo: true });
      });
      const ids = async (despuesDeId?: string) =>
        (
          await a.consultar({
            coleccion: "personas",
            donde: [
              ["rol", "==", "c"],
              ["activo", "==", true],
              ["marcas", "array-contains", "zontes"],
            ],
            ordenId: "asc",
            despuesDeId,
            limite: 1,
          })
        ).map((d) => d.id);
      expect(await ids()).toEqual(["p1"]);
      expect(await ids("p1")).toEqual(["p2"]);
      expect(await ids("p2")).toEqual([]);
      // Agregación de conteo con los mismos filtros, sin leer documentos.
      expect(
        await a.contar({
          coleccion: "personas",
          donde: [
            ["rol", "==", "c"],
            ["marcas", "array-contains", "zontes"],
          ],
        }),
      ).toBe(3);
      expect(await a.contar({ coleccion: "personas" })).toBe(4);
    });

    it("las subcolecciones no se mezclan con su colección padre", async () => {
      await a.transaccion(async (tx) => {
        tx.fijar("padres/p1", { x: 1 });
        tx.fijar("padres/p1/hijos/h1", { y: 1 });
      });
      expect(
        (await a.consultar({ coleccion: "padres" })).map((d) => d.id),
      ).toEqual(["p1"]);
      expect(
        (await a.consultar({ coleccion: "padres/p1/hijos" })).map((d) => d.id),
      ).toEqual(["h1"]);
    });
  });
}

contrato("memoria", crearAlmacenEnMemoria);

describe("Almacen en memoria · reglas de Firestore", () => {
  it("prohíbe leer después de escribir dentro de una transacción", async () => {
    const a = crearAlmacenEnMemoria();
    await expect(
      a.transaccion(async (tx) => {
        tx.fijar("x/1", {});
        await tx.leer("x/2");
      }),
    ).rejects.toThrow(/lectura después de escritura/);
  });
});

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · almacén", () => {
  const prefijo = `prueba_${Date.now().toString(36)}_`;
  const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));
  contrato("firestore", () => crearAlmacenFirestore(db(), prefijo));
  afterAll(async () => {
    for (const c of ["pruebas", "lista", "padres", "personas"]) {
      await db().recursiveDelete(db().collection(`${prefijo}${c}`));
    }
  });
});
