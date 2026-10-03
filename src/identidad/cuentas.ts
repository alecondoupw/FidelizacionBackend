import type { Auth, UserRecord } from "firebase-admin/auth";
import { AppError } from "../http/errors.js";

/** Datos de Firebase Auth que muestra la administración (nombre y último acceso viven en Auth). */
export interface CuentaAuth {
  uid: string;
  nombre: string | null;
  correo: string | null;
  correoVerificado: boolean;
  /** ISO 8601 UTC o null si nunca inició sesión. */
  ultimoAcceso: string | null;
}

/**
 * Operaciones de Firebase Auth de F4 (DEC-03/04/08). Sólo Express las usa;
 * el navegador nunca crea, edita ni borra cuentas de otras personas.
 */
export interface ProveedorCuentas {
  obtener(uids: string[]): Promise<Map<string, CuentaAuth>>;
  buscarPorCorreo(correo: string): Promise<{ uid: string } | null>;
  /** Cuenta sin contraseña: la persona la define con el correo de Firebase (invitación). */
  crear(datos: { correo: string; nombre: string }): Promise<{ uid: string }>;
  /** Cambiar el correo lo deja sin verificar. */
  actualizar(
    uid: string,
    cambios: { nombre?: string; correo?: string },
  ): Promise<void>;
  /** Idempotente: una cuenta ya borrada no es error. */
  eliminar(uid: string): Promise<void>;
  /** Invalida las sesiones abiertas (tokens con checkRevoked). */
  revocarSesiones(uid: string): Promise<void>;
}

const correoEnUso = () =>
  new AppError(409, "EMAIL_IN_USE", "Ese correo ya pertenece a otra cuenta.");

const codigo = (e: unknown) => (e as { code?: unknown }).code;

function aCuenta(u: UserRecord): CuentaAuth {
  const ultimo = u.metadata.lastSignInTime;
  return {
    uid: u.uid,
    nombre: u.displayName ?? null,
    correo: u.email ?? null,
    correoVerificado: u.emailVerified,
    ultimoAcceso: ultimo ? new Date(ultimo).toISOString() : null,
  };
}

export function crearCuentasFirebase(auth: Auth): ProveedorCuentas {
  return {
    async obtener(uids) {
      const mapa = new Map<string, CuentaAuth>();
      for (let i = 0; i < uids.length; i += 100) {
        const r = await auth.getUsers(
          uids.slice(i, i + 100).map((uid) => ({ uid })),
        );
        for (const u of r.users) mapa.set(u.uid, aCuenta(u));
      }
      return mapa;
    },
    async buscarPorCorreo(correo) {
      try {
        return { uid: (await auth.getUserByEmail(correo)).uid };
      } catch (e) {
        if (codigo(e) === "auth/user-not-found") return null;
        throw e;
      }
    },
    async crear({ correo, nombre }) {
      try {
        const u = await auth.createUser({
          email: correo,
          displayName: nombre,
          emailVerified: false,
        });
        return { uid: u.uid };
      } catch (e) {
        if (codigo(e) === "auth/email-already-exists") throw correoEnUso();
        throw e;
      }
    },
    async actualizar(uid, { nombre, correo }) {
      try {
        await auth.updateUser(uid, {
          ...(nombre !== undefined ? { displayName: nombre } : {}),
          ...(correo !== undefined
            ? { email: correo, emailVerified: false }
            : {}),
        });
      } catch (e) {
        if (codigo(e) === "auth/email-already-exists") throw correoEnUso();
        throw e;
      }
    },
    async eliminar(uid) {
      try {
        await auth.deleteUser(uid);
      } catch (e) {
        if (codigo(e) !== "auth/user-not-found") throw e;
      }
    },
    revocarSesiones: (uid) => auth.revokeRefreshTokens(uid),
  };
}

/** Doble en memoria con las mismas reglas (correo único, borrado idempotente). */
export function crearCuentasEnMemoria(
  iniciales: CuentaAuth[] = [],
): ProveedorCuentas & {
  cuentas: Map<string, CuentaAuth>;
  revocadas: string[];
} {
  const cuentas = new Map(iniciales.map((c) => [c.uid, { ...c }]));
  const revocadas: string[] = [];
  let n = 0;
  const ocupado = (correo: string, salvo?: string) =>
    [...cuentas.values()].some((c) => c.correo === correo && c.uid !== salvo);
  return {
    cuentas,
    revocadas,
    async obtener(uids) {
      return new Map(
        uids.flatMap((uid) => {
          const c = cuentas.get(uid);
          return c ? [[uid, { ...c }] as const] : [];
        }),
      );
    },
    async buscarPorCorreo(correo) {
      const c = [...cuentas.values()].find((x) => x.correo === correo);
      return c ? { uid: c.uid } : null;
    },
    async crear({ correo, nombre }) {
      if (ocupado(correo)) throw correoEnUso();
      const uid = `auth-${++n}`;
      cuentas.set(uid, {
        uid,
        nombre,
        correo,
        correoVerificado: false,
        ultimoAcceso: null,
      });
      return { uid };
    },
    async actualizar(uid, { nombre, correo }) {
      const c = cuentas.get(uid);
      if (!c) throw new Error(`auth/user-not-found ${uid}`);
      if (correo !== undefined && ocupado(correo, uid)) throw correoEnUso();
      if (nombre !== undefined) c.nombre = nombre;
      if (correo !== undefined) {
        c.correo = correo;
        c.correoVerificado = false;
      }
    },
    async eliminar(uid) {
      cuentas.delete(uid);
    },
    async revocarSesiones(uid) {
      revocadas.push(uid);
    },
  };
}
