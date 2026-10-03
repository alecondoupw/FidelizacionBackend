import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Almacen } from "../almacen/almacen.js";
import { crearAlmacenFirestore } from "../almacen/firestore.js";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { loadConfig } from "../config/env.js";
import type { Marca } from "../dominio/tipos.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { AppError } from "../http/errors.js";
import { crearFuenteSintetica } from "../legacy/fuente-legacy.js";
import { R } from "../puntos/rutas.js";
import { huellaCorreo } from "../usuarios/correo.js";
import { crearPerfilesAlmacen } from "../usuarios/perfiles-almacen.js";
import {
  actualizarAdministrador,
  crearAdministrador,
  eliminarAdministrador,
  listarAdministradores,
} from "./administradores.js";
import {
  actualizarCliente,
  actualizarNombrePropio,
  detalleCliente,
  eliminarCliente,
  historialDe,
  listarClientes,
} from "./clientes.js";
import { crearCuentasEnMemoria, type ProveedorCuentas } from "./cuentas.js";

/**
 * Especificación de F4 (DEC-03/04/08, RN-01–RN-03) sobre memoria y, con
 * FIRESTORE_INTEGRATION=1, sobre el proyecto de desarrollo. Firebase Auth se
 * sustituye siempre por el doble: las pruebas no crean cuentas reales.
 * Escenarios T-ROLE, T-LINK, T-HISTORY y T-AUTHZ.
 */
function especificacion(nombre: string, crear: () => Almacen) {
  describe(`Identidades · ${nombre}`, () => {
    let almacen: Almacen;
    let cuentas: ReturnType<typeof crearCuentasEnMemoria>;
    const AHORA = new Date("2026-10-03T15:00:00.000Z");
    const run = Math.random().toString(36).slice(2, 8);
    const correo = (n: string) => `${n}.${run}@ejemplo.test`;
    const deps = () => ({
      almacen,
      cuentas,
      fuenteLegacy: crearFuenteSintetica({
        [correo("zontes")]: ["zontes"],
        [correo("kiden")]: ["kiden"],
        [correo("multi")]: ["zontes", "kiden", "niu"],
      }),
    });

    beforeEach(() => {
      almacen = crear();
      cuentas = crearCuentasEnMemoria();
    });

    async function codigoDe(p: Promise<unknown>) {
      try {
        await p;
      } catch (e) {
        if (e instanceof AppError) return e.code;
        throw e;
      }
      return "OK";
    }

    let orden = 0;
    async function sembrar(
      n: string,
      rol: "cliente" | "administrador",
      extra: { marcas?: Marca[]; activo?: boolean } = {},
    ) {
      const { uid } = await cuentas.crear({
        correo: correo(n),
        nombre: `Persona ${n}`,
      });
      const marcas = extra.marcas ?? [];
      await almacen.transaccion(async (tx) => {
        tx.fijar(R.usuario(uid), {
          correo: correo(n),
          rol,
          activo: extra.activo ?? true,
          marcas,
          vinculo: marcas.length ? "vinculado" : "no_vinculado",
          creadoEn: `2026-10-01T00:00:${String(++orden).padStart(2, "0")}.000Z`,
        });
        tx.fijar(R.correo(huellaCorreo(correo(n))), { uid });
      });
      return uid;
    }

    async function auditoria() {
      return (await almacen.consultar({ coleccion: "auditoria" })).map(
        (d) => d.datos,
      );
    }

    // ── Administradores ────────────────────────────────────────────────
    it("crea un administrador por invitación: perfil, índice, auditoría y Auth sin contraseña", async () => {
      const yo = await sembrar("yo", "administrador");
      const nuevo = await crearAdministrador(
        deps(),
        { nombre: "Ana Admin", correo: ` ${correo("ana").toUpperCase()} ` },
        yo,
        AHORA,
      );
      expect(nuevo).toMatchObject({
        nombre: "Ana Admin",
        correo: correo("ana"),
        activo: true,
        invitacionPendiente: true,
      });
      expect(cuentas.cuentas.get(nuevo.uid)?.correoVerificado).toBe(false);
      expect(await almacen.leer(R.correo(huellaCorreo(correo("ana"))))).toEqual(
        {
          uid: nuevo.uid,
        },
      );
      expect(
        await crearPerfilesAlmacen(almacen).obtener(nuevo.uid),
      ).toMatchObject({ rol: "administrador", activo: true });
      const ev = await auditoria();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        accion: "administrador.creado",
        actor: yo,
        objetivo: nuevo.uid,
      });
      expect(JSON.stringify(ev)).not.toContain("@");
      expect((await listarAdministradores(deps())).map((a) => a.uid)).toEqual([
        yo,
        nuevo.uid,
      ]);
    });

    it("un correo de cliente o de una cuenta de Auth sin perfil no se convierte en administrador", async () => {
      const yo = await sembrar("yo", "administrador");
      await sembrar("cli", "cliente");
      await cuentas.crear({ correo: correo("huerfano"), nombre: "X" });
      for (const c of [correo("cli"), correo("huerfano")]) {
        expect(
          await codigoDe(
            crearAdministrador(deps(), { nombre: "X Y", correo: c }, yo, AHORA),
          ),
        ).toBe("EMAIL_IN_USE");
      }
      expect(
        (await listarAdministradores(deps())).map((a) => a.correo),
      ).toEqual([correo("yo")]);
    });

    it("si el perfil no se puede crear, no queda una cuenta de Auth huérfana", async () => {
      const yo = await sembrar("yo", "administrador");
      // Otra operación ocupa el correo entre la comprobación y la transacción.
      const carrera: ProveedorCuentas = {
        ...cuentas,
        async crear(d) {
          const r = await cuentas.crear(d);
          await almacen.transaccion(async (tx) => {
            tx.fijar(R.correo(huellaCorreo(d.correo)), { uid: "otro" });
          });
          return r;
        },
      };
      const antes = cuentas.cuentas.size;
      expect(
        await codigoDe(
          crearAdministrador(
            { ...deps(), cuentas: carrera },
            { nombre: "Ana A", correo: correo("ana") },
            yo,
            AHORA,
          ),
        ),
      ).toBe("EMAIL_IN_USE");
      expect(cuentas.cuentas.size).toBe(antes);
    });

    it("protege al último administrador activo y a uno mismo", async () => {
      const yo = await sembrar("yo", "administrador");
      const otro = await sembrar("otro", "administrador");
      const inactivo = await sembrar("inactivo", "administrador", {
        activo: false,
      });
      // Nadie se desactiva ni se elimina a sí mismo.
      expect(
        await codigoDe(
          actualizarAdministrador(deps(), yo, { activo: false }, yo, AHORA),
        ),
      ).toBe("SELF_ACTION");
      expect(await codigoDe(eliminarAdministrador(deps(), yo, yo, AHORA))).toBe(
        "SELF_ACTION",
      );
      // Desactivar al otro deja a «yo» como único activo.
      await actualizarAdministrador(deps(), otro, { activo: false }, yo, AHORA);
      // Desde la cuenta inactiva (si el control de rol fallara) tampoco se
      // podría dejar el sistema sin administradores.
      expect(
        await codigoDe(
          actualizarAdministrador(
            deps(),
            yo,
            { activo: false },
            inactivo,
            AHORA,
          ),
        ),
      ).toBe("LAST_ADMIN");
      expect(
        await codigoDe(eliminarAdministrador(deps(), yo, inactivo, AHORA)),
      ).toBe("LAST_ADMIN");
      // Un inactivo sí se puede eliminar.
      await eliminarAdministrador(deps(), inactivo, yo, AHORA);
      expect(
        (await listarAdministradores(deps())).map((a) => [a.uid, a.activo]),
      ).toEqual([
        [yo, true],
        [otro, false],
      ]);
    });

    it("dos desactivaciones cruzadas simultáneas no dejan cero administradores activos", async () => {
      const a = await sembrar("a", "administrador");
      const b = await sembrar("b", "administrador");
      const resultados = await Promise.all([
        codigoDe(
          actualizarAdministrador(deps(), b, { activo: false }, a, AHORA),
        ),
        codigoDe(
          actualizarAdministrador(deps(), a, { activo: false }, b, AHORA),
        ),
      ]);
      expect(resultados.sort()).toEqual(["LAST_ADMIN", "OK"]);
      const activos = (await listarAdministradores(deps())).filter(
        (x) => x.activo,
      );
      expect(activos).toHaveLength(1);
    });

    it("eliminar un administrador lo anonimiza, libera el correo y borra la cuenta de Auth", async () => {
      const yo = await sembrar("yo", "administrador");
      const otro = await sembrar("otro", "administrador");
      await eliminarAdministrador(deps(), otro, yo, AHORA);
      expect(cuentas.cuentas.has(otro)).toBe(false);
      expect(
        await almacen.leer(R.correo(huellaCorreo(correo("otro")))),
      ).toBeNull();
      expect(await almacen.leer(R.usuario(otro))).toMatchObject({
        correo: "",
        activo: false,
        eliminado: true,
      });
      expect(await crearPerfilesAlmacen(almacen).obtener(otro)).toMatchObject({
        activo: false,
      });
      expect(
        await codigoDe(eliminarAdministrador(deps(), otro, yo, AHORA)),
      ).toBe("NOT_FOUND");
      // El correo liberado puede volver a usarse.
      const de_nuevo = await crearAdministrador(
        deps(),
        { nombre: "Otro O", correo: correo("otro") },
        yo,
        AHORA,
      );
      expect(de_nuevo.uid).not.toBe(otro);
    });

    it("editar el nombre de un admin cambia Auth y audita sin datos personales", async () => {
      const yo = await sembrar("yo", "administrador");
      const otro = await sembrar("otro", "administrador");
      const r = await actualizarAdministrador(
        deps(),
        otro,
        { nombre: "Nombre Nuevo" },
        yo,
        AHORA,
      );
      expect(r.nombre).toBe("Nombre Nuevo");
      const ev = await auditoria();
      expect(ev).toEqual([
        expect.objectContaining({
          accion: "administrador.actualizado",
          datos: { campos: ["nombre"] },
        }),
      ]);
      // Sin cambios reales no hay evento.
      await actualizarAdministrador(
        deps(),
        otro,
        { nombre: "Nombre Nuevo" },
        yo,
        AHORA,
      );
      expect(await auditoria()).toHaveLength(1);
      // Un cliente no es un administrador editable.
      const cli = await sembrar("cli", "cliente");
      expect(
        await codigoDe(
          actualizarAdministrador(deps(), cli, { activo: false }, yo, AHORA),
        ),
      ).toBe("NOT_FOUND");
    });

    // ── Clientes ───────────────────────────────────────────────────────
    it("lista clientes con filtros de igualdad, marca, paginación y búsqueda exacta por correo", async () => {
      await sembrar("admin", "administrador");
      const z = await sembrar("z", "cliente", { marcas: ["zontes"] });
      const k = await sembrar("k", "cliente", { marcas: ["kiden", "niu"] });
      const sin = await sembrar("sin", "cliente");
      const off = await sembrar("off", "cliente", {
        marcas: ["zontes"],
        activo: false,
      });
      await almacen.transaccion(async (tx) => {
        tx.fijar(R.saldo(k, "kiden"), { disponible: 40, actualizadoEn: "" });
        tx.fijar(R.saldo(k, "niu"), { disponible: 2, actualizadoEn: "" });
      });
      const uids = async (f: Parameters<typeof listarClientes>[1]) =>
        (await listarClientes(deps(), f)).items.map((c) => c.uid).sort();

      expect(await uids({ limite: 50 })).toEqual([z, k, sin, off].sort());
      expect(await uids({ limite: 50, activo: false })).toEqual([off]);
      expect(await uids({ limite: 50, vinculo: "no_vinculado" })).toEqual([
        sin,
      ]);
      expect(await uids({ limite: 50, marca: "zontes" })).toEqual(
        [z, off].sort(),
      );
      expect(await uids({ limite: 50, marca: "zontes", activo: true })).toEqual(
        [z],
      );
      expect(
        await uids({ limite: 50, correo: correo("K").toUpperCase() }),
      ).toEqual([k]);
      expect(await uids({ limite: 50, correo: correo("admin") })).toEqual([]);
      expect(
        await uids({ limite: 50, correo: correo("k"), marca: "zontes" }),
      ).toEqual([]);

      const p1 = await listarClientes(deps(), { limite: 2 });
      const p2 = await listarClientes(deps(), {
        limite: 2,
        cursor: p1.siguiente!,
      });
      expect(p1.items).toHaveLength(2);
      expect([...p1.items, ...p2.items].map((c) => c.uid).sort()).toEqual(
        [z, k, sin, off].sort(),
      );

      const fila = (
        await listarClientes(deps(), { limite: 5, correo: correo("k") })
      ).items[0]!;
      expect(fila).toMatchObject({
        nombre: "Persona k",
        puntos: 42,
        vinculo: "vinculado",
        verificacionPendiente: false,
      });
    });

    it("cambiar el correo recalcula el vínculo sólo por el correo nuevo y conserva saldos", async () => {
      const yo = await sembrar("yo", "administrador");
      const cli = await sembrar("zontes", "cliente", { marcas: ["zontes"] });
      await almacen.transaccion(async (tx) => {
        tx.fijar(R.saldo(cli, "zontes"), { disponible: 30, actualizadoEn: "" });
      });

      const r = await actualizarCliente(
        deps(),
        cli,
        { correo: correo("kiden").toUpperCase() },
        yo,
        AHORA,
      );
      expect(r).toMatchObject({
        correo: correo("kiden"),
        marcas: ["kiden"],
        vinculo: "vinculado",
        verificacionPendiente: true,
        puntos: 0,
      });
      expect(r.saldos).toEqual([
        { marca: "kiden", disponible: 0, vinculada: true },
        { marca: "zontes", disponible: 30, vinculada: false },
      ]);
      expect(cuentas.cuentas.get(cli)).toMatchObject({
        correo: correo("kiden"),
        correoVerificado: false,
      });
      expect(cuentas.revocadas).toEqual([cli]);
      expect(
        await almacen.leer(R.correo(huellaCorreo(correo("zontes")))),
      ).toBeNull();
      expect(
        await almacen.leer(R.correo(huellaCorreo(correo("kiden")))),
      ).toEqual({
        uid: cli,
      });
      const ev = await auditoria();
      expect(ev).toEqual([
        expect.objectContaining({
          accion: "cliente.actualizado",
          objetivo: cli,
          datos: {
            campos: ["correo"],
            vinculo: { antes: "vinculado", despues: "vinculado" },
            marcas: { antes: ["zontes"], despues: ["kiden"] },
          },
        }),
      ]);
      expect(JSON.stringify(ev)).not.toContain("@");

      // Volver al correo original vuelve a mostrar el saldo de Zontes.
      const vuelta = await actualizarCliente(
        deps(),
        cli,
        { correo: correo("zontes") },
        yo,
        AHORA,
      );
      expect(vuelta.puntos).toBe(30);

      // Sin coincidencia queda no vinculado.
      const nada = await actualizarCliente(
        deps(),
        cli,
        { correo: correo("desconocido") },
        yo,
        AHORA,
      );
      expect(nada).toMatchObject({ marcas: [], vinculo: "no_vinculado" });
    });

    it("un correo ocupado se rechaza y Auth no queda con el correo nuevo", async () => {
      const yo = await sembrar("yo", "administrador");
      const a = await sembrar("a", "cliente");
      await sembrar("b", "cliente");
      expect(
        await codigoDe(
          actualizarCliente(deps(), a, { correo: correo("b") }, yo, AHORA),
        ),
      ).toBe("EMAIL_IN_USE");
      // Ocupado sólo en Auth (cuenta sin perfil): Auth lo rechaza.
      await cuentas.crear({ correo: correo("solo-auth"), nombre: "S" });
      expect(
        await codigoDe(
          actualizarCliente(
            deps(),
            a,
            { correo: correo("solo-auth") },
            yo,
            AHORA,
          ),
        ),
      ).toBe("EMAIL_IN_USE");
      expect(cuentas.cuentas.get(a)?.correo).toBe(correo("a"));
      expect(await auditoria()).toHaveLength(0);
    });

    it("activa, desactiva y edita el nombre con un único evento por operación", async () => {
      const yo = await sembrar("yo", "administrador");
      const cli = await sembrar("c", "cliente", { marcas: ["niu"] });
      const r = await actualizarCliente(
        deps(),
        cli,
        { nombre: "Nuevo Nombre", activo: false },
        yo,
        AHORA,
      );
      expect(r).toMatchObject({ nombre: "Nuevo Nombre", activo: false });
      expect(await auditoria()).toEqual([
        expect.objectContaining({
          datos: {
            campos: ["nombre", "activo"],
            activo: { antes: true, despues: false },
          },
        }),
      ]);
      expect(await crearPerfilesAlmacen(almacen).obtener(cli)).toMatchObject({
        activo: false,
      });
      expect(
        await codigoDe(
          actualizarCliente(deps(), yo, { activo: false }, yo, AHORA),
        ),
      ).toBe("NOT_FOUND");
    });

    it("eliminar un cliente lo anonimiza y conserva movimientos, canjes y auditoría", async () => {
      const yo = await sembrar("yo", "administrador");
      const cli = await sembrar("zontes", "cliente", { marcas: ["zontes"] });
      await almacen.transaccion(async (tx) => {
        tx.fijar(R.saldo(cli, "zontes"), { disponible: 10, actualizadoEn: "" });
        tx.fijar(`${R.movimientos(cli, "zontes")}/m1`, {
          tipo: "otorgamiento",
          puntos: 10,
        });
        tx.fijar(R.canje(cli, "c1"), { codigo: "ML-AAAA-BBBB-CC" });
      });
      await eliminarCliente(deps(), cli, yo, AHORA);

      expect(cuentas.cuentas.has(cli)).toBe(false);
      expect(await almacen.leer(R.usuario(cli))).toMatchObject({
        correo: "",
        activo: false,
        eliminado: true,
        marcas: ["zontes"],
      });
      expect(
        await almacen.leer(R.correo(huellaCorreo(correo("zontes")))),
      ).toBeNull();
      expect(await almacen.leer(R.saldo(cli, "zontes"))).toMatchObject({
        disponible: 10,
      });
      expect(
        await almacen.leer(`${R.movimientos(cli, "zontes")}/m1`),
      ).not.toBeNull();
      expect(await almacen.leer(R.canje(cli, "c1"))).not.toBeNull();
      expect((await listarClientes(deps(), { limite: 50 })).items).toEqual([]);
      expect(await codigoDe(detalleCliente(deps(), cli))).toBe("NOT_FOUND");
      expect(await codigoDe(eliminarCliente(deps(), cli, yo, AHORA))).toBe(
        "NOT_FOUND",
      );
      const ev = await auditoria();
      expect(ev).toEqual([
        expect.objectContaining({
          accion: "cliente.eliminado",
          datos: { marcas: ["zontes"], vinculo: "vinculado" },
        }),
      ]);
    });

    it("el historial de una persona reúne sus eventos del más reciente al más antiguo con el nombre del actor", async () => {
      const yo = await sembrar("yo", "administrador");
      const cli = await sembrar("c", "cliente");
      await almacen.transaccion(async (tx) => {
        // Formato de F1 (`objetivoUid`).
        tx.fijar(R.auditoria("f1"), {
          accion: "cliente.registrado",
          actor: cli,
          objetivoUid: cli,
          en: "2026-10-01T00:00:00.000Z",
          datos: {},
        });
      });
      await actualizarNombrePropio(deps(), cli, "Yo Mismo", AHORA);
      await actualizarCliente(
        deps(),
        cli,
        { activo: false },
        yo,
        new Date("2026-10-04T00:00:00.000Z"),
      );
      const h = await historialDe(deps(), cli);
      expect(h.map((e) => [e.accion, e.actorNombre])).toEqual([
        ["cliente.actualizado", "Persona yo"],
        ["perfil.actualizado", "Yo Mismo"],
        ["cliente.registrado", "Yo Mismo"],
      ]);
      expect(cuentas.cuentas.get(cli)?.nombre).toBe("Yo Mismo");
    });
  });
}

especificacion("memoria", crearAlmacenEnMemoria);

const integracion = process.env.FIRESTORE_INTEGRATION === "1";
describe.runIf(integracion)("integración Firestore · identidades", () => {
  const prefijos: string[] = [];
  const db = () => getFirestore(getFirebaseAdminApp(loadConfig()));
  // Un prefijo por prueba: las consultas de administradores activos no se mezclan.
  especificacion("firestore", () => {
    const prefijo = `prueba_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}_`;
    prefijos.push(prefijo);
    return crearAlmacenFirestore(db(), prefijo);
  });
  afterAll(async () => {
    for (const prefijo of prefijos) {
      for (const c of ["usuarios", "correos", "auditoria"]) {
        await db().recursiveDelete(db().collection(`${prefijo}${c}`));
      }
    }
  }, 120_000);
});
