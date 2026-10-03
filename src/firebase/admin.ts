import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../http/errors.js";

/**
 * Firebase Admin SDK vive exclusivamente en este backend (SRC-02 pp. 11, 14–15).
 * Se inicializa de forma perezosa: F0 arranca y se prueba sin proyecto ni
 * credenciales. Las credenciales llegan por Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS fuera del repositorio), nunca desde Git.
 * El Admin SDK omite las reglas de Firestore: cada operación debe pasar antes
 * por la frontera de autorización de src/auth.
 */
export function getFirebaseAdminApp(config: AppConfig): App {
  if (!config.firebaseProjectId) {
    throw new AppError(
      503,
      "AUTH_NOT_CONFIGURED",
      "La autenticación no está configurada en este entorno.",
    );
  }
  return (
    getApps()[0] ??
    initializeApp({
      credential: applicationDefault(),
      projectId: config.firebaseProjectId,
    })
  );
}
