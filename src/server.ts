import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { crearDependencias } from "./dependencias.js";

const config = loadConfig();
const app = createApp(config, crearDependencias(config));

const server = app.listen(config.port, config.host, () => {
  console.log(
    `fidelizacion-backend escuchando en http://${config.host}:${config.port} (${config.nodeEnv})`,
  );
});

server.on("error", (error) => {
  console.error("No se pudo iniciar el servidor:", error);
  process.exitCode = 1;
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} recibido, cerrando servidor…`);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
