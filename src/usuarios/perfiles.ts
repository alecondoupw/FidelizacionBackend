import type { EventoAuditoria, Perfil } from "../dominio/tipos.js";

export type ResultadoRegistro = "creado" | "uid_existente" | "correo_existente";

/**
 * Persistencia de perfiles (DEC-03: Firestore). Cada registro escribe perfil,
 * índice de correo y evento de auditoría de forma atómica.
 */
export interface PerfilRepository {
  obtener(uid: string): Promise<Perfil | null>;
  registrar(
    perfil: Perfil,
    evento: EventoAuditoria,
  ): Promise<ResultadoRegistro>;
  hayAdministradorActivo(): Promise<boolean>;
}

/** Implementación en memoria para pruebas; mismas reglas que la de Firestore. */
export function crearPerfilesEnMemoria(): PerfilRepository & {
  auditoria: EventoAuditoria[];
} {
  const perfiles = new Map<string, Perfil>();
  const correos = new Map<string, string>();
  const auditoria: EventoAuditoria[] = [];

  return {
    auditoria,
    async obtener(uid) {
      const perfil = perfiles.get(uid);
      return perfil ? structuredClone(perfil) : null;
    },
    async registrar(perfil, evento) {
      if (perfiles.has(perfil.uid)) return "uid_existente";
      if (correos.has(perfil.correo)) return "correo_existente";
      perfiles.set(perfil.uid, structuredClone(perfil));
      correos.set(perfil.correo, perfil.uid);
      auditoria.push(structuredClone(evento));
      return "creado";
    },
    async hayAdministradorActivo() {
      return [...perfiles.values()].some(
        (p) => p.rol === "administrador" && p.activo,
      );
    },
  };
}
