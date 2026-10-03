/** Tipos de dominio compartidos (SRC-01 p. 1, SRC-02 pp. 1–3, contrato I-01/I-02 v1). */
export const ROLES = ["cliente", "administrador"] as const;
export type Rol = (typeof ROLES)[number];

export const MARCAS = ["zontes", "kiden", "niu"] as const;
export type Marca = (typeof MARCAS)[number];

export type Vinculo = "vinculado" | "no_vinculado";

/** Perfil de fidelización asociado a un usuario de Firebase Auth. */
export interface Perfil {
  uid: string;
  /** Correo normalizado (único criterio de vínculo, ADR-04). */
  correo: string;
  rol: Rol;
  activo: boolean;
  marcas: Marca[];
  vinculo: Vinculo;
  /** ISO 8601 UTC. */
  creadoEn: string;
}

export interface EventoAuditoria {
  accion: "cliente.registrado" | "administrador.bootstrap";
  /** uid del actor o `bootstrap` para el procedimiento inicial. */
  actor: string;
  objetivoUid: string;
  /** ISO 8601 UTC. */
  en: string;
  /** Sin correos, tokens ni contraseñas. */
  datos: Record<string, unknown>;
}
