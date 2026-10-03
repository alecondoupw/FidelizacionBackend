import type { Transaccion } from "../almacen/almacen.js";
import { R } from "./rutas.js";

export type AccionF2 =
  | "regla.creada"
  | "regla.actualizada"
  | "regla.eliminada"
  | "vigencia.actualizada"
  | "puntos.ajuste"
  | "beneficio.creado"
  | "beneficio.actualizado"
  | "canje.entregado"
  | "canje.anulado";

/** Evento de auditoría de F2: actor, objetivo y antes/después, sin correos (RN-02, SRC-02 p. 5). */
export interface RegistroAuditoria extends Record<string, unknown> {
  accion: AccionF2;
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
