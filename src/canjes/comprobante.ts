import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { ZONA } from "../puntos/fechas.js";
import type { CanjeVista } from "./canjes.js";

const NOMBRE_MARCA = { zontes: "Zontes", kiden: "Kiden", niu: "NIU" } as const;
const ESTADO = {
  emitido: "Emitido — pendiente de entrega",
  entregado: "Entregado",
  vencido: "Vencido",
  anulado: "Anulado",
} as const;
const FECHA = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeZone: ZONA,
});
const FECHA_HORA = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: ZONA,
});
const NUMERO = new Intl.NumberFormat("es-BO");

/**
 * Comprobante PDF del canje (UI-16, DEC-07): generado en el servidor con los
 * datos del canje y un QR que contiene sólo su código (sin datos personales).
 * Refleja el estado del momento en que se descarga.
 */
export async function generarComprobante(
  c: CanjeVista,
  generadoEn: Date,
): Promise<Buffer> {
  const qr = await QRCode.toBuffer(c.codigo, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 300,
  });
  const doc = new PDFDocument({
    size: "A5",
    margin: 40,
    info: {
      Title: `Comprobante de canje ${c.codigo}`,
      Author: "MOTO LOYALTY",
      Subject: `${c.beneficioNombre} · ${NOMBRE_MARCA[c.marca]}`,
    },
  });
  const partes: Buffer[] = [];
  doc.on("data", (p: Buffer) => partes.push(p));
  const terminado = new Promise<Buffer>((ok, error) => {
    doc.on("end", () => ok(Buffer.concat(partes)));
    doc.on("error", error);
  });

  const indigo = "#4f46e5";
  const gris = "#5b6377";
  const ancho = doc.page.width - 80;

  doc
    .fillColor(indigo)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("MOTO LOYALTY · FIDELIZACIÓN");
  doc
    .moveDown(0.3)
    .fillColor("#111827")
    .fontSize(18)
    .text("Comprobante de canje");
  doc.moveDown(0.8);

  doc.image(qr, (doc.page.width - 130) / 2, doc.y, { width: 130 });
  doc.moveDown(0.2).y += 135;
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#111827")
    .text(c.codigo, { align: "center", characterSpacing: 1 });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(gris)
    .text("Código único del canje", { align: "center" });
  doc.moveDown(1);

  const fila = (etiqueta: string, valor: string) => {
    const y = doc.y;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(gris)
      .text(etiqueta, 40, y, { width: ancho * 0.4 });
    doc
      .font("Helvetica-Bold")
      .fillColor("#111827")
      .text(valor, 40 + ancho * 0.4, y, { width: ancho * 0.6, align: "right" });
    doc.moveDown(0.5);
  };
  fila("Beneficio", c.beneficioNombre);
  fila("Opción", c.varianteNombre);
  fila("Marca", NOMBRE_MARCA[c.marca]);
  fila("Puntos utilizados", NUMERO.format(c.puntos));
  fila("Fecha del canje", FECHA_HORA.format(new Date(c.emitidoEn)));
  fila("Válido hasta", FECHA.format(new Date(c.venceEn)));
  fila("Estado", ESTADO[c.estado]);
  if (c.estado === "anulado" && c.motivoAnulacion)
    fila("Motivo de anulación", c.motivoAnulacion);

  doc.moveDown(1);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(gris)
    .text(
      `Generado el ${FECHA_HORA.format(generadoEn)} (hora de Bolivia). El estado vigente se verifica en el sistema con el código; este documento no reemplaza esa verificación.`,
      40,
      doc.y,
      { width: ancho, align: "center" },
    );
  doc.end();
  return terminado;
}
