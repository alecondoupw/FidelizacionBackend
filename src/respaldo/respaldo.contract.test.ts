import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import {
  coleccionesRaiz,
  comparar,
  contar,
  exportar,
  restaurar,
  RespaldoError,
} from "./respaldo.js";

/**
 * Simulacro de respaldo y restauración (DEC-13) contra el proyecto de
 * desarrollo, sólo con colecciones temporales prueba_*.
 */
const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · respaldo", () => {
  const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));
  const sufijo = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const origen = `prueba_${sufijo}o_`;
  const copia = `prueba_${sufijo}c_`;

  afterAll(async () => {
    for (const p of [origen, copia]) {
      for (const c of await coleccionesRaiz(db(), p)) {
        await db().recursiveDelete(c);
      }
    }
  }, 120_000);

  it("exporta, restaura en otro prefijo y el resultado coincide", async () => {
    const d = db();
    const cuando = new Timestamp(1_790_000_000, 987_654_321);
    await d
      .doc(`${origen}usuarios/u1`)
      .set({ rol: "cliente", marcas: ["niu"] });
    await d
      .doc(`${origen}usuarios/u1/marcas/niu`)
      .set({ saldo: 12, actualizado: cuando });
    await d
      .doc(`${origen}usuarios/u1/marcas/niu/movimientos/m1`)
      .set({ puntos: 12, detalle: { evento: "compra", tildes: "Ñandú" } });
    // Padre sin datos que sólo agrupa una subcolección.
    await d.doc(`${origen}usuarios/u2/canjes/c1`).set({ estado: "pendiente" });
    await d.doc(`${origen}libro/a1`).set({ puntos: 12, nulo: null });

    const respaldo = await exportar(d, { prefijo: origen });
    expect(contar(respaldo)).toEqual({ usuarios: 4, libro: 1 });
    expect(Object.keys(respaldo.colecciones)).toEqual(["libro", "usuarios"]);

    const r = await restaurar(d, respaldo, { prefijo: copia });
    expect(r.documentos).toBe(5);
    const restaurado = await exportar(d, { prefijo: copia });
    expect(comparar(respaldo, restaurado)).toEqual([]);
    // Firestore guarda microsegundos: se compara con lo guardado en el origen.
    const leer = async (p: string) =>
      (await d.doc(`${p}usuarios/u1/marcas/niu`).get()).get(
        "actualizado",
      ) as Timestamp;
    const guardado = await leer(origen);
    expect(guardado.toMillis()).toBe(cuando.toMillis());
    expect((await leer(copia)).isEqual(guardado)).toBe(true);

    // Un cambio en el destino se detecta.
    await d.doc(`${copia}libro/a1`).update({ puntos: 13 });
    await d.doc(`${copia}libro/a2`).set({ puntos: 1 });
    expect(comparar(respaldo, await exportar(d, { prefijo: copia }))).toEqual([
      { ruta: "libro/a1", tipo: "distinto" },
      { ruta: "libro/a2", tipo: "sobra" },
    ]);

    // Por defecto no escribe sobre colecciones con datos.
    await expect(restaurar(d, respaldo, { prefijo: copia })).rejects.toThrow(
      RespaldoError,
    );
  }, 120_000);
});
