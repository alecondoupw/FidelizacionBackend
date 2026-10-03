/**
 * Almacén transaccional mínimo sobre el que se escribe la lógica de puntos una
 * sola vez. Implementaciones: memoria (pruebas) y Firestore (DEC-02/03).
 *
 * Reglas compartidas con Firestore, que la implementación en memoria también
 * hace cumplir para que las pruebas detecten usos inválidos:
 *   - En una transacción todas las lecturas van antes que las escrituras.
 *   - Un filtro de rango no se combina con orden por identificador.
 *   - Sólo existe orden ascendente por identificador: el descendente exige un
 *     índice adicional en Firestore (detectado en F2 contra el proyecto real).
 * Las rutas son relativas («reglas/zontes__compra»); el prefijo de colecciones
 * se aplica sólo al primer segmento.
 */
export type Datos = Record<string, unknown>;

export type Operador = "==" | "<" | "<=" | ">" | ">=" | "array-contains";
export type Filtro = [campo: string, operador: Operador, valor: unknown];

export interface Consulta {
  coleccion: string;
  donde?: Filtro[];
  /** Orden ascendente por identificador; no se combina con filtros de rango. */
  ordenId?: "asc";
  /** Cursor: identificador a partir del cual continuar (excluido). */
  despuesDeId?: string;
  limite?: number;
}

export interface Documento<T> {
  id: string;
  datos: T;
}

export interface Lector {
  leer<T extends Datos>(ruta: string): Promise<T | null>;
  consultar<T extends Datos>(consulta: Consulta): Promise<Documento<T>[]>;
}

export interface Transaccion extends Lector {
  /** Falla si el documento ya existe. */
  crear(ruta: string, datos: Datos): void;
  fijar(ruta: string, datos: Datos): void;
  borrar(ruta: string): void;
}

export interface Almacen extends Lector {
  transaccion<R>(fn: (tx: Transaccion) => Promise<R>): Promise<R>;
  /** Identificador aleatorio para documentos nuevos. */
  nuevoId(): string;
}

export class DocumentoExistenteError extends Error {
  constructor(readonly ruta: string) {
    super(`El documento ya existe: ${ruta}`);
    this.name = "DocumentoExistenteError";
  }
}

export const esRango = (op: Operador) =>
  op === "<" || op === "<=" || op === ">" || op === ">=";
