// Carga inicial del catálogo desde un archivo JSON (DEC-07). Crea los
// beneficios nuevos y omite los existentes para no pisar el stock.
//   npm run catalogo:cargar -- --archivo datos/catalogo.ejemplo.json
import { readFileSync } from "node:fs";
import { z } from "zod";
import { cargarCatalogo } from "../canjes/catalogo.js";
import { esquemaBeneficio } from "../routes/canjes.js";
import { argumento, conectarFirebase } from "./firebase-cli.js";

const ruta = argumento("archivo");
if (!ruta) {
  console.error("Uso: npm run catalogo:cargar -- --archivo <ruta.json>");
  process.exit(2);
}
const archivo = z
  .object({
    nota: z.string().optional(),
    beneficios: z.array(
      esquemaBeneficio.safeExtend({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      }),
    ),
  })
  .safeParse(JSON.parse(readFileSync(ruta, "utf8")));
if (!archivo.success) {
  console.error("Archivo inválido:");
  for (const i of archivo.error.issues)
    console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
const { almacen } = conectarFirebase();
const r = await cargarCatalogo(
  almacen,
  archivo.data.beneficios,
  "carga-inicial",
  new Date(),
);
console.log(
  `Creados: ${r.creados.length}${r.creados.length ? ` (${r.creados.join(", ")})` : ""}`,
);
console.log(
  `Omitidos por existir: ${r.omitidos.length}${r.omitidos.length ? ` (${r.omitidos.join(", ")})` : ""}`,
);
