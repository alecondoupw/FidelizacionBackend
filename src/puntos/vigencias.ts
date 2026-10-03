import type { Almacen } from "../almacen/almacen.js";
import { MARCAS, type Marca } from "../dominio/tipos.js";
import { auditar, type RegistroAuditoria } from "./auditoria.js";
import { R } from "./rutas.js";
import type { Unidad, Vigencia } from "./tipos.js";

/** Sin configuración, los puntos de una marca no vencen (SRC-02 p. 5, punto 3). */
export const vigenciaPorDefecto = (marca: Marca): Vigencia => ({
  marca,
  activa: false,
  cantidad: 12,
  unidad: "meses",
  actualizadoEn: null,
  actualizadoPor: null,
});

export async function listarVigencias(almacen: Almacen): Promise<Vigencia[]> {
  return Promise.all(
    MARCAS.map(
      async (m) =>
        (await almacen.leer<Vigencia>(R.vigencia(m))) ?? vigenciaPorDefecto(m),
    ),
  );
}

/** Cambio prospectivo y auditado (SRC-02 p. 5, puntos 5 y 7). */
export async function actualizarVigencia(
  almacen: Almacen,
  marca: Marca,
  cambios: { activa: boolean; cantidad: number; unidad: Unidad },
  actor: string,
  ahora: Date,
): Promise<Vigencia> {
  const en = ahora.toISOString();
  return almacen.transaccion(async (tx) => {
    const actual =
      (await tx.leer<Vigencia>(R.vigencia(marca))) ?? vigenciaPorDefecto(marca);
    const nueva: Vigencia = {
      marca,
      ...cambios,
      actualizadoEn: en,
      actualizadoPor: actor,
    };
    tx.fijar(R.vigencia(marca), nueva);
    const valor = (v: Vigencia) => ({
      activa: v.activa,
      cantidad: v.cantidad,
      unidad: v.unidad,
    });
    auditar(tx, almacen.nuevoId(), {
      accion: "vigencia.actualizada",
      actor,
      objetivo: marca,
      en,
      datos: { antes: valor(actual), despues: valor(nueva) },
    });
    return nueva;
  });
}

export async function historialVigencia(
  almacen: Almacen,
  marca: Marca,
): Promise<{ en: string; actor: string; antes: unknown; despues: unknown }[]> {
  const docs = await almacen.consultar<RegistroAuditoria>({
    coleccion: "auditoria",
    donde: [
      ["accion", "==", "vigencia.actualizada"],
      ["objetivo", "==", marca],
    ],
  });
  return docs
    .map((d) => ({
      en: d.datos.en,
      actor: d.datos.actor,
      antes: d.datos.datos.antes,
      despues: d.datos.datos.despues,
    }))
    .sort((a, b) => (a.en < b.en ? 1 : -1));
}
