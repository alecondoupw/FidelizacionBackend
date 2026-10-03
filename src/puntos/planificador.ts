import type { Documento } from "../almacen/almacen.js";
import { estaVencido } from "./fechas.js";
import type { Lote } from "./tipos.js";

export interface Plan {
  /** Remanentes que vencen ahora, por lote. */
  vencidos: { loteId: string; puntos: number }[];
  /** Puntos tomados de cada lote para la resta solicitada. */
  consumos: { loteId: string; puntos: number }[];
  /** Restante final de cada lote modificado. */
  restantes: Map<string, number>;
  /** Puntos que no pudieron cubrirse (0 si alcanza). */
  faltante: number;
  disponibleFinal: number;
}

/** Mayor que cualquier fecha ISO real: los lotes sin vencimiento se consumen al final. */
const SIN_VENCIMIENTO = "9999-12-31T23:59:59.999Z";

/** Orden de consumo de DEC-06: vence antes primero; sin vencimiento al final. */
export function ordenarParaConsumo(
  lotes: Documento<Lote>[],
): Documento<Lote>[] {
  return [...lotes].sort((a, b) => {
    const va = a.datos.venceEn ?? SIN_VENCIMIENTO;
    const vb = b.datos.venceEn ?? SIN_VENCIMIENTO;
    if (va !== vb) return va < vb ? -1 : 1;
    if (a.datos.otorgadoEn !== b.datos.otorgadoEn) {
      return a.datos.otorgadoEn < b.datos.otorgadoEn ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Plan puro sobre los lotes con remanente: primero vence lo que ya pasó su
 * fecha y después consume `restar` puntos de los lotes vigentes. No aplica
 * nada si falta saldo: quien llama decide rechazar.
 */
export function planificar(
  lotes: Documento<Lote>[],
  ahora: Date,
  restar = 0,
): Plan {
  const restantes = new Map<string, number>();
  const vencidos: Plan["vencidos"] = [];
  const vigentes: Documento<Lote>[] = [];

  for (const lote of lotes) {
    if (lote.datos.restante <= 0) continue;
    if (estaVencido(lote.datos.venceEn, ahora)) {
      vencidos.push({ loteId: lote.id, puntos: lote.datos.restante });
      restantes.set(lote.id, 0);
    } else {
      vigentes.push(lote);
    }
  }

  let pendiente = restar;
  const consumos: Plan["consumos"] = [];
  for (const lote of ordenarParaConsumo(vigentes)) {
    if (pendiente <= 0) break;
    const tomar = Math.min(pendiente, lote.datos.restante);
    consumos.push({ loteId: lote.id, puntos: tomar });
    restantes.set(lote.id, lote.datos.restante - tomar);
    pendiente -= tomar;
  }

  const vigenteTotal = vigentes.reduce((s, l) => s + l.datos.restante, 0);
  return {
    vencidos,
    consumos,
    restantes,
    faltante: Math.max(pendiente, 0),
    disponibleFinal: vigenteTotal - (restar - Math.max(pendiente, 0)),
  };
}
