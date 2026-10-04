import type { Almacen, Filtro, Transaccion } from "../almacen/almacen.js";
import type { Marca, Perfil, Vinculo } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import type { FuenteLegacy } from "../legacy/fuente-legacy.js";
import { auditar } from "../puntos/auditoria.js";
import { R } from "../puntos/rutas.js";
import type { SaldoMarca } from "../puntos/tipos.js";
import { huellaCorreo, normalizarCorreo } from "../usuarios/correo.js";
import { aPerfil, datosDePerfil } from "../usuarios/perfiles-almacen.js";
import { importacionDe } from "../importacion/importacion.js";
import type { DepsIdentidad } from "./administradores.js";
import type { ProveedorCuentas } from "./cuentas.js";

/** Fila de UI-07 (A01). `puntos` = saldo disponible en las marcas vinculadas. */
export interface ClienteVista {
  uid: string;
  nombre: string | null;
  correo: string;
  marcas: Marca[];
  vinculo: Vinculo;
  activo: boolean;
  puntos: number;
  creadoEn: string;
  ultimoAcceso: string | null;
  /** Cambió el correo y aún no verificó el nuevo (DEC-04). */
  verificacionPendiente: boolean;
}

export interface SaldoClienteMarca {
  marca: Marca;
  disponible: number;
  /** false: la marca dejó de coincidir con el correo; el saldo se conserva (DEC-04). */
  vinculada: boolean;
}

export interface FiltroClientes {
  correo?: string;
  marca?: Marca;
  activo?: boolean;
  vinculo?: Vinculo;
  limite: number;
  cursor?: string;
}

const noEncontrado = () =>
  new AppError(404, "NOT_FOUND", "El cliente no existe.");

async function leerCliente(lector: Pick<Transaccion, "leer">, uid: string) {
  const datos = await lector.leer(R.usuario(uid));
  const p = datos ? aPerfil(uid, datos) : null;
  if (!p || p.rol !== "cliente" || p.eliminado) throw noEncontrado();
  return p;
}

async function saldos(
  almacen: Almacen,
  p: Perfil,
): Promise<SaldoClienteMarca[]> {
  const docs = await almacen.consultar<SaldoMarca>({
    coleccion: `usuarios/${p.uid}/marcas`,
  });
  const porMarca = new Map(docs.map((d) => [d.id, d.datos.disponible]));
  const marcas = [
    ...p.marcas,
    ...[...porMarca.keys()].filter(
      (m): m is Marca => !p.marcas.includes(m as Marca),
    ),
  ];
  return marcas.map((marca) => ({
    marca,
    disponible: porMarca.get(marca) ?? 0,
    vinculada: p.marcas.includes(marca),
  }));
}

async function vistas(
  deps: DepsIdentidad,
  perfiles: Perfil[],
): Promise<ClienteVista[]> {
  const [auth, todosSaldos] = await Promise.all([
    deps.cuentas.obtener(perfiles.map((p) => p.uid)),
    Promise.all(perfiles.map((p) => saldos(deps.almacen, p))),
  ]);
  return perfiles.map((p, i) => {
    const c = auth.get(p.uid);
    return {
      uid: p.uid,
      nombre: c?.nombre ?? null,
      correo: p.correo,
      marcas: p.marcas,
      vinculo: p.vinculo,
      activo: p.activo,
      puntos: todosSaldos[i]!.filter((s) => s.vinculada).reduce(
        (t, s) => t + s.disponible,
        0,
      ),
      creadoEn: p.creadoEn,
      ultimoAcceso: c?.ultimoAcceso ?? null,
      verificacionPendiente: p.verificarCorreo === true,
    };
  });
}

/**
 * UI-07 (SRC-02 p. 3): búsqueda exacta por correo normalizado (el mismo
 * índice del vínculo) o lista paginada con filtros de igualdad. Sin índices
 * compuestos: no hay búsqueda parcial por nombre.
 */
export async function listarClientes(
  deps: DepsIdentidad,
  f: FiltroClientes,
): Promise<{ items: ClienteVista[]; siguiente: string | null }> {
  if (f.correo) {
    const indice = await deps.almacen.leer<{ uid: string }>(
      R.correo(huellaCorreo(normalizarCorreo(f.correo))),
    );
    const datos = indice
      ? await deps.almacen.leer(R.usuario(indice.uid))
      : null;
    const p = datos && indice ? aPerfil(indice.uid, datos) : null;
    const coincide =
      p &&
      p.rol === "cliente" &&
      !p.eliminado &&
      (f.marca === undefined || p.marcas.includes(f.marca)) &&
      (f.activo === undefined || p.activo === f.activo) &&
      (f.vinculo === undefined || p.vinculo === f.vinculo);
    return { items: coincide ? await vistas(deps, [p]) : [], siguiente: null };
  }

  const donde: Filtro[] = [["rol", "==", "cliente"]];
  if (f.activo !== undefined) donde.push(["activo", "==", f.activo]);
  if (f.vinculo) donde.push(["vinculo", "==", f.vinculo]);
  if (f.marca) donde.push(["marcas", "array-contains", f.marca]);
  const docs = await deps.almacen.consultar({
    coleccion: "usuarios",
    donde,
    ordenId: "asc",
    despuesDeId: f.cursor,
    limite: f.limite,
  });
  const perfiles = docs
    .map((d) => aPerfil(d.id, d.datos))
    .filter((p) => !p.eliminado);
  return {
    items: await vistas(deps, perfiles),
    siguiente: docs.length === f.limite ? docs.at(-1)!.id : null,
  };
}

export interface EventoHistorial {
  accion: string;
  actor: string;
  actorNombre: string | null;
  en: string;
  datos: Record<string, unknown>;
}

/**
 * Auditoría de una persona (F4-BE-03): eventos cuyo objetivo es el uid.
 * F1 guardó `objetivoUid`; F2–F4 guardan `objetivo`.
 */
export async function historialDe(
  deps: DepsIdentidad,
  uid: string,
  limite = 50,
): Promise<EventoHistorial[]> {
  const [a, b] = await Promise.all([
    deps.almacen.consultar<Record<string, unknown>>({
      coleccion: "auditoria",
      donde: [["objetivo", "==", uid]],
    }),
    deps.almacen.consultar<Record<string, unknown>>({
      coleccion: "auditoria",
      donde: [["objetivoUid", "==", uid]],
    }),
  ]);
  const eventos = [...a, ...b]
    .map((d) => d.datos)
    .sort((x, y) => String(y.en).localeCompare(String(x.en)))
    .slice(0, limite);
  const actores = await nombresDe(
    deps.cuentas,
    eventos.map((e) => String(e.actor)),
  );
  return eventos.map((e) => ({
    accion: String(e.accion),
    actor: String(e.actor),
    actorNombre: actores.get(String(e.actor)) ?? null,
    en: String(e.en),
    datos: (e.datos ?? {}) as Record<string, unknown>,
  }));
}

async function nombresDe(cuentas: ProveedorCuentas, actores: string[]) {
  // `bootstrap`, `carga-inicial` o `api:sistema` no son cuentas de Auth.
  const uids = [...new Set(actores)].filter(
    (a) =>
      /^[A-Za-z0-9_-]{1,128}$/.test(a) &&
      !["bootstrap", "carga-inicial"].includes(a),
  );
  const cuentasAuth = await cuentas.obtener(uids);
  return new Map(
    [...cuentasAuth.values()].map((c) => [c.uid, c.nombre ?? c.correo]),
  );
}

export async function detalleCliente(deps: DepsIdentidad, uid: string) {
  const p = await leerCliente(deps.almacen, uid);
  const [[vista], porMarca, historial, importadas] = await Promise.all([
    vistas(deps, [p]),
    saldos(deps.almacen, p),
    historialDe(deps, uid),
    importacionDe(deps.almacen, p.correo),
  ]);
  // Marcas en que su correo figura en una importación (SRC-06 p. 1 punto 11).
  return { ...vista!, saldos: porMarca, historial, importadas };
}

/**
 * Edición permitida (DEC-08): nombre, correo y estado. Cambiar el correo
 * recalcula el vínculo sólo con el correo nuevo (DEC-04, ADR-04), lo deja
 * pendiente de verificación y cierra las sesiones abiertas. Un único evento
 * de auditoría por operación, sin correos.
 */
export async function actualizarCliente(
  deps: DepsIdentidad & { fuenteLegacy: FuenteLegacy },
  uid: string,
  cambios: { nombre?: string; correo?: string; activo?: boolean },
  actor: string,
  ahora: Date,
) {
  const actual = await leerCliente(deps.almacen, uid);
  const nombreAnterior =
    (await deps.cuentas.obtener([uid])).get(uid)?.nombre ?? null;
  const correoNuevo =
    cambios.correo !== undefined ? normalizarCorreo(cambios.correo) : undefined;
  const cambiaCorreo =
    correoNuevo !== undefined && correoNuevo !== actual.correo;
  const cambiaNombre =
    cambios.nombre !== undefined && cambios.nombre !== nombreAnterior;
  const cambiaActivo =
    cambios.activo !== undefined && cambios.activo !== actual.activo;
  if (!cambiaCorreo && !cambiaNombre && !cambiaActivo) {
    return detalleCliente(deps, uid);
  }

  const enUso = () =>
    new AppError(409, "EMAIL_IN_USE", "Ese correo ya pertenece a otra cuenta.");
  let legado: { marcas: Marca[] } | null = null;
  if (cambiaCorreo) {
    if (await deps.almacen.leer(R.correo(huellaCorreo(correoNuevo)))) {
      throw enUso();
    }
    legado = await deps.fuenteLegacy.buscarPorCorreo(correoNuevo);
    await deps.cuentas.actualizar(uid, { correo: correoNuevo });
  }
  if (cambiaNombre)
    await deps.cuentas.actualizar(uid, { nombre: cambios.nombre });

  try {
    await deps.almacen.transaccion(async (tx) => {
      const p = await leerCliente(tx, uid);
      if (
        cambiaCorreo &&
        (await tx.leer(R.correo(huellaCorreo(correoNuevo))))
      ) {
        throw enUso();
      }
      const nuevo: Perfil = { ...p, activo: cambios.activo ?? p.activo };
      if (cambiaCorreo) {
        nuevo.correo = correoNuevo;
        nuevo.marcas = legado?.marcas ?? [];
        nuevo.vinculo = legado ? "vinculado" : "no_vinculado";
        nuevo.verificarCorreo = true;
        tx.borrar(R.correo(huellaCorreo(p.correo)));
        tx.crear(R.correo(huellaCorreo(correoNuevo)), { uid });
      }
      if (cambiaCorreo || nuevo.activo !== p.activo) {
        tx.fijar(R.usuario(uid), datosDePerfil(nuevo));
      }
      auditar(tx, deps.almacen.nuevoId(), {
        accion: "cliente.actualizado",
        actor,
        objetivo: uid,
        en: ahora.toISOString(),
        datos: {
          campos: [
            ...(cambiaNombre ? ["nombre"] : []),
            ...(cambiaCorreo ? ["correo"] : []),
            ...(nuevo.activo !== p.activo ? ["activo"] : []),
          ],
          ...(cambiaCorreo
            ? {
                vinculo: { antes: p.vinculo, despues: nuevo.vinculo },
                marcas: { antes: p.marcas, despues: nuevo.marcas },
              }
            : {}),
          ...(nuevo.activo !== p.activo
            ? { activo: { antes: p.activo, despues: nuevo.activo } }
            : {}),
        },
      });
    });
  } catch (error) {
    // Auth ya tiene el correo nuevo: se devuelve al anterior para no divergir.
    if (cambiaCorreo) {
      await deps.cuentas.actualizar(uid, { correo: actual.correo });
    }
    throw error;
  }
  if (cambiaCorreo) await deps.cuentas.revocarSesiones(uid);
  return detalleCliente(deps, uid);
}

/**
 * Eliminar = baja + anonimización (DEC-08): se borra la cuenta de Auth, se
 * libera el correo y el perfil queda sin datos personales; movimientos,
 * canjes y auditoría se conservan con el uid para que reportes y saldos
 * históricos sigan cuadrando. Irreversible.
 */
export async function eliminarCliente(
  deps: DepsIdentidad,
  uid: string,
  actor: string,
  ahora: Date,
): Promise<void> {
  await deps.almacen.transaccion(async (tx) => {
    const p = await leerCliente(tx, uid);
    const resto: Perfil = { ...p };
    delete resto.verificarCorreo;
    tx.fijar(
      R.usuario(uid),
      datosDePerfil({ ...resto, correo: "", activo: false, eliminado: true }),
    );
    tx.borrar(R.correo(huellaCorreo(p.correo)));
    auditar(tx, deps.almacen.nuevoId(), {
      accion: "cliente.eliminado",
      actor,
      objetivo: uid,
      en: ahora.toISOString(),
      datos: { marcas: p.marcas, vinculo: p.vinculo },
    });
  });
  await deps.cuentas.eliminar(uid);
}

/** El cliente o admin cambia su propio nombre (DEC-08); un evento de auditoría. */
export async function actualizarNombrePropio(
  deps: DepsIdentidad,
  uid: string,
  nombre: string,
  ahora: Date,
): Promise<void> {
  await deps.cuentas.actualizar(uid, { nombre });
  await deps.almacen.transaccion(async (tx) => {
    auditar(tx, deps.almacen.nuevoId(), {
      accion: "perfil.actualizado",
      actor: uid,
      objetivo: uid,
      en: ahora.toISOString(),
      datos: { campos: ["nombre"] },
    });
  });
}
