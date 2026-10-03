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
  consultarSaldo,
  listarMovimientos,
  registrarEvento,
} from "../puntos/libro.js";
import { crearRegla, eliminarRegla, listarReglas } from "../puntos/reglas.js";
import { R } from "../puntos/rutas.js";
import type { Lote } from "../puntos/tipos.js";
import { actualizarVigencia } from "../puntos/vigencias.js";
import {
  anularCanje,
  canjear,
  entregarCanje,
  listarCanjes,
  obtenerCanje,
} from "./canjes.js";
import { generarComprobante } from "./comprobante.js";
import {
  cargarCatalogo,
  listarCatalogo,
  obtenerBeneficioCliente,
} from "./catalogo.js";
import type { Beneficio, DatosBeneficio } from "./tipos.js";

/**
 * Especificación de F3 (DEC-07) sobre memoria y, con FIRESTORE_INTEGRATION=1,
 * sobre el proyecto de desarrollo. Escenarios T-REDEEM y T-BRAND.
 */
function especificacion(nombre: string, crear: () => Almacen) {
  describe(`Catálogo y canje · ${nombre}`, () => {
    let a: Almacen;
    const run = Math.random().toString(36).slice(2, 8);
    const id = (s: string) => `${run}-${s}`;
    const uid = (n: string) => `u-${run}-${n}`;
    const correo = (n: string) => `${n}.${run}@ejemplo.test`;
    const t = (iso: string) => new Date(iso);
    const ADMIN = "admin-1";

    const beneficio = (
      marca: Marca,
      extra: Partial<DatosBeneficio> = {},
    ): DatosBeneficio => ({
      marca,
      nombre: "Beneficio de prueba",
      descripcion: "Descripción con tildes: canción",
      categoria: "accesorios",
      puntos: 100,
      activo: true,
      disponibleDesde: null,
      vigenciaCuponDias: 10,
      caracteristicas: [],
      variantes: [{ id: "unica", nombre: "Única", stock: 10 }],
      ...extra,
    });

    async function sembrarCliente(n: string, marcas: Marca[]) {
      await a.transaccion(async (tx) => {
        tx.fijar(R.usuario(uid(n)), {
          correo: correo(n),
          rol: "cliente",
          activo: true,
          marcas,
          vinculo: "vinculado",
          creadoEn: "",
        });
        tx.fijar(R.correo(huellaCorreo(correo(n))), { uid: uid(n) });
      });
    }
    let secuencia = 0;
    async function darPuntos(
      n: string,
      marca: Marca,
      veces: number,
      iso: string,
    ) {
      for (let i = 0; i < veces; i++) {
        await registrarEvento(
          a,
          {
            origen: "panel",
            idExterno: `${run}-p${secuencia++}`,
            evento: "compra",
            marca,
            correoCliente: correo(n),
            actor: ADMIN,
          },
          t(iso),
        );
      }
    }
    const pedir = (
      n: string,
      marcas: Marca[],
      beneficioId: string,
      varianteId = "unica",
      solicitud = `${run}-${Math.random()}`,
    ) => ({
      uid: uid(n),
      marcasCliente: marcas,
      beneficioId: id(beneficioId),
      varianteId,
      idSolicitud: solicitud,
    });
    const stock = async (b: string, v = "unica") =>
      (await a.leer<Beneficio>(R.beneficio(id(b))))!.variantes.find(
        (x) => x.id === v,
      )!.stock;
    const sumaLotes = async (n: string, marca: Marca) =>
      (await a.consultar<Lote>({ coleccion: R.lotes(uid(n), marca) })).reduce(
        (s, l) => s + l.datos.restante,
        0,
      );

    beforeAll(async () => {
      a = crear();
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
        { marca: "kiden", evento: "compra", puntos: 100, activa: true },
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
      await actualizarVigencia(
        a,
        "zontes",
        { activa: false, cantidad: 12, unidad: "meses" },
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
      await cargarCatalogo(
        a,
        [
          {
            id: id("casco"),
            ...beneficio("zontes", {
              nombre: "Casco integral",
              variantes: [
                { id: "s", nombre: "Talla S", stock: 0 },
                { id: "m", nombre: "Talla M", stock: 1 },
                { id: "l", nombre: "Talla L", stock: 9 },
              ],
            }),
          },
          {
            id: id("servicio"),
            ...beneficio("zontes", {
              nombre: "Revisión",
              categoria: "servicios",
              puntos: 50,
              variantes: [{ id: "unica", nombre: "Única", stock: null }],
            }),
          },
          {
            id: id("kiden"),
            ...beneficio("kiden", {
              nombre: "Chaqueta Kiden",
              categoria: "ropa",
            }),
          },
          {
            id: id("pronto"),
            ...beneficio("zontes", {
              nombre: "Rodada",
              categoria: "experiencias",
              disponibleDesde: "2027-01-01T04:00:00.000Z",
            }),
          },
          { id: id("inactivo"), ...beneficio("zontes", { activo: false }) },
          {
            id: id("ultimo"),
            ...beneficio("zontes", {
              nombre: "Última unidad",
              puntos: 10,
              variantes: [{ id: "unica", nombre: "Única", stock: 1 }],
            }),
          },
        ],
        ADMIN,
        t("2026-01-01T00:00:00Z"),
      );
      await sembrarCliente("ana", ["zontes"]);
      await darPuntos("ana", "zontes", 3, "2026-02-01T15:00:00Z");
    });

    describe("F3-BE-01 · catálogo (T-BRAND)", () => {
      it("sólo muestra beneficios activos de marcas vinculadas, con disponibilidad del backend", async () => {
        const items = (
          await listarCatalogo(a, ["zontes"], {}, t("2026-02-01T16:00:00Z"))
        ).filter((b) => b.id.startsWith(run));
        expect(items.map((b) => b.id).sort()).toEqual(
          [id("casco"), id("pronto"), id("servicio"), id("ultimo")].sort(),
        );
        const casco = items.find((b) => b.id === id("casco"))!;
        expect(casco.disponibilidad).toBe("disponible");
        expect(casco.variantes.map((v) => v.disponibilidad)).toEqual([
          "agotado",
          "ultimas",
          "disponible",
        ]);
        expect(items.find((b) => b.id === id("pronto"))!.disponibilidad).toBe(
          "proximamente",
        );
        expect(
          items.find((b) => b.id === id("servicio"))!.variantes[0]!
            .disponibilidad,
        ).toBe("disponible");
        expect(JSON.stringify(items)).not.toContain('"stock"');
      });

      it("busca sin distinguir mayúsculas ni tildes y filtra por categoría", async () => {
        const porTexto = await listarCatalogo(
          a,
          ["zontes"],
          { q: "CANCION" },
          t("2026-02-01T16:00:00Z"),
        );
        expect(porTexto.length).toBeGreaterThan(0);
        const servicios = (
          await listarCatalogo(
            a,
            ["zontes"],
            { categoria: "servicios" },
            t("2026-02-01T16:00:00Z"),
          )
        ).filter((b) => b.id.startsWith(run));
        expect(servicios.map((b) => b.id)).toEqual([id("servicio")]);
      });

      it("un beneficio de otra marca, inactivo o inexistente responde 404", async () => {
        for (const b of ["kiden", "inactivo", "nada"]) {
          await expect(
            obtenerBeneficioCliente(
              a,
              id(b),
              ["zontes"],
              t("2026-02-01T16:00:00Z"),
            ),
          ).rejects.toMatchObject({ status: 404 });
        }
      });
    });

    describe("F3-BE-02 · canje atómico (T-REDEEM)", () => {
      it("descuenta puntos y stock, deja movimiento y cupón emitido con vigencia", async () => {
        const r = await canjear(
          a,
          pedir("ana", ["zontes"], "casco", "l"),
          t("2026-02-02T15:00:00Z"),
        );
        expect(r.canje).toMatchObject({
          estado: "emitido",
          puntos: 100,
          varianteNombre: "Talla L",
          venceEn: "2026-02-13T03:59:59.999Z",
        });
        expect(r.canje.codigo).toMatch(/^ML-/);
        expect(r.disponible).toBe(200);
        expect(await stock("casco", "l")).toBe(8);
        expect(await sumaLotes("ana", "zontes")).toBe(200);
        const { items } = await listarMovimientos(a, uid("ana"), ["zontes"], {
          limite: 1,
        });
        expect(items[0]).toMatchObject({
          tipo: "canje",
          puntos: -100,
          motivo: "Canje: Casco integral",
        });
      });

      it("la misma solicitud no canjea dos veces", async () => {
        const p = pedir(
          "ana",
          ["zontes"],
          "servicio",
          "unica",
          `${run}-solicitud-fija`,
        );
        const r1 = await canjear(a, p, t("2026-02-03T15:00:00Z"));
        const r2 = await canjear(a, p, t("2026-02-03T15:00:05Z"));
        expect(r2.repetido).toBe(true);
        expect(r2.canje.codigo).toBe(r1.canje.codigo);
        expect(await sumaLotes("ana", "zontes")).toBe(150);
      });

      it("rechaza sin efectos: agotado, próximamente, sin saldo, otra marca", async () => {
        const antes = await sumaLotes("ana", "zontes");
        await expect(
          canjear(
            a,
            pedir("ana", ["zontes"], "casco", "s"),
            t("2026-02-04T15:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
        await expect(
          canjear(
            a,
            pedir("ana", ["zontes"], "pronto"),
            t("2026-02-04T15:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "NOT_AVAILABLE_YET" });
        await expect(
          canjear(
            a,
            pedir("ana", ["zontes"], "kiden"),
            t("2026-02-04T15:00:00Z"),
          ),
        ).rejects.toMatchObject({ status: 404 });
        await sembrarCliente("pobre", ["zontes"]);
        await expect(
          canjear(
            a,
            pedir("pobre", ["zontes"], "servicio"),
            t("2026-02-04T15:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
        expect(await sumaLotes("ana", "zontes")).toBe(antes);
        expect(await sumaLotes("pobre", "zontes")).toBe(0);
      });

      it("dos canjes simultáneos del último stock: sólo uno se emite", async () => {
        await sembrarCliente("beto", ["zontes"]);
        await darPuntos("beto", "zontes", 1, "2026-02-01T15:00:00Z");
        const resultados = await Promise.allSettled([
          canjear(
            a,
            pedir("ana", ["zontes"], "ultimo"),
            t("2026-02-05T15:00:00Z"),
          ),
          canjear(
            a,
            pedir("beto", ["zontes"], "ultimo"),
            t("2026-02-05T15:00:00Z"),
          ),
        ]);
        expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(
          1,
        );
        const rechazo = resultados.find(
          (r) => r.status === "rejected",
        ) as PromiseRejectedResult;
        expect(rechazo.reason).toMatchObject({ code: "OUT_OF_STOCK" });
        expect(await stock("ultimo")).toBe(0);
      });
    });

    describe("F3-BE-03 · estados, comprobante y anulación (DEC-07)", () => {
      it("el cupón no usado a tiempo se ve como vencido y no se entrega", async () => {
        await darPuntos("ana", "zontes", 1, "2026-02-06T14:00:00Z");
        const { canje } = await canjear(
          a,
          pedir("ana", ["zontes"], "casco", "l"),
          t("2026-02-06T15:00:00Z"),
        );
        const despues = t("2026-03-01T15:00:00Z");
        expect(
          (await obtenerCanje(a, canje.codigo, despues)).vista.estado,
        ).toBe("vencido");
        await expect(
          entregarCanje(a, canje.codigo, ADMIN, despues),
        ).rejects.toMatchObject({ code: "INVALID_STATE" });
      });

      it("se entrega una vez y un canje entregado no se anula", async () => {
        await darPuntos("ana", "zontes", 1, "2026-02-07T14:00:00Z");
        const { canje } = await canjear(
          a,
          pedir("ana", ["zontes"], "casco", "l"),
          t("2026-02-07T15:00:00Z"),
        );
        expect(
          (
            await entregarCanje(
              a,
              canje.codigo,
              ADMIN,
              t("2026-02-08T15:00:00Z"),
            )
          ).estado,
        ).toBe("entregado");
        await expect(
          entregarCanje(a, canje.codigo, ADMIN, t("2026-02-08T15:00:00Z")),
        ).rejects.toMatchObject({ code: "INVALID_STATE" });
        await expect(
          anularCanje(
            a,
            canje.codigo,
            "Error de prueba",
            ADMIN,
            t("2026-02-08T15:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "INVALID_STATE" });
      });

      it("anular devuelve puntos y stock, y queda en historial y auditoría", async () => {
        await sembrarCliente("caro", ["kiden"]);
        await darPuntos("caro", "kiden", 2, "2026-02-01T15:00:00Z");
        const { canje } = await canjear(
          a,
          pedir("caro", ["kiden"], "kiden"),
          t("2026-02-09T15:00:00Z"),
        );
        const stockAntes = await stock("kiden");
        const r = await anularCanje(
          a,
          canje.codigo,
          "Producto dañado",
          ADMIN,
          t("2026-02-10T15:00:00Z"),
        );
        expect(r).toMatchObject({
          canje: { estado: "anulado", motivoAnulacion: "Producto dañado" },
          disponible: 200,
        });
        expect(await stock("kiden")).toBe(stockAntes! + 1);
        expect(await sumaLotes("caro", "kiden")).toBe(200);
        const { items } = await listarMovimientos(a, uid("caro"), ["kiden"], {
          limite: 1,
        });
        expect(items[0]).toMatchObject({ tipo: "canje", puntos: 100 });
        expect(items[0]!.motivo).toContain(
          `Anulación del canje ${canje.codigo}`,
        );
        await expect(
          anularCanje(
            a,
            canje.codigo,
            "Otra vez",
            ADMIN,
            t("2026-02-10T16:00:00Z"),
          ),
        ).rejects.toMatchObject({ code: "INVALID_STATE" });
      });

      it("al anular, los puntos de un lote ya vencido no reviven", async () => {
        await actualizarVigencia(
          a,
          "kiden",
          { activa: true, cantidad: 10, unidad: "dias" },
          ADMIN,
          t("2026-04-01T00:00:00Z"),
        );
        await sembrarCliente("dani", ["kiden"]);
        await darPuntos("dani", "kiden", 1, "2026-04-01T15:00:00Z"); // vence 11 abr 23:59:59 BO
        const { canje } = await canjear(
          a,
          pedir("dani", ["kiden"], "kiden"),
          t("2026-04-02T15:00:00Z"),
        );
        const r = await anularCanje(
          a,
          canje.codigo,
          "Anulación tardía",
          ADMIN,
          t("2026-05-01T15:00:00Z"),
        );
        expect(r.disponible).toBe(0);
        const s = await consultarSaldo(
          a,
          uid("dani"),
          ["kiden"],
          t("2026-05-01T16:00:00Z"),
        );
        expect(s.marcas[0]!.disponible).toBe(0);
        const tipos = (
          await listarMovimientos(a, uid("dani"), ["kiden"], { limite: 10 })
        ).items.map((m) => `${m.tipo}${m.puntos}`);
        expect(tipos).toEqual([
          "vencimiento-100",
          "canje100",
          "canje-100",
          "otorgamiento100",
        ]);
        await actualizarVigencia(
          a,
          "kiden",
          { activa: false, cantidad: 12, unidad: "meses" },
          ADMIN,
          t("2026-05-02T00:00:00Z"),
        );
      });

      it("Mis canjes sólo del propietario; otro cliente recibe 404", async () => {
        const { items } = await listarCanjes(
          a,
          uid("ana"),
          { limite: 50 },
          t("2026-02-10T15:00:00Z"),
        );
        expect(items.length).toBeGreaterThanOrEqual(3);
        expect([...items].map((c) => c.emitidoEn)).toEqual(
          [...items]
            .map((c) => c.emitidoEn)
            .sort()
            .reverse(),
        );
        await expect(
          obtenerCanje(
            a,
            items[0]!.codigo,
            t("2026-02-10T15:00:00Z"),
            uid("beto"),
          ),
        ).rejects.toMatchObject({ status: 404 });
      });

      it("el comprobante es un PDF con el código", async () => {
        const { items } = await listarCanjes(
          a,
          uid("ana"),
          { limite: 1 },
          t("2026-02-10T15:00:00Z"),
        );
        const pdf = await generarComprobante(
          items[0]!,
          t("2026-02-10T15:00:00Z"),
        );
        expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
        expect(pdf.toString("latin1")).toContain(items[0]!.codigo);
      });
    });
  });
}

especificacion("memoria", crearAlmacenEnMemoria);

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · catálogo y canje", () => {
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
      "beneficios",
      "codigos",
      "libro",
    ]) {
      await db().recursiveDelete(db().collection(`${prefijo}${c}`));
    }
  }, 60_000);
});
