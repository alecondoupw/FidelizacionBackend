// Crea el administrador inicial (DEC-03). Lo ejecuta el custodio:
//   npm run admin:bootstrap -- --email persona@dominio
import {
  BootstrapRechazado,
  bootstrapAdministrador,
} from "../admin/bootstrap.js";
import { argumento, conectarFirebase } from "./firebase-cli.js";

const correo = argumento("email");
if (!correo) {
  console.error("Uso: npm run admin:bootstrap -- --email <correo>");
  process.exit(2);
}

try {
  const { cuentas, perfiles } = conectarFirebase();
  const resultado = await bootstrapAdministrador(
    { cuentas, perfiles, reloj: () => new Date() },
    correo,
  );
  if (resultado.estado === "ya_era_administrador") {
    console.log(`Sin cambios: ${resultado.uid} ya es administrador.`);
  } else {
    console.log(`Administrador inicial creado (uid ${resultado.uid}).`);
    console.log(
      "Enlace para definir la contraseña (personal, no lo compartas ni lo guardes):",
    );
    console.log(resultado.enlace);
  }
} catch (error) {
  if (error instanceof BootstrapRechazado) {
    console.error(`Rechazado: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
