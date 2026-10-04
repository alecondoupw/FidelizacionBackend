import { readSheet } from "read-excel-file/node";
import { AppError } from "../http/errors.js";

/**
 * Lectura del archivo de importación (DEC-17): CSV o XLSX en memoria; el
 * archivo no se guarda. Devuelve filas de texto recortado, con la primera
 * fila como encabezado.
 */
export const MAX_BYTES_IMPORTACION = 5 * 1024 * 1024;

const archivoInvalido = (mensaje: string) =>
  new AppError(422, "VALIDATION_ERROR", mensaje);

/** XLSX es un ZIP: empieza por «PK». */
export const esXlsx = (datos: Buffer) =>
  datos.length > 3 && datos[0] === 0x50 && datos[1] === 0x4b;

export async function leerTabla(datos: Buffer): Promise<string[][]> {
  if (datos.length === 0) throw archivoInvalido("El archivo está vacío.");
  if (datos.length > MAX_BYTES_IMPORTACION) {
    throw new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      "El archivo supera el máximo de 5 MB.",
    );
  }
  const filas = esXlsx(datos) ? await leerXlsx(datos) : leerCsv(datos);
  return filas
    .map((f) => f.map((c) => c.trim()))
    .filter((f) => f.some((c) => c !== ""));
}

async function leerXlsx(datos: Buffer): Promise<string[][]> {
  try {
    const hoja = await readSheet(datos);
    return hoja.map((fila) =>
      fila.map((celda) =>
        celda === null || celda === undefined
          ? ""
          : celda instanceof Date
            ? celda.toISOString()
            : String(celda),
      ),
    );
  } catch {
    throw archivoInvalido("No se pudo leer el archivo Excel (.xlsx).");
  }
}

/** CSV RFC 4180 con separador «;», «,» o tabulador (el que más aparezca en el encabezado). */
export function leerCsv(datos: Buffer): string[][] {
  let texto = datos.toString("utf8");
  if (texto.includes("�")) {
    // No es UTF-8 válido: Excel en Windows guarda CSV en Windows-1252.
    texto = datos.toString("latin1");
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  const primera = texto.split(/\r?\n/, 1)[0] ?? "";
  const separador = [";", ",", "\t"]
    .map((s) => [s, primera.split(s).length] as const)
    .sort((a, b) => b[1] - a[1])[0]![0];

  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          celda += '"';
          i++;
        } else comillas = false;
      } else celda += c;
    } else if (c === '"' && celda === "") {
      comillas = true;
    } else if (c === separador) {
      fila.push(celda);
      celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = "";
    } else celda += c;
  }
  if (comillas) throw archivoInvalido("El CSV tiene comillas sin cerrar.");
  if (celda !== "" || fila.length) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}
