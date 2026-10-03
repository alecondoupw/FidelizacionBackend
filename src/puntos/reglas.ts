import type { Almacen } from "../almacen/almacen.js";
import { MARCAS, type Marca } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { auditar } from "./auditoria.js";
import { idRegla, R } from "./rutas.js";
import { EVENTOS, type Evento, type Regla } from "./tipos.js";

export type ReglaConId = Regla & { id: string };

const noEncontrada = () =>
  new AppError(404, "NOT_FOUND", "La regla no existe.");

export function parsearIdRegla(id: string): { marca: Marca; evento: Evento } {
  const [marca, evento] = id.split("__");
  const m = MARCAS.find((x) => x === marca);
  const e = EVENTOS.find((x) => x === evento);
  if (!m || !e) throw noEncontrada();
  return { marca: m, evento: e };
}

/** Reglas por marca y evento (SRC-02 pp. 3–5): sin condición, una por combinación. */
export async function listarReglas(almacen: Almacen): Promise<ReglaConId[]> {
  const docs = await almacen.consultar<Regla>({ coleccion: R.reglas });
  return docs.map((d) => ({ id: d.id, ...d.datos }));
}

export async function crearRegla(
  almacen: Almacen,
  datos: { marca: Marca; evento: Evento; puntos: number; activa: boolean },
  actor: string,
  ahora: Date,
): Promise<ReglaConId> {
  const id = idRegla(datos.marca, datos.evento);
  const en = ahora.toISOString();
  const regla: Regla = {
    ...datos,
    creadoEn: en,
    actualizadoEn: en,
    actualizadoPor: actor,
  };
  await almacen.transaccion(async (tx) => {
    if (await tx.leer(R.regla(datos.marca, datos.evento))) {
      throw new AppError(
        409,
        "RULE_EXISTS",
        "Ya existe una regla para ese evento y esa marca.",
      );
    }
    tx.crear(R.regla(datos.marca, datos.evento), regla);
    auditar(tx, almacen.nuevoId(), {
      accion: "regla.creada",
      actor,
      objetivo: id,
      en,
      datos: { despues: datos },
    });
  });
  return { id, ...regla };
}

/**
 * Cambia puntos, marca o estado (SRC-02 p. 4). Sólo afecta eventos futuros:
 * cada otorgamiento copia los puntos de la regla en su propio movimiento.
 */
export async function actualizarRegla(
  almacen: Almacen,
  id: string,
  cambios: { puntos?: number; marca?: Marca; activa?: boolean },
  actor: string,
  ahora: Date,
): Promise<ReglaConId> {
  const { marca, evento } = parsearIdRegla(id);
  const en = ahora.toISOString();
  return almacen.transaccion(async (tx) => {
    const actual = await tx.leer<Regla>(R.regla(marca, evento));
    if (!actual) throw noEncontrada();
    const nuevaMarca = cambios.marca ?? marca;
    const mueve = nuevaMarca !== marca;
    if (mueve && (await tx.leer(R.regla(nuevaMarca, evento)))) {
      throw new AppError(
        409,
        "RULE_EXISTS",
        "Ya existe una regla para ese evento y esa marca.",
      );
    }
    const nueva: Regla = {
      ...actual,
      marca: nuevaMarca,
      puntos: cambios.puntos ?? actual.puntos,
      activa: cambios.activa ?? actual.activa,
      actualizadoEn: en,
      actualizadoPor: actor,
    };
    if (mueve) {
      tx.borrar(R.regla(marca, evento));
      tx.crear(R.regla(nuevaMarca, evento), nueva);
    } else {
      tx.fijar(R.regla(marca, evento), nueva);
    }
    const resumen = (r: Regla) => ({
      marca: r.marca,
      evento: r.evento,
      puntos: r.puntos,
      activa: r.activa,
    });
    auditar(tx, almacen.nuevoId(), {
      accion: "regla.actualizada",
      actor,
      objetivo: id,
      en,
      datos: { antes: resumen(actual), despues: resumen(nueva) },
    });
    return { id: idRegla(nuevaMarca, evento), ...nueva };
  });
}

/** Eliminar no toca puntos ya otorgados (SRC-02 p. 4). */
export async function eliminarRegla(
  almacen: Almacen,
  id: string,
  actor: string,
  ahora: Date,
): Promise<void> {
  const { marca, evento } = parsearIdRegla(id);
  await almacen.transaccion(async (tx) => {
    const actual = await tx.leer<Regla>(R.regla(marca, evento));
    if (!actual) throw noEncontrada();
    tx.borrar(R.regla(marca, evento));
    auditar(tx, almacen.nuevoId(), {
      accion: "regla.eliminada",
      actor,
      objetivo: id,
      en: ahora.toISOString(),
      datos: {
        antes: { marca, evento, puntos: actual.puntos, activa: actual.activa },
      },
    });
  });
}
