// Concilia el libro global de reportes y el índice de canjes con los datos de
// cada cliente (F5-I-01). Sin argumentos sólo informa; con --reparar completa
// lo que falta (p. ej. movimientos anteriores a F5). Nunca borra.
//   npm run reportes:conciliar [-- --reparar]
import { conciliar } from "../reportes/conciliacion.js";
import { conectarFirebase } from "./firebase-cli.js";

const reparar = process.argv.includes("--reparar");
const { almacen } = conectarFirebase();
const r = await conciliar(almacen, { reparar });
console.log(
  [
    `Movimientos de clientes: ${r.movimientos} · asientos en el libro: ${r.asientos}`,
    `Faltantes: ${r.faltantes} · distintos: ${r.distintos} · sobrantes: ${r.sobrantes.length}`,
    `Canjes: ${r.canjes} · índices desactualizados: ${r.indicesDesactualizados}`,
    reparar
      ? `Escrituras aplicadas: ${r.reparados}`
      : "Modo informe: no se escribió nada (usa --reparar para completar).",
  ].join("\n"),
);
if (r.sobrantes.length) {
  console.log(`Asientos sin movimiento (revisar): ${r.sobrantes.join(", ")}`);
}
if (!reparar && (r.faltantes || r.distintos || r.indicesDesactualizados)) {
  process.exitCode = 1;
}
