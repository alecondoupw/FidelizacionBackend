import type { Almacen } from "../almacen/almacen.js";
import type { Marca } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { auditar } from "../puntos/auditoria.js";
import { R } from "../puntos/rutas.js";
import {
  disponibilidadBeneficio,
  disponibilidadVariante,
} from "./disponibilidad.js";
import type {
  Beneficio,
  Categoria,
  DatosBeneficio,
  Disponibilidad,
  Variante,
} from "./tipos.js";

export type { DatosBeneficio };

/** Vista para clientes: estado de disponibilidad, nunca el stock exacto. */
export interface BeneficioVista {
  id: string;
  marca: Marca;
  nombre: string;
  descripcion: string;
  categoria: Categoria;
  puntos: number;
  caracteristicas: string[];
  disponibleDesde: string | null;
  vigenciaCuponDias: number;
  disponibilidad: Disponibilidad;
  variantes: { id: string; nombre: string; disponibilidad: Disponibilidad }[];
}

export function vistaCliente(
  id: string,
  b: Beneficio,
  ahora: Date,
): BeneficioVista {
  const general = disponibilidadBeneficio(b, ahora);
  return {
    id,
    marca: b.marca,
    nombre: b.nombre,
    descripcion: b.descripcion,
    categoria: b.categoria,
    puntos: b.puntos,
    caracteristicas: b.caracteristicas,
    disponibleDesde: b.disponibleDesde,
    vigenciaCuponDias: b.vigenciaCuponDias,
    disponibilidad: general,
    variantes: b.variantes.map((v) => ({
      id: v.id,
      nombre: v.nombre,
      disponibilidad:
        general === "proximamente" ? "proximamente" : disponibilidadVariante(v),
    })),
  };
}

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Catálogo de las marcas vinculadas (SRC-03 p. 6): sólo beneficios activos,
 * separados por marca; búsqueda sin distinguir mayúsculas ni tildes.
 */
export async function listarCatalogo(
  almacen: Almacen,
  marcasCliente: Marca[],
  filtros: { marca?: Marca; categoria?: Categoria; q?: string },
  ahora: Date,
): Promise<BeneficioVista[]> {
  const marcas = filtros.marca
    ? [filtros.marca].filter((m) => marcasCliente.includes(m))
    : marcasCliente;
  if (marcas.length === 0) return [];
  const docs = await almacen.consultar<Beneficio>({
    coleccion: R.beneficios,
    donde: [["activo", "==", true]],
  });
  const q = filtros.q ? normalizar(filtros.q.trim()) : "";
  return docs
    .filter((d) => marcas.includes(d.datos.marca))
    .filter(
      (d) => !filtros.categoria || d.datos.categoria === filtros.categoria,
    )
    .filter(
      (d) =>
        !q ||
        normalizar(`${d.datos.nombre} ${d.datos.descripcion}`).includes(q),
    )
    .map((d) => vistaCliente(d.id, d.datos, ahora))
    .sort(
      (a, b) =>
        a.marca.localeCompare(b.marca) ||
        a.puntos - b.puntos ||
        a.nombre.localeCompare(b.nombre),
    );
}

/** Detalle de un beneficio; inexistente, inactivo o de marca no vinculada → 404 (sin filtrar). */
export async function obtenerBeneficioCliente(
  almacen: Almacen,
  id: string,
  marcasCliente: Marca[],
  ahora: Date,
): Promise<BeneficioVista> {
  const b = await almacen.leer<Beneficio>(R.beneficio(id));
  if (!b || !b.activo || !marcasCliente.includes(b.marca)) {
    throw new AppError(404, "NOT_FOUND", "El beneficio no existe.");
  }
  return vistaCliente(id, b, ahora);
}

// ── Administración (UI-25 propuesta) ─────────────────────────────────

export async function listarBeneficiosAdmin(
  almacen: Almacen,
): Promise<(Beneficio & { id: string })[]> {
  const docs = await almacen.consultar<Beneficio>({ coleccion: R.beneficios });
  return docs.map((d) => ({ id: d.id, ...d.datos }));
}

const datosDe = (b: Beneficio): DatosBeneficio => ({
  marca: b.marca,
  nombre: b.nombre,
  descripcion: b.descripcion,
  categoria: b.categoria,
  puntos: b.puntos,
  activo: b.activo,
  disponibleDesde: b.disponibleDesde,
  vigenciaCuponDias: b.vigenciaCuponDias,
  caracteristicas: b.caracteristicas,
  variantes: b.variantes,
});

function validarVariantes(variantes: Variante[]) {
  const ids = new Set(variantes.map((v) => v.id));
  if (ids.size !== variantes.length) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Hay variantes con el mismo identificador.",
    );
  }
}

export async function crearBeneficio(
  almacen: Almacen,
  datos: DatosBeneficio,
  actor: string,
  ahora: Date,
  id = almacen.nuevoId(),
): Promise<Beneficio & { id: string }> {
  validarVariantes(datos.variantes);
  const en = ahora.toISOString();
  const beneficio: Beneficio = {
    ...datos,
    creadoEn: en,
    actualizadoEn: en,
    actualizadoPor: actor,
  };
  await almacen.transaccion(async (tx) => {
    if (await tx.leer(R.beneficio(id))) {
      throw new AppError(
        409,
        "ALREADY_EXISTS",
        "Ya existe un beneficio con ese identificador.",
      );
    }
    tx.crear(R.beneficio(id), beneficio);
    auditar(tx, almacen.nuevoId(), {
      accion: "beneficio.creado",
      actor,
      objetivo: id,
      en,
      datos: { despues: datos },
    });
  });
  return { id, ...beneficio };
}

/** Edición completa; los canjes ya emitidos guardan su propia fotografía. */
export async function actualizarBeneficio(
  almacen: Almacen,
  id: string,
  datos: DatosBeneficio,
  actor: string,
  ahora: Date,
): Promise<Beneficio & { id: string }> {
  validarVariantes(datos.variantes);
  const en = ahora.toISOString();
  return almacen.transaccion(async (tx) => {
    const actual = await tx.leer<Beneficio>(R.beneficio(id));
    if (!actual)
      throw new AppError(404, "NOT_FOUND", "El beneficio no existe.");
    const nuevo: Beneficio = {
      ...datos,
      creadoEn: actual.creadoEn,
      actualizadoEn: en,
      actualizadoPor: actor,
    };
    tx.fijar(R.beneficio(id), nuevo);
    auditar(tx, almacen.nuevoId(), {
      accion: "beneficio.actualizado",
      actor,
      objetivo: id,
      en,
      datos: { antes: datosDe(actual), despues: datos },
    });
    return { id, ...nuevo };
  });
}

/**
 * Carga inicial desde archivo (DEC-07): crea los beneficios nuevos y omite los
 * existentes para no pisar el stock que ya se mantiene desde el panel.
 */
export async function cargarCatalogo(
  almacen: Almacen,
  beneficios: (DatosBeneficio & { id: string })[],
  actor: string,
  ahora: Date,
): Promise<{ creados: string[]; omitidos: string[] }> {
  const creados: string[] = [];
  const omitidos: string[] = [];
  for (const { id, ...datos } of beneficios) {
    if (await almacen.leer(R.beneficio(id))) {
      omitidos.push(id);
      continue;
    }
    await crearBeneficio(almacen, datos, actor, ahora, id);
    creados.push(id);
  }
  return { creados, omitidos };
}
