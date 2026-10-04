// Exporta Firestore a un archivo JSON fechado (DEC-13). Contiene datos
// personales: guardarlo fuera de Git y del alcance de terceros.
//   npm run respaldo:exportar [-- --salida <carpeta>]
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contar, exportar } from "../respaldo/respaldo.js";
import { argumento, conectarFirebase } from "./firebase-cli.js";

const { config, db } = conectarFirebase();
const ahora = new Date();
const respaldo = await exportar(db, {
  prefijo: config.firestorePrefix,
  proyecto: config.firebaseProjectId ?? null,
  ahora,
});
const carpeta = argumento("salida") ?? "respaldos";
await mkdir(carpeta, { recursive: true });
const sello = ahora.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
const archivo = join(carpeta, `respaldo-${sello}.json`);
await writeFile(archivo, JSON.stringify(respaldo), { flag: "wx" });

const cuentas = contar(respaldo);
for (const [coleccion, n] of Object.entries(cuentas)) {
  console.log(`${coleccion.padEnd(14)} ${n}`);
}
const total = Object.values(cuentas).reduce((a, b) => a + b, 0);
console.log(`Respaldo: ${archivo} (${total} documentos).`);
