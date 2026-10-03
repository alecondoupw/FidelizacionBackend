import { tz } from "@date-fns/tz";
import { format } from "date-fns";
import writeXlsxFile from "write-excel-file/node";
import type { Filtro } from "../almacen/almacen.js";
import type { EstadoCanje } from "../canjes/tipos.js";
import type { Marca, Vinculo } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { ZONA } from "../puntos/fechas.js";
import type { Evento, TipoMovimiento } from "../puntos/tipos.js";
import { aPerfil } from "../usuarios/perfiles-almacen.js";
import { asientos, MAX_DOCUMENTOS, personas } from "./fuentes.js";
import { fechaLocal, type Periodo } from "./periodo.js";
import {
  canjesFiltrados,
  reporteActividad,
  type DepsReportes,
} from "./reportes.js";

/** Tope por archivo (DEC-09): si hay más filas se pide acotar los filtros. */
export const MAX_FILAS = 10_000;

export const TIPOS_EXPORTACION = [
  "clientes",
  "movimientos",
  "canjes",
  "actividad",
] as const;
export type TipoExportacion = (typeof TIPOS_EXPORTACION)[number];
export const FORMATOS = ["csv", "xlsx"] as const;
export type Formato = (typeof FORMATOS)[number];

export interface FiltrosExportacion {
  periodo?: Periodo;
  marca?: Marca;
  activo?: boolean;
  vinculo?: Vinculo;
  tipo?: TipoMovimiento;
  evento?: Evento;
  estado?: EstadoCanje;
}

type Celda = string | number | null;
export interface Seleccion {
  columnas: string[];
  filas: number;
  /** Resuelve nombres y correos sólo cuando se genera el archivo. */
  construir(): Promise<Celda[][]>;
}

const NOMBRE_MARCA: Record<Marca, string> = {
  zontes: "Zontes",
  kiden: "Kiden",
  niu: "NIU",
};
const NOMBRE_TIPO: Record<TipoMovimiento, string> = {
  otorgamiento: "Otorgamiento",
  ajuste: "Ajuste",
  canje: "Canje",
  vencimiento: "Vencimiento",
};
const NOMBRE_EVENTO: Record<Evento, string> = {
  compra: "Compra",
  referido: "Referido",
  mantenimiento: "Mantenimiento",
  asistencia: "Asistencia a eventos",
};
const NOMBRE_ESTADO: Record<EstadoCanje, string> = {
  emitido: "Emitido",
  entregado: "Entregado",
  vencido: "Vencido",
  anulado: "Anulado",
};

/** Fecha y hora de Bolivia, legible en Excel sin depender de su zona. */
const fechaHora = (iso: string | null) =>
  iso ? format(new Date(iso), "yyyy-MM-dd HH:mm", { in: tz(ZONA) }) : null;

function limitar(n: number) {
  if (n > MAX_FILAS) {
    throw new AppError(
      422,
      "TOO_MANY_ROWS",
      `La exportación tendría ${n} filas; el máximo es ${MAX_FILAS}. Acota los filtros.`,
      { filas: n, maximo: MAX_FILAS },
    );
  }
}

function requierePeriodo(f: FiltrosExportacion): Periodo {
  if (!f.periodo) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Indica el periodo (desde y hasta).",
    );
  }
  return f.periodo;
}

/** Filas y columnas de cada exportación con sus filtros efectivos (A12). */
export async function seleccionar(
  deps: DepsReportes,
  tipo: TipoExportacion,
  f: FiltrosExportacion,
  ahora: Date,
): Promise<Seleccion> {
  if (tipo === "clientes") {
    const donde: Filtro[] = [["rol", "==", "cliente"]];
    if (f.activo !== undefined) donde.push(["activo", "==", f.activo]);
    if (f.vinculo) donde.push(["vinculo", "==", f.vinculo]);
    if (f.marca) donde.push(["marcas", "array-contains", f.marca]);
    const docs = await deps.almacen.consultar({
      coleccion: "usuarios",
      donde,
      limite: MAX_DOCUMENTOS + 1,
    });
    const inicio = f.periodo?.inicio.toISOString();
    const fin = f.periodo?.fin.toISOString();
    const clientes = docs
      .map((d) => aPerfil(d.id, d.datos))
      .filter((p) => !p.eliminado)
      .filter((p) => !inicio || (p.creadoEn >= inicio && p.creadoEn < fin!))
      .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
    limitar(clientes.length);
    return {
      columnas: [
        "Nombre",
        "Correo",
        "Marcas",
        "Vinculación",
        "Estado",
        "Fecha de registro",
      ],
      filas: clientes.length,
      async construir() {
        const auth = await deps.cuentas.obtener(clientes.map((c) => c.uid));
        return clientes.map((c) => [
          auth.get(c.uid)?.nombre ?? null,
          c.correo,
          c.marcas.map((m) => NOMBRE_MARCA[m]).join(", "),
          c.vinculo === "vinculado" ? "Vinculado" : "No vinculado",
          c.activo ? "Activo" : "Inactivo",
          fechaHora(c.creadoEn),
        ]);
      },
    };
  }

  const p = requierePeriodo(f);
  if (tipo === "movimientos") {
    const xs = (await asientos(deps.almacen, p, f.marca))
      .filter((a) => !f.tipo || a.tipo === f.tipo)
      .filter((a) => !f.evento || a.evento === f.evento)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    limitar(xs.length);
    return {
      columnas: [
        "Fecha",
        "Cliente",
        "Correo",
        "Marca",
        "Tipo",
        "Evento",
        "Puntos",
        "Detalle",
      ],
      filas: xs.length,
      async construir() {
        const gente = await personas(
          deps.almacen,
          deps.cuentas,
          xs.map((a) => a.uid),
        );
        return xs.map((a) => [
          fechaHora(a.fecha),
          gente.get(a.uid)?.nombre ?? null,
          gente.get(a.uid)?.correo ?? null,
          NOMBRE_MARCA[a.marca],
          NOMBRE_TIPO[a.tipo],
          a.evento ? NOMBRE_EVENTO[a.evento] : null,
          a.puntos,
          a.motivo,
        ]);
      },
    };
  }

  if (tipo === "canjes") {
    const cs = await canjesFiltrados(
      deps,
      p,
      { marca: f.marca, estado: f.estado },
      ahora,
    );
    limitar(cs.length);
    return {
      columnas: [
        "Código",
        "Fecha",
        "Cliente",
        "Correo",
        "Beneficio",
        "Marca",
        "Puntos",
        "Estado",
        "Válido hasta",
        "Entregado",
        "Anulado",
      ],
      filas: cs.length,
      async construir() {
        const gente = await personas(
          deps.almacen,
          deps.cuentas,
          cs.map((c) => c.uid),
        );
        return cs.map((c) => [
          c.codigo,
          fechaHora(c.emitidoEn),
          gente.get(c.uid)?.nombre ?? null,
          gente.get(c.uid)?.correo ?? null,
          c.beneficioNombre,
          NOMBRE_MARCA[c.marca],
          c.puntos,
          NOMBRE_ESTADO[c.estadoEfectivo],
          fechaLocal(c.venceEn),
          fechaHora(c.entregadoEn),
          fechaHora(c.anuladoEn),
        ]);
      },
    };
  }

  // Reporte de actividad (A10) en filas indicador/valor.
  const r = await reporteActividad(deps, p, f.marca);
  const filas: Celda[][] = [
    ["Periodo", `${p.desde} a ${p.hasta}`],
    ["Marca", f.marca ? NOMBRE_MARCA[f.marca] : "Todas"],
    ["Usuarios con actividad", r.usuariosConActividad],
    ["Nuevos registros", r.nuevosRegistros],
    ["Puntos generados", r.puntosGenerados],
    ["Puntos utilizados", r.puntosUtilizados],
    ["Puntos vencidos", r.puntosVencidos],
    ["Ajustes positivos", r.ajustes.positivos],
    ["Ajustes negativos", r.ajustes.negativos],
    ["Canjes", r.canjes],
    ["Canjes anulados", r.canjesAnulados],
    ["Actividades registradas", r.actividadesRegistradas],
    ...r.porEvento.flatMap((e) => [
      [`${NOMBRE_EVENTO[e.evento]} · movimientos`, e.movimientos],
      [`${NOMBRE_EVENTO[e.evento]} · puntos`, e.puntos],
      [`${NOMBRE_EVENTO[e.evento]} · clientes`, e.clientes],
    ]),
  ];
  return {
    columnas: ["Indicador", "Valor"],
    filas: filas.length,
    construir: async () => filas,
  };
}

/** Evita que Excel interprete un texto como fórmula (inyección CSV). */
const segura = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/**
 * CSV con BOM UTF-8 (Excel respeta las tildes), separador «;» (el de Excel
 * en configuración regional de Bolivia) y fin de línea CRLF.
 */
export function aCsv(columnas: string[], filas: Celda[][]): Buffer {
  const celda = (v: Celda) => {
    if (v === null) return "";
    if (typeof v === "number") return String(v);
    const s = segura(v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [columnas, ...filas].map((f) => f.map(celda).join(";"));
  return Buffer.from(`\uFEFF${lineas.join("\r\n")}\r\n`, "utf8");
}

export async function aXlsx(
  columnas: string[],
  filas: Celda[][],
  hoja: string,
): Promise<Buffer> {
  const encabezado = columnas.map((c) => ({
    value: c,
    fontWeight: "bold" as const,
  }));
  const cuerpo = filas.map((f) =>
    f.map((v) =>
      v === null
        ? null
        : typeof v === "number"
          ? { value: v, type: Number }
          : { value: segura(v), type: String },
    ),
  );
  return writeXlsxFile([encabezado, ...cuerpo], {
    sheet: hoja,
    stickyRowsCount: 1,
    columns: columnas.map((c) => ({ width: Math.max(12, c.length + 4) })),
  }).toBuffer();
}
