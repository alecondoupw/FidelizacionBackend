import { GeoPoint, Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  comparar,
  contar,
  deserializar,
  FORMATO_RESPALDO,
  RespaldoError,
  serializar,
  validarRespaldo,
  type DocumentoRespaldo,
  type Respaldo,
} from "./respaldo.js";

const respaldo = (
  colecciones: Record<string, DocumentoRespaldo[]>,
): Respaldo => ({
  formato: FORMATO_RESPALDO,
  version: 1,
  creadoEn: "2026-10-03T12:00:00.000Z",
  proyecto: null,
  colecciones,
});

describe("F7 · respaldo JSON (DEC-13)", () => {
  it("serializa y recupera valores, incluidas marcas de tiempo con nanosegundos", () => {
    const t = new Timestamp(1_790_000_000, 123_456_789);
    const datos = {
      texto: "Ñandú «á»",
      numero: 1.5,
      nulo: null,
      lista: [1, { a: true }],
      mapa: { b: { c: "d" } },
      cuando: t,
    };
    const json = JSON.parse(JSON.stringify(serializar(datos)));
    const vuelta = deserializar(json) as typeof datos;
    expect(vuelta.cuando).toBeInstanceOf(Timestamp);
    expect((vuelta.cuando as Timestamp).isEqual(t)).toBe(true);
    expect({ ...vuelta, cuando: null }).toEqual({ ...datos, cuando: null });
  });

  it("rechaza tipos sin uso en el modelo y el campo reservado", () => {
    expect(() => serializar({ lugar: new GeoPoint(1, 2) }, "x")).toThrow(
      /Tipo no soportado \(GeoPoint\) en x\.lugar/,
    );
    expect(() => serializar({ a: { __tipo: "timestamp" } })).toThrow(
      RespaldoError,
    );
    expect(() => serializar({ n: Number.NaN })).toThrow(RespaldoError);
  });

  it("cuenta documentos con datos, incluidas subcolecciones y padres sin datos", () => {
    const r = respaldo({
      usuarios: [
        {
          id: "u1",
          datos: null,
          subcolecciones: {
            marcas: [{ id: "zontes", datos: { saldo: 3 } }],
          },
        },
        { id: "u2", datos: { rol: "cliente" } },
      ],
      libro: [],
    });
    expect(contar(r)).toEqual({ usuarios: 2, libro: 0 });
  });

  it("compara documento a documento sin depender del orden de las claves", () => {
    const a = respaldo({
      usuarios: [
        { id: "u1", datos: { a: 1, b: 2 } },
        { id: "u2", datos: { a: 1 } },
      ],
    });
    expect(
      comparar(
        a,
        respaldo({
          usuarios: [
            { id: "u1", datos: { b: 2, a: 1 } },
            { id: "u2", datos: { a: 1 } },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      comparar(
        a,
        respaldo({
          usuarios: [
            { id: "u1", datos: { a: 1, b: 3 } },
            {
              id: "u3",
              datos: null,
              subcolecciones: { marcas: [{ id: "niu", datos: {} }] },
            },
          ],
        }),
      ),
    ).toEqual([
      { ruta: "usuarios/u1", tipo: "distinto" },
      { ruta: "usuarios/u2", tipo: "falta" },
      { ruta: "usuarios/u3/marcas/niu", tipo: "sobra" },
    ]);
  });

  it("valida el formato antes de restaurar", () => {
    expect(validarRespaldo(respaldo({})).version).toBe(1);
    expect(() => validarRespaldo({ formato: "otro" })).toThrow(RespaldoError);
    expect(() => validarRespaldo(null)).toThrow(RespaldoError);
  });
});
