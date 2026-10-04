import { describe, expect, it } from "vitest";
import { aXlsx } from "../reportes/exportaciones.js";
import { leerCsv, leerTabla, MAX_BYTES_IMPORTACION } from "./archivo.js";

const BOM = String.fromCharCode(0xfeff);
const csv = (s: string, codificacion: BufferEncoding = "utf8") =>
  Buffer.from(s, codificacion);

describe("F8-BE-01 · lectura de CSV y XLSX", () => {
  it("CSV con BOM, «;», CRLF y comillas con separador y salto de línea", () => {
    expect(
      leerCsv(
        csv(
          BOM +
            'Nombre;Correo\r\n"Pérez; Ana";ana@ejemplo.test\r\n"Luis ""Lucho""\nRojas";luis@ejemplo.test\r\n',
        ),
      ),
    ).toEqual([
      ["Nombre", "Correo"],
      ["Pérez; Ana", "ana@ejemplo.test"],
      ['Luis "Lucho"\nRojas', "luis@ejemplo.test"],
    ]);
  });

  it("detecta «,» o tabulador según el encabezado", () => {
    expect(leerCsv(csv("nombre,correo\nAna,a@ejemplo.test"))).toEqual([
      ["nombre", "correo"],
      ["Ana", "a@ejemplo.test"],
    ]);
    expect(leerCsv(csv("nombre\tcorreo\nAna\ta@ejemplo.test"))[1]).toEqual([
      "Ana",
      "a@ejemplo.test",
    ]);
  });

  it("acepta CSV de Excel en Windows-1252", () => {
    expect(
      leerCsv(csv("nombre;correo\nJosé Muñoz;j@ejemplo.test", "latin1"))[1],
    ).toEqual(["José Muñoz", "j@ejemplo.test"]);
  });

  it("recorta celdas, descarta filas vacías y lee XLSX", async () => {
    expect(
      await leerTabla(csv("nombre;correo\n  Ana  ; a@ejemplo.test \n;\n")),
    ).toEqual([
      ["nombre", "correo"],
      ["Ana", "a@ejemplo.test"],
    ]);
    const xlsx = await aXlsx(
      ["Nombre", "Correo electrónico"],
      [["Ana Pérez", "ana@ejemplo.test"]],
      "clientes",
    );
    expect(await leerTabla(xlsx)).toEqual([
      ["Nombre", "Correo electrónico"],
      ["Ana Pérez", "ana@ejemplo.test"],
    ]);
  });

  it("rechaza archivo vacío, comillas sin cerrar, XLSX dañado y más de 5 MB", async () => {
    await expect(leerTabla(Buffer.alloc(0))).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      leerTabla(csv('nombre;correo\n"Ana;a@x.test')),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      leerTabla(Buffer.from("PK\u0003\u0004basura")),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      leerTabla(Buffer.alloc(MAX_BYTES_IMPORTACION + 1, 0x61)),
    ).rejects.toMatchObject({ status: 413 });
  });
});
