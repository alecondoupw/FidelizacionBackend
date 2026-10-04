import {
  Timestamp,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";

/**
 * Respaldo propio de Firestore en JSON (DEC-13): funciona en el plan gratuito
 * y se restaura en colecciones con prefijo para probarlo sin tocar las reales.
 *
 *   exportar   → lee todas las colecciones raíz del prefijo, con subcolecciones
 *   restaurar  → escribe un respaldo bajo otro prefijo (por defecto exige vacío)
 *   comparar   → diferencias documento a documento entre dos respaldos
 *
 * No incluye las cuentas de Firebase Auth: los perfiles guardan uid y correo,
 * pero contraseñas y proveedores viven en Auth (ver el manual de operación).
 */
export const FORMATO_RESPALDO = "fidelizacion-respaldo";

export interface DocumentoRespaldo {
  id: string;
  /** null: documento inexistente que sólo agrupa subcolecciones. */
  datos: Record<string, unknown> | null;
  subcolecciones?: Record<string, DocumentoRespaldo[]>;
}

export interface Respaldo {
  formato: typeof FORMATO_RESPALDO;
  version: 1;
  creadoEn: string;
  proyecto: string | null;
  colecciones: Record<string, DocumentoRespaldo[]>;
}

export class RespaldoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "RespaldoError";
  }
}

// ── Valores ───────────────────────────────────────────────────────────
const MARCA = "__tipo";

/** Convierte un valor de Firestore a JSON; los tipos sin uso en el modelo fallan. */
export function serializar(valor: unknown, ruta = ""): unknown {
  if (valor === null || typeof valor !== "object") {
    if (typeof valor === "number" && !Number.isFinite(valor)) {
      throw new RespaldoError(`Número no representable en ${ruta}.`);
    }
    return valor;
  }
  if (valor instanceof Timestamp) {
    return {
      [MARCA]: "timestamp",
      iso: valor.toDate().toISOString(),
      nanos: valor.nanoseconds,
    };
  }
  if (Array.isArray(valor))
    return valor.map((v, i) => serializar(v, `${ruta}[${i}]`));
  if (Object.getPrototypeOf(valor) !== Object.prototype) {
    throw new RespaldoError(
      `Tipo no soportado (${valor.constructor?.name ?? "desconocido"}) en ${ruta}.`,
    );
  }
  if (MARCA in valor) {
    throw new RespaldoError(`Campo reservado «${MARCA}» en ${ruta}.`);
  }
  return Object.fromEntries(
    Object.entries(valor).map(([k, v]) => [k, serializar(v, `${ruta}.${k}`)]),
  );
}

export function deserializar(valor: unknown): unknown {
  if (valor === null || typeof valor !== "object") return valor;
  if (Array.isArray(valor)) return valor.map(deserializar);
  const objeto = valor as Record<string, unknown>;
  if (objeto[MARCA] === "timestamp") {
    const segundos = Math.floor(Date.parse(String(objeto.iso)) / 1000);
    return new Timestamp(segundos, Number(objeto.nanos));
  }
  return Object.fromEntries(
    Object.entries(objeto).map(([k, v]) => [k, deserializar(v)]),
  );
}

// ── Exportar ──────────────────────────────────────────────────────────
const LOTE = 200;

async function exportarColeccion(
  db: Firestore,
  coleccion: CollectionReference,
): Promise<DocumentoRespaldo[]> {
  const refs = await coleccion.listDocuments();
  const salida: DocumentoRespaldo[] = [];
  for (let i = 0; i < refs.length; i += LOTE) {
    const grupo = refs.slice(i, i + LOTE);
    const snaps = grupo.length ? await db.getAll(...grupo) : [];
    const docs = await Promise.all(
      grupo.map(async (ref, j) => {
        const snap = snaps[j]!;
        const doc: DocumentoRespaldo = {
          id: ref.id,
          datos: snap.exists
            ? (serializar(snap.data(), ref.path) as Record<string, unknown>)
            : null,
        };
        const subs = await exportarSubcolecciones(db, ref);
        if (subs) doc.subcolecciones = subs;
        return doc;
      }),
    );
    salida.push(...docs);
  }
  return salida.sort((a, b) => a.id.localeCompare(b.id));
}

async function exportarSubcolecciones(db: Firestore, ref: DocumentReference) {
  const cols = await ref.listCollections();
  if (!cols.length) return undefined;
  const subs: Record<string, DocumentoRespaldo[]> = {};
  for (const c of cols.sort((a, b) => a.id.localeCompare(b.id))) {
    subs[c.id] = await exportarColeccion(db, c);
  }
  return subs;
}

/** Colecciones raíz del prefijo; sin prefijo se excluyen las temporales `prueba_*`. */
export async function coleccionesRaiz(db: Firestore, prefijo: string) {
  return (await db.listCollections())
    .filter((c) =>
      prefijo ? c.id.startsWith(prefijo) : !c.id.startsWith("prueba_"),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function exportar(
  db: Firestore,
  opciones: { prefijo?: string; proyecto?: string | null; ahora?: Date } = {},
): Promise<Respaldo> {
  const prefijo = opciones.prefijo ?? "";
  const colecciones: Record<string, DocumentoRespaldo[]> = {};
  for (const c of await coleccionesRaiz(db, prefijo)) {
    colecciones[c.id.slice(prefijo.length)] = await exportarColeccion(db, c);
  }
  return {
    formato: FORMATO_RESPALDO,
    version: 1,
    creadoEn: (opciones.ahora ?? new Date()).toISOString(),
    proyecto: opciones.proyecto ?? null,
    colecciones,
  };
}

// ── Restaurar ─────────────────────────────────────────────────────────
export function validarRespaldo(json: unknown): Respaldo {
  const r = json as Partial<Respaldo> | null;
  if (
    !r ||
    r.formato !== FORMATO_RESPALDO ||
    r.version !== 1 ||
    typeof r.colecciones !== "object" ||
    r.colecciones === null
  ) {
    throw new RespaldoError("El archivo no es un respaldo de Fidelización v1.");
  }
  return r as Respaldo;
}

export async function restaurar(
  db: Firestore,
  respaldo: Respaldo,
  opciones: { prefijo: string; permitirNoVacio?: boolean },
): Promise<{ documentos: number }> {
  const nombres = Object.keys(respaldo.colecciones);
  if (!opciones.permitirNoVacio) {
    for (const n of nombres) {
      const hay = await db.collection(`${opciones.prefijo}${n}`).limit(1).get();
      if (!hay.empty) {
        throw new RespaldoError(
          `La colección de destino «${opciones.prefijo}${n}» no está vacía.`,
        );
      }
    }
  }
  const escritor = db.bulkWriter();
  let documentos = 0;
  const escribir = (base: string, docs: DocumentoRespaldo[]) => {
    for (const d of docs) {
      const ruta = `${base}/${d.id}`;
      if (d.datos) {
        void escritor.set(
          db.doc(ruta),
          deserializar(d.datos) as Record<string, unknown>,
        );
        documentos++;
      }
      for (const [sub, hijos] of Object.entries(d.subcolecciones ?? {})) {
        escribir(`${ruta}/${sub}`, hijos);
      }
    }
  };
  for (const n of nombres) {
    escribir(`${opciones.prefijo}${n}`, respaldo.colecciones[n]!);
  }
  await escritor.close();
  return { documentos };
}

// ── Contar y comparar ─────────────────────────────────────────────────
export function contar(respaldo: Respaldo): Record<string, number> {
  const cuenta = (docs: DocumentoRespaldo[]): number =>
    docs.reduce(
      (n, d) =>
        n +
        (d.datos ? 1 : 0) +
        Object.values(d.subcolecciones ?? {}).reduce(
          (m, h) => m + cuenta(h),
          0,
        ),
      0,
    );
  return Object.fromEntries(
    Object.entries(respaldo.colecciones).map(([n, docs]) => [n, cuenta(docs)]),
  );
}

/** JSON con claves ordenadas: dos documentos iguales dan el mismo texto. */
function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  const o = valor as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
    .join(",")}}`;
}

function aplanar(
  colecciones: Record<string, DocumentoRespaldo[]>,
  base = "",
  salida = new Map<string, string>(),
) {
  for (const [nombre, docs] of Object.entries(colecciones)) {
    for (const d of docs) {
      const ruta = `${base}${nombre}/${d.id}`;
      if (d.datos) salida.set(ruta, canonico(d.datos));
      aplanar(d.subcolecciones ?? {}, `${ruta}/`, salida);
    }
  }
  return salida;
}

export interface Diferencia {
  ruta: string;
  tipo: "falta" | "sobra" | "distinto";
}

/** Diferencias de `destino` respecto de `origen`, documento a documento. */
export function comparar(origen: Respaldo, destino: Respaldo): Diferencia[] {
  const a = aplanar(origen.colecciones);
  const b = aplanar(destino.colecciones);
  const diferencias: Diferencia[] = [];
  for (const [ruta, valor] of a) {
    if (!b.has(ruta)) diferencias.push({ ruta, tipo: "falta" });
    else if (b.get(ruta) !== valor)
      diferencias.push({ ruta, tipo: "distinto" });
  }
  for (const ruta of b.keys()) {
    if (!a.has(ruta)) diferencias.push({ ruta, tipo: "sobra" });
  }
  return diferencias.sort((x, y) => x.ruta.localeCompare(y.ruta));
}
