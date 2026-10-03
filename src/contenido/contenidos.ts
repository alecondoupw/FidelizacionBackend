import { addDays } from "date-fns";
import type { Almacen } from "../almacen/almacen.js";
import type { Marca } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { auditar } from "../puntos/auditoria.js";
import { R } from "../puntos/rutas.js";
import { inicioDelDia } from "../reportes/periodo.js";

/** Contenido por marca (F6, DEC-10, SRC-02 p. 7). */
export const CATEGORIAS_CONTENIDO = ["noticia", "evento", "promocion"] as const;
export type CategoriaContenido = (typeof CATEGORIAS_CONTENIDO)[number];
export type EstadoPublicacion = "programada" | "publicada" | "finalizada";

export interface DatosPublicacion {
  marca: Marca;
  categoria: CategoriaContenido;
  titulo: string;
  texto: string;
  /** Enlace externo opcional (sólo https). */
  enlace: string | null;
  destacada: boolean;
  activa: boolean;
  /** Fechas locales de Bolivia (AAAA-MM-DD), ambas incluidas; null = sin límite. */
  publicarDesde: string | null;
  publicarHasta: string | null;
}

export interface Publicacion extends DatosPublicacion, Record<string, unknown> {
  creadoEn: string;
  actualizadoEn: string;
  actualizadoPor: string;
}

export interface PublicacionAdmin extends Publicacion {
  id: string;
  estado: EstadoPublicacion;
  /** Lo que ve hoy el cliente: activa y dentro de su ventana. */
  visible: boolean;
}

/** Estado temporal de A09 según la ventana de publicación en hora de Bolivia. */
export function estadoPublicacion(
  p: Pick<DatosPublicacion, "publicarDesde" | "publicarHasta">,
  ahora: Date,
): EstadoPublicacion {
  if (p.publicarDesde && ahora < inicioDelDia(p.publicarDesde)) {
    return "programada";
  }
  if (p.publicarHasta && ahora >= addDays(inicioDelDia(p.publicarHasta), 1)) {
    return "finalizada";
  }
  return "publicada";
}

const vista = (id: string, p: Publicacion, ahora: Date): PublicacionAdmin => {
  const estado = estadoPublicacion(p, ahora);
  return { ...p, id, estado, visible: p.activa && estado === "publicada" };
};

/** Vista del cliente: sin datos internos de edición. */
export interface PublicacionCliente {
  id: string;
  marca: Marca;
  categoria: CategoriaContenido;
  titulo: string;
  texto: string;
  enlace: string | null;
  destacada: boolean;
  publicarDesde: string | null;
}

const fechaDeOrden = (p: PublicacionAdmin) =>
  p.publicarDesde ?? p.creadoEn.slice(0, 10);
const masRecientes = (a: PublicacionAdmin, b: PublicacionAdmin) =>
  fechaDeOrden(b).localeCompare(fechaDeOrden(a)) ||
  b.creadoEn.localeCompare(a.creadoEn);

function validarVentana(d: DatosPublicacion) {
  if (d.publicarDesde) inicioDelDia(d.publicarDesde);
  if (d.publicarHasta) inicioDelDia(d.publicarHasta);
  if (d.publicarDesde && d.publicarHasta && d.publicarHasta < d.publicarDesde) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "La fecha final de publicación debe ser igual o posterior a la inicial.",
    );
  }
}

// ── Administración (UI-12, A09) ──────────────────────────────────────
export async function listarContenidosAdmin(
  almacen: Almacen,
  ahora: Date,
  marca?: Marca,
): Promise<PublicacionAdmin[]> {
  const docs = await almacen.consultar<Publicacion>({
    coleccion: R.contenidos,
    donde: marca ? [["marca", "==", marca]] : [],
  });
  return docs.map((d) => vista(d.id, d.datos, ahora)).sort(masRecientes);
}

export async function crearContenido(
  almacen: Almacen,
  datos: DatosPublicacion,
  actor: string,
  ahora: Date,
): Promise<PublicacionAdmin> {
  validarVentana(datos);
  const id = almacen.nuevoId();
  const en = ahora.toISOString();
  const p: Publicacion = {
    ...datos,
    creadoEn: en,
    actualizadoEn: en,
    actualizadoPor: actor,
  };
  await almacen.transaccion(async (tx) => {
    tx.crear(R.contenido(id), p);
    auditar(tx, almacen.nuevoId(), {
      accion: "contenido.creado",
      actor,
      objetivo: id,
      en,
      datos: { marca: p.marca, categoria: p.categoria, activa: p.activa },
    });
  });
  return vista(id, p, ahora);
}

/** Edición completa o parcial (A09: el interruptor sólo cambia `activa`). */
export async function actualizarContenido(
  almacen: Almacen,
  id: string,
  cambios: Partial<DatosPublicacion>,
  actor: string,
  ahora: Date,
): Promise<PublicacionAdmin> {
  const en = ahora.toISOString();
  const nuevo = await almacen.transaccion(async (tx) => {
    const p = await tx.leer<Publicacion>(R.contenido(id));
    if (!p) throw new AppError(404, "NOT_FOUND", "La publicación no existe.");
    const n: Publicacion = {
      ...p,
      ...cambios,
      actualizadoEn: en,
      actualizadoPor: actor,
    };
    validarVentana(n);
    const campos = (Object.keys(cambios) as (keyof DatosPublicacion)[]).filter(
      (k) => JSON.stringify(p[k]) !== JSON.stringify(n[k]),
    );
    if (campos.length === 0) return p;
    tx.fijar(R.contenido(id), n);
    auditar(tx, almacen.nuevoId(), {
      accion: "contenido.actualizado",
      actor,
      objetivo: id,
      en,
      datos: { marca: n.marca, campos },
    });
    return n;
  });
  return vista(id, nuevo, ahora);
}

export async function eliminarContenido(
  almacen: Almacen,
  id: string,
  actor: string,
  ahora: Date,
): Promise<void> {
  await almacen.transaccion(async (tx) => {
    const p = await tx.leer<Publicacion>(R.contenido(id));
    if (!p) throw new AppError(404, "NOT_FOUND", "La publicación no existe.");
    tx.borrar(R.contenido(id));
    auditar(tx, almacen.nuevoId(), {
      accion: "contenido.eliminado",
      actor,
      objetivo: id,
      en: ahora.toISOString(),
      datos: { marca: p.marca, categoria: p.categoria, titulo: p.titulo },
    });
  });
}

// ── Cliente (C08 carrusel, Novedades) ─────────────────────────────────
/**
 * Sólo publicaciones activas, dentro de su ventana y de marcas vinculadas
 * (RN-09): una por marca consultada, sin índices compuestos.
 */
export async function contenidosCliente(
  almacen: Almacen,
  marcasCliente: Marca[],
  ahora: Date,
  opciones: { marca?: Marca; destacadas?: boolean; limite: number },
): Promise<PublicacionCliente[]> {
  const marcas = opciones.marca
    ? marcasCliente.filter((m) => m === opciones.marca)
    : marcasCliente;
  const listas = await Promise.all(
    marcas.map((m) => listarContenidosAdmin(almacen, ahora, m)),
  );
  return listas
    .flat()
    .filter((p) => p.visible && (!opciones.destacadas || p.destacada))
    .sort(masRecientes)
    .slice(0, opciones.limite)
    .map((p) => ({
      id: p.id,
      marca: p.marca,
      categoria: p.categoria,
      titulo: p.titulo,
      texto: p.texto,
      enlace: p.enlace,
      destacada: p.destacada,
      publicarDesde: p.publicarDesde,
    }));
}
