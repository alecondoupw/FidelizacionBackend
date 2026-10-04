// Restaura un respaldo JSON y lo verifica documento a documento (DEC-13).
//   Prueba (recomendada):  npm run respaldo:restaurar -- --archivo <json> --prefijo prueba_restauracion_ [--limpiar]
//   Sobre el proyecto:     npm run respaldo:restaurar -- --archivo <json> --sobre-proyecto [--permitir-no-vacio]
// Por defecto exige colecciones de destino vacías; nunca borra fuera de un prefijo prueba_*.
import { readFile } from "node:fs/promises";
import {
  coleccionesRaiz,
  comparar,
  exportar,
  restaurar,
  validarRespaldo,
} from "../respaldo/respaldo.js";
import { argumento, conectarFirebase } from "./firebase-cli.js";

const bandera = (nombre: string) => process.argv.includes(`--${nombre}`);
const archivo = argumento("archivo");
const prefijo = argumento("prefijo");
if (!archivo || (!prefijo && !bandera("sobre-proyecto"))) {
  console.error(
    "Uso: --archivo <json> y --prefijo prueba_<nombre>_ o --sobre-proyecto.",
  );
  process.exit(2);
}
if (prefijo && !/^prueba_[a-z0-9_]*_$/.test(prefijo)) {
  console.error("El prefijo de prueba debe tener la forma prueba_<nombre>_.");
  process.exit(2);
}

const { config, db } = conectarFirebase();
const destino = prefijo ?? config.firestorePrefix;
const respaldo = validarRespaldo(JSON.parse(await readFile(archivo, "utf8")));

const { documentos } = await restaurar(db, respaldo, {
  prefijo: destino,
  permitirNoVacio: bandera("permitir-no-vacio"),
});
console.log(`Restaurados ${documentos} documentos con prefijo «${destino}».`);

const copia = await exportar(db, { prefijo: destino });
const diferencias = comparar(respaldo, copia);
if (diferencias.length) {
  console.error(`Verificación: ${diferencias.length} diferencia(s).`);
  for (const d of diferencias.slice(0, 20))
    console.error(`  ${d.tipo} ${d.ruta}`);
  process.exitCode = 1;
} else {
  console.log("Verificación: el destino coincide documento a documento.");
}

if (bandera("limpiar") && prefijo) {
  for (const c of await coleccionesRaiz(db, prefijo)) {
    await db.recursiveDelete(c);
  }
  console.log(`Colecciones «${prefijo}*» borradas.`);
}
