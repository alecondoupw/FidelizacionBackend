import type { Almacen, Datos } from "../almacen/almacen.js";
import { indiceDe, type Canje } from "../canjes/tipos.js";
import type { Marca } from "../dominio/tipos.js";
import { asientoDe, type Asiento } from "../puntos/libro.js";
import { R } from "../puntos/rutas.js";
import type { Movimiento } from "../puntos/tipos.js";

export interface ResultadoConciliacion {
  movimientos: number;
  asientos: number;
  /** Movimientos sin asiento en el libro (p. ej. anteriores a F5). */
  faltantes: number;
  /** Asientos cuyo contenido no coincide con su movimiento. */
  distintos: number;
  /** Asientos sin movimiento de origen: se informan, nunca se borran. */
  sobrantes: string[];
  canjes: number;
  /** Índices de código ausentes o sin los datos de reporte. */
  indicesDesactualizados: number;
  /** Escrituras aplicadas con `reparar`. */
  reparados: number;
}

const igual = (a: Datos, b: Datos) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

/**
 * Concilia el libro global y el índice de canjes con los datos de cada
 * cliente (F5-I-01). Con `reparar` escribe lo que falta o difiere, en lotes
 * pequeños; es idempotente.
 */
export async function conciliar(
  almacen: Almacen,
  { reparar = false }: { reparar?: boolean } = {},
): Promise<ResultadoConciliacion> {
  const libro = new Map(
    (await almacen.consultar<Asiento>({ coleccion: R.libro })).map((d) => [
      d.id,
      d.datos,
    ]),
  );
  const pendientes: [string, Datos][] = [];
  const vistos = new Set<string>();
  let movimientos = 0;
  let faltantes = 0;
  let distintos = 0;
  let canjes = 0;
  let indicesDesactualizados = 0;

  for (const usuario of await almacen.consultar({ coleccion: "usuarios" })) {
    const uid = usuario.id;
    for (const cuenta of await almacen.consultar({
      coleccion: `usuarios/${uid}/marcas`,
    })) {
      const marca = cuenta.id as Marca;
      for (const m of await almacen.consultar<Movimiento>({
        coleccion: R.movimientos(uid, marca),
      })) {
        movimientos++;
        vistos.add(m.id);
        const esperado = asientoDe(uid, marca, m.datos);
        const actual = libro.get(m.id);
        if (!actual) faltantes++;
        else if (!igual(actual, esperado)) distintos++;
        else continue;
        pendientes.push([R.asiento(m.id), esperado]);
      }
    }
    for (const c of await almacen.consultar<Canje>({
      coleccion: R.canjes(uid),
    })) {
      canjes++;
      const esperado = indiceDe(c.datos, uid, c.id);
      const actual = await almacen.leer(R.codigo(c.datos.codigo));
      if (actual && igual(actual, esperado)) continue;
      indicesDesactualizados++;
      pendientes.push([R.codigo(c.datos.codigo), esperado]);
    }
  }

  let reparados = 0;
  if (reparar) {
    for (let i = 0; i < pendientes.length; i += 200) {
      const lote = pendientes.slice(i, i + 200);
      await almacen.transaccion(async (tx) => {
        for (const [ruta, datos] of lote) tx.fijar(ruta, datos);
      });
      reparados += lote.length;
    }
  }
  return {
    movimientos,
    asientos: libro.size,
    faltantes,
    distintos,
    sobrantes: [...libro.keys()].filter((id) => !vistos.has(id)),
    canjes,
    indicesDesactualizados,
    reparados,
  };
}
