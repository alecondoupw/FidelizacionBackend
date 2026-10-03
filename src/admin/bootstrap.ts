import type { Perfil } from "../dominio/tipos.js";
import { normalizarCorreo } from "../usuarios/correo.js";
import type { PerfilRepository } from "../usuarios/perfiles.js";

/** Operaciones de Firebase Auth que necesita el bootstrap (ADR-03, DEC-03). */
export interface CuentasAuth {
  buscarPorCorreo(correo: string): Promise<{ uid: string } | null>;
  /** Crea la cuenta sin contraseña; el custodio la define con el enlace. */
  crear(correo: string): Promise<{ uid: string }>;
  enlaceDefinirContrasena(correo: string): Promise<string>;
}

export type ResultadoBootstrap =
  | { estado: "creado"; uid: string; enlace: string }
  | { estado: "ya_era_administrador"; uid: string };

export class BootstrapRechazado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "BootstrapRechazado";
  }
}

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Crea el administrador inicial una sola vez (SRC-02 pp. 1–3, RN-01).
 * Idempotente para el mismo correo; se niega si ya hay otro admin activo
 * (los siguientes los crea un admin, F4-BE-01) o si el correo es de un cliente
 * (un cliente nunca se promueve). El chequeo y la escritura no son atómicos:
 * lo ejecuta sólo el custodio, una vez.
 */
export async function bootstrapAdministrador(
  deps: { cuentas: CuentasAuth; perfiles: PerfilRepository; reloj: () => Date },
  correoEntrada: string,
): Promise<ResultadoBootstrap> {
  const correo = normalizarCorreo(correoEntrada);
  if (!CORREO.test(correo)) throw new BootstrapRechazado("Correo inválido.");

  const existente = await deps.cuentas.buscarPorCorreo(correo);
  if (existente) {
    const perfil = await deps.perfiles.obtener(existente.uid);
    if (perfil?.rol === "administrador") {
      return { estado: "ya_era_administrador", uid: existente.uid };
    }
    if (perfil) {
      throw new BootstrapRechazado(
        "El correo pertenece a un cliente; un cliente no se convierte en administrador.",
      );
    }
  }

  if (await deps.perfiles.hayAdministradorActivo()) {
    throw new BootstrapRechazado(
      "Ya existe un administrador activo; los siguientes los crea un administrador.",
    );
  }

  const { uid } = existente ?? (await deps.cuentas.crear(correo));
  const ahora = deps.reloj().toISOString();
  const perfil: Perfil = {
    uid,
    correo,
    rol: "administrador",
    activo: true,
    marcas: [],
    vinculo: "no_vinculado",
    creadoEn: ahora,
  };
  const resultado = await deps.perfiles.registrar(perfil, {
    accion: "administrador.bootstrap",
    actor: "bootstrap",
    objetivoUid: uid,
    en: ahora,
    datos: {},
  });
  if (resultado !== "creado") {
    throw new BootstrapRechazado(
      `No se pudo registrar el perfil (${resultado}).`,
    );
  }
  return {
    estado: "creado",
    uid,
    enlace: await deps.cuentas.enlaceDefinirContrasena(correo),
  };
}
