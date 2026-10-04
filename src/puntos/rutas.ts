import type { Marca } from "../dominio/tipos.js";
import type { Evento } from "./tipos.js";

/**
 * Modelo Firestore de F2 (sin índices compuestos):
 *   reglas/{marca}__{evento}                     regla única por combinación (RN-04)
 *   vigencias/{marca}                            (histórico F2–F7; sin uso desde F8, DEC-18)
 *   eventos/{sha256(origen|idExterno)}           idempotencia de eventos y ajustes
 *   usuarios/{uid}/marcas/{marca}                saldo materializado
 *   usuarios/{uid}/marcas/{marca}/movimientos/{id ordenable por fecha}
 *   usuarios/{uid}/marcas/{marca}/lotes/{id}
 *   vencimientos/{uid}__{marca}__{loteId}        lotes con fecha de vencimiento pendiente
 *   auditoria/{id}
 *   libro/{id del movimiento}                    copia global para reportes (F5)
 */
export const R = {
  regla: (marca: Marca, evento: Evento) => `reglas/${marca}__${evento}`,
  reglas: "reglas",
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
  // F3 (DEC-07)
  beneficios: "beneficios",
  beneficio: (id: string) => `beneficios/${id}`,
  canjes: (uid: string) => `usuarios/${uid}/canjes`,
  canje: (uid: string, id: string) => `usuarios/${uid}/canjes/${id}`,
  codigo: (codigo: string) => `codigos/${codigo}`,
  lote: (uid: string, marca: Marca, loteId: string) =>
    `usuarios/${uid}/marcas/${marca}/lotes/${loteId}`,
  // F5 (DEC-09): copia global de cada movimiento para reportes y exportación
  libro: "libro",
  asiento: (id: string) => `libro/${id}`,
  // F6 (DEC-10)
  contenidos: "contenidos",
  contenido: (id: string) => `contenidos/${id}`,
  // F8 (DEC-17): registros importados por correo y lotes de importación
  importados: "importados",
  importado: (huella: string) => `importados/${huella}`,
  importaciones: "importaciones",
  importacion: (id: string) => `importaciones/${id}`,
  parteImportacion: (id: string, n: number) =>
    `importaciones/${id}/partes/${String(n).padStart(3, "0")}`,
};

export const idRegla = (marca: Marca, evento: Evento) => `${marca}__${evento}`;
