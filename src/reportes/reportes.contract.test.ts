import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Almacen } from "../almacen/almacen.js";
import { crearAlmacenFirestore } from "../almacen/firestore.js";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { anularCanje, canjear, entregarCanje } from "../canjes/canjes.js";
import { cargarCatalogo } from "../canjes/catalogo.js";
import type { DatosBeneficio } from "../canjes/tipos.js";
import { loadConfig } from "../config/env.js";
import type { Marca } from "../dominio/tipos.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { AppError } from "../http/errors.js";
import { eliminarCliente } from "../identidad/clientes.js";
import { crearCuentasEnMemoria } from "../identidad/cuentas.js";
import {
  ajustarPuntos,
  procesarVencimientos,
  registrarEvento,
} from "../puntos/libro.js";
import { crearRegla } from "../puntos/reglas.js";
import { R } from "../puntos/rutas.js";
import type { Evento } from "../puntos/tipos.js";
import { actualizarVigencia } from "../puntos/vigencias.js";
import { crearPerfilesAlmacen } from "../usuarios/perfiles-almacen.js";
import { conciliar } from "./conciliacion.js";
import { aCsv, aXlsx, seleccionar } from "./exportaciones.js";
import { periodo } from "./periodo.js";
import {
  listarLibro,
  reporteActividad,
  reporteCanjes,
  reporteTendencias,
  resumen,
} from "./reportes.js";

/**
 * Especificación de F5 (DEC-09, REQ-15/16) sobre memoria y, con
 * FIRESTORE_INTEGRATION=1, sobre el proyecto de desarrollo. Los datos se
 * generan con los flujos reales de F1–F4 y cada cifra se calcula a mano a
 * partir de ellos (conciliación con el libro). Auth es siempre un doble.
 */
function especificacion(nombre: string, crear: () => Almacen) {
  describe(`Reportes · ${nombre}`, () => {
    let a: Almacen;
    const cuentas = crearCuentasEnMemoria();
    const run = Math.random().toString(36).slice(2, 8);
    const correo = (n: string) => `${n}.${run}@ejemplo.test`;
    const uids: Record<string, string> = {};
    const codigos: string[] = [];
    const ADMIN = "admin-1";
    const t = (iso: string) => new Date(iso);
    const AHORA = t("2026-10-03T15:00:00.000Z");
    const SEP = periodo("2026-09-01", "2026-09-30");
    const deps = () => ({ almacen: a, cuentas });
    let n = 0;

    async function cliente(nombre: string, marcas: Marca[], creadoEn: string) {
      const { uid } = await cuentas.crear({
        correo: correo(nombre),
        nombre: `Persona ${nombre}`,
      });
      uids[nombre] = uid;
      await crearPerfilesAlmacen(a).registrar(
        {
          uid,
          correo: correo(nombre),
          rol: "cliente",
          activo: true,
          marcas,
          vinculo: marcas.length ? "vinculado" : "no_vinculado",
          creadoEn,
        },
        {
          accion: "cliente.registrado",
          actor: uid,
          objetivoUid: uid,
          en: creadoEn,
          datos: {},
        },
      );
    }
    const evento = (quien: string, ev: Evento, marca: Marca, iso: string) =>
      registrarEvento(
        a,
        {
          origen: "panel",
          idExterno: `${run}-${n++}`,
          evento: ev,
          marca,
          correoCliente: correo(quien),
          actor: ADMIN,
        },
        t(iso),
      );
    const canje = async (
      quien: string,
      marcas: Marca[],
      b: string,
      iso: string,
    ) => {
      const r = await canjear(
        a,
        {
          uid: uids[quien]!,
          marcasCliente: marcas,
          beneficioId: `${run}-${b}`,
          varianteId: "unica",
          idSolicitud: `${run}-c${n++}`,
        },
        t(iso),
      );
      codigos.push(r.canje.codigo);
      return r.canje.codigo;
    };
    const beneficio = (
      marca: Marca,
      nombre: string,
      puntos: number,
      stock: number | null,
    ): DatosBeneficio => ({
      marca,
      nombre,
      descripcion: "",
      categoria: "servicios",
      puntos,
      activo: true,
      disponibleDesde: null,
      vigenciaCuponDias: 30,
      caracteristicas: [],
      variantes: [{ id: "unica", nombre: "Única", stock }],
    });

    beforeAll(async () => {
      a = crear();
      const t0 = t("2026-01-01T00:00:00Z");
      for (const [marca, ev, puntos] of [
        ["zontes", "compra", 100],
        ["zontes", "referido", 50],
        ["kiden", "compra", 200],
      ] as const) {
        await crearRegla(
          a,
          { marca, evento: ev, puntos, activa: true },
          ADMIN,
          t0,
        );
      }
      await actualizarVigencia(
        a,
        "zontes",
        { activa: true, cantidad: 1, unidad: "meses" },
        ADMIN,
        t0,
      );
      await actualizarVigencia(
        a,
        "kiden",
        { activa: false, cantidad: 12, unidad: "meses" },
        ADMIN,
        t0,
      );
      await cargarCatalogo(
        a,
        [
          {
            id: `${run}-revision`,
            ...beneficio("zontes", "Revisión", 50, null),
          },
          { id: `${run}-chaqueta`, ...beneficio("kiden", "Chaqueta", 90, 5) },
        ],
        ADMIN,
        t0,
      );
      await cliente("ana", ["zontes"], "2026-08-10T15:00:00.000Z");
      await cliente("beto", ["zontes", "kiden"], "2026-09-05T15:00:00.000Z");
      await cliente("caro", [], "2026-09-20T15:00:00.000Z");
      await cliente("dani", ["kiden"], "2026-09-25T15:00:00.000Z");

      await evento("ana", "compra", "zontes", "2026-08-15T15:00:00.000Z"); // vence el 15-09
      await evento("ana", "compra", "zontes", "2026-09-10T15:00:00.000Z");
      await evento("ana", "referido", "zontes", "2026-09-11T15:00:00.000Z");
      await evento("beto", "compra", "kiden", "2026-09-12T15:00:00.000Z");
      await ajustarPuntos(
        a,
        {
          idExterno: `${run}-aj1`,
          marca: "kiden",
          correoCliente: correo("beto"),
          puntos: -20,
          motivo: "Corrección de prueba",
          actor: ADMIN,
        },
        t("2026-09-13T15:00:00.000Z"),
      );
      await ajustarPuntos(
        a,
        {
          idExterno: `${run}-aj2`,
          marca: "zontes",
          correoCliente: correo("ana"),
          puntos: 30,
          motivo: "Bonificación de prueba",
          actor: ADMIN,
        },
        t("2026-09-14T15:00:00.000Z"),
      );
      await procesarVencimientos(a, t("2026-09-20T12:00:00.000Z"));
      const c1 = await canje(
        "ana",
        ["zontes"],
        "revision",
        "2026-09-21T15:00:00.000Z",
      );
      await canje(
        "beto",
        ["zontes", "kiden"],
        "chaqueta",
        "2026-09-22T15:00:00.000Z",
      );
      await entregarCanje(a, c1, ADMIN, t("2026-09-22T16:00:00.000Z"));
      const c3 = await canje(
        "beto",
        ["zontes", "kiden"],
        "chaqueta",
        "2026-09-23T15:00:00.000Z",
      );
      await anularCanje(
        a,
        c3,
        "Pedido duplicado",
        ADMIN,
        t("2026-09-24T15:00:00.000Z"),
      );
      await evento("dani", "compra", "kiden", "2026-09-26T15:00:00.000Z");
      await eliminarCliente(
        deps(),
        uids.dani!,
        ADMIN,
        t("2026-09-27T15:00:00.000Z"),
      );
      // 23:30 del 28 de septiembre en Bolivia (29 en UTC).
      await evento("beto", "compra", "zontes", "2026-09-29T03:30:00.000Z");
    }, 120_000);

    it("el libro global concilia con los movimientos y canjes de cada cliente", async () => {
      const r = await conciliar(a);
      expect(r).toMatchObject({
        movimientos: 13,
        asientos: 13,
        faltantes: 0,
        distintos: 0,
        sobrantes: [],
        canjes: 3,
        indicesDesactualizados: 0,
      });
    });

    it("actividad del periodo, total y por marca (A10)", async () => {
      const r = await reporteActividad(deps(), SEP);
      expect(r).toMatchObject({
        usuariosConActividad: 3,
        nuevosRegistros: 3,
        puntosGenerados: 650,
        puntosUtilizados: 140,
        puntosVencidos: 100,
        ajustes: { positivos: 30, negativos: 20 },
        canjes: 2,
        canjesAnulados: 1,
        actividadesRegistradas: 5,
      });
      expect(r.porEvento).toEqual([
        { evento: "compra", movimientos: 4, puntos: 600, clientes: 3 },
        { evento: "referido", movimientos: 1, puntos: 50, clientes: 1 },
        { evento: "mantenimiento", movimientos: 0, puntos: 0, clientes: 0 },
        { evento: "asistencia", movimientos: 0, puntos: 0, clientes: 0 },
      ]);
      const z = await reporteActividad(deps(), SEP, "zontes");
      expect(z).toMatchObject({
        puntosGenerados: 250,
        puntosUtilizados: 50,
        puntosVencidos: 100,
        nuevosRegistros: 1,
        canjes: 1,
      });
    });

    it("tendencias con periodo anterior, día local de Bolivia y comparación por marca (A11)", async () => {
      const r = await reporteTendencias(deps(), "otorgados", SEP);
      expect(r.granularidad).toBe("dia");
      expect(r.actual.total).toBe(650);
      expect(r.anterior).toMatchObject({
        desde: "2026-08-02",
        hasta: "2026-08-31",
        total: 100,
      });
      expect(r.variacion).toEqual({ absoluta: 550, porcentaje: 550 });
      expect(r.actual.serie).toHaveLength(30);
      expect(r.actual.serie.find((s) => s.desde === "2026-09-28")?.valor).toBe(
        100,
      );
      expect(r.actual.serie.find((s) => s.desde === "2026-09-29")?.valor).toBe(
        0,
      );
      expect(r.porMarca).toEqual([
        { marca: "zontes", total: 250 },
        { marca: "kiden", total: 400 },
        { marca: "niu", total: 0 },
      ]);
      const reg = await reporteTendencias(deps(), "registros", SEP, "kiden");
      expect(reg.actual.total).toBe(2);
      expect(reg.porMarca.map((m) => m.total)).toEqual([1, 2, 0]);
      const semanal = await reporteTendencias(
        deps(),
        "utilizados",
        periodo("2026-08-01", "2026-09-30"),
      );
      expect(semanal.granularidad).toBe("semana");
      expect(semanal.actual.total).toBe(140);
    });

    it("reporte de canjes con filtros, estado efectivo, ranking y paginación (A08)", async () => {
      const r = await reporteCanjes(deps(), SEP, { limite: 2 }, AHORA);
      expect(r).toMatchObject({
        total: 3,
        validos: 2,
        anulados: 1,
        puntosUtilizados: 140,
        clientesConCanjes: 2,
      });
      expect(r.beneficiosMasCanjeados.map((b) => [b.nombre, b.canjes])).toEqual(
        [
          ["Chaqueta", 1],
          ["Revisión", 1],
        ],
      );
      expect(r.porMarca).toEqual([
        { marca: "zontes", canjes: 1, puntos: 50 },
        { marca: "kiden", canjes: 1, puntos: 90 },
        { marca: "niu", canjes: 0, puntos: 0 },
      ]);
      expect(r.items.map((c) => c.estado)).toEqual(["anulado", "emitido"]);
      expect(r.items[0]!.cliente).toEqual({
        nombre: "Persona beto",
        correo: correo("beto"),
      });
      const p2 = await reporteCanjes(
        deps(),
        SEP,
        { limite: 2, cursor: r.siguiente! },
        AHORA,
      );
      expect(p2.items.map((c) => c.estado)).toEqual(["entregado"]);
      expect(p2.siguiente).toBeNull();
      expect(
        (
          await reporteCanjes(
            deps(),
            SEP,
            { limite: 10, estado: "entregado" },
            AHORA,
          )
        ).total,
      ).toBe(1);
      expect(
        (
          await reporteCanjes(
            deps(),
            SEP,
            { limite: 10, correo: correo("BETO") },
            AHORA,
          )
        ).total,
      ).toBe(2);
      expect(
        (
          await reporteCanjes(
            deps(),
            SEP,
            { limite: 10, correo: correo("nadie") },
            AHORA,
          )
        ).total,
      ).toBe(0);
      // Pasada la vigencia del cupón, el emitido aparece como vencido.
      const tarde = await reporteCanjes(
        deps(),
        SEP,
        { limite: 10 },
        t("2026-11-01T00:00:00Z"),
      );
      expect(tarde.items.map((c) => c.estado).sort()).toEqual([
        "anulado",
        "entregado",
        "vencido",
      ]);
    });

    it("dashboard: clientes vigentes por agregación y KPI de 30 días contra los 30 anteriores (A13)", async () => {
      const r = await resumen(deps(), AHORA);
      expect(r.clientes).toMatchObject({
        total: 3,
        vinculados: 2,
        sinVincular: 1,
        nuevos: { valor: 3, variacion: { absoluta: 2, porcentaje: 200 } },
      });
      expect(r.clientes.porMarca).toEqual([
        { marca: "zontes", clientes: 2 },
        { marca: "kiden", clientes: 1 },
        { marca: "niu", clientes: 0 },
      ]);
      expect(r.puntosOtorgados).toEqual({
        valor: 650,
        variacion: { absoluta: 550, porcentaje: 550 },
      });
      expect(r.puntosUtilizados).toMatchObject({ valor: 140, vencidos: 100 });
      expect(r.canjes).toMatchObject({ valor: 2, pendientesDeEntrega: 1 });
      expect(r.actividadMensual.map((m) => m.desde)).toEqual([
        "2026-05-01",
        "2026-06-01",
        "2026-07-01",
        "2026-08-01",
        "2026-09-01",
        "2026-10-01",
      ]);
      expect(r.actividadMensual[3]).toEqual({
        desde: "2026-08-01",
        otorgados: 100,
        utilizados: 0,
      });
      expect(r.actividadMensual[4]).toEqual({
        desde: "2026-09-01",
        otorgados: 650,
        utilizados: 140,
      });
      expect(r.canjesMensualesPorMarca[4]).toEqual({
        desde: "2026-09-01",
        zontes: 1,
        kiden: 1,
        niu: 0,
      });
      // La baja no aparece entre los últimos registros ni deja datos personales.
      expect(r.ultimosRegistros.map((x) => x.nombre)).toEqual([
        "Persona caro",
        "Persona beto",
        "Persona ana",
      ]);
      expect(r.ultimosCanjes).toHaveLength(3);
    });

    it("movimientos globales del más reciente al más antiguo con filtros y cursor (A07)", async () => {
      const p1 = await listarLibro(deps(), SEP, { limite: 5 });
      expect(p1.items.map((m) => [m.tipo, m.puntos])).toEqual([
        ["otorgamiento", 100],
        ["otorgamiento", 200],
        ["canje", 90],
        ["canje", -90],
        ["canje", -90],
      ]);
      expect(p1.items[1]!.cliente).toEqual({
        nombre: "Cliente eliminado",
        correo: null,
      });
      const p2 = await listarLibro(deps(), SEP, {
        limite: 5,
        cursor: p1.siguiente!,
      });
      const p3 = await listarLibro(deps(), SEP, {
        limite: 5,
        cursor: p2.siguiente!,
      });
      expect([...p1.items, ...p2.items, ...p3.items]).toHaveLength(12);
      expect(p3.siguiente).toBeNull();
      const kiden = await listarLibro(deps(), SEP, {
        limite: 10,
        marca: "kiden",
        tipo: "otorgamiento",
      });
      expect(kiden.items.map((m) => m.puntos)).toEqual([200, 200]);
      const compras = await listarLibro(deps(), SEP, {
        limite: 10,
        evento: "compra",
      });
      expect(compras.items).toHaveLength(4);
    });

    it("exportaciones con filtros efectivos, CSV y Excel (A12)", async () => {
      const mov = await seleccionar(
        deps(),
        "movimientos",
        { periodo: SEP },
        AHORA,
      );
      expect(mov.filas).toBe(12);
      const filas = await mov.construir();
      const csv = aCsv(mov.columnas, filas).toString("utf8");
      expect(
        csv.startsWith(
          "﻿Fecha;Cliente;Correo;Marca;Tipo;Evento;Puntos;Detalle\r\n",
        ),
      ).toBe(true);
      expect(csv).toContain(
        `2026-09-28 23:30;Persona beto;${correo("beto")};Zontes;Otorgamiento;Compra;100;`,
      );
      const xlsx = await aXlsx(mov.columnas, filas, "movimientos");
      expect(xlsx.subarray(0, 2).toString()).toBe("PK");

      const cli = await seleccionar(
        deps(),
        "clientes",
        { marca: "zontes" },
        AHORA,
      );
      expect(cli.filas).toBe(2);
      expect((await cli.construir()).map((f) => f[0])).toEqual([
        "Persona beto",
        "Persona ana",
      ]);
      expect(
        (await seleccionar(deps(), "clientes", { periodo: SEP }, AHORA)).filas,
      ).toBe(2);

      const can = await seleccionar(
        deps(),
        "canjes",
        { periodo: SEP, estado: "anulado" },
        AHORA,
      );
      expect(can.filas).toBe(1);
      const act = await seleccionar(
        deps(),
        "actividad",
        { periodo: SEP, marca: "kiden" },
        AHORA,
      );
      expect(
        (await act.construir()).find((f) => f[0] === "Puntos generados"),
      ).toEqual(["Puntos generados", 400]);
    });

    it("la conciliación detecta y repara datos anteriores al libro sin borrar nada", async () => {
      const asiento = (
        await a.consultar({ coleccion: R.libro, limite: 1 })
      )[0]!;
      await a.transaccion(async (tx) => {
        tx.borrar(R.asiento(asiento.id));
        tx.fijar(R.codigo(codigos[0]!), { uid: uids.ana, canjeId: "x" });
      });
      const antes = await conciliar(a);
      expect(antes).toMatchObject({
        faltantes: 1,
        indicesDesactualizados: 1,
        reparados: 0,
      });
      const reparado = await conciliar(a, { reparar: true });
      expect(reparado.reparados).toBe(2);
      expect(await conciliar(a)).toMatchObject({
        faltantes: 0,
        distintos: 0,
        indicesDesactualizados: 0,
        sobrantes: [],
      });
    });
  });
}

especificacion("memoria", crearAlmacenEnMemoria);

describe("Exportación · límites y seguridad (DEC-09)", () => {
  it("rechaza más de 10.000 filas y pide acotar", async () => {
    const a = crearAlmacenEnMemoria();
    await a.transaccion(async (tx) => {
      for (let i = 0; i < 10_001; i++) {
        tx.fijar(R.asiento(`id-${String(i).padStart(5, "0")}`), {
          uid: "u",
          marca: "zontes",
          tipo: "otorgamiento",
          puntos: 1,
          fecha: "2026-09-10T15:00:00.000Z",
          evento: "compra",
          origen: null,
          motivo: null,
          actor: "x",
        });
      }
    });
    const error = await seleccionar(
      { almacen: a, cuentas: crearCuentasEnMemoria() },
      "movimientos",
      { periodo: periodo("2026-09-01", "2026-09-30") },
      new Date(),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("TOO_MANY_ROWS");
  });

  it("neutraliza fórmulas y escapa separadores en CSV", () => {
    const csv = aCsv(
      ["A", "B"],
      [
        ['=HYPERLINK("x")', "uno;dos"],
        [-5, null],
      ],
    ).toString("utf8");
    expect(csv).toBe('﻿A;B\r\n"\'=HYPERLINK(""x"")";"uno;dos"\r\n-5;\r\n');
  });
});

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · reportes", () => {
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
  }, 120_000);
});
