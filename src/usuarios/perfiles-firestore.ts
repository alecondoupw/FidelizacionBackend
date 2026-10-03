import type { Firestore } from "firebase-admin/firestore";
import { MARCAS, ROLES, type Perfil } from "../dominio/tipos.js";
import { huellaCorreo } from "./correo.js";
import type { PerfilRepository } from "./perfiles.js";

/**
 * Modelo Firestore (DEC-03):
 *   {prefijo}usuarios/{uid}          perfil, rol y estado
 *   {prefijo}correos/{sha256(correo)} { uid }  — unicidad del correo
 *   {prefijo}auditoria/{auto}         eventos sin datos personales
 */
export function crearPerfilesFirestore(
  db: Firestore,
  prefijo = "",
): PerfilRepository {
  const usuarios = db.collection(`${prefijo}usuarios`);
  const correos = db.collection(`${prefijo}correos`);
  const auditoria = db.collection(`${prefijo}auditoria`);

  return {
    async obtener(uid) {
      const snap = await usuarios.doc(uid).get();
      return snap.exists ? aPerfil(uid, snap.data()) : null;
    },

    async registrar(perfil, evento) {
      const usuarioRef = usuarios.doc(perfil.uid);
      const correoRef = correos.doc(huellaCorreo(perfil.correo));
      return db.runTransaction(async (tx) => {
        const [usuario, correo] = await Promise.all([
          tx.get(usuarioRef),
          tx.get(correoRef),
        ]);
        if (usuario.exists) return "uid_existente";
        if (correo.exists) return "correo_existente";
        tx.create(usuarioRef, {
          correo: perfil.correo,
          rol: perfil.rol,
          activo: perfil.activo,
          marcas: perfil.marcas,
          vinculo: perfil.vinculo,
          creadoEn: perfil.creadoEn,
        });
        tx.create(correoRef, { uid: perfil.uid });
        tx.create(auditoria.doc(), evento);
        return "creado";
      });
    },

    async hayAdministradorActivo() {
      const snap = await usuarios
        .where("rol", "==", "administrador")
        .where("activo", "==", true)
        .limit(1)
        .get();
      return !snap.empty;
    },
  };
}

/** Valida el documento leído: un dato corrupto no concede permisos. */
function aPerfil(uid: string, data: unknown): Perfil {
  const d = (data ?? {}) as Record<string, unknown>;
  const rol = ROLES.find((r) => r === d.rol);
  const marcas = Array.isArray(d.marcas)
    ? MARCAS.filter((m) => (d.marcas as unknown[]).includes(m))
    : [];
  if (!rol || typeof d.correo !== "string") {
    throw new Error(`Perfil ${uid} con formato inválido en Firestore.`);
  }
  return {
    uid,
    correo: d.correo,
    rol,
    activo: d.activo === true,
    marcas,
    vinculo: d.vinculo === "vinculado" ? "vinculado" : "no_vinculado",
    creadoEn: typeof d.creadoEn === "string" ? d.creadoEn : "",
  };
}
