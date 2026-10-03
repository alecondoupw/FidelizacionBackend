import type { Almacen, Documento } from "../almacen/almacen.js";
import type { Marca } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { auditar } from "../puntos/auditoria.js";
import { calcularVencimiento, idMovimiento } from "../puntos/fechas.js";
import {
  aplicarPlan,
  claveIdempotencia,
  fijarSaldo,
  firmaDe,
  generadorIds,
  leerIdempotencia,
  leerLotes,
  escribirMovimiento,
  movimiento,
  type RegistroIdempotencia,
} from "../puntos/libro.js";
import { planificar } from "../puntos/planificador.js";
import { R } from "../puntos/rutas.js";
import type { Lote, SaldoMarca } from "../puntos/tipos.js";
import {
  disponibilidadBeneficio,
  disponibilidadVariante,
  estadoEfectivo,
  generarCodigo,
} from "./disponibilidad.js";
import {
  indiceDe,
  type Beneficio,
  type Canje,
  type EstadoCanje,
} from "./tipos.js";

/** Vista del canje para su propietario y para administración. */
export interface CanjeVista {
  codigo: string;
  beneficioId: string;
  beneficioNombre: string;
  marca: Marca;
  varianteNombre: string;
  puntos: number;
  estado: EstadoCanje;
  emitidoEn: string;
  venceEn: string;
  entregadoEn: string | null;
  anuladoEn: string | null;
  motivoAnulacion: string | null;
}

export const vistaCanje = (c: Canje, ahora: Date): CanjeVista => ({
  codigo: c.codigo,
  beneficioId: c.beneficioId,
  beneficioNombre: c.beneficioNombre,
  marca: c.marca,
  varianteNombre: c.varianteNombre,
  puntos: c.puntos,
  estado: estadoEfectivo(c, ahora),
  emitidoEn: c.emitidoEn,
  venceEn: c.venceEn,
  entregadoEn: c.entregadoEn,
  anuladoEn: c.anuladoEn,
  motivoAnulacion: c.motivoAnulacion,
});

/**
 * Canje atómico (F3-BE-02, SRC-03 pp. 6–8): en una transacción valida
 * beneficio, disponibilidad, stock de la variante y saldo; consume lotes por
 * vencimiento más próximo (DEC-06), descuenta stock y emite el cupón. Un
 * reintento con la misma solicitud devuelve el mismo canje.
 */
export async function canjear(
  almacen: Almacen,
  s: {
    uid: string;
    marcasCliente: Marca[];
    beneficioId: string;
    varianteId: string;
    idSolicitud: string;
  },
  ahora: Date,
): Promise<{ canje: CanjeVista; disponible: number; repetido: boolean }> {
  const clave = claveIdempotencia(`canje:${s.uid}`, s.idSolicitud);
  const firma = firmaDe([s.beneficioId, s.varianteId]);

  for (let intento = 0; intento < 3; intento++) {
    const codigo = generarCodigo();
    const nuevoId = generadorIds(almacen, ahora);
    const resultado = await almacen.transaccion(async (tx) => {
      const previo = await leerIdempotencia(tx, clave, "canje", firma);
      if (previo) {
        return {
          ...(previo as { canje: CanjeVista; disponible: number }),
          repetido: true,
        };
      }
      const b = await tx.leer<Beneficio>(R.beneficio(s.beneficioId));
      if (!b || !b.activo || !s.marcasCliente.includes(b.marca)) {
        throw new AppError(404, "NOT_FOUND", "El beneficio no existe.");
      }
      if (disponibilidadBeneficio(b, ahora) === "proximamente") {
        throw new AppError(
          422,
          "NOT_AVAILABLE_YET",
          "Este beneficio todavía no está disponible para canje.",
        );
      }
      const variante = b.variantes.find((v) => v.id === s.varianteId);
      if (!variante)
        throw new AppError(
          422,
          "VALIDATION_ERROR",
          "La variante elegida no existe.",
        );
      if (disponibilidadVariante(variante) === "agotado") {
        throw new AppError(409, "OUT_OF_STOCK", "Esta opción está agotada.");
      }
      if (await tx.leer(R.codigo(codigo))) return null; // colisión improbable: reintentar
      const lotes = await leerLotes(tx, s.uid, b.marca);

      const plan = planificar(lotes, ahora, b.puntos);
      if (plan.faltante > 0) {
        throw new AppError(
          409,
          "INSUFFICIENT_BALANCE",
          `Necesitas ${b.puntos} puntos de esta marca y tienes ${plan.disponibleFinal + b.puntos - plan.faltante}.`,
        );
      }
      aplicarPlan(tx, s.uid, b.marca, lotes, plan, ahora, nuevoId);
      const movimientoId = nuevoId();
      escribirMovimiento(
        tx,
        s.uid,
        b.marca,
        movimientoId,
        movimiento("canje", -b.puntos, ahora, s.uid, {
          motivo: `Canje: ${b.nombre}`,
          origen: "canje",
          lotes: plan.consumos,
        }),
      );
      fijarSaldo(tx, s.uid, b.marca, plan.disponibleFinal, ahora);
      tx.fijar(R.beneficio(s.beneficioId), {
        ...b,
        variantes: b.variantes.map((v) =>
          v.id === variante.id && v.stock !== null
            ? { ...v, stock: v.stock - 1 }
            : v,
        ),
      });

      const canjeId = idMovimiento(ahora, 0, almacen.nuevoId());
      const canje: Canje = {
        codigo,
        beneficioId: s.beneficioId,
        beneficioNombre: b.nombre,
        marca: b.marca,
        categoria: b.categoria,
        varianteId: variante.id,
        varianteNombre: variante.nombre,
        puntos: b.puntos,
        estado: "emitido",
        emitidoEn: ahora.toISOString(),
        venceEn: calcularVencimiento(ahora, {
          activa: true,
          cantidad: b.vigenciaCuponDias,
          unidad: "dias",
        })!,
        entregadoEn: null,
        anuladoEn: null,
        motivoAnulacion: null,
        movimientoId,
        lotes: plan.consumos,
      };
      tx.crear(R.canje(s.uid, canjeId), canje);
      tx.crear(R.codigo(codigo), indiceDe(canje, s.uid, canjeId));
      const respuesta = {
        canje: vistaCanje(canje, ahora),
        disponible: plan.disponibleFinal,
      };
      tx.crear(R.evento(clave), {
        tipo: "canje",
        firma,
        registradoEn: ahora.toISOString(),
        respuesta,
      } satisfies RegistroIdempotencia);
      return { ...respuesta, repetido: false };
    });
    if (resultado) return resultado;
  }
  throw new AppError(
    500,
    "INTERNAL_ERROR",
    "No se pudo generar un código de canje único.",
  );
}

/** Mis canjes, del más reciente al más antiguo (UI-15). */
export async function listarCanjes(
  almacen: Almacen,
  uid: string,
  opciones: { marca?: Marca; limite: number; cursor?: string },
  ahora: Date,
): Promise<{ items: CanjeVista[]; siguiente: string | null }> {
  const items: CanjeVista[] = [];
  let cursor = opciones.cursor;
  for (
    let vuelta = 0;
    vuelta < 10 && items.length < opciones.limite;
    vuelta++
  ) {
    const docs = await almacen.consultar<Canje>({
      coleccion: R.canjes(uid),
      ordenId: "asc",
      despuesDeId: cursor,
      limite: opciones.limite,
    });
    for (const d of docs) {
      cursor = d.id;
      if (opciones.marca && d.datos.marca !== opciones.marca) continue;
      items.push(vistaCanje(d.datos, ahora));
      if (items.length === opciones.limite) break;
    }
    if (docs.length < opciones.limite) return { items, siguiente: null };
  }
  return {
    items,
    siguiente: items.length === opciones.limite ? (cursor ?? null) : null,
  };
}

async function ubicar(almacen: Almacen, codigo: string) {
  const idx = await almacen.leer<{ uid: string; canjeId: string }>(
    R.codigo(codigo),
  );
  if (!idx)
    throw new AppError(404, "NOT_FOUND", "No existe un canje con ese código.");
  return idx;
}

/** Detalle por código; el propietario sólo ve lo suyo (otro dueño → 404, sin filtrar). */
export async function obtenerCanje(
  almacen: Almacen,
  codigo: string,
  ahora: Date,
  propietario?: string,
): Promise<{ canje: Canje; vista: CanjeVista; uid: string }> {
  const { uid, canjeId } = await ubicar(almacen, codigo);
  if (propietario && propietario !== uid) {
    throw new AppError(404, "NOT_FOUND", "No existe un canje con ese código.");
  }
  const canje = await almacen.leer<Canje>(R.canje(uid, canjeId));
  if (!canje)
    throw new AppError(404, "NOT_FOUND", "No existe un canje con ese código.");
  return { canje, vista: vistaCanje(canje, ahora), uid };
}

/** Entrega en mostrador (DEC-07): sólo un cupón emitido y vigente. */
export async function entregarCanje(
  almacen: Almacen,
  codigo: string,
  actor: string,
  ahora: Date,
): Promise<CanjeVista> {
  const { uid, canjeId } = await ubicar(almacen, codigo);
  return almacen.transaccion(async (tx) => {
    const canje = await tx.leer<Canje>(R.canje(uid, canjeId));
    if (!canje)
      throw new AppError(
        404,
        "NOT_FOUND",
        "No existe un canje con ese código.",
      );
    const estado = estadoEfectivo(canje, ahora);
    if (estado !== "emitido") {
      throw new AppError(
        409,
        "INVALID_STATE",
        `No se puede entregar un canje ${estado}.`,
      );
    }
    const nuevo: Canje = {
      ...canje,
      estado: "entregado",
      entregadoEn: ahora.toISOString(),
    };
    tx.fijar(R.canje(uid, canjeId), nuevo);
    tx.fijar(R.codigo(codigo), indiceDe(nuevo, uid, canjeId));
    auditar(tx, almacen.nuevoId(), {
      accion: "canje.entregado",
      actor,
      objetivo: codigo,
      en: ahora.toISOString(),
      datos: { marca: canje.marca, beneficioId: canje.beneficioId },
    });
    return vistaCanje(nuevo, ahora);
  });
}

/**
 * Anulación por un administrador con motivo (DEC-07): devuelve los puntos a
 * sus lotes originales y una unidad de stock. Si un lote ya venció, esa
 * parte vuelve y vence en el acto con su movimiento: nunca reviven puntos
 * caducados. Un canje entregado no se anula.
 */
export async function anularCanje(
  almacen: Almacen,
  codigo: string,
  motivo: string,
  actor: string,
  ahora: Date,
): Promise<{ canje: CanjeVista; disponible: number }> {
  const { uid, canjeId } = await ubicar(almacen, codigo);
  const nuevoId = generadorIds(almacen, ahora);
  return almacen.transaccion(async (tx) => {
    const canje = await tx.leer<Canje>(R.canje(uid, canjeId));
    if (!canje)
      throw new AppError(
        404,
        "NOT_FOUND",
        "No existe un canje con ese código.",
      );
    const estado = estadoEfectivo(canje, ahora);
    if (estado === "entregado" || estado === "anulado") {
      throw new AppError(
        409,
        "INVALID_STATE",
        `No se puede anular un canje ${estado}.`,
      );
    }
    const beneficio = await tx.leer<Beneficio>(R.beneficio(canje.beneficioId));
    const activos = await leerLotes(tx, uid, canje.marca);
    const porId = new Map<string, Documento<Lote>>(
      activos.map((l) => [l.id, l]),
    );
    for (const { loteId } of canje.lotes) {
      if (!porId.has(loteId)) {
        const lote = await tx.leer<Lote>(R.lote(uid, canje.marca, loteId));
        if (lote) porId.set(loteId, { id: loteId, datos: lote });
      }
    }

    // Devolver a los lotes originales y después vencer lo que ya caducó.
    const devueltos = new Set<string>();
    for (const { loteId, puntos } of canje.lotes) {
      const l = porId.get(loteId);
      if (!l) continue;
      porId.set(loteId, {
        id: loteId,
        datos: { ...l.datos, restante: l.datos.restante + puntos },
      });
      devueltos.add(loteId);
    }
    const lotes = [...porId.values()];
    escribirMovimiento(
      tx,
      uid,
      canje.marca,
      nuevoId(),
      movimiento("canje", canje.puntos, ahora, actor, {
        motivo: `Anulación del canje ${codigo}: ${motivo}`,
        origen: "anulacion",
        lotes: canje.lotes,
      }),
    );
    const plan = planificar(lotes, ahora);
    aplicarPlan(tx, uid, canje.marca, lotes, plan, ahora, nuevoId);
    for (const loteId of devueltos) {
      if (plan.restantes.has(loteId)) continue; // ya escrito por el plan (vencido)
      const l = porId.get(loteId)!;
      tx.fijar(R.lote(uid, canje.marca, loteId), l.datos);
      if (l.datos.venceEn) {
        tx.fijar(R.vencimiento(uid, canje.marca, loteId), {
          uid,
          marca: canje.marca,
          loteId,
          venceEn: l.datos.venceEn,
        });
      }
    }
    fijarSaldo(tx, uid, canje.marca, plan.disponibleFinal, ahora);
    if (beneficio) {
      tx.fijar(R.beneficio(canje.beneficioId), {
        ...beneficio,
        variantes: beneficio.variantes.map((v) =>
          v.id === canje.varianteId && v.stock !== null
            ? { ...v, stock: v.stock + 1 }
            : v,
        ),
      });
    }
    const nuevo: Canje = {
      ...canje,
      estado: "anulado",
      anuladoEn: ahora.toISOString(),
      motivoAnulacion: motivo,
    };
    tx.fijar(R.canje(uid, canjeId), nuevo);
    tx.fijar(R.codigo(codigo), indiceDe(nuevo, uid, canjeId));
    auditar(tx, almacen.nuevoId(), {
      accion: "canje.anulado",
      actor,
      objetivo: codigo,
      en: ahora.toISOString(),
      datos: {
        marca: canje.marca,
        puntos: canje.puntos,
        motivo,
        estadoPrevio: estado,
      },
    });
    return {
      canje: vistaCanje(nuevo, ahora),
      disponible: plan.disponibleFinal,
    };
  });
}

/** Saldo actual de una marca leyendo sólo el documento materializado. */
export async function saldoMarca(
  almacen: Almacen,
  uid: string,
  marca: Marca,
): Promise<number> {
  return (await almacen.leer<SaldoMarca>(R.saldo(uid, marca)))?.disponible ?? 0;
}
