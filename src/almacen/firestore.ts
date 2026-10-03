import {
  FieldPath,
  type Firestore,
  type Query,
  type QuerySnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import {
  DocumentoExistenteError,
  esRango,
  type Almacen,
  type Consulta,
  type Datos,
  type Documento,
  type Transaccion,
} from "./almacen.js";

/** Almacén sobre Firestore; las transacciones usan `runTransaction`. */
export function crearAlmacenFirestore(db: Firestore, prefijo = ""): Almacen {
  const conPrefijo = (ruta: string) => `${prefijo}${ruta}`;
  const doc = (ruta: string) => db.doc(conPrefijo(ruta));

  const consulta = (c: Consulta): Query => {
    if ((c.donde ?? []).some(([, op]) => esRango(op)) && c.ordenId) {
      throw new Error("Consulta inválida: rango combinado con orden por id.");
    }
    let q: Query = db.collection(conPrefijo(c.coleccion));
    for (const [campo, op, valor] of c.donde ?? [])
      q = q.where(campo, op, valor);
    if (c.ordenId) q = q.orderBy(FieldPath.documentId(), c.ordenId);
    if (c.despuesDeId) q = q.startAfter(c.despuesDeId);
    if (c.limite) q = q.limit(c.limite);
    return q;
  };

  const aDocumentos = <T>(snap: QuerySnapshot) =>
    snap.docs.map((d) => ({
      id: d.id,
      datos: d.data() as T,
    })) as Documento<T>[];

  const lectorDe = (t?: Transaction) => ({
    async leer<T extends Datos>(ruta: string) {
      const snap = t ? await t.get(doc(ruta)) : await doc(ruta).get();
      return snap.exists ? (snap.data() as T) : null;
    },
    async consultar<T extends Datos>(c: Consulta) {
      const q = consulta(c);
      return aDocumentos<T>(t ? await t.get(q) : await q.get());
    },
  });

  return {
    ...lectorDe(),
    nuevoId: () => db.collection("_").doc().id,
    transaccion<R>(fn: (tx: Transaccion) => Promise<R>) {
      return db
        .runTransaction((t) =>
          fn({
            ...lectorDe(t),
            crear: (ruta, datos) => void t.create(doc(ruta), datos),
            fijar: (ruta, datos) => void t.set(doc(ruta), datos),
            borrar: (ruta) => void t.delete(doc(ruta)),
          }),
        )
        .catch((error: unknown) => {
          // ALREADY_EXISTS (gRPC 6) llega al confirmar un `create` sobre un documento existente.
          if ((error as { code?: unknown }).code === 6) {
            throw new DocumentoExistenteError("(detectado al confirmar)");
          }
          throw error;
        });
    },
  };
}
