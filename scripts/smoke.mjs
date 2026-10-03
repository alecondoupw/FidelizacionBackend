// Prueba de arranque: ejecuta el build (dist/server.js) y comprueba salud y errores.
// Uso: npm run build && npm run smoke   (BE_SMOKE_PORT opcional, por defecto 4100)
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.BE_SMOKE_PORT ?? 4100);
const base = `http://127.0.0.1:${port}/api/v1`;

const server = spawn(process.execPath, ["dist/server.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    FIREBASE_PROJECT_ID: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await fetch(`${base}/health`);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`El servidor no arrancó en ${base}.\n${output}`);
}

const checks = [
  {
    name: "GET /api/v1/health -> 200 ok",
    run: async () => {
      const res = await fetch(`${base}/health`);
      const body = await res.json();
      return res.status === 200 && body.status === "ok";
    },
  },
  {
    name: "GET /api/v1/no-existe -> 404 NOT_FOUND",
    run: async () => {
      const res = await fetch(`${base}/no-existe`);
      const body = await res.json();
      return res.status === 404 && body.error?.code === "NOT_FOUND";
    },
  },
];

let failed = false;
try {
  await waitForServer();
  for (const check of checks) {
    const ok = await check.run();
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name}`);
    if (!ok) failed = true;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failed = true;
} finally {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await exited;
}
process.exitCode = failed ? 1 : 0;
