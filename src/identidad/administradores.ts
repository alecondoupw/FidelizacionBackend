import type { Almacen, Transaccion } from "../almacen/almacen.js";
import type { Perfil } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { auditar } from "../puntos/auditoria.js";
import { R } from "../puntos/rutas.js";
import { huellaCorreo, normalizarCorreo } from "../usuarios/correo.js";
import { aPerfil, datosDePerfil } from "../usuarios/perfiles-almacen.js";
import type { ProveedorCuentas } from "./cuentas.js";

export interface DepsIdentidad {
  almacen: Almacen;
  cuentas: ProveedorCuentas;
}

/** Fila de UI-06 (A03): sin contraseñas ni tokens. */
export interface AdministradorVista {
  uid: string;
  nombre: string | null;
  correo: string;
  activo: boolean;
  creadoEn: string;
  ultimoAcceso: string | null;
  /** Nunca inició sesión: la invitación sigue pendiente. */
  invitacionPendiente: boolean;
}

const noEncontrado = () =>
  new AppError(404, "NOT_FOUND", "El administrador no existe.");

const ultimoActivo = () =>
  new AppError(
    409,
    "LAST_ADMIN",
    "Debe existir al menos un administrador activo.",
  );

async function vistas(
  cuentas: ProveedorCuentas,
  perfiles: Perfil[],
): Promise<AdministradorVista[]> {
  const auth = await cuentas.obtener(perfiles.map((p) => p.uid));
  return perfiles.map((p) => {
    const c = auth.get(p.uid);
    return {
      uid: p.uid,
      nombre: c?.nombre ?? null,
      correo: p.correo,
      activo: p.activo,
      creadoEn: p.creadoEn,
      ultimoAcceso: c?.ultimoAcceso ?? null,
      invitacionPendiente: !c?.ultimoAcceso,
    };
  });
}

async function leerAdmin(lector: Pick<Transaccion, "leer">, uid: string) {
  const datos = await lector.leer(R.usuario(uid));
  const p = datos ? aPerfil(uid, datos) : null;
  if (!p || p.rol !== "administrador" || p.eliminado) throw noEncontrado();
  return p;
}

/**
 * Otros administradores activos leídos dentro de la transacción: Firestore
 * bloquea esos documentos, así que dos desactivaciones cruzadas simultáneas
 * no pueden dejar cero administradores activos (RN-02).
 */
async function otrosActivos(tx: Transaccion, uid: string) {
  const activos = await tx.consultar({
    coleccion: "usuarios",
    donde: [
      ["rol", "==", "administrador"],
      ["activo", "==", true],
    ],
  });
  return activos.filter((d) => d.id !== uid && d.datos.eliminado !== true);
}

/** UI-06: administradores no eliminados (SRC-02 pp. 2–3). */
export async function listarAdministradores(
  deps: DepsIdentidad,
): Promise<AdministradorVista[]> {
  const docs = await deps.almacen.consultar({
    coleccion: "usuarios",
    donde: [["rol", "==", "administrador"]],
  });
  const perfiles = docs
    .map((d) => aPerfil(d.id, d.datos))
    .filter((p) => !p.eliminado)
    .sort((a, b) => a.creadoEn.localeCompare(b.creadoEn));
  return vistas(deps.cuentas, perfiles);
}

/**
 * Alta por invitación (DEC-03 en F4): cuenta de Auth sin contraseña y perfil
 * de administrador. El correo de Firebase para definir la contraseña lo pide
 * el navegador del admin con el SDK cliente. Un correo de cliente nunca se
 * promueve, ni se adopta una cuenta de Auth existente sin perfil.
 */
export async function crearAdministrador(
  deps: DepsIdentidad,
  datos: { nombre: string; correo: string },
  actor: string,
  ahora: Date,
): Promise<AdministradorVista> {
  const correo = normalizarCorreo(datos.correo);
  const enUso = () =>
    new AppError(
      409,
      "EMAIL_IN_USE",
      "Ese correo ya pertenece a otra cuenta. Un cliente no puede convertirse en administrador.",
    );
  if (await deps.almacen.leer(R.correo(huellaCorreo(correo)))) throw enUso();
  if (await deps.cuentas.buscarPorCorreo(correo)) throw enUso();

  const { uid } = await deps.cuentas.crear({ correo, nombre: datos.nombre });
  const en = ahora.toISOString();
  const perfil: Perfil = {
    uid,
    correo,
    rol: "administrador",
    activo: true,
    marcas: [],
    vinculo: "no_vinculado",
    creadoEn: en,
  };
  try {
    await deps.almacen.transaccion(async (tx) => {
      if (await tx.leer(R.correo(huellaCorreo(correo)))) throw enUso();
      tx.crear(R.usuario(uid), datosDePerfil(perfil));
      tx.crear(R.correo(huellaCorreo(correo)), { uid });
      auditar(tx, deps.almacen.nuevoId(), {
        accion: "administrador.creado",
        actor,
        objetivo: uid,
        en,
        datos: {},
      });
    });
  } catch (error) {
    // Sin perfil no debe quedar una cuenta de Auth huérfana.
    await deps.cuentas.eliminar(uid);
    throw error;
  }
  const [vista] = await vistas(deps.cuentas, [perfil]);
  return vista!;
}

/** Edición permitida: nombre y estado (SRC-02 p. 3). El correo de un admin no se edita en F4. */
export async function actualizarAdministrador(
  deps: DepsIdentidad,
  uid: string,
  cambios: { nombre?: string; activo?: boolean },
  actor: string,
  ahora: Date,
): Promise<AdministradorVista> {
  if (uid === actor && cambios.activo === false) {
    throw new AppError(
      409,
      "SELF_ACTION",
      "No puedes desactivar tu propia cuenta.",
    );
  }
  const actual = await leerAdmin(deps.almacen, uid);
  const anterior = (await deps.cuentas.obtener([uid])).get(uid)?.nombre ?? null;
  const cambiaNombre =
    cambios.nombre !== undefined && cambios.nombre !== anterior;
  const cambiaActivo =
    cambios.activo !== undefined && cambios.activo !== actual.activo;
  if (!cambiaNombre && !cambiaActivo) {
    return (await vistas(deps.cuentas, [actual]))[0]!;
  }
  if (cambiaNombre) {
    await deps.cuentas.actualizar(uid, { nombre: cambios.nombre });
  }

  const perfil = await deps.almacen.transaccion(async (tx) => {
    const p = await leerAdmin(tx, uid);
    const activo = cambios.activo ?? p.activo;
    if (p.activo && !activo && (await otrosActivos(tx, uid)).length === 0) {
      throw ultimoActivo();
    }
    const nuevo = { ...p, activo };
    if (activo !== p.activo) tx.fijar(R.usuario(uid), datosDePerfil(nuevo));
    auditar(tx, deps.almacen.nuevoId(), {
      accion: "administrador.actualizado",
      actor,
      objetivo: uid,
      en: ahora.toISOString(),
      datos: {
        campos: [
          ...(cambiaNombre ? ["nombre"] : []),
          ...(activo !== p.activo ? ["activo"] : []),
        ],
        ...(activo !== p.activo
          ? { antes: { activo: p.activo }, despues: { activo } }
          : {}),
      },
    });
    return nuevo;
  });
  return (await vistas(deps.cuentas, [perfil]))[0]!;
}

/**
 * Eliminación confirmada (SRC-02 p. 3): el perfil queda anonimizado para el
 * historial, se libera el correo y se borra la cuenta de Auth. Nunca el
 * propio ni el último administrador activo.
 */
export async function eliminarAdministrador(
  deps: DepsIdentidad,
  uid: string,
  actor: string,
  ahora: Date,
): Promise<void> {
  if (uid === actor) {
    throw new AppError(
      409,
      "SELF_ACTION",
      "No puedes eliminar tu propia cuenta.",
    );
  }
  await deps.almacen.transaccion(async (tx) => {
    const p = await leerAdmin(tx, uid);
    if (p.activo && (await otrosActivos(tx, uid)).length === 0) {
      throw ultimoActivo();
    }
    tx.fijar(
      R.usuario(uid),
      datosDePerfil({ ...p, correo: "", activo: false, eliminado: true }),
    );
    tx.borrar(R.correo(huellaCorreo(p.correo)));
    auditar(tx, deps.almacen.nuevoId(), {
      accion: "administrador.eliminado",
      actor,
      objetivo: uid,
      en: ahora.toISOString(),
      datos: { estabaActivo: p.activo },
    });
  });
  await deps.cuentas.eliminar(uid);
}
