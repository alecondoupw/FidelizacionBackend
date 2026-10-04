import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Almacen } from "../almacen/almacen.js";
import { crearAlmacenFirestore } from "../almacen/firestore.js";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { loadConfig } from "../config/env.js";
import type { Marca, Perfil } from "../dominio/tipos.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { R } from "../puntos/rutas.js";
import { aXlsx } from "../reportes/exportaciones.js";
import { huellaCorreo } from "../usuarios/correo.js";
import {
  confirmarImportacion,
  crearFuenteImportacion,
  DIAS_CONSERVACION,
  listarImportaciones,
  listarPendientes,
  purgarVencidas,
  reporteImportacion,
  vistaPrevia,
} from "./importacion.js";

/**
 * Especificación de la importación (F8-BE-01/02, SRC-06 pp. 1–2, DEC-17)
 * sobre memoria y, con FIRESTORE_INTEGRATION=1, sobre el proyecto de
 * desarrollo con colecciones temporales. Escenarios T-IMPORT y T-LINK.
 */
function especificacion(nombre: string, crear: () => Almacen) {
  describe(`Importación de clientes · ${nombre}`, () => {
    let a: Almacen;
    const run = Math.random().toString(36).slice(2, 8);
    const correo = (n: string) => `${n}.${run}@ejemplo.test`;
    const AHORA = new Date("2026-10-04T15:00:00.000Z");
    const ADMIN = "admin-1";
    let secuencia = 0;
    const id = () => `imp-${run}-${secuencia++}`;

    async function cuenta(
      n: string,
      rol: Perfil["rol"],
      extra: Partial<Perfil> = {},
    ) {
      await a.transaccion(async (tx) => {
        tx.fijar(R.usuario(`u-${run}-${n}`), {
          correo: correo(n),
          rol,
          activo: true,
          marcas: [],
          vinculo: "no_vinculado",
          creadoEn: "2026-01-01T00:00:00.000Z",
          ...extra,
        });
        tx.fijar(R.correo(huellaCorreo(correo(n))), { uid: `u-${run}-${n}` });
      });
    }
    const perfil = (n: string) =>
      a.leer<Omit<Perfil, "uid">>(R.usuario(`u-${run}-${n}`));
    const archivo = (filas: string[][]) =>
      Buffer.from(
        ["Nombre;Correo electrónico", ...filas.map((f) => f.join(";"))].join(
          "\r\n",
        ),
      );
    const confirmar = (marca: Marca, datos: Buffer, idImportacion = id()) =>
      confirmarImportacion(
        a,
        { idImportacion, marca, archivo: "clientes.csv", datos, actor: ADMIN },
        AHORA,
      );

    beforeEach(async () => {
      a = crear();
      await cuenta("ana", "cliente");
      await cuenta("beto", "cliente", { verificarCorreo: true });
      await cuenta("adm", "administrador");
    });

    it("vista previa: valida filas, detecta duplicados y clasifica sin escribir", async () => {
      const r = await vistaPrevia(
        a,
        "zontes",
        archivo([
          ["Carla Ruiz", `  ${correo("carla").toUpperCase()}  `],
          ["Ana Pérez", correo("ana")],
          ["Carla Otra", correo("carla")],
          ["Sin Correo", ""],
          ["", correo("nadie")],
          ["Correo Malo", "no-es-correo"],
          ["Admin", correo("adm")],
          ["Beto", correo("beto")],
        ]),
      );
      expect(
        r.filas.map((f) => [f.fila, f.estado, f.vinculacion, f.correo]),
      ).toEqual([
        [2, "nuevo", "pendiente", correo("carla")],
        [3, "nuevo", "vinculara", correo("ana")],
        [4, "duplicado_archivo", null, correo("carla")],
        [5, "error", null, ""],
        [6, "error", null, correo("nadie")],
        [7, "error", null, "no-es-correo"],
        [8, "revision", null, correo("adm")],
        [9, "revision", null, correo("beto")],
      ]);
      expect(r.filas[2]!.motivo).toBe("Repite el correo de la fila 2.");
      expect(r.resumen).toEqual({
        filas: 8,
        importados: 2,
        vinculados: 1,
        pendientes: 1,
        duplicados: 1,
        conflictos: 0,
        revision: 2,
        errores: 3,
      });
      expect(
        await a.leer(R.importado(huellaCorreo(correo("carla")))),
      ).toBeNull();
      expect((await perfil("ana"))!.marcas).toEqual([]);
    });

    it("confirmar vincula la cuenta existente, deja pendientes y es idempotente", async () => {
      const datos = archivo([
        ["Carla Ruiz", correo("carla")],
        ["Ana Pérez", correo("ana")],
        ["Admin", correo("adm")],
      ]);
      const idImportacion = id();
      const r = await confirmar("zontes", datos, idImportacion);
      expect(r.resumen).toMatchObject({
        importados: 2,
        vinculados: 1,
        pendientes: 1,
        revision: 1,
      });
      expect(await perfil("ana")).toMatchObject({
        marcas: ["zontes"],
        vinculo: "vinculado",
        rol: "cliente",
      });
      // La cuenta administrativa no se convierte ni recibe marcas (punto 13).
      expect(await perfil("adm")).toMatchObject({
        rol: "administrador",
        marcas: [],
      });
      expect(await a.leer(R.importado(huellaCorreo(correo("adm"))))).toBeNull();

      const otra = await confirmar("zontes", datos, idImportacion);
      expect(otra).toEqual({ ...r, repetido: true });
      await expect(
        confirmar("kiden", datos, idImportacion),
      ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });

      const auditoria = await a.consultar<{ accion: string; objetivo: string }>(
        {
          coleccion: "auditoria",
        },
      );
      expect(auditoria.map((x) => x.datos.accion).sort()).toEqual([
        "cliente.actualizado",
        "importacion.confirmada",
      ]);
      expect(JSON.stringify(auditoria)).not.toContain("@");
    });

    it("otra marca suma asociaciones sin reemplazar; reimportar no duplica ni sobrescribe", async () => {
      await confirmar(
        "zontes",
        archivo([
          ["Carla Ruiz", correo("carla")],
          ["Ana Pérez", correo("ana")],
        ]),
      );
      const kiden = await confirmar(
        "kiden",
        archivo([
          ["Carla Ruiz", correo("carla")],
          ["Ana Pérez", correo("ana")],
        ]),
      );
      expect(kiden.resumen).toMatchObject({ importados: 2, vinculados: 1 });
      expect((await perfil("ana"))!.marcas).toEqual(["zontes", "kiden"]);
      const otra = await vistaPrevia(
        a,
        "zontes",
        archivo([
          ["carla  ruiz", correo("carla")],
          ["Carla R. Ruiz", correo("ana")],
        ]),
      );
      expect(
        otra.filas.map((f) => [f.estado, f.vinculacion, f.asociacionesPrevias]),
      ).toEqual([
        ["ya_importado", "pendiente", ["zontes", "kiden"]],
        ["conflicto", "ya_vinculado", ["zontes", "kiden"]],
      ]);
      expect(otra.filas[1]!.motivo).toContain("«Ana Pérez»");
      await confirmar("zontes", archivo([["Carla R. Ruiz", correo("ana")]]));
      const doc = await a.leer<{ marcas: Record<string, { nombre: string }> }>(
        R.importado(huellaCorreo(correo("ana"))),
      );
      expect(doc!.marcas.zontes!.nombre).toBe("Ana Pérez");
    });

    it("el vínculo se completa al registrarse: fuente del registro y lista de pendientes", async () => {
      await confirmar(
        "niu",
        archivo([
          ["Carla Ruiz", correo("carla")],
          ["Dani Soto", correo("dani")],
        ]),
      );
      const fuente = crearFuenteImportacion(a);
      expect(await fuente.buscarPorCorreo(correo("carla"))).toEqual({
        marcas: ["niu"],
      });
      expect(await fuente.buscarPorCorreo(correo("otro"))).toBeNull();
      const antes = await listarPendientes(a, { marca: "niu", limite: 10 });
      expect(antes.items.map((p) => p.correo).sort()).toEqual(
        [correo("carla"), correo("dani")].sort(),
      );
      // Carla se registra (crea su cuenta con el mismo correo verificado).
      await cuenta("carla", "cliente", {
        marcas: ["niu"],
        vinculo: "vinculado",
      });
      const despues = await listarPendientes(a, { marca: "niu", limite: 10 });
      expect(despues.items.map((p) => p.correo)).toEqual([correo("dani")]);
      expect(
        (
          await listarPendientes(a, {
            correo: ` ${correo("dani").toUpperCase()} `,
            limite: 10,
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (await listarPendientes(a, { marca: "kiden", limite: 10 })).items,
      ).toEqual([]);
    });

    it("XLSX, reporte descargable y conservación de 90 días", async () => {
      const xlsx = await aXlsx(
        ["Correo", "Nombre"],
        [
          [correo("eva"), "Eva Luna"],
          ["malo", "Sin correo válido"],
        ],
        "clientes",
      );
      const r = await confirmar("kiden", xlsx);
      expect(r.resumen).toMatchObject({ importados: 1, errores: 1 });
      const { archivo: csv } = await reporteImportacion(a, r.id, "csv", AHORA);
      const texto = csv.toString("utf8");
      expect(texto).toContain("Fila;Nombre;Correo;Resultado;Vinculación");
      expect(texto).toContain(
        `2;Eva Luna;${correo("eva")};Importado;Pendiente de registro`,
      );
      expect(texto).toContain(
        "3;Sin correo válido;malo;Error;;;Correo electrónico inválido.",
      );
      const lista = await listarImportaciones(a, AHORA);
      expect(lista.find((x) => x.id === r.id)).toMatchObject({
        marca: "kiden",
        estado: "completada",
      });
      const vencida = new Date(
        AHORA.getTime() + (DIAS_CONSERVACION + 1) * 86_400_000,
      );
      expect(await purgarVencidas(a, vencida)).toBeGreaterThanOrEqual(1);
      expect(await a.leer(R.importacion(r.id))).toBeNull();
      expect(await a.leer(R.parteImportacion(r.id, 0))).toBeNull();
      await expect(
        reporteImportacion(a, r.id, "csv", AHORA),
      ).rejects.toMatchObject({ status: 404 });
      // Los clientes importados se conservan: sólo vence el reporte.
      expect(
        await a.leer(R.importado(huellaCorreo(correo("eva")))),
      ).not.toBeNull();
    });

    it("exige las columnas nombre y correo y respeta el máximo de filas", async () => {
      await expect(
        vistaPrevia(a, "zontes", Buffer.from("cliente;telefono\nAna;123")),
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
      const muchas = archivo(
        Array.from({ length: 5_001 }, (_, i) => [
          `N${i}`,
          `n${i}@ejemplo.test`,
        ]),
      );
      await expect(vistaPrevia(a, "zontes", muchas)).rejects.toMatchObject({
        code: "TOO_MANY_ROWS",
      });
    });
  });
}

especificacion("memoria", crearAlmacenEnMemoria);

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · importación", () => {
  const prefijos: string[] = [];
  const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));
  especificacion("firestore", () => {
    const prefijo = `prueba_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}_`;
    prefijos.push(prefijo);
    return crearAlmacenFirestore(db(), prefijo);
  });
  afterAll(async () => {
    for (const p of prefijos) {
      for (const c of [
        "usuarios",
        "correos",
        "auditoria",
        "importados",
        "importaciones",
      ]) {
        await db().recursiveDelete(db().collection(`${p}${c}`));
      }
    }
  }, 180_000);
});
