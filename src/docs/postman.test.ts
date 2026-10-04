import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearAlmacenEnMemoria } from "../almacen/memoria.js";
import { API_PREFIX, createApp } from "../app.js";
import { hashClave } from "../auth/integracion.js";
import {
  TokenInvalidoError,
  type TokenVerifier,
} from "../auth/token-verifier.js";
import { loadConfig } from "../config/env.js";
import { crearDependencias } from "../dependencias.js";
import { crearCuentasEnMemoria } from "../identidad/cuentas.js";
import { crearFuenteSintetica } from "../legacy/fuente-legacy.js";
import { R } from "../puntos/rutas.js";
import { huellaCorreo } from "../usuarios/correo.js";
import { crearPerfilesAlmacen } from "../usuarios/perfiles-almacen.js";

/**
 * F7-BE-02: la colección Postman (docs/postman) es la documentación de pruebas
 * manuales. Debe cubrir exactamente las rutas de Express y sus ejemplos deben
 * pasar la validación de cada endpoint con el acceso documentado.
 */
interface Peticion {
  name: string;
  request: {
    method: string;
    header: { key: string; value: string }[];
    auth: { type: string; bearer?: { value: string }[] };
    url: {
      raw: string;
      path: string[];
      query?: { key: string; value: string }[];
      variable?: { key: string; value: string }[];
    };
    body?: { raw: string };
  };
}
interface Carpeta {
  name: string;
  item: (Peticion | Carpeta)[];
}

const coleccion = JSON.parse(
  readFileSync("docs/postman/fidelizacion.postman_collection.json", "utf8"),
) as { item: Carpeta[] };
const peticiones = coleccion.item
  .filter((c) => !c.name.startsWith("Autenticación"))
  .flatMap((c) => c.item as Peticion[]);
const firma = (p: Peticion) =>
  `${p.request.method} /${p.request.url.path.join("/")}`;

function rutasExpress(): string[] {
  const config = loadConfig({ NODE_ENV: "test" });
  const app = createApp(config, crearDependencias(config)) as unknown as {
    router: { stack: Capa[] };
  };
  interface Capa {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Capa[] };
  }
  const salida: string[] = [];
  const recorrer = (stack: Capa[]) => {
    for (const capa of stack) {
      if (capa.route) {
        for (const m of Object.keys(capa.route.methods)) {
          salida.push(`${m.toUpperCase()} ${capa.route.path}`);
        }
      } else if (capa.handle?.stack) recorrer(capa.handle.stack);
    }
  };
  recorrer(app.router.stack);
  return salida;
}

const AHORA = new Date("2026-10-03T15:00:00.000Z");
const CLAVE = "clave-de-prueba-integracion";

async function montar() {
  const almacen = crearAlmacenEnMemoria();
  const cuentas = crearCuentasEnMemoria();
  const uids: Record<string, string> = {};
  for (const [n, rol, marcas] of [
    ["admin", "administrador", []],
    ["cliente", "cliente", ["zontes", "kiden", "niu"]],
  ] as const) {
    const correo = `${n}@ejemplo.test`;
    const { uid } = await cuentas.crear({ correo, nombre: n });
    uids[n] = uid;
    await almacen.transaccion(async (tx) => {
      tx.fijar(R.usuario(uid), {
        correo,
        rol,
        activo: true,
        marcas: [...marcas],
        vinculo: marcas.length ? "vinculado" : "no_vinculado",
        creadoEn: AHORA.toISOString(),
      });
      tx.fijar(R.correo(huellaCorreo(correo)), { uid });
    });
  }
  const verifier: TokenVerifier = {
    async verificar(t) {
      const c = cuentas.cuentas.get(t);
      if (!c) throw new TokenInvalidoError("auth/user-not-found");
      return {
        uid: c.uid,
        correo: c.correo ?? undefined,
        correoVerificado: true,
      };
    },
  };
  const config = loadConfig({
    NODE_ENV: "test",
    INTEGRACION_CLAVES: `facturacion:${hashClave(CLAVE).toString("hex")}`,
  });
  const app = createApp(config, {
    tokenVerifier: verifier,
    perfiles: crearPerfilesAlmacen(almacen),
    cuentas,
    fuenteLegacy: crearFuenteSintetica(),
    almacen,
    reloj: () => AHORA,
  });
  return { app, uids };
}

describe("F7-BE-02 · colección Postman", () => {
  it("documenta exactamente las rutas registradas en Express", () => {
    const documentadas = peticiones.map(firma).sort();
    expect(new Set(documentadas).size).toBe(documentadas.length);
    expect(documentadas).toEqual(rutasExpress().sort());
  });

  it("cada petición describe su acceso", () => {
    for (const p of peticiones) {
      expect(
        String((p.request as { description?: string }).description),
      ).toMatch(/Acceso: /);
    }
  });

  it.each(peticiones.map((p) => [firma(p), p] as const))(
    "%s: el ejemplo pasa la validación con el acceso documentado",
    async (_firma, p) => {
      const { app, uids } = await montar();
      const valores: Record<string, string> = {
        beneficioId: "beneficio-inexistente",
        codigoCanje: "ML-ABCD-EFGH-JK",
        uidCliente: uids.cliente!,
        uidAdmin: "admin-inexistente",
        contenidoId: "contenido-inexistente",
        $guid: "solicitud-0001",
        idTokenCliente: uids.cliente!,
        idTokenAdmin: uids.admin!,
        claveIntegracion: CLAVE,
      };
      const sustituir = (texto: string) =>
        texto.replace(/\{\{([$\w]+)\}\}/g, (_m, k: string) => valores[k] ?? "");
      const variables = Object.fromEntries(
        (p.request.url.variable ?? []).map((v) => [v.key, sustituir(v.value)]),
      );
      const ruta = p.request.url.path
        .map((s) => (s.startsWith(":") ? variables[s.slice(1)] : s))
        .join("/");
      const query = Object.fromEntries(
        (p.request.url.query ?? []).map((q) => [q.key, sustituir(q.value)]),
      );
      let r = request(app)
        [p.request.method.toLowerCase() as "get"](`${API_PREFIX}/${ruta}`)
        .query(query);
      for (const h of p.request.header) r = r.set(h.key, sustituir(h.value));
      const token = p.request.auth.bearer?.[0]?.value;
      if (token) r = r.set("Authorization", `Bearer ${sustituir(token)}`);
      const res = p.request.body
        ? await r.send(JSON.parse(sustituir(p.request.body.raw)))
        : await r;

      const codigo = (res.body as { error?: { code?: string } })?.error?.code;
      expect({ estado: res.status, codigo }).not.toMatchObject({
        codigo: expect.stringMatching(
          /^(VALIDATION_ERROR|BAD_REQUEST|UNAUTHENTICATED|FORBIDDEN|INTERNAL_ERROR)$/,
        ),
      });
      expect(res.status).toBeLessThan(500);
    },
  );
});
