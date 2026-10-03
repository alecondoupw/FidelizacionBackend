// Vence los lotes cuya fecha pasó (F2-BE-03). Es reejecutable: nunca descuenta
// dos veces. La programación periódica se decide en DEC-13; mientras tanto el
// saldo de cada cliente ya excluye lo vencido al consultarlo.
//   npm run puntos:vencer
import { procesarVencimientos } from "../puntos/libro.js";
import { conectarFirebase } from "./firebase-cli.js";

const { almacen } = conectarFirebase();
const r = await procesarVencimientos(almacen, new Date());
console.log(`Lotes vencidos: ${r.lotesVencidos} en ${r.cuentas} cuenta(s).`);
