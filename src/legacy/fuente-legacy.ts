import type { Marca } from "../dominio/tipos.js";

/**
 * Fuente de clientes existentes (DEC-04). Express sólo pregunta por un correo
 * normalizado y recibe las marcas confirmadas; nunca nombre ni teléfono.
 * La conexión real se implementa cuando Paulo entregue API/esquema.
 */
export interface FuenteLegacy {
  buscarPorCorreo(
    correoNormalizado: string,
  ): Promise<{ marcas: Marca[] } | null>;
}

/**
 * Doble sintético para F1. Dominio reservado `.test`: no corresponde a
 * personas reales. Un correo puede tener 1–3 marcas (DEC-04).
 */
export const CLIENTES_SINTETICOS: Readonly<Record<string, readonly Marca[]>> = {
  "cliente.zontes@ejemplo.test": ["zontes"],
  "cliente.kiden.niu@ejemplo.test": ["kiden", "niu"],
  "cliente.multimarca@ejemplo.test": ["zontes", "kiden", "niu"],
};

export function crearFuenteSintetica(
  datos: Readonly<Record<string, readonly Marca[]>> = CLIENTES_SINTETICOS,
): FuenteLegacy {
  return {
    async buscarPorCorreo(correoNormalizado) {
      const marcas = datos[correoNormalizado];
      return marcas ? { marcas: [...marcas] } : null;
    },
  };
}
