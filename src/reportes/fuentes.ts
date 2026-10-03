import type { Almacen, Consulta, Documento } from "../almacen/almacen.js";
import type { IndiceCanje } from "../canjes/tipos.js";
import type { Marca } from "../dominio/tipos.js";
import type { ProveedorCuentas } from "../identidad/cuentas.js";
import { AppError } from "../http/errors.js";
import type { Asiento } from "../puntos/libro.js";
import { R } from "../puntos/rutas.js";
import { aPerfil } from "../usuarios/perfiles-almacen.js";
import type { Periodo } from "./periodo.js";

/**
 * Lecturas de los reportes (DEC-09): rangos sobre un único campo (índice
 * automático de Firestore) y el resto de filtros en memoria. Un periodo con
 * más documentos que el tope se rechaza para pedir acotarlo.
 */
export const MAX_DOCUMENTOS = 50_000;

async function leerRango<T extends Record<string, unknown>>(
  almacen: Almacen,
  coleccion: string,
  campo: string,
  p: Periodo,
): Promise<Documento<T>[]> {
  const consulta: Consulta = {
    coleccion,
    donde: [
      [campo, ">=", p.inicio.toISOString()],
      [campo, "<", p.fin.toISOString()],
    ],
    limite: MAX_DOCUMENTOS + 1,
  };
  const docs = await almacen.consultar<T>(consulta);
  if (docs.length > MAX_DOCUMENTOS) {
    throw new AppError(
      422,
      "RANGE_TOO_LARGE",
      "El periodo tiene demasiados registros; acota las fechas.",
    );
  }
  return docs;
}

export interface AsientoConId extends Asiento {
  id: string;
}

/** Movimientos del libro global en el periodo, opcionalmente de una marca. */
export async function asientos(
  almacen: Almacen,
  p: Periodo,
  marca?: Marca,
): Promise<AsientoConId[]> {
  const docs = await leerRango<Asiento>(almacen, R.libro, "fecha", p);
  return docs
    .filter((d) => !marca || d.datos.marca === marca)
    .map((d) => ({ ...d.datos, id: d.id }));
}

export interface CanjeIndexado extends IndiceCanje {
  codigo: string;
}

/** Canjes emitidos en el periodo (índice `codigos`). */
export async function canjesEmitidos(
  almacen: Almacen,
  p: Periodo,
  marca?: Marca,
): Promise<CanjeIndexado[]> {
  const docs = await leerRango<IndiceCanje>(almacen, "codigos", "emitidoEn", p);
  return docs
    .filter((d) => !marca || d.datos.marca === marca)
    .map((d) => ({ ...d.datos, codigo: d.id }));
}

export interface Registro {
  uid: string;
  marcas: Marca[];
  vinculo: string;
  creadoEn: string;
  eliminado: boolean;
}

/** Clientes registrados en el periodo (incluye los que luego se dieron de baja). */
export async function registros(
  almacen: Almacen,
  p: Periodo,
  marca?: Marca,
): Promise<Registro[]> {
  const docs = await leerRango(almacen, "usuarios", "creadoEn", p);
  return docs
    .map((d) => aPerfil(d.id, d.datos))
    .filter((x) => x.rol === "cliente")
    .filter((x) => !marca || x.marcas.includes(marca))
    .map((x) => ({
      uid: x.uid,
      marcas: x.marcas,
      vinculo: x.vinculo,
      creadoEn: x.creadoEn,
      eliminado: x.eliminado === true,
    }));
}

export interface Persona {
  nombre: string | null;
  correo: string | null;
}

/**
 * Nombre (Auth) y correo (perfil) de cada uid para tablas y exportaciones.
 * Un cliente eliminado queda como «Cliente eliminado» sin datos personales.
 */
export async function personas(
  almacen: Almacen,
  cuentas: ProveedorCuentas,
  uids: string[],
): Promise<Map<string, Persona>> {
  const unicos = [...new Set(uids)];
  const [auth, perfiles] = await Promise.all([
    cuentas.obtener(unicos),
    Promise.all(unicos.map((u) => almacen.leer(R.usuario(u)))),
  ]);
  return new Map<string, Persona>(
    unicos.map((uid, i): [string, Persona] => {
      const datos = perfiles[i];
      const p = datos ? aPerfil(uid, datos) : null;
      if (!p || p.eliminado) {
        return [uid, { nombre: "Cliente eliminado", correo: null }];
      }
      return [uid, { nombre: auth.get(uid)?.nombre ?? null, correo: p.correo }];
    }),
  );
}
