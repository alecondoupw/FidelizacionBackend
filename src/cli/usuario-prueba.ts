// Crea un usuario de PRUEBA con correo sintético y verificado en el proyecto
// Firebase de desarrollo, para ejercitar registro y vínculo (DEC-02/04).
//   npm run dev:usuario-prueba -- --email cliente.multimarca@ejemplo.test
// Sólo acepta el dominio reservado ejemplo.test y se niega en producción.
import { normalizarCorreo } from "../usuarios/correo.js";
import { argumento, conectarFirebase } from "./firebase-cli.js";

const correo = normalizarCorreo(argumento("email") ?? "");
if (!correo.endsWith("@ejemplo.test")) {
  console.error(
    "Uso: npm run dev:usuario-prueba -- --email <nombre>@ejemplo.test",
  );
  process.exit(2);
}

const { config, auth, cuentas } = conectarFirebase();
if (config.nodeEnv === "production") {
  console.error(
    "Rechazado: no se crean usuarios de prueba con NODE_ENV=production.",
  );
  process.exit(1);
}

const existente = await cuentas.buscarPorCorreo(correo);
const uid =
  existente?.uid ??
  (await auth.createUser({ email: correo, emailVerified: true })).uid;
if (existente) await auth.updateUser(uid, { emailVerified: true });
console.log(
  `${existente ? "Ya existía" : "Creado"}: ${correo} (uid ${uid}), correo verificado.`,
);
console.log("Enlace para definir la contraseña de prueba:");
console.log(await cuentas.enlaceDefinirContrasena(correo));
