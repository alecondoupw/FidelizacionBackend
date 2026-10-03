import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { CuentasAuth } from "../admin/bootstrap.js";
import { loadConfig } from "../config/env.js";
import { getFirebaseAdminApp } from "../firebase/admin.js";
import { crearPerfilesFirestore } from "../usuarios/perfiles-firestore.js";

/** Conexión común de los comandos de operación (los ejecuta Paulo, no la API). */
export function conectarFirebase() {
  const config = loadConfig();
  const app = getFirebaseAdminApp(config);
  const auth = getAuth(app);
  return {
    config,
    auth,
    cuentas: crearCuentasAuth(auth),
    perfiles: crearPerfilesFirestore(getFirestore(app), config.firestorePrefix),
  };
}

export function crearCuentasAuth(auth: Auth): CuentasAuth {
  return {
    async buscarPorCorreo(correo) {
      try {
        return { uid: (await auth.getUserByEmail(correo)).uid };
      } catch (error) {
        if ((error as { code?: string }).code === "auth/user-not-found")
          return null;
        throw error;
      }
    },
    async crear(correo) {
      return { uid: (await auth.createUser({ email: correo })).uid };
    },
    enlaceDefinirContrasena: (correo) => auth.generatePasswordResetLink(correo),
  };
}

export function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
