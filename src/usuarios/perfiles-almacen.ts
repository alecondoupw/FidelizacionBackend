import {
  DocumentoExistenteError,
  type Almacen,
  type Datos,
} from "../almacen/almacen.js";
import { MARCAS, ROLES, type Perfil } from "../dominio/tipos.js";
import { R } from "../puntos/rutas.js";
import { huellaCorreo } from "./correo.js";
import type { PerfilRepository } from "./perfiles.js";

/**
 * Perfiles sobre el almacén transaccional (DEC-03), el mismo que usan puntos,
 * canjes y la gestión de identidades de F4:
 *   usuarios/{uid}              perfil, rol y estado
 *   correos/{sha256(correo)}    { uid } — unicidad del correo
 *   auditoria/{id}              eventos sin datos personales
 */
export function crearPerfilesAlmacen(almacen: Almacen): PerfilRepository {
  return {
    async obtener(uid) {
      const datos = await almacen.leer(R.usuario(uid));
      return datos ? aPerfil(uid, datos) : null;
    },

    async registrar(perfil, evento) {
      try {
        return await almacen.transaccion(async (tx) => {
          const [usuario, correo] = await Promise.all([
            tx.leer(R.usuario(perfil.uid)),
            tx.leer(R.correo(huellaCorreo(perfil.correo))),
          ]);
          if (usuario) return "uid_existente" as const;
          if (correo) return "correo_existente" as const;
          tx.crear(R.usuario(perfil.uid), datosDePerfil(perfil));
          tx.crear(R.correo(huellaCorreo(perfil.correo)), { uid: perfil.uid });
          tx.crear(R.auditoria(almacen.nuevoId()), { ...evento });
          return "creado" as const;
        });
      } catch (error) {
        // Carrera con otro registro del mismo uid o correo entre lectura y escritura.
        // Firestore no informa qué documento chocó: se decide releyendo.
        if (error instanceof DocumentoExistenteError) {
          return (await almacen.leer(R.usuario(perfil.uid)))
            ? "uid_existente"
            : "correo_existente";
        }
        throw error;
      }
    },

    async hayAdministradorActivo() {
      const activos = await almacen.consultar({
        coleccion: "usuarios",
        donde: [
          ["rol", "==", "administrador"],
          ["activo", "==", true],
        ],
        limite: 1,
      });
      return activos.length > 0;
    },
  };
}

/** Campos persistidos del perfil (el uid es el id del documento). */
export function datosDePerfil(p: Perfil): Datos {
  const datos: Datos = { ...p };
  delete datos.uid;
  return datos;
}

/** Valida el documento leído: un dato corrupto no concede permisos. */
export function aPerfil(uid: string, data: unknown): Perfil {
  const d = (data ?? {}) as Record<string, unknown>;
  const rol = ROLES.find((r) => r === d.rol);
  const marcas = Array.isArray(d.marcas)
    ? MARCAS.filter((m) => (d.marcas as unknown[]).includes(m))
    : [];
  if (!rol || typeof d.correo !== "string") {
    throw new Error(`Perfil ${uid} con formato inválido.`);
  }
  const perfil: Perfil = {
    uid,
    correo: d.correo,
    rol,
    activo: d.activo === true && d.eliminado !== true,
    marcas,
    vinculo: d.vinculo === "vinculado" ? "vinculado" : "no_vinculado",
    creadoEn: typeof d.creadoEn === "string" ? d.creadoEn : "",
  };
  if (d.verificarCorreo === true) perfil.verificarCorreo = true;
  if (d.eliminado === true) perfil.eliminado = true;
  return perfil;
}
