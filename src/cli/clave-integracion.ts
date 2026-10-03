// Genera una clave de integración para un sistema externo (DEC-05). La clave
// se muestra una sola vez; en el servidor sólo se guarda su SHA-256.
//   npm run integracion:clave -- --sistema facturacion
import { randomBytes } from "node:crypto";
import { hashClave } from "../auth/integracion.js";
import { argumento } from "./firebase-cli.js";

const sistema = argumento("sistema") ?? "";
if (!/^[a-z0-9-]{2,32}$/.test(sistema)) {
  console.error(
    "Uso: npm run integracion:clave -- --sistema <nombre-en-minúsculas>",
  );
  process.exit(2);
}
const clave = randomBytes(32).toString("base64url");
console.log(
  "Clave para el sistema externo (entrégala por un canal seguro; no se vuelve a mostrar):",
);
console.log(clave);
console.log(
  "Añade esta entrada a INTEGRACION_CLAVES en el .env del backend (separa varias con coma):",
);
console.log(`${sistema}:${hashClave(clave).toString("hex")}`);
