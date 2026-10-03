import type { Marca } from "../dominio/tipos.js";

/** Categorías de SRC-03 p. 6. */
export const CATEGORIAS = [
  "accesorios",
  "ropa",
  "servicios",
  "experiencias",
  "descuentos",
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export interface Variante {
  id: string;
  /** «Única», «Talla M · Negro»… */
  nombre: string;
  /** null = sin límite (servicios, descuentos). */
  stock: number | null;
}

/** Datos editables de un beneficio (DEC-07). El stock vive en sus variantes. */
export interface DatosBeneficio {
  marca: Marca;
  nombre: string;
  descripcion: string;
  categoria: Categoria;
  puntos: number;
  activo: boolean;
  /** ISO; antes de esta fecha el beneficio se ve como «Próximamente» y no se canjea. */
  disponibleDesde: string | null;
  /** Vigencia del cupón emitido, en días (vence a fin de día, America/La_Paz). */
  vigenciaCuponDias: number;
  caracteristicas: string[];
  variantes: Variante[];
}

export interface Beneficio extends DatosBeneficio, Record<string, unknown> {
  creadoEn: string;
  actualizadoEn: string;
  actualizadoPor: string;
}

export type Disponibilidad =
  "disponible" | "ultimas" | "agotado" | "proximamente";

export const ESTADOS_CANJE = [
  "emitido",
  "entregado",
  "vencido",
  "anulado",
] as const;
export type EstadoCanje = (typeof ESTADOS_CANJE)[number];

/** Canje del propietario: fotografía del beneficio al momento de canjear. */
export interface Canje extends Record<string, unknown> {
  codigo: string;
  beneficioId: string;
  beneficioNombre: string;
  marca: Marca;
  categoria: Categoria;
  varianteId: string;
  varianteNombre: string;
  puntos: number;
  /** Estado guardado; «vencido» se deriva al leer (ver estadoEfectivo). */
  estado: Exclude<EstadoCanje, "vencido">;
  emitidoEn: string;
  venceEn: string;
  entregadoEn: string | null;
  anuladoEn: string | null;
  motivoAnulacion: string | null;
  movimientoId: string;
  lotes: { loteId: string; puntos: number }[];
}
