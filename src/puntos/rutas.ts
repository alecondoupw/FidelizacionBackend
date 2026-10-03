import type { Marca } from "../dominio/tipos.js";
import type { Evento } from "./tipos.js";

/**
 * Modelo Firestore de F2 (sin índices compuestos):
 *   reglas/{marca}__{evento}                     regla única por combinación (RN-04)
 *   vigencias/{marca}                            periodo de vencimiento por marca
 *   eventos/{sha256(origen|idExterno)}           idempotencia de eventos y ajustes
 *   usuarios/{uid}/marcas/{marca}                saldo materializado
 *   usuarios/{uid}/marcas/{marca}/movimientos/{id ordenable por fecha}
 *   usuarios/{uid}/marcas/{marca}/lotes/{id}
 *   vencimientos/{uid}__{marca}__{loteId}        lotes con fecha de vencimiento pendiente
 *   auditoria/{id}
 */
export const R = {
  regla: (marca: Marca, evento: Evento) => `reglas/${marca}__${evento}`,
  reglas: "reglas",
  vigencia: (marca: Marca) => `vigencias/${marca}`,
  evento: (clave: string) => `eventos/${clave}`,
  correo: (huella: string) => `correos/${huella}`,
  usuario: (uid: string) => `usuarios/${uid}`,
  saldo: (uid: string, marca: Marca) => `usuarios/${uid}/marcas/${marca}`,
  movimientos: (uid: string, marca: Marca) =>
    `usuarios/${uid}/marcas/${marca}/movimientos`,
  lotes: (uid: string, marca: Marca) => `usuarios/${uid}/marcas/${marca}/lotes`,
  vencimientos: "vencimientos",
  vencimiento: (uid: string, marca: Marca, loteId: string) =>
    `vencimientos/${uid}__${marca}__${loteId}`,
  auditoria: (id: string) => `auditoria/${id}`,
};

export const idRegla = (marca: Marca, evento: Evento) => `${marca}__${evento}`;
