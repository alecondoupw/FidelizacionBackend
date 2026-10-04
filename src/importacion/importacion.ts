import { addDays } from "date-fns";
import { z } from "zod";
import type {
  Almacen,
  Filtro,
  Lector,
  Transaccion,
} from "../almacen/almacen.js";
import { MARCAS, type Marca, type Perfil } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import type { FuenteLegacy } from "../legacy/fuente-legacy.js";
import { auditar } from "../puntos/auditoria.js";
import { R } from "../puntos/rutas.js";
import { aCsv, aXlsx, type Celda } from "../reportes/exportaciones.js";
import { huellaCorreo, normalizarCorreo } from "../usuarios/correo.js";
import { leerTabla } from "./archivo.js";

/**
 * Importación y vinculación de clientes por marca (F8, SRC-06 pp. 1–2, DEC-17).
 *
 *   importados/{sha256(correo)}   { correo, marcas: { marca: { nombre, importadoEn,
 *                                   importacionId } }, listaMarcas, uid, actualizadoEn }
 *   importaciones/{id}            resumen, estado y vencimiento (90 días)
 *   importaciones/{id}/partes/{n} detalle por fila para volver a descargar el reporte
 *
 * Nunca crea cuentas ni administradores. Un correo con cuenta de cliente
 * verificada se vincula en el acto; sin cuenta queda pendiente hasta que la
 * persona se registre y verifique el mismo correo (los importados son la
 * fuente del vínculo, ver `crearFuenteImportacion`).
 */
export const MAX_FILAS_IMPORTACION = 5_000;
export const DIAS_CONSERVACION = 90;
const FILAS_POR_PARTE = 500;
const FILAS_POR_TRANSACCION = 40;

export type EstadoFila =
  | "nuevo"
  | "nueva_asociacion"
  | "ya_importado"
  | "duplicado_archivo"
  | "conflicto"
  | "revision"
  | "error";
export type Vinculacion =
  "vinculara" | "vinculado" | "ya_vinculado" | "pendiente" | null;

export interface FilaResultado {
  /** Número de fila en el archivo (el encabezado es la 1). */
  fila: number;
  nombre: string;
  correo: string;
  estado: EstadoFila;
  vinculacion: Vinculacion;
  asociacionesPrevias: Marca[];
  motivo: string | null;
}

export interface ResumenImportacion {
  filas: number;
  importados: number;
  vinculados: number;
  pendientes: number;
  duplicados: number;
  conflictos: number;
  revision: number;
  errores: number;
}

interface Importado extends Record<string, unknown> {
  correo: string;
  marcas: Partial<
    Record<
      Marca,
      { nombre: string; importadoEn: string; importacionId: string }
    >
  >;
  listaMarcas: Marca[];
  uid: string | null;
  actualizadoEn: string;
}

interface LoteImportacion extends Record<string, unknown> {
  marca: Marca;
  archivo: string;
  actor: string;
  creadoEn: string;
  expiraEn: string;
  estado: "en_proceso" | "completada";
  resumen: ResumenImportacion | null;
  partes: number;
}

// ── Lectura y validación del archivo ──────────────────────────────────
const sinTildes = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
const COLUMNAS = {
  nombre: ["nombre", "nombres", "nombrecompleto", "name", "cliente"],
  correo: ["correo", "correoelectronico", "email", "mail", "emailaddress"],
};
const correoValido = z.email();

interface FilaArchivo {
  fila: number;
  nombre: string;
  correo: string;
}

/** Filas del archivo con las columnas nombre y correo (encabezado obligatorio). */
export async function filasDelArchivo(datos: Buffer): Promise<FilaArchivo[]> {
  const tabla = await leerTabla(datos);
  const encabezado = (tabla[0] ?? []).map(sinTildes);
  const iNombre = encabezado.findIndex((c) => COLUMNAS.nombre.includes(c));
  const iCorreo = encabezado.findIndex((c) => COLUMNAS.correo.includes(c));
  if (iNombre < 0 || iCorreo < 0) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "El archivo debe tener las columnas «nombre» y «correo electrónico» en la primera fila.",
    );
  }
  const cuerpo = tabla.slice(1);
  if (cuerpo.length === 0) {
    throw new AppError(422, "VALIDATION_ERROR", "El archivo no tiene filas.");
  }
  if (cuerpo.length > MAX_FILAS_IMPORTACION) {
    throw new AppError(
      422,
      "TOO_MANY_ROWS",
      `El archivo tiene ${cuerpo.length} filas; el máximo es ${MAX_FILAS_IMPORTACION}.`,
    );
  }
  return cuerpo.map((f, i) => ({
    fila: i + 2,
    nombre: (f[iNombre] ?? "").replace(/\s+/g, " ").trim(),
    correo: (f[iCorreo] ?? "").trim(),
  }));
}

// ── Estado actual de un correo ────────────────────────────────────────
interface Cuenta {
  uid: string;
  rol: Perfil["rol"];
  marcas: Marca[];
  verificarCorreo: boolean;
}

async function estadoCorreo(
  lector: Lector,
  correo: string,
): Promise<{ importado: Importado | null; cuenta: Cuenta | null }> {
  const huella = huellaCorreo(correo);
  const [importado, indice] = await Promise.all([
    lector.leer<Importado>(R.importado(huella)),
    lector.leer<{ uid: string }>(R.correo(huella)),
  ]);
  const perfil = indice
    ? await lector.leer<Omit<Perfil, "uid">>(R.usuario(indice.uid))
    : null;
  const cuenta =
    indice && perfil && !perfil.eliminado
      ? {
          uid: indice.uid,
          rol: perfil.rol,
          marcas: perfil.marcas ?? [],
          verificarCorreo: perfil.verificarCorreo === true,
        }
      : null;
  return { importado, cuenta };
}

const mismoNombre = (a: string, b: string) =>
  sinTildes(a) === sinTildes(b) && a.trim() !== "";

/** Clasifica una fila válida y única frente al estado actual (SRC-06 pp. 1–2). */
function clasificar(
  f: FilaArchivo & { correo: string },
  marca: Marca,
  { importado, cuenta }: Awaited<ReturnType<typeof estadoCorreo>>,
): FilaResultado {
  const base = {
    fila: f.fila,
    nombre: f.nombre,
    correo: f.correo,
    asociacionesPrevias: importado?.listaMarcas ?? [],
  };
  if (cuenta?.rol === "administrador") {
    return {
      ...base,
      estado: "revision",
      vinculacion: null,
      motivo:
        "El correo pertenece a una cuenta administrativa; no se importa (punto 13).",
    };
  }
  if (cuenta && cuenta.verificarCorreo) {
    return {
      ...base,
      estado: "revision",
      vinculacion: null,
      motivo:
        "La cuenta con ese correo tiene la verificación pendiente; vuelve a importar cuando la verifique.",
    };
  }
  const vinculacion: Vinculacion = !cuenta
    ? "pendiente"
    : cuenta.marcas.includes(marca)
      ? "ya_vinculado"
      : "vinculara";
  const previo = importado?.marcas[marca];
  if (previo) {
    return mismoNombre(previo.nombre, f.nombre)
      ? {
          ...base,
          estado: "ya_importado",
          vinculacion,
          motivo: "Ya estaba importado en esta marca.",
        }
      : {
          ...base,
          estado: "conflicto",
          vinculacion,
          motivo: `Ya importado en esta marca como «${previo.nombre}»; se conserva el dato existente.`,
        };
  }
  return {
    ...base,
    estado: base.asociacionesPrevias.length ? "nueva_asociacion" : "nuevo",
    vinculacion,
    motivo: null,
  };
}

/** Errores de datos y duplicados dentro del mismo archivo. */
function revisarFilas(filas: FilaArchivo[]) {
  const vistos = new Map<string, number>();
  const invalidas: FilaResultado[] = [];
  const unicas: (FilaArchivo & { correo: string })[] = [];
  for (const f of filas) {
    const correo = normalizarCorreo(f.correo);
    const error = !f.nombre
      ? "Falta el nombre."
      : !f.correo
        ? "Falta el correo electrónico."
        : !correoValido.safeParse(correo).success
          ? "Correo electrónico inválido."
          : null;
    const base = {
      fila: f.fila,
      nombre: f.nombre,
      correo: f.correo,
      vinculacion: null,
      asociacionesPrevias: [],
    };
    if (error) {
      invalidas.push({ ...base, estado: "error", motivo: error });
      continue;
    }
    const anterior = vistos.get(correo);
    if (anterior) {
      invalidas.push({
        ...base,
        correo,
        estado: "duplicado_archivo",
        motivo: `Repite el correo de la fila ${anterior}.`,
      });
      continue;
    }
    vistos.set(correo, f.fila);
    unicas.push({ ...f, correo });
  }
  return { invalidas, unicas };
}

const porFila = (a: FilaResultado, b: FilaResultado) => a.fila - b.fila;

export function resumir(filas: FilaResultado[]): ResumenImportacion {
  const cuenta = (p: (f: FilaResultado) => boolean) => filas.filter(p).length;
  const importada = (f: FilaResultado) =>
    f.estado === "nuevo" || f.estado === "nueva_asociacion";
  return {
    filas: filas.length,
    importados: cuenta(importada),
    vinculados: cuenta(
      (f) => f.vinculacion === "vinculara" || f.vinculacion === "vinculado",
    ),
    pendientes: cuenta((f) => importada(f) && f.vinculacion === "pendiente"),
    duplicados: cuenta(
      (f) => f.estado === "ya_importado" || f.estado === "duplicado_archivo",
    ),
    conflictos: cuenta((f) => f.estado === "conflicto"),
    revision: cuenta((f) => f.estado === "revision"),
    errores: cuenta((f) => f.estado === "error"),
  };
}

// ── Vista previa (sin escrituras) ─────────────────────────────────────
export async function vistaPrevia(
  almacen: Almacen,
  marca: Marca,
  datos: Buffer,
): Promise<{
  marca: Marca;
  resumen: ResumenImportacion;
  filas: FilaResultado[];
}> {
  const { invalidas, unicas } = revisarFilas(await filasDelArchivo(datos));
  const clasificadas: FilaResultado[] = [];
  for (let i = 0; i < unicas.length; i += 100) {
    const grupo = unicas.slice(i, i + 100);
    const estados = await Promise.all(
      grupo.map((f) => estadoCorreo(almacen, f.correo)),
    );
    grupo.forEach((f, j) =>
      clasificadas.push(clasificar(f, marca, estados[j]!)),
    );
  }
  const filas = [...invalidas, ...clasificadas].sort(porFila);
  return { marca, resumen: resumir(filas), filas };
}

// ── Confirmación ──────────────────────────────────────────────────────
/**
 * Escribe una fila ya clasificada (sin lecturas: Firestore exige leer todo
 * antes de escribir dentro de la transacción).
 */
function aplicarFila(
  tx: Transaccion,
  almacen: Almacen,
  f: FilaArchivo & { correo: string },
  estado: Awaited<ReturnType<typeof estadoCorreo>>,
  perfil: Record<string, unknown> | null,
  ctx: { marca: Marca; id: string; actor: string; en: string },
): FilaResultado {
  const r = clasificar(f, ctx.marca, estado);
  if (r.estado === "revision") return r;
  const actual = estado.importado;
  const importa = r.estado === "nuevo" || r.estado === "nueva_asociacion";
  const uid =
    r.vinculacion === "vinculara" || r.vinculacion === "ya_vinculado"
      ? estado.cuenta!.uid
      : (actual?.uid ?? null);
  if (importa || (actual && actual.uid !== uid)) {
    const marcas = { ...(actual?.marcas ?? {}) };
    if (importa) {
      marcas[ctx.marca] = {
        nombre: f.nombre,
        importadoEn: ctx.en,
        importacionId: ctx.id,
      };
    }
    tx.fijar(R.importado(huellaCorreo(f.correo)), {
      correo: f.correo,
      marcas,
      listaMarcas: MARCAS.filter((m) => marcas[m]),
      uid,
      actualizadoEn: ctx.en,
    } satisfies Importado);
  }
  if (r.vinculacion !== "vinculara") return r;
  const cuenta = estado.cuenta!;
  tx.fijar(R.usuario(cuenta.uid), {
    ...perfil,
    marcas: MARCAS.filter((m) => m === ctx.marca || cuenta.marcas.includes(m)),
    vinculo: "vinculado",
  });
  auditar(tx, almacen.nuevoId(), {
    accion: "cliente.actualizado",
    actor: ctx.actor,
    objetivo: cuenta.uid,
    en: ctx.en,
    datos: {
      marcaAgregada: ctx.marca,
      origen: "importacion",
      importacionId: ctx.id,
    },
  });
  return { ...r, vinculacion: "vinculado" };
}

export async function confirmarImportacion(
  almacen: Almacen,
  p: {
    idImportacion: string;
    marca: Marca;
    archivo: string;
    datos: Buffer;
    actor: string;
  },
  ahora: Date,
): Promise<{ id: string; resumen: ResumenImportacion; repetido: boolean }> {
  const en = ahora.toISOString();
  const previo = await almacen.leer<LoteImportacion>(
    R.importacion(p.idImportacion),
  );
  if (previo && (previo.marca !== p.marca || previo.archivo !== p.archivo)) {
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Ese identificador de importación ya se usó con otro archivo o marca.",
    );
  }
  if (previo?.estado === "completada") {
    return { id: p.idImportacion, resumen: previo.resumen!, repetido: true };
  }
  const { invalidas, unicas } = revisarFilas(await filasDelArchivo(p.datos));
  await purgarVencidas(almacen, ahora);
  await almacen.transaccion(async (tx) => {
    if (!(await tx.leer(R.importacion(p.idImportacion)))) {
      tx.crear(R.importacion(p.idImportacion), {
        marca: p.marca,
        archivo: p.archivo,
        actor: p.actor,
        creadoEn: en,
        expiraEn: addDays(ahora, DIAS_CONSERVACION).toISOString(),
        estado: "en_proceso",
        resumen: null,
        partes: 0,
      } satisfies LoteImportacion);
    }
  });

  const aplicadas: FilaResultado[] = [];
  const ctx = { marca: p.marca, id: p.idImportacion, actor: p.actor, en };
  for (let i = 0; i < unicas.length; i += FILAS_POR_TRANSACCION) {
    const grupo = unicas.slice(i, i + FILAS_POR_TRANSACCION);
    aplicadas.push(
      ...(await almacen.transaccion(async (tx) => {
        // Primero todas las lecturas del grupo; después las escrituras.
        const estados = await Promise.all(
          grupo.map((f) => estadoCorreo(tx, f.correo)),
        );
        const perfiles = await Promise.all(
          estados.map((e) =>
            e.cuenta ? tx.leer(R.usuario(e.cuenta.uid)) : null,
          ),
        );
        return grupo.map((f, j) =>
          aplicarFila(tx, almacen, f, estados[j]!, perfiles[j]!, ctx),
        );
      })),
    );
  }

  const filas = [...invalidas, ...aplicadas].sort(porFila);
  const resumen = resumir(filas);
  const partes = Math.ceil(filas.length / FILAS_POR_PARTE);
  await almacen.transaccion(async (tx) => {
    const lote = await tx.leer<LoteImportacion>(R.importacion(p.idImportacion));
    for (let n = 0; n < partes; n++) {
      tx.fijar(R.parteImportacion(p.idImportacion, n), {
        filas: filas.slice(n * FILAS_POR_PARTE, (n + 1) * FILAS_POR_PARTE),
      });
    }
    tx.fijar(R.importacion(p.idImportacion), {
      ...lote!,
      estado: "completada",
      resumen,
      partes,
    });
    auditar(tx, almacen.nuevoId(), {
      accion: "importacion.confirmada",
      actor: p.actor,
      objetivo: p.idImportacion,
      en,
      datos: { marca: p.marca, ...resumen },
    });
  });
  return { id: p.idImportacion, resumen, repetido: false };
}

// ── Consulta, reporte y conservación ──────────────────────────────────
export async function purgarVencidas(almacen: Almacen, ahora: Date) {
  const vencidas = await almacen.consultar<LoteImportacion>({
    coleccion: R.importaciones,
    donde: [["expiraEn", "<", ahora.toISOString()]],
    limite: 20,
  });
  for (const v of vencidas) {
    await almacen.transaccion(async (tx) => {
      for (let n = 0; n < v.datos.partes; n++) {
        tx.borrar(R.parteImportacion(v.id, n));
      }
      tx.borrar(R.importacion(v.id));
    });
  }
  return vencidas.length;
}

export async function listarImportaciones(almacen: Almacen, ahora: Date) {
  const docs = await almacen.consultar<LoteImportacion>({
    coleccion: R.importaciones,
    donde: [["expiraEn", ">=", ahora.toISOString()]],
  });
  return docs
    .map((d) => ({
      id: d.id,
      marca: d.datos.marca,
      archivo: d.datos.archivo,
      creadoEn: d.datos.creadoEn,
      expiraEn: d.datos.expiraEn,
      estado: d.datos.estado,
      resumen: d.datos.resumen,
    }))
    .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
}

export async function filasDeImportacion(
  almacen: Almacen,
  id: string,
  ahora: Date,
) {
  const lote = await almacen.leer<LoteImportacion>(R.importacion(id));
  if (
    !lote ||
    lote.expiraEn < ahora.toISOString() ||
    lote.estado !== "completada"
  ) {
    throw new AppError(
      404,
      "NOT_FOUND",
      "La importación no existe o ya venció.",
    );
  }
  const partes = await Promise.all(
    Array.from({ length: lote.partes }, (_, n) =>
      almacen.leer<{ filas: FilaResultado[] }>(R.parteImportacion(id, n)),
    ),
  );
  return { lote, filas: partes.flatMap((p) => p?.filas ?? []) };
}

const ETIQUETA_ESTADO: Record<EstadoFila, string> = {
  nuevo: "Importado",
  nueva_asociacion: "Importado (marca nueva)",
  ya_importado: "Duplicado: ya importado",
  duplicado_archivo: "Duplicado en el archivo",
  conflicto: "Conflicto",
  revision: "Revisión",
  error: "Error",
};
const ETIQUETA_VINCULO: Record<NonNullable<Vinculacion>, string> = {
  vinculara: "Se vinculará",
  vinculado: "Vinculado",
  ya_vinculado: "Ya vinculado",
  pendiente: "Pendiente de registro",
};
const NOMBRE_MARCA: Record<Marca, string> = {
  zontes: "Zontes",
  kiden: "Kiden",
  niu: "NIU",
};

export async function reporteImportacion(
  almacen: Almacen,
  id: string,
  formato: "csv" | "xlsx",
  ahora: Date,
) {
  const { lote, filas } = await filasDeImportacion(almacen, id, ahora);
  const columnas = [
    "Fila",
    "Nombre",
    "Correo",
    "Resultado",
    "Vinculación",
    "Marcas previas",
    "Motivo",
  ];
  const celdas: Celda[][] = filas.map((f) => [
    f.fila,
    f.nombre,
    f.correo,
    ETIQUETA_ESTADO[f.estado],
    f.vinculacion ? ETIQUETA_VINCULO[f.vinculacion] : "",
    f.asociacionesPrevias.map((m) => NOMBRE_MARCA[m]).join(", "),
    f.motivo ?? "",
  ]);
  const archivo =
    formato === "xlsx"
      ? await aXlsx(columnas, celdas, "importacion")
      : aCsv(columnas, celdas);
  return { lote, archivo };
}

// ── Pendientes de registro y fuente del vínculo ───────────────────────
export interface Pendiente {
  correo: string;
  marcas: { marca: Marca; nombre: string; importadoEn: string }[];
  actualizadoEn: string;
}

const aPendiente = (d: Importado): Pendiente => ({
  correo: d.correo,
  marcas: d.listaMarcas
    .map((m) => ({ marca: m, ...d.marcas[m]! }))
    .map(({ marca, nombre, importadoEn }) => ({ marca, nombre, importadoEn })),
  actualizadoEn: d.actualizadoEn,
});

/**
 * Importados sin cuenta de cliente (SRC-06 p. 1 punto 8). Si la persona ya se
 * registró, se anota su uid y deja de figurar aquí.
 */
export async function listarPendientes(
  almacen: Almacen,
  q: { marca?: Marca; correo?: string; limite: number; cursor?: string },
): Promise<{ items: Pendiente[]; siguiente: string | null }> {
  if (q.correo) {
    const correo = normalizarCorreo(q.correo);
    const { importado, cuenta } = await estadoCorreo(almacen, correo);
    const vale =
      importado &&
      !cuenta &&
      (!q.marca || importado.listaMarcas.includes(q.marca));
    return { items: vale ? [aPendiente(importado)] : [], siguiente: null };
  }
  const docs = await almacen.consultar<Importado>({
    coleccion: R.importados,
    donde: [
      ["uid", "==", null],
      ...(q.marca
        ? [["listaMarcas", "array-contains", q.marca] satisfies Filtro]
        : []),
    ],
    ordenId: "asc",
    despuesDeId: q.cursor,
    limite: q.limite,
  });
  const items: Pendiente[] = [];
  for (const d of docs) {
    const indice = await almacen.leer<{ uid: string }>(R.correo(d.id));
    if (indice) {
      // Se registró después de importarse: queda anotado y sale de la lista.
      await almacen.transaccion(async (tx) => {
        const actual = await tx.leer<Importado>(R.importado(d.id));
        if (actual && actual.uid === null) {
          tx.fijar(R.importado(d.id), { ...actual, uid: indice.uid });
        }
      });
      continue;
    }
    items.push(aPendiente(d.datos));
  }
  return {
    items,
    siguiente: docs.length === q.limite ? docs.at(-1)!.id : null,
  };
}

/** Marcas importadas de un correo (para el detalle del cliente). */
export async function importacionDe(almacen: Almacen, correo: string) {
  const d = await almacen.leer<Importado>(
    R.importado(huellaCorreo(normalizarCorreo(correo))),
  );
  return d ? aPendiente(d).marcas : [];
}

/**
 * Fuente del vínculo (DEC-04 → DEC-17): las marcas en que el correo fue
 * importado. Con `sintetica` se suma el doble de desarrollo.
 */
export function crearFuenteImportacion(
  almacen: Almacen,
  adicional?: FuenteLegacy,
): FuenteLegacy {
  return {
    async buscarPorCorreo(correoNormalizado) {
      const [importado, extra] = await Promise.all([
        almacen.leer<Importado>(R.importado(huellaCorreo(correoNormalizado))),
        adicional?.buscarPorCorreo(correoNormalizado) ?? null,
      ]);
      const marcas = MARCAS.filter(
        (m) => importado?.listaMarcas.includes(m) || extra?.marcas.includes(m),
      );
      return marcas.length ? { marcas } : null;
    },
  };
}
