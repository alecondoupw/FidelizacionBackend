import type { Almacen, Filtro } from "../almacen/almacen.js";
import { estadoEfectivo } from "../canjes/disponibilidad.js";
import type { Canje, EstadoCanje } from "../canjes/tipos.js";
import { MARCAS, type Marca } from "../dominio/tipos.js";
import type { ProveedorCuentas } from "../identidad/cuentas.js";
import { normalizarCorreo, huellaCorreo } from "../usuarios/correo.js";
import { R } from "../puntos/rutas.js";
import { EVENTOS, type Evento } from "../puntos/tipos.js";
import {
  asientos,
  canjesEmitidos,
  personas,
  registros,
  type AsientoConId,
  type CanjeIndexado,
} from "./fuentes.js";
import {
  anterior,
  claveCubeta,
  cubetas,
  granularidad,
  ultimosDias,
  ultimosMeses,
  type Granularidad,
  type Periodo,
} from "./periodo.js";

export interface DepsReportes {
  almacen: Almacen;
  cuentas: ProveedorCuentas;
}

// ── Métricas sobre el libro (REQ-15: cada KPI se rastrea a movimientos) ──
const suma = (xs: AsientoConId[]) => xs.reduce((t, a) => t + a.puntos, 0);
const deTipo = (xs: AsientoConId[], tipo: AsientoConId["tipo"]) =>
  xs.filter((a) => a.tipo === tipo);

/** Puntos otorgados por eventos (no incluye ajustes). */
export const otorgados = (xs: AsientoConId[]) =>
  suma(deTipo(xs, "otorgamiento"));
/** Puntos usados en canjes, neto de anulaciones. */
export const utilizados = (xs: AsientoConId[]) => -suma(deTipo(xs, "canje"));
export const vencidos = (xs: AsientoConId[]) =>
  -suma(deTipo(xs, "vencimiento"));
const validos = (cs: CanjeIndexado[]) =>
  cs.filter((c) => c.estado !== "anulado");

const variacion = (actual: number, previo: number) => ({
  absoluta: actual - previo,
  porcentaje: previo === 0 ? null : ((actual - previo) / previo) * 100,
});

// ── A10 Actividad ─────────────────────────────────────────────────────
export async function reporteActividad(
  deps: DepsReportes,
  p: Periodo,
  marca?: Marca,
) {
  const [xs, cs, rs] = await Promise.all([
    asientos(deps.almacen, p, marca),
    canjesEmitidos(deps.almacen, p, marca),
    registros(deps.almacen, p, marca),
  ]);
  // Actividad = movimientos que la persona originó (eventos, canjes, ajustes); no los vencimientos.
  const conActividad = new Set(
    xs.filter((a) => a.tipo !== "vencimiento").map((a) => a.uid),
  );
  const porEvento = EVENTOS.map((evento) => {
    const delEvento = xs.filter(
      (a) => a.tipo === "otorgamiento" && a.evento === evento,
    );
    return {
      evento,
      movimientos: delEvento.length,
      puntos: suma(delEvento),
      clientes: new Set(delEvento.map((a) => a.uid)).size,
    };
  });
  const ajustes = deTipo(xs, "ajuste");
  return {
    periodo: { desde: p.desde, hasta: p.hasta },
    marca: marca ?? null,
    usuariosConActividad: conActividad.size,
    nuevosRegistros: rs.length,
    puntosGenerados: otorgados(xs),
    puntosUtilizados: utilizados(xs),
    puntosVencidos: vencidos(xs),
    ajustes: {
      positivos: suma(ajustes.filter((a) => a.puntos > 0)),
      negativos: -suma(ajustes.filter((a) => a.puntos < 0)),
    },
    canjes: validos(cs).length,
    canjesAnulados: cs.length - validos(cs).length,
    actividadesRegistradas: deTipo(xs, "otorgamiento").length,
    porEvento,
  };
}

// ── A11 Tendencias ────────────────────────────────────────────────────
export const METRICAS = [
  "otorgados",
  "utilizados",
  "canjes",
  "registros",
] as const;
export type Metrica = (typeof METRICAS)[number];

/** Un hecho medible; un registro cuenta en cada marca vinculada. */
interface Hecho {
  fecha: string;
  marcas: Marca[];
  valor: number;
}

async function hechos(
  deps: DepsReportes,
  metrica: Metrica,
  p: Periodo,
): Promise<Hecho[]> {
  if (metrica === "canjes") {
    return validos(await canjesEmitidos(deps.almacen, p)).map((c) => ({
      fecha: c.emitidoEn,
      marcas: [c.marca],
      valor: 1,
    }));
  }
  if (metrica === "registros") {
    return (await registros(deps.almacen, p)).map((r) => ({
      fecha: r.creadoEn,
      marcas: r.marcas,
      valor: 1,
    }));
  }
  const tipo = metrica === "otorgados" ? "otorgamiento" : "canje";
  const signo = metrica === "otorgados" ? 1 : -1;
  return deTipo(await asientos(deps.almacen, p), tipo).map((a) => ({
    fecha: a.fecha,
    marcas: [a.marca],
    valor: signo * a.puntos,
  }));
}

const deMarca = (h: Hecho, marca: Marca) => h.marcas.includes(marca);

function serie(hs: Hecho[], p: Periodo, g: Granularidad) {
  const valores = new Map(cubetas(p, g).map((k) => [k, 0]));
  for (const h of hs) {
    const k = claveCubeta(h.fecha, g, p);
    valores.set(k, (valores.get(k) ?? 0) + h.valor);
  }
  return [...valores].map(([desde, valor]) => ({ desde, valor }));
}

export async function reporteTendencias(
  deps: DepsReportes,
  metrica: Metrica,
  p: Periodo,
  marca?: Marca,
) {
  const previo = anterior(p);
  const g = granularidad(p.dias);
  const [actual, antes] = await Promise.all([
    hechos(deps, metrica, p),
    hechos(deps, metrica, previo),
  ]);
  const filtrar = (hs: Hecho[]) =>
    marca ? hs.filter((h) => deMarca(h, marca)) : hs;
  const total = (hs: Hecho[]) => hs.reduce((t, h) => t + h.valor, 0);
  const a = filtrar(actual);
  const b = filtrar(antes);
  return {
    metrica,
    marca: marca ?? null,
    granularidad: g,
    actual: {
      desde: p.desde,
      hasta: p.hasta,
      total: total(a),
      serie: serie(a, p, g),
    },
    anterior: {
      desde: previo.desde,
      hasta: previo.hasta,
      total: total(b),
      serie: serie(b, previo, g),
    },
    variacion: variacion(total(a), total(b)),
    // La comparación entre marcas usa siempre las tres (A11).
    porMarca: MARCAS.map((m) => ({
      marca: m,
      total: total(actual.filter((h) => deMarca(h, m))),
    })),
  };
}

// ── A08 Canjes ────────────────────────────────────────────────────────
export interface FiltroCanjes {
  marca?: Marca;
  estado?: EstadoCanje;
  correo?: string;
  limite: number;
  cursor?: string;
}

function estadoDe(c: CanjeIndexado, ahora: Date): EstadoCanje {
  return estadoEfectivo(c as unknown as Canje, ahora);
}

/** Canjes del periodo con los filtros efectivos, del más reciente al más antiguo. */
export async function canjesFiltrados(
  deps: DepsReportes,
  p: Periodo,
  f: Omit<FiltroCanjes, "limite" | "cursor">,
  ahora: Date,
) {
  let uid: string | null | undefined;
  if (f.correo) {
    const idx = await deps.almacen.leer<{ uid: string }>(
      R.correo(huellaCorreo(normalizarCorreo(f.correo))),
    );
    uid = idx?.uid ?? null;
  }
  const cs = (await canjesEmitidos(deps.almacen, p, f.marca))
    .map((c) => ({ ...c, estadoEfectivo: estadoDe(c, ahora) }))
    .filter((c) => uid === undefined || c.uid === uid)
    .filter((c) => !f.estado || c.estadoEfectivo === f.estado);
  return cs.sort(
    (x, y) =>
      y.emitidoEn.localeCompare(x.emitidoEn) ||
      x.codigo.localeCompare(y.codigo),
  );
}

export async function reporteCanjes(
  deps: DepsReportes,
  p: Periodo,
  f: FiltroCanjes,
  ahora: Date,
) {
  const cs = await canjesFiltrados(deps, p, f, ahora);
  const ok = cs.filter((c) => c.estado !== "anulado");
  const porBeneficio = new Map<string, { nombre: string; canjes: number }>();
  for (const c of ok) {
    const b = porBeneficio.get(c.beneficioId) ?? {
      nombre: c.beneficioNombre,
      canjes: 0,
    };
    b.canjes++;
    porBeneficio.set(c.beneficioId, b);
  }
  const top = [...porBeneficio]
    .map(([beneficioId, b]) => ({ beneficioId, ...b }))
    .sort((a, b) => b.canjes - a.canjes || a.nombre.localeCompare(b.nombre));

  const desde = f.cursor ? cs.findIndex((c) => c.codigo === f.cursor) + 1 : 0;
  const pagina = cs.slice(desde, desde + f.limite);
  const gente = await personas(
    deps.almacen,
    deps.cuentas,
    pagina.map((c) => c.uid),
  );
  return {
    periodo: { desde: p.desde, hasta: p.hasta },
    total: cs.length,
    validos: ok.length,
    anulados: cs.length - ok.length,
    puntosUtilizados: ok.reduce((t, c) => t + c.puntos, 0),
    clientesConCanjes: new Set(ok.map((c) => c.uid)).size,
    beneficiosMasCanjeados: top.slice(0, 5),
    porMarca: MARCAS.map((m) => {
      const deM = ok.filter((c) => c.marca === m);
      return {
        marca: m,
        canjes: deM.length,
        puntos: deM.reduce((t, c) => t + c.puntos, 0),
      };
    }),
    items: pagina.map((c) => ({
      codigo: c.codigo,
      cliente: gente.get(c.uid)!,
      beneficioNombre: c.beneficioNombre,
      marca: c.marca,
      puntos: c.puntos,
      estado: c.estadoEfectivo,
      emitidoEn: c.emitidoEn,
    })),
    siguiente:
      desde + f.limite < cs.length ? (pagina.at(-1)?.codigo ?? null) : null,
  };
}

// ── A13 Dashboard ─────────────────────────────────────────────────────
/** Clientes vigentes (sin las bajas) que cumplen los filtros, por agregación. */
async function contarClientes(almacen: Almacen, extra: Filtro[] = []) {
  const base: Filtro[] = [["rol", "==", "cliente"], ...extra];
  const [todos, eliminados] = await Promise.all([
    almacen.contar({ coleccion: "usuarios", donde: base }),
    almacen.contar({
      coleccion: "usuarios",
      donde: [...base, ["eliminado", "==", true]],
    }),
  ]);
  return todos - eliminados;
}

/**
 * Dashboard (A13): totales de clientes vigentes, KPI de los últimos 30 días
 * comparados con los 30 anteriores y series de los últimos 6 meses.
 */
export async function resumen(deps: DepsReportes, ahora: Date) {
  const p30 = ultimosDias(30, ahora);
  const previo = anterior(p30);
  const seisMeses = ultimosMeses(6, ahora);
  const [
    total,
    vinculados,
    porMarcaClientes,
    x30,
    xPrevio,
    c30,
    cPrevio,
    r30,
    rPrevio,
    x6,
    c6,
    r6,
    pendientes,
  ] = await Promise.all([
    contarClientes(deps.almacen),
    contarClientes(deps.almacen, [["vinculo", "==", "vinculado"]]),
    Promise.all(
      MARCAS.map((m) =>
        contarClientes(deps.almacen, [["marcas", "array-contains", m]]),
      ),
    ),
    asientos(deps.almacen, p30),
    asientos(deps.almacen, previo),
    canjesEmitidos(deps.almacen, p30),
    canjesEmitidos(deps.almacen, previo),
    registros(deps.almacen, p30),
    registros(deps.almacen, previo),
    asientos(deps.almacen, seisMeses),
    canjesEmitidos(deps.almacen, seisMeses),
    registros(deps.almacen, seisMeses),
    deps.almacen.consultar<CanjeIndexado>({
      coleccion: "codigos",
      donde: [["estado", "==", "emitido"]],
    }),
  ]);
  const meses = cubetas(seisMeses, "mes");
  const porMes = <T>(
    xs: T[],
    fecha: (x: T) => string,
    valor: (x: T) => number,
  ) => {
    const m = new Map(meses.map((k) => [k, 0]));
    for (const x of xs) {
      const k = claveCubeta(fecha(x), "mes", seisMeses);
      m.set(k, (m.get(k) ?? 0) + valor(x));
    }
    return m;
  };
  const otorgadosMes = porMes(
    deTipo(x6, "otorgamiento"),
    (a) => a.fecha,
    (a) => a.puntos,
  );
  const utilizadosMes = porMes(
    deTipo(x6, "canje"),
    (a) => a.fecha,
    (a) => -a.puntos,
  );
  const canjesMesMarca = MARCAS.map((marca) =>
    porMes(
      validos(c6).filter((c) => c.marca === marca),
      (c) => c.emitidoEn,
      () => 1,
    ),
  );
  const ultimosRegistros = [...r6]
    .filter((r) => !r.eliminado)
    .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn))
    .slice(0, 5);
  const ultimosCanjes = [...c6]
    .sort((a, b) => b.emitidoEn.localeCompare(a.emitidoEn))
    .slice(0, 5);
  const gente = await personas(deps.almacen, deps.cuentas, [
    ...ultimosRegistros.map((r) => r.uid),
    ...ultimosCanjes.map((c) => c.uid),
  ]);

  return {
    periodo: { desde: p30.desde, hasta: p30.hasta },
    clientes: {
      total,
      vinculados,
      sinVincular: total - vinculados,
      nuevos: {
        valor: r30.length,
        variacion: variacion(r30.length, rPrevio.length),
      },
      porMarca: MARCAS.map((m, i) => ({
        marca: m,
        clientes: porMarcaClientes[i]!,
      })),
    },
    puntosOtorgados: {
      valor: otorgados(x30),
      variacion: variacion(otorgados(x30), otorgados(xPrevio)),
    },
    puntosUtilizados: {
      valor: utilizados(x30),
      variacion: variacion(utilizados(x30), utilizados(xPrevio)),
      vencidos: vencidos(x30),
    },
    canjes: {
      valor: validos(c30).length,
      variacion: variacion(validos(c30).length, validos(cPrevio).length),
      pendientesDeEntrega: pendientes.filter(
        (d) => d.datos.venceEn >= ahora.toISOString(),
      ).length,
    },
    actividadMensual: meses.map((desde) => ({
      desde,
      otorgados: otorgadosMes.get(desde) ?? 0,
      utilizados: utilizadosMes.get(desde) ?? 0,
    })),
    canjesMensualesPorMarca: meses.map((desde) => ({
      desde,
      ...Object.fromEntries(
        MARCAS.map((m, i) => [m, canjesMesMarca[i]!.get(desde) ?? 0]),
      ),
    })),
    ultimosRegistros: ultimosRegistros.map((r) => ({
      uid: r.uid,
      nombre: gente.get(r.uid)?.nombre ?? null,
      marcas: r.marcas,
      vinculo: r.vinculo,
      creadoEn: r.creadoEn,
    })),
    ultimosCanjes: ultimosCanjes.map((c) => ({
      codigo: c.codigo,
      beneficioNombre: c.beneficioNombre,
      cliente: gente.get(c.uid)?.nombre ?? null,
      marca: c.marca,
      puntos: c.puntos,
      estado: estadoDe(c, ahora),
    })),
  };
}

// ── A07 Movimientos ───────────────────────────────────────────────────
export interface FiltroMovimientos {
  marca?: Marca;
  tipo?: AsientoConId["tipo"];
  evento?: Evento;
  limite: number;
  cursor?: string;
}

const MAX_MS = 9_999_999_999_999;

/**
 * Libro global del más reciente al más antiguo (ids con la fecha invertida):
 * igualdades + orden por id, sin índices compuestos. El periodo se aplica
 * empezando en el id de `fin` y cortando al pasar `inicio`.
 */
export async function listarLibro(
  deps: DepsReportes,
  p: Periodo,
  f: FiltroMovimientos,
) {
  const donde: Filtro[] = [];
  if (f.marca) donde.push(["marca", "==", f.marca]);
  if (f.tipo) donde.push(["tipo", "==", f.tipo]);
  if (f.evento) donde.push(["evento", "==", f.evento]);
  const inicioId = String(MAX_MS - p.fin.getTime()).padStart(13, "0");
  const docs = await deps.almacen.consultar<AsientoConId>({
    coleccion: R.libro,
    donde,
    ordenId: "asc",
    despuesDeId: f.cursor ?? inicioId,
    limite: f.limite + 1,
  });
  const enPeriodo = docs.filter((d) => d.datos.fecha >= p.inicio.toISOString());
  const pagina = enPeriodo.slice(0, f.limite);
  const gente = await personas(
    deps.almacen,
    deps.cuentas,
    pagina.map((d) => d.datos.uid),
  );
  return {
    items: pagina.map((d) => ({
      id: d.id,
      fecha: d.datos.fecha,
      cliente: gente.get(d.datos.uid)!,
      marca: d.datos.marca,
      tipo: d.datos.tipo,
      evento: d.datos.evento,
      puntos: d.datos.puntos,
      motivo: d.datos.motivo,
    })),
    siguiente: enPeriodo.length > f.limite ? pagina.at(-1)!.id : null,
  };
}
