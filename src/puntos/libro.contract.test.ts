import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Almacen } from "../almacen/almacen.js";
import { crearAlmacenFirestore } from "../almacen/firestore.js";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { loadConfig } from "../config/env.js";
import type { Marca } from "../dominio/tipos.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { huellaCorreo } from "../usuarios/correo.js";
import {
  ajustarPuntos,
  consultarSaldo,
  listarMovimientos,
  procesarVencimientos,
  registrarEvento,
} from "./libro.js";
import {
  actualizarRegla,
  crearRegla,
  eliminarRegla,
  listarReglas,
} from "./reglas.js";
import { R } from "./rutas.js";
import type { Lote } from "./tipos.js";
import {
  actualizarVigencia,
  historialVigencia,
  listarVigencias,
} from "./vigencias.js";

/**
 * Especificación del motor de puntos (F2-BE-01/02/03) ejecutada sobre memoria
 * y, con FIRESTORE_INTEGRATION=1, sobre el proyecto de desarrollo (DEC-02).
 * Escenarios T-RULE, T-POINTS, T-HISTORY, T-EXP y T-BRAND de Testing.
 */
function especificacion(nombre: string, crear: () => Almacen) {
  describe(`Motor de puntos · ${nombre}`, () => {
    let a: Almacen;
    const run = Math.random().toString(36).slice(2, 8);
    const correo = (n: string) => `${n}.${run}@ejemplo.test`;
    const uid = (n: string) => `u-${run}-${n}`;
    const ADMIN = "admin-1";
    const t = (iso: string) => new Date(iso);

    async function sembrarCliente(n: string, marcas: Marca[], activo = true) {
      await a.transaccion(async (tx) => {
        tx.fijar(R.usuario(uid(n)), {
          correo: correo(n),
          rol: "cliente",
          activo,
          marcas,
          vinculo: "vinculado",
          creadoEn: "2026-01-01T00:00:00.000Z",
        });
        tx.fijar(R.correo(huellaCorreo(correo(n))), { uid: uid(n) });
      });
    }

    const evento = (
      n: string,
      idExterno: string,
      marca: Marca = "zontes",
      ev: "compra" | "referido" | "mantenimiento" | "asistencia" = "compra",
    ) => ({
      origen: "panel",
      idExterno: `${run}-${idExterno}`,
      evento: ev,
      marca,
      correoCliente: correo(n),
      actor: ADMIN,
    });

    async function sumaLotes(n: string, marca: Marca) {
      const lotes = await a.consultar<Lote>({
        coleccion: R.lotes(uid(n), marca),
      });
      return lotes.reduce((s, l) => s + l.datos.restante, 0);
    }

    beforeAll(async () => {
      a = crear();
      // Reglas compartidas por los escenarios.
      for (const r of await listarReglas(a))
        await eliminarRegla(a, r.id, ADMIN, t("2026-01-01T00:00:00Z"));
      await crearRegla(
        a,
        { marca: "zontes", evento: "compra", puntos: 100, activa: true },
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
      await crearRegla(
        a,
        { marca: "kiden", evento: "referido", puntos: 200, activa: true },
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
      await crearRegla(
        a,
        { marca: "niu", evento: "mantenimiento", puntos: 50, activa: false },
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
      await actualizarVigencia(
        a,
        "zontes",
        { activa: true, cantidad: 1, unidad: "meses" },
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
      await actualizarVigencia(
        a,
        "kiden",
        { activa: false, cantidad: 12, unidad: "meses" },
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
    });

    describe("F2-BE-01 · reglas (T-RULE)", () => {
      it("no permite dos reglas para la misma marca y evento", async () => {
        await expect(
          crearRegla(
            a,
            { marca: "zontes", evento: "compra", puntos: 1, activa: true },
            ADMIN,
            t("2026-01-02T00:00:00Z"),
          ),
        ).rejects.toMatchObject({ status: 409, code: "RULE_EXISTS" });
      });

      it("cambiar la marca a una combinación ocupada → 409 sin perder la original", async () => {
        await crearRegla(
          a,
          { marca: "niu", evento: "compra", puntos: 10, activa: true },
          ADMIN,
          t("2026-01-02T00:00:00Z"),
        );
        await expect(
          actualizarRegla(
            a,
            "niu__compra",
            { marca: "zontes" },
            ADMIN,
            t("2026-01-02T00:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "RULE_EXISTS" });
        expect(
          (await listarReglas(a)).some((r) => r.id === "niu__compra"),
        ).toBe(true);
        await eliminarRegla(a, "niu__compra", ADMIN, t("2026-01-02T00:00:00Z"));
      });

      it("regla inexistente → 404", async () => {
        await expect(
          eliminarRegla(a, "kiden__compra", ADMIN, t("2026-01-02T00:00:00Z")),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          eliminarRegla(a, "basura", ADMIN, t("2026-01-02T00:00:00Z")),
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe("F2-BE-03 · vigencias", () => {
      it("las marcas sin configurar no vencen y el historial guarda antes/después", async () => {
        const v = await listarVigencias(a);
        expect(v.find((x) => x.marca === "niu")).toMatchObject({
          activa: false,
        });
        const historial = await historialVigencia(a, "zontes");
        expect(historial[0]).toMatchObject({
          actor: ADMIN,
          despues: { activa: true, cantidad: 1, unidad: "meses" },
        });
      });
    });

    describe("F2-BE-02 · otorgamiento (T-POINTS, T-BRAND)", () => {
      beforeAll(async () => {
        await sembrarCliente("ana", ["zontes", "kiden"]);
        await sembrarCliente("inactiva", ["zontes"], false);
      });

      it("evento válido con regla activa otorga los puntos con vencimiento de la marca", async () => {
        const r = await registrarEvento(
          a,
          evento("ana", "c1"),
          t("2026-01-31T14:00:00Z"),
        );
        expect(r).toMatchObject({
          resultado: "otorgado",
          puntos: 100,
          venceEn: "2026-03-01T03:59:59.999Z",
          repetido: false,
        });
      });

      it("el mismo origen + id externo nunca otorga dos veces", async () => {
        const r = await registrarEvento(
          a,
          evento("ana", "c1"),
          t("2026-02-01T14:00:00Z"),
        );
        expect(r).toMatchObject({
          resultado: "otorgado",
          puntos: 100,
          repetido: true,
        });
        const saldo = await consultarSaldo(
          a,
          uid("ana"),
          ["zontes"],
          t("2026-02-01T15:00:00Z"),
        );
        expect(saldo.marcas[0]!.disponible).toBe(100);
      });

      it("reutilizar el id con otros datos → 409 IDEMPOTENCY_CONFLICT", async () => {
        await expect(
          registrarEvento(
            a,
            { ...evento("ana", "c1"), evento: "referido" },
            t("2026-02-01T14:00:00Z"),
          ),
        ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
      });

      it("sin regla o con regla inactiva el evento queda sin puntos", async () => {
        await sembrarCliente("niuista", ["niu"]);
        expect(
          await registrarEvento(
            a,
            evento("niuista", "m1", "niu", "mantenimiento"),
            t("2026-02-01T14:00:00Z"),
          ),
        ).toMatchObject({
          resultado: "sin_puntos",
          motivo: "regla_inactiva",
        });
        expect(
          await registrarEvento(
            a,
            evento("niuista", "a1", "niu", "asistencia"),
            t("2026-02-01T14:00:00Z"),
          ),
        ).toMatchObject({
          resultado: "sin_puntos",
          motivo: "sin_regla",
        });
      });

      it("cliente desconocido, inactivo o no vinculado a la marca → 422", async () => {
        await expect(
          registrarEvento(a, evento("nadie", "x1"), t("2026-02-01T14:00:00Z")),
        ).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
        await expect(
          registrarEvento(
            a,
            evento("inactiva", "x2"),
            t("2026-02-01T14:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "CLIENT_INACTIVE" });
        await expect(
          registrarEvento(
            a,
            evento("ana", "x3", "niu", "mantenimiento"),
            t("2026-02-01T14:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "BRAND_NOT_LINKED" });
      });

      it("cambiar una regla afecta sólo eventos futuros", async () => {
        await registrarEvento(
          a,
          evento("ana", "k1", "kiden", "referido"),
          t("2026-02-01T14:00:00Z"),
        );
        await actualizarRegla(
          a,
          "kiden__referido",
          { puntos: 300 },
          ADMIN,
          t("2026-02-02T00:00:00Z"),
        );
        await registrarEvento(
          a,
          evento("ana", "k2", "kiden", "referido"),
          t("2026-02-03T14:00:00Z"),
        );
        const { items } = await listarMovimientos(a, uid("ana"), ["kiden"], {
          limite: 10,
        });
        expect(items.map((m) => m.puntos)).toEqual([300, 200]);
        expect(
          (
            await consultarSaldo(
              a,
              uid("ana"),
              ["kiden"],
              t("2026-02-04T00:00:00Z"),
            )
          ).marcas[0]!.disponible,
        ).toBe(500);
      });

      it("las marcas no se mezclan: cada saldo es independiente", async () => {
        const s = await consultarSaldo(
          a,
          uid("ana"),
          ["zontes", "kiden"],
          t("2026-02-04T00:00:00Z"),
        );
        expect(s.marcas.map((m) => [m.marca, m.disponible])).toEqual([
          ["zontes", 100],
          ["kiden", 500],
        ]);
        expect(s.total).toBe(600);
      });
    });

    describe("F2-BE-03 · vencimiento (T-EXP)", () => {
      it("al leer el saldo vence lo caducado y lo deja en el historial", async () => {
        await sembrarCliente("beto", ["zontes"]);
        await registrarEvento(
          a,
          evento("beto", "b1"),
          t("2026-01-10T15:00:00Z"),
        ); // vence 10 feb 23:59:59 BO
        let s = await consultarSaldo(
          a,
          uid("beto"),
          ["zontes"],
          t("2026-02-11T03:59:59.999Z"),
        );
        expect(s.marcas[0]).toMatchObject({
          disponible: 100,
          proximoVencimiento: {
            fecha: "2026-02-11T03:59:59.999Z",
            puntos: 100,
          },
        });
        s = await consultarSaldo(
          a,
          uid("beto"),
          ["zontes"],
          t("2026-02-11T04:00:00.000Z"),
        );
        expect(s.marcas[0]).toMatchObject({
          disponible: 0,
          proximoVencimiento: null,
        });
        const { items } = await listarMovimientos(a, uid("beto"), ["zontes"], {
          limite: 10,
        });
        expect(items[0]).toMatchObject({ tipo: "vencimiento", puntos: -100 });
        expect(items[0]!.motivo).toMatch(/Vencimiento de puntos otorgados el/);
      });

      it("el proceso es reejecutable y no descuenta dos veces", async () => {
        await sembrarCliente("caro", ["zontes"]);
        await registrarEvento(
          a,
          evento("caro", "caro1"),
          t("2026-03-01T15:00:00Z"),
        );
        const ahora = t("2026-05-01T00:00:00Z");
        const primero = await procesarVencimientos(a, ahora);
        expect(primero.lotesVencidos).toBeGreaterThanOrEqual(1);
        const segundo = await procesarVencimientos(a, ahora);
        expect(segundo.lotesVencidos).toBe(0);
        const { items } = await listarMovimientos(a, uid("caro"), ["zontes"], {
          limite: 10,
          tipo: "vencimiento",
        });
        expect(items).toHaveLength(1);
        expect(await sumaLotes("caro", "zontes")).toBe(0);
      });

      it("cambiar la vigencia no altera vencimientos ya calculados", async () => {
        await sembrarCliente("dani", ["zontes"]);
        await registrarEvento(
          a,
          evento("dani", "d1"),
          t("2026-04-01T15:00:00Z"),
        );
        await actualizarVigencia(
          a,
          "zontes",
          { activa: true, cantidad: 2, unidad: "anios" },
          ADMIN,
          t("2026-04-02T00:00:00Z"),
        );
        await registrarEvento(
          a,
          evento("dani", "d2"),
          t("2026-04-03T15:00:00Z"),
        );
        const lotes = await a.consultar<Lote>({
          coleccion: R.lotes(uid("dani"), "zontes"),
        });
        expect(lotes.map((l) => l.datos.venceEn).sort()).toEqual([
          "2026-05-02T03:59:59.999Z",
          "2028-04-04T03:59:59.999Z",
        ]);
        await actualizarVigencia(
          a,
          "zontes",
          { activa: true, cantidad: 1, unidad: "meses" },
          ADMIN,
          t("2026-04-04T00:00:00Z"),
        );
      });
    });

    describe("DEC-14 · ajustes (T-HISTORY)", () => {
      it("un ajuste negativo consume primero el lote que vence antes y queda auditado", async () => {
        await sembrarCliente("eva", ["zontes", "kiden"]);
        await registrarEvento(
          a,
          evento("eva", "e1", "kiden", "referido"),
          t("2026-06-01T15:00:00Z"),
        ); // kiden: sin vencimiento
        await ajustarPuntos(
          a,
          {
            idExterno: `${run}-aj1`,
            marca: "kiden",
            correoCliente: correo("eva"),
            puntos: 50,
            motivo: "Compensación por error",
            actor: ADMIN,
          },
          t("2026-06-02T15:00:00Z"),
        );
        const r = await ajustarPuntos(
          a,
          {
            idExterno: `${run}-aj2`,
            marca: "kiden",
            correoCliente: correo("eva"),
            puntos: -120,
            motivo: "Corrección de referido duplicado",
            actor: ADMIN,
          },
          t("2026-06-03T15:00:00Z"),
        );
        expect(r).toMatchObject({
          puntos: -120,
          disponible: 230,
          repetido: false,
        });
        expect(await sumaLotes("eva", "kiden")).toBe(230);
        const auditoria = await a.consultar<{
          accion: string;
          objetivo: string;
        }>({
          coleccion: "auditoria",
          donde: [
            ["accion", "==", "puntos.ajuste"],
            ["objetivo", "==", uid("eva")],
          ],
        });
        expect(auditoria).toHaveLength(2);
        expect(JSON.stringify(auditoria)).not.toContain("@");
      });

      it("nunca deja el saldo negativo", async () => {
        await expect(
          ajustarPuntos(
            a,
            {
              idExterno: `${run}-aj3`,
              marca: "kiden",
              correoCliente: correo("eva"),
              puntos: -1000,
              motivo: "Ajuste excesivo",
              actor: ADMIN,
            },
            t("2026-06-04T15:00:00Z"),
          ),
        ).rejects.toMatchObject({ status: 409, code: "INSUFFICIENT_BALANCE" });
        expect(
          (
            await consultarSaldo(
              a,
              uid("eva"),
              ["kiden"],
              t("2026-06-04T16:00:00Z"),
            )
          ).marcas[0]!.disponible,
        ).toBe(230);
      });

      it("el ajuste repetido con el mismo id no se aplica dos veces", async () => {
        const r = await ajustarPuntos(
          a,
          {
            idExterno: `${run}-aj2`,
            marca: "kiden",
            correoCliente: correo("eva"),
            puntos: -120,
            motivo: "Corrección de referido duplicado",
            actor: ADMIN,
          },
          t("2026-06-05T15:00:00Z"),
        );
        expect(r.repetido).toBe(true);
        expect(await sumaLotes("eva", "kiden")).toBe(230);
      });
    });

    describe("I-04 · movimientos paginados", () => {
      it("une marcas sin saltar ni repetir y respeta el filtro de tipo", async () => {
        await sembrarCliente("fer", ["zontes", "kiden"]);
        for (let i = 0; i < 4; i++) {
          await registrarEvento(
            a,
            evento("fer", `fz${i}`),
            t(`2026-07-0${i + 1}T15:00:00Z`),
          );
          await registrarEvento(
            a,
            evento("fer", `fk${i}`, "kiden", "referido"),
            t(`2026-07-0${i + 1}T16:00:00Z`),
          );
        }
        const vistos: string[] = [];
        let cursor: string | undefined;
        do {
          const p = await listarMovimientos(
            a,
            uid("fer"),
            ["zontes", "kiden"],
            { limite: 3, cursor },
          );
          vistos.push(...p.items.map((m) => m.fecha + m.marca));
          cursor = p.siguiente ?? undefined;
        } while (cursor);
        expect(vistos).toHaveLength(8);
        expect(new Set(vistos).size).toBe(8);
        expect([...vistos].sort().reverse()).toEqual(vistos);
        const soloAjustes = await listarMovimientos(
          a,
          uid("fer"),
          ["zontes", "kiden"],
          { limite: 5, tipo: "ajuste" },
        );
        expect(soloAjustes).toEqual({ items: [], siguiente: null });
      });
    });

    it("conciliación: el saldo materializado coincide con la suma de lotes", async () => {
      for (const [n, marcas] of [
        ["ana", ["zontes", "kiden"]],
        ["eva", ["zontes", "kiden"]],
        ["fer", ["zontes", "kiden"]],
      ] as const) {
        const s = await consultarSaldo(
          a,
          uid(n),
          [...marcas],
          t("2026-07-10T00:00:00Z"),
        );
        for (const m of s.marcas) {
          expect(m.disponible).toBe(await sumaLotes(n, m.marca));
          expect(
            (await a.leer<{ disponible: number }>(R.saldo(uid(n), m.marca)))
              ?.disponible ?? 0,
          ).toBe(m.disponible);
        }
      }
    });
  });
}

especificacion("memoria", crearAlmacenEnMemoria);

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · motor de puntos", () => {
  const prefijo = `prueba_${Date.now().toString(36)}_`;
  const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));
  especificacion("firestore", () => crearAlmacenFirestore(db(), prefijo));
  afterAll(async () => {
    for (const c of [
      "usuarios",
      "correos",
      "auditoria",
      "reglas",
      "vigencias",
      "eventos",
      "vencimientos",
    ]) {
      await db().recursiveDelete(db().collection(`${prefijo}${c}`));
    }
  }, 60_000);
});
