import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { TokenVerifier } from "./auth/token-verifier.js";
import {
  compartirEnCurso,
  crearVerificadorFirebase,
} from "./auth/token-verifier.js";
import type { AppConfig } from "./config/env.js";
import { getFirebaseAdminApp } from "./firebase/admin.js";
import { AppError } from "./http/errors.js";
import {
  crearFuenteSintetica,
  type FuenteLegacy,
} from "./legacy/fuente-legacy.js";
import type { Almacen } from "./almacen/almacen.js";
import { crearAlmacenFirestore } from "./almacen/firestore.js";
import {
  crearCuentasFirebase,
  type ProveedorCuentas,
} from "./identidad/cuentas.js";
import type { PerfilRepository } from "./usuarios/perfiles.js";
import { crearPerfilesAlmacen } from "./usuarios/perfiles-almacen.js";
import { crearFuenteImportacion } from "./importacion/importacion.js";

/** Puertos que usan las rutas; las pruebas inyectan dobles. */
export interface Dependencias {
  tokenVerifier: TokenVerifier;
  perfiles: PerfilRepository;
  /** Firebase Auth para la gestión de identidades (F4). */
  cuentas: ProveedorCuentas;
  fuenteLegacy: FuenteLegacy;
  /** Almacén transaccional del motor de puntos (F2). */
  almacen: Almacen;
  reloj: () => Date;
}

/**
 * Con FIREBASE_PROJECT_ID: Admin SDK (inicializado al primer uso) + Firestore.
 * Sin él: el servidor arranca y toda ruta protegida responde 503.
 */
export function crearDependencias(config: AppConfig): Dependencias {
  const sintetica =
    config.legacySource === "sintetica" ? crearFuenteSintetica() : undefined;
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
      cuentas: {
        obtener: async () => noConfigurado(),
        buscarPorCorreo: async () => noConfigurado(),
        crear: async () => noConfigurado(),
        actualizar: async () => noConfigurado(),
        eliminar: async () => noConfigurado(),
        revocarSesiones: async () => noConfigurado(),
      },
      fuenteLegacy: sintetica ?? { buscarPorCorreo: async () => null },
      almacen: {
        leer: async () => noConfigurado(),
        consultar: async () => noConfigurado(),
        contar: async () => noConfigurado(),
        transaccion: async () => noConfigurado(),
        nuevoId: () => noConfigurado(),
      },
      reloj,
    };
  }

  let verifier: TokenVerifier | undefined;
  let cuentas: ProveedorCuentas | undefined;
  let almacen: Almacen | undefined;
  const app = () => getFirebaseAdminApp(config);
  const getVerifier = () =>
    (verifier ??= compartirEnCurso(crearVerificadorFirebase(getAuth(app()))));
  const getCuentas = () => (cuentas ??= crearCuentasFirebase(getAuth(app())));
  const getAlmacen = () =>
    (almacen ??= crearAlmacenFirestore(
      getFirestore(app()),
      config.firestorePrefix,
    ));

  const almacenPerezoso: Almacen = {
    leer: (r) => getAlmacen().leer(r),
    consultar: (c) => getAlmacen().consultar(c),
    contar: (c) => getAlmacen().contar(c),
    transaccion: (fn) => getAlmacen().transaccion(fn),
    nuevoId: () => getAlmacen().nuevoId(),
  };
  return {
    tokenVerifier: { verificar: (t) => getVerifier().verificar(t) },
    // Perfiles sobre el mismo almacén que puntos, canjes e identidades.
    perfiles: crearPerfilesAlmacen(almacenPerezoso),
    cuentas: {
      obtener: (u) => getCuentas().obtener(u),
      buscarPorCorreo: (c) => getCuentas().buscarPorCorreo(c),
      crear: (d) => getCuentas().crear(d),
      actualizar: (u, c) => getCuentas().actualizar(u, c),
      eliminar: (u) => getCuentas().eliminar(u),
      revocarSesiones: (u) => getCuentas().revocarSesiones(u),
    },
    // Clientes importados por marca (DEC-17), más el doble si se pidió.
    fuenteLegacy: crearFuenteImportacion(almacenPerezoso, sintetica),
    almacen: almacenPerezoso,
    reloj,
  };
}
