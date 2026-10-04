import { createHash } from "node:crypto";
import type { Almacen, Documento, Transaccion } from "../almacen/almacen.js";
import type { Marca, Perfil } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { huellaCorreo, normalizarCorreo } from "../usuarios/correo.js";
import { auditar } from "./auditoria.js";
import { idMovimiento, vencimientoElegido, ZONA } from "./fechas.js";
import { planificar, type Plan } from "./planificador.js";
import { R } from "./rutas.js";
import type {
  Evento,
  Lote,
  Movimiento,
  Regla,
  SaldoMarca,
  TipoMovimiento,
} from "./tipos.js";

/**
 * Libro de puntos (F2-BE-02/03): movimientos definitivos (DEC-14), lotes por
 * otorgamiento consumidos por vencimiento más próximo (DEC-06) y saldo
 * materializado igual a la suma de remanentes vigentes. Todo cambio ocurre en
 * una transacción; el mismo origen + id externo nunca otorga dos veces (DEC-05).
 */

export type ResultadoEvento =
  | {
      resultado: "otorgado";
      puntos: number;
      movimientoId: string;
      venceEn: string | null;
    }
  | {
      resultado: "sin_puntos";
      puntos: 0;
      motivo: "sin_regla" | "regla_inactiva";
    };

export interface RegistroIdempotencia extends Record<string, unknown> {
  tipo: "evento" | "ajuste" | "asignacion" | "canje";
  /** Huella de lo solicitado: un reintento con datos distintos es un conflicto. */
  firma: string;
  registradoEn: string;
  respuesta: Record<string, unknown>;
}

export const claveIdempotencia = (origen: string, idExterno: string) =>
  createHash("sha256").update(`${origen}|${idExterno}`, "utf8").digest("hex");

export const firmaDe = (partes: unknown[]) =>
  createHash("sha256").update(JSON.stringify(partes), "utf8").digest("hex");

const FECHA_LOCAL = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeZone: ZONA,
});

export async function leerIdempotencia(
  tx: Transaccion,
  clave: string,
  tipo: RegistroIdempotencia["tipo"],
  firma: string,
) {
  const previo = await tx.leer<RegistroIdempotencia>(R.evento(clave));
  if (!previo) return null;
  if (previo.tipo !== tipo || previo.firma !== firma) {
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Ese identificador ya se usó con otros datos.",
    );
  }
  return previo.respuesta;
}

/** Cliente activo, vinculado a la marca, resuelto por correo normalizado (ADR-04). */
async function resolverCliente(
  tx: Transaccion,
  correo: string,
  marca: Marca,
  { exigirActivo }: { exigirActivo: boolean },
): Promise<string> {
  const indice = await tx.leer<{ uid: string }>(
    R.correo(huellaCorreo(normalizarCorreo(correo))),
  );
  const perfil = indice
    ? await tx.leer<Omit<Perfil, "uid">>(R.usuario(indice.uid))
    : null;
  if (!indice || !perfil || perfil.rol !== "cliente") {
    throw new AppError(
      422,
      "CLIENT_NOT_FOUND",
      "No existe un cliente registrado con ese correo.",
    );
  }
  if (exigirActivo && !perfil.activo) {
    throw new AppError(
      422,
      "CLIENT_INACTIVE",
      "La cuenta del cliente está desactivada.",
    );
  }
  if (!perfil.marcas.includes(marca)) {
    throw new AppError(
      422,
      "BRAND_NOT_LINKED",
      "El cliente no está vinculado a esa marca.",
    );
  }
  return indice.uid;
}

export async function leerLotes(
  tx: Transaccion | Almacen,
  uid: string,
  marca: Marca,
) {
  return tx.consultar<Lote>({
    coleccion: R.lotes(uid, marca),
    donde: [["restante", ">", 0]],
  });
}

/** Contador de movimientos dentro de una transacción para ids únicos y ordenados. */
export function generadorIds(almacen: Almacen, ahora: Date) {
  let secuencia = 0;
  return () => idMovimiento(ahora, secuencia++, almacen.nuevoId());
}

export function movimiento(
  tipo: TipoMovimiento,
  puntos: number,
  ahora: Date,
  actor: string,
  extra: Partial<Movimiento> = {},
): Movimiento {
  return {
    tipo,
    puntos,
    fecha: ahora.toISOString(),
    venceEn: null,
    evento: null,
    origen: null,
    motivo: null,
    actor,
    lotes: [],
    ...extra,
  };
}

/** Copia global de un movimiento (F5): mismo id, sin el detalle de lotes. */
export interface Asiento extends Record<string, unknown> {
  uid: string;
  marca: Marca;
  tipo: TipoMovimiento;
  puntos: number;
  fecha: string;
  evento: Evento | null;
  origen: string | null;
  motivo: string | null;
  actor: string;
}

export const asientoDe = (
  uid: string,
  marca: Marca,
  m: Movimiento,
): Asiento => ({
  uid,
  marca,
  tipo: m.tipo,
  puntos: m.puntos,
  fecha: m.fecha,
  evento: m.evento,
  origen: m.origen,
  motivo: m.motivo,
  actor: m.actor,
});

/**
 * Único punto de escritura de movimientos: el del cliente y su asiento en el
 * libro global, en la misma transacción, para que los reportes (DEC-09)
 * cuadren siempre con el historial.
 */
export function escribirMovimiento(
  tx: Transaccion,
  uid: string,
  marca: Marca,
  id: string,
  m: Movimiento,
) {
  tx.crear(`${R.movimientos(uid, marca)}/${id}`, m);
  tx.crear(R.asiento(id), asientoDe(uid, marca, m));
}

/** Escribe vencimientos y restantes de un plan. Sólo escrituras: llamar tras leer todo. */
export function aplicarPlan(
  tx: Transaccion,
  uid: string,
  marca: Marca,
  lotes: Documento<Lote>[],
  plan: Plan,
  ahora: Date,
  nuevoId: () => string,
) {
  const porId = new Map(lotes.map((l) => [l.id, l]));
  for (const { loteId, puntos } of plan.vencidos) {
    const lote = porId.get(loteId)!;
    escribirMovimiento(
      tx,
      uid,
      marca,
      nuevoId(),
      movimiento("vencimiento", -puntos, ahora, "sistema", {
        motivo: `Vencimiento de puntos otorgados el ${FECHA_LOCAL.format(new Date(lote.datos.otorgadoEn))}`,
        lotes: [{ loteId, puntos }],
      }),
    );
  }
  for (const [loteId, restante] of plan.restantes) {
    const lote = porId.get(loteId)!;
    tx.fijar(`${R.lotes(uid, marca)}/${loteId}`, { ...lote.datos, restante });
    if (restante === 0 && lote.datos.venceEn)
      tx.borrar(R.vencimiento(uid, marca, loteId));
  }
}

/** Crea un lote y su movimiento positivo; devuelve id de movimiento y vencimiento. */
function otorgarLote(
  tx: Transaccion,
  almacen: Almacen,
  uid: string,
  marca: Marca,
  puntos: number,
  venceEn: string,
  ahora: Date,
  movimientoId: string,
  datosMovimiento: Partial<Movimiento> & {
    tipo: TipoMovimiento;
    actor: string;
  },
) {
  const loteId = almacen.nuevoId();
  const { tipo, actor, ...extra } = datosMovimiento;
  escribirMovimiento(
    tx,
    uid,
    marca,
    movimientoId,
    movimiento(tipo, puntos, ahora, actor, {
      ...extra,
      venceEn,
      lotes: [{ loteId, puntos }],
    }),
  );
  const lote: Lote = {
    otorgados: puntos,
    restante: puntos,
    otorgadoEn: ahora.toISOString(),
    venceEn,
    movimientoId,
  };
  tx.crear(`${R.lotes(uid, marca)}/${loteId}`, lote);
  tx.crear(R.vencimiento(uid, marca, loteId), {
    uid,
    marca,
    loteId,
    venceEn,
  });
  return { venceEn };
}

export const fijarSaldo = (
  tx: Transaccion,
  uid: string,
  marca: Marca,
  disponible: number,
  ahora: Date,
) =>
  tx.fijar(R.saldo(uid, marca), {
    disponible,
    actualizadoEn: ahora.toISOString(),
  } satisfies SaldoMarca);

/**
 * Registra un evento de un sistema integrado y aplica la regla activa (SRC-02
 * p. 5, punto 14). Cada evento trae su fecha de vencimiento (DEC-18). Sin regla
 * o con regla inactiva el evento queda registrado sin puntos.
 */
export async function registrarEvento(
  almacen: Almacen,
  e: {
    origen: string;
    idExterno: string;
    evento: Evento;
    marca: Marca;
    correoCliente: string;
    /** AAAA-MM-DD: vence al final de ese día en Bolivia. */
    vence: string;
    actor: string;
  },
  ahora: Date,
): Promise<ResultadoEvento & { repetido: boolean }> {
  const clave = claveIdempotencia(e.origen, e.idExterno);
  const firma = firmaDe([
    e.evento,
    e.marca,
    normalizarCorreo(e.correoCliente),
    e.vence,
  ]);
  const venceEn = vencimientoElegido(e.vence, ahora);
  const nuevoId = generadorIds(almacen, ahora);

  return almacen.transaccion(async (tx) => {
    const previo = await leerIdempotencia(tx, clave, "evento", firma);
    if (previo) return { ...(previo as ResultadoEvento), repetido: true };

    const uid = await resolverCliente(tx, e.correoCliente, e.marca, {
      exigirActivo: true,
    });
    const regla = await tx.leer<Regla>(R.regla(e.marca, e.evento));
    const lotes = await leerLotes(tx, uid, e.marca);

    let respuesta: ResultadoEvento;
    if (!regla || !regla.activa) {
      respuesta = {
        resultado: "sin_puntos",
        puntos: 0,
        motivo: regla ? "regla_inactiva" : "sin_regla",
      };
    } else {
      const plan = planificar(lotes, ahora);
      aplicarPlan(tx, uid, e.marca, lotes, plan, ahora, nuevoId);
      const movimientoId = nuevoId();
      otorgarLote(
        tx,
        almacen,
        uid,
        e.marca,
        regla.puntos,
        venceEn,
        ahora,
        movimientoId,
        {
          tipo: "otorgamiento",
          actor: e.actor,
          evento: e.evento,
          origen: e.origen,
        },
      );
      fijarSaldo(tx, uid, e.marca, plan.disponibleFinal + regla.puntos, ahora);
      respuesta = {
        resultado: "otorgado",
        puntos: regla.puntos,
        movimientoId,
        venceEn,
      };
    }
    tx.crear(R.evento(clave), {
      tipo: "evento",
      firma,
      registradoEn: ahora.toISOString(),
      respuesta,
    } satisfies RegistroIdempotencia);
    return { ...respuesta, repetido: false };
  });
}

/**
 * Asignación manual de puntos (DEC-18, SRC-06 p. 3): sólo suma, con motivo y
 * fecha de vencimiento propia; definitiva, idempotente y auditada. Sustituye a
 * los eventos y ajustes del panel (DEC-05/14), cuyo historial se conserva.
 */
export async function asignarPuntos(
  almacen: Almacen,
  a: {
    idSolicitud: string;
    marca: Marca;
    correoCliente: string;
    puntos: number;
    motivo: string;
    /** AAAA-MM-DD: vence al final de ese día en Bolivia. */
    vence: string;
    actor: string;
  },
  ahora: Date,
): Promise<{
  movimientoId: string;
  puntos: number;
  venceEn: string;
  disponible: number;
  repetido: boolean;
}> {
  if (!Number.isInteger(a.puntos) || a.puntos <= 0) {
    throw new AppError(
      422,
      "VALIDATION_ERROR",
      "Sólo se pueden sumar puntos: indica un entero mayor que cero.",
    );
  }
  const origen = "panel-asignacion";
  const clave = claveIdempotencia(origen, a.idSolicitud);
  const firma = firmaDe([
    a.marca,
    normalizarCorreo(a.correoCliente),
    a.puntos,
    a.motivo,
    a.vence,
  ]);
  const venceEn = vencimientoElegido(a.vence, ahora);
  const nuevoId = generadorIds(almacen, ahora);

  return almacen.transaccion(async (tx) => {
    const previo = await leerIdempotencia(tx, clave, "asignacion", firma);
    if (previo) {
      return {
        ...(previo as {
          movimientoId: string;
          puntos: number;
          venceEn: string;
          disponible: number;
        }),
        repetido: true,
      };
    }
    const uid = await resolverCliente(tx, a.correoCliente, a.marca, {
      exigirActivo: true,
    });
    const lotes = await leerLotes(tx, uid, a.marca);
    const plan = planificar(lotes, ahora);
    aplicarPlan(tx, uid, a.marca, lotes, plan, ahora, nuevoId);

    const movimientoId = nuevoId();
    // Otorgamiento sin evento: cuenta en «puntos otorgados» de los reportes.
    otorgarLote(
      tx,
      almacen,
      uid,
      a.marca,
      a.puntos,
      venceEn,
      ahora,
      movimientoId,
      {
        tipo: "otorgamiento",
        actor: a.actor,
        origen,
        motivo: a.motivo,
      },
    );
    const disponible = plan.disponibleFinal + a.puntos;
    fijarSaldo(tx, uid, a.marca, disponible, ahora);
    const respuesta = { movimientoId, puntos: a.puntos, venceEn, disponible };
    tx.crear(R.evento(clave), {
      tipo: "asignacion",
      firma,
      registradoEn: ahora.toISOString(),
      respuesta,
    } satisfies RegistroIdempotencia);
    auditar(tx, almacen.nuevoId(), {
      accion: "puntos.asignados",
      actor: a.actor,
      objetivo: uid,
      en: ahora.toISOString(),
      datos: {
        marca: a.marca,
        puntos: a.puntos,
        motivo: a.motivo,
        venceEn,
        movimientoId,
      },
    });
    return { ...respuesta, repetido: false };
  });
}

/**
 * Vence los lotes caducados de un cliente y marca y devuelve los vigentes.
 * Se llama al leer el saldo para que nunca incluya puntos vencidos aunque el
 * proceso periódico aún no haya corrido (SRC-02 p. 5, punto 6).
 */
export async function vencerYLeer(
  almacen: Almacen,
  uid: string,
  marca: Marca,
  ahora: Date,
): Promise<{
  disponible: number;
  vigentes: Documento<Lote>[];
  vencidos: number;
}> {
  const nuevoId = generadorIds(almacen, ahora);
  return almacen.transaccion(async (tx) => {
    const lotes = await leerLotes(tx, uid, marca);
    const saldo = await tx.leer<SaldoMarca>(R.saldo(uid, marca));
    const plan = planificar(lotes, ahora);
    if (
      plan.vencidos.length > 0 ||
      (saldo?.disponible ?? 0) !== plan.disponibleFinal
    ) {
      aplicarPlan(tx, uid, marca, lotes, plan, ahora, nuevoId);
      fijarSaldo(tx, uid, marca, plan.disponibleFinal, ahora);
    }
    const vencidosIds = new Set(plan.vencidos.map((v) => v.loteId));
    return {
      disponible: plan.disponibleFinal,
      vigentes: lotes.filter((l) => !vencidosIds.has(l.id)),
      vencidos: plan.vencidos.length,
    };
  });
}

/** Proceso reejecutable: vence lo pendiente sin descontar dos veces. */
export async function procesarVencimientos(
  almacen: Almacen,
  ahora: Date,
  limite = 500,
): Promise<{ lotesVencidos: number; cuentas: number }> {
  const pendientes = await almacen.consultar<{ uid: string; marca: Marca }>({
    coleccion: R.vencimientos,
    donde: [["venceEn", "<", ahora.toISOString()]],
    limite,
  });
  const cuentas = new Map(
    pendientes.map((p) => [`${p.datos.uid}__${p.datos.marca}`, p.datos]),
  );
  let lotesVencidos = 0;
  for (const { uid, marca } of cuentas.values()) {
    lotesVencidos += (await vencerYLeer(almacen, uid, marca, ahora)).vencidos;
  }
  return { lotesVencidos, cuentas: cuentas.size };
}

export interface SaldoRespuesta {
  total: number;
  marcas: {
    marca: Marca;
    disponible: number;
    proximoVencimiento: { fecha: string; puntos: number } | null;
  }[];
}

/** Saldo por marca vinculada; el total es informativo (Referencias UI, regla 3). */
export async function consultarSaldo(
  almacen: Almacen,
  uid: string,
  marcas: Marca[],
  ahora: Date,
): Promise<SaldoRespuesta> {
  const porMarca = await Promise.all(
    marcas.map(async (marca) => {
      const { disponible, vigentes } = await vencerYLeer(
        almacen,
        uid,
        marca,
        ahora,
      );
      const conFecha = vigentes.filter(
        (l) => l.datos.venceEn && l.datos.restante > 0,
      );
      const primera = conFecha.map((l) => l.datos.venceEn!).sort()[0];
      return {
        marca,
        disponible,
        proximoVencimiento: primera
          ? {
              fecha: primera,
              puntos: conFecha
                .filter((l) => l.datos.venceEn === primera)
                .reduce((s, l) => s + l.datos.restante, 0),
            }
          : null,
      };
    }),
  );
  return {
    total: porMarca.reduce((s, m) => s + m.disponible, 0),
    marcas: porMarca,
  };
}

export interface MovimientoVista {
  id: string;
  marca: Marca;
  tipo: TipoMovimiento;
  puntos: number;
  fecha: string;
  venceEn: string | null;
  evento: Evento | null;
  motivo: string | null;
}

/**
 * Historial del propietario, del más reciente al más antiguo, con cursor.
 * Los ids invierten la fecha, así que el orden ascendente es de reciente a
 * antiguo. Une las marcas sin saltar ni repetir: sólo devuelve elementos que
 * no superan la frontera segura de las consultas que llegaron al límite.
 */
export async function listarMovimientos(
  almacen: Almacen,
  uid: string,
  marcas: Marca[],
  opciones: { tipo?: TipoMovimiento; limite: number; cursor?: string },
): Promise<{ items: MovimientoVista[]; siguiente: string | null }> {
  const items: MovimientoVista[] = [];
  let cursor = opciones.cursor;
  for (
    let vuelta = 0;
    vuelta < 10 && items.length < opciones.limite;
    vuelta++
  ) {
    const lotes = await Promise.all(
      marcas.map(async (marca) => ({
        marca,
        docs: await almacen.consultar<Movimiento>({
          coleccion: R.movimientos(uid, marca),
          ordenId: "asc",
          despuesDeId: cursor,
          limite: opciones.limite,
        }),
      })),
    );
    const llenos = lotes.filter((l) => l.docs.length === opciones.limite);
    const frontera = llenos.length
      ? llenos.map((l) => l.docs[l.docs.length - 1]!.id).sort()[0]!
      : null;
    const seguros = lotes
      .flatMap((l) => l.docs.map((d) => ({ marca: l.marca, d })))
      .filter(({ d }) => frontera === null || d.id <= frontera)
      .sort((a, b) => (a.d.id < b.d.id ? -1 : 1));
    if (seguros.length === 0) return { items, siguiente: null };
    for (const { marca, d } of seguros) {
      cursor = d.id;
      if (opciones.tipo && d.datos.tipo !== opciones.tipo) continue;
      items.push({
        id: d.id,
        marca,
        tipo: d.datos.tipo,
        puntos: d.datos.puntos,
        fecha: d.datos.fecha,
        venceEn: d.datos.venceEn,
        evento: d.datos.evento,
        motivo: d.datos.motivo,
      });
      if (items.length === opciones.limite) break;
    }
    if (frontera === null && items.length < opciones.limite)
      return { items, siguiente: null };
  }
  return {
    items,
    siguiente: items.length === opciones.limite ? (cursor ?? null) : null,
  };
}
