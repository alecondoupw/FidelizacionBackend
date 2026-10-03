import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { TokenVerifier } from "./auth/token-verifier.js";
import { crearVerificadorFirebase } from "./auth/token-verifier.js";
import type { AppConfig } from "./config/env.js";
import { getFirebaseAdminApp } from "./firebase/admin.js";
import { AppError } from "./http/errors.js";
import {
  crearFuenteSintetica,
  type FuenteLegacy,
} from "./legacy/fuente-legacy.js";
import type { PerfilRepository } from "./usuarios/perfiles.js";
import { crearPerfilesFirestore } from "./usuarios/perfiles-firestore.js";

/** Puertos que usan las rutas; las pruebas inyectan dobles. */
export interface Dependencias {
  tokenVerifier: TokenVerifier;
  perfiles: PerfilRepository;
  fuenteLegacy: FuenteLegacy;
  reloj: () => Date;
}

/**
 * Con FIREBASE_PROJECT_ID: Admin SDK (inicializado al primer uso) + Firestore.
 * Sin él: el servidor arranca y toda ruta protegida responde 503.
 */
export function crearDependencias(config: AppConfig): Dependencias {
  const fuenteLegacy = crearFuenteSintetica();
  const reloj = () => new Date();
  if (!config.firebaseProjectId) {
    const noConfigurado = (): never => {
      throw new AppError(
        503,
        "AUTH_NOT_CONFIGURED",
        "La autenticación no está configurada en este entorno.",
      );
    };
    return {
      tokenVerifier: { verificar: async () => noConfigurado() },
      perfiles: {
        obtener: async () => noConfigurado(),
        registrar: async () => noConfigurado(),
        hayAdministradorActivo: async () => noConfigurado(),
      },
      fuenteLegacy,
      reloj,
    };
  }

  let verifier: TokenVerifier | undefined;
  let perfiles: PerfilRepository | undefined;
  const app = () => getFirebaseAdminApp(config);
  const getVerifier = () =>
    (verifier ??= crearVerificadorFirebase(getAuth(app())));
  const getPerfiles = () =>
    (perfiles ??= crearPerfilesFirestore(
      getFirestore(app()),
      config.firestorePrefix,
    ));

  return {
    tokenVerifier: { verificar: (t) => getVerifier().verificar(t) },
    perfiles: {
      obtener: (uid) => getPerfiles().obtener(uid),
      registrar: (p, e) => getPerfiles().registrar(p, e),
      hayAdministradorActivo: () => getPerfiles().hayAdministradorActivo(),
    },
    fuenteLegacy,
    reloj,
  };
}
