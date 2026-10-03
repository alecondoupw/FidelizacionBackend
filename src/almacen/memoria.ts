import { randomUUID } from "node:crypto";
import {
  DocumentoExistenteError,
  esRango,
  type Almacen,
  type Consulta,
  type Datos,
  type Documento,
  type Filtro,
  type Transaccion,
} from "./almacen.js";

const padre = (ruta: string) => ruta.slice(0, ruta.lastIndexOf("/"));
const idDe = (ruta: string) => ruta.slice(ruta.lastIndexOf("/") + 1);

function cumple(datos: Datos, [campo, op, valor]: Filtro): boolean {
  const v = datos[campo] as never;
  const x = valor as never;
  switch (op) {
    case "==":
      return v === x;
    case "<":
      return v !== null && v !== undefined && v < x;
    case "<=":
      return v !== null && v !== undefined && v <= x;
    case ">":
      return v !== null && v !== undefined && v > x;
    case ">=":
      return v !== null && v !== undefined && v >= x;
    case "array-contains":
      return Array.isArray(v) && (v as unknown[]).includes(x);
  }
}

function validar(c: Consulta) {
  const rango = (c.donde ?? []).some(([, op]) => esRango(op));
  if (rango && c.ordenId) {
    throw new Error("Consulta inválida: rango combinado con orden por id.");
  }
  if (c.despuesDeId && !c.ordenId) {
    throw new Error("Consulta inválida: cursor sin orden por id.");
  }
}

/** Almacén en memoria con transacciones serializadas y escritura atómica. */
export function crearAlmacenEnMemoria(): Almacen & {
  volcado(): Map<string, Datos>;
} {
  const docs = new Map<string, Datos>();
  let cola: Promise<unknown> = Promise.resolve();

  const leer = async <T extends Datos>(ruta: string) =>
    (docs.has(ruta) ? structuredClone(docs.get(ruta)) : null) as T | null;

  const consultar = async <T extends Datos>(c: Consulta) => {
    validar(c);
    let res: Documento<T>[] = [...docs.entries()]
      .filter(([ruta]) => padre(ruta) === c.coleccion)
      .filter(([, d]) => (c.donde ?? []).every((f) => cumple(d, f)))
      .map(([ruta, d]) => ({ id: idDe(ruta), datos: structuredClone(d) as T }));
    if (c.ordenId) {
      res.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (c.despuesDeId) {
        const corte = c.despuesDeId;
        res = res.filter((d) => d.id > corte);
      }
    }
    return c.limite ? res.slice(0, c.limite) : res;
  };

  return {
    leer,
    consultar,
    contar: async (c) => (await consultar(c)).length,
    nuevoId: () => randomUUID().replace(/-/g, "").slice(0, 20),
    volcado: () => new Map(docs),
    transaccion<R>(fn: (tx: Transaccion) => Promise<R>): Promise<R> {
      const ejecutar = async () => {
        const escrituras: Array<() => void> = [];
        const creadas = new Set<string>();
        let escribio = false;
        const antesDeLeer = () => {
          if (escribio)
            throw new Error(
              "Transacción inválida: lectura después de escritura.",
            );
        };
        const tx: Transaccion = {
          leer: async (ruta) => (antesDeLeer(), leer(ruta)),
          consultar: async (c) => (antesDeLeer(), consultar(c)),
          crear(ruta, datos) {
            escribio = true;
            if (docs.has(ruta) || creadas.has(ruta))
              throw new DocumentoExistenteError(ruta);
            creadas.add(ruta);
            const copia = structuredClone(datos);
            escrituras.push(() => docs.set(ruta, copia));
          },
          fijar(ruta, datos) {
            escribio = true;
            const copia = structuredClone(datos);
            escrituras.push(() => docs.set(ruta, copia));
          },
          borrar(ruta) {
            escribio = true;
            escrituras.push(() => docs.delete(ruta));
          },
        };
        const resultado = await fn(tx);
        for (const aplicar of escrituras) aplicar();
        return resultado;
      };
      const siguiente = cola.then(ejecutar, ejecutar);
      cola = siguiente.catch(() => undefined);
      return siguiente;
    },
  };
}
