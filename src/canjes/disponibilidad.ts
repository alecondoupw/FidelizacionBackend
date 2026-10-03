import { randomInt } from "node:crypto";
import type {
  Beneficio,
  Canje,
  Disponibilidad,
  EstadoCanje,
  Variante,
} from "./tipos.js";

/** «Últimas unidades» con 5 o menos (DEC-07). */
export const UMBRAL_ULTIMAS = 5;

export function disponibilidadVariante(
  v: Variante,
): Exclude<Disponibilidad, "proximamente"> {
  if (v.stock === null) return "disponible";
  if (v.stock <= 0) return "agotado";
  return v.stock <= UMBRAL_ULTIMAS ? "ultimas" : "disponible";
}

/** Estado visible del beneficio (SRC-03 p. 6): siempre lo decide el backend. */
export function disponibilidadBeneficio(
  b: Beneficio,
  ahora: Date,
): Disponibilidad {
  if (b.disponibleDesde && b.disponibleDesde > ahora.toISOString())
    return "proximamente";
  const estados = b.variantes.map(disponibilidadVariante);
  if (estados.every((e) => e === "agotado")) return "agotado";
  if (estados.some((e) => e === "disponible")) return "disponible";
  const restantes = b.variantes.reduce((s, v) => s + (v.stock ?? 0), 0);
  return restantes <= UMBRAL_ULTIMAS ? "ultimas" : "disponible";
}

/** Un cupón emitido que pasó su vigencia sin entregarse es «Vencido» (DEC-07). */
export function estadoEfectivo(
  c: Pick<Canje, "estado" | "venceEn">,
  ahora: Date,
): EstadoCanje {
  return c.estado === "emitido" && c.venceEn < ahora.toISOString()
    ? "vencido"
    : c.estado;
}

/** Base32 de Crockford sin I, L, O ni U: fácil de dictar y de leer en mostrador. */
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Código único de canje, p. ej. «ML-7K3Q-9XWD-2F». */
export function generarCodigo(): string {
  const c = Array.from(
    { length: 10 },
    () => ALFABETO[randomInt(ALFABETO.length)],
  ).join("");
  return `ML-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

export const CODIGO_VALIDO =
  /^ML-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/;
