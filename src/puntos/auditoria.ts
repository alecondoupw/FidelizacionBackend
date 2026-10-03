import type { Transaccion } from "../almacen/almacen.js";
import { R } from "./rutas.js";

export type AccionAuditoria =
  | "regla.creada"
  | "regla.actualizada"
  | "regla.eliminada"
  | "vigencia.actualizada"
  | "puntos.ajuste"
  | "beneficio.creado"
  | "beneficio.actualizado"
  | "canje.entregado"
  | "canje.anulado"
  // F4 (DEC-03/04/08)
  | "administrador.creado"
  | "administrador.actualizado"
  | "administrador.eliminado"
  | "cliente.actualizado"
  | "cliente.eliminado"
  | "perfil.actualizado"
  // F5 (DEC-09)
  | "exportacion.generada"
  // F6 (DEC-10)
  | "contenido.creado"
  | "contenido.actualizado"
  | "contenido.eliminado";

/** Evento de auditoría (F2–F4): actor, objetivo y antes/después, sin correos ni contraseñas (RN-02, SRC-02 p. 5, DEC-08). */
export interface RegistroAuditoria extends Record<string, unknown> {
  accion: AccionAuditoria;
  actor: string;
  objetivo: string;
  en: string;
  datos: Record<string, unknown>;
}

export function auditar(
  tx: Transaccion,
  id: string,
  registro: RegistroAuditoria,
): void {
  tx.crear(R.auditoria(id), registro);
}
