# FidelizacionBackend

API **Express.js + TypeScript** de la plataforma de fidelización multimarca Zontes / Kiden / NIU. Express es la única capa que modifica datos sensibles: verifica identidad con Firebase Admin SDK, autoriza rol, estado, propietario y marca, y ejecuta las reglas de puntos, canjes, reportes y contenido. La documentación canónica (requisitos, decisiones, pruebas y manuales) vive en el Core de Obsidian del repositorio [FidelizacionDoc](https://github.com/alecondoupw/FidelizacionDoc) (`Zontes-Core/`).

**Estado:** F1–F7 implementadas; F8 (correcciones de SRC-06: importación de clientes, puntos con vencimiento propio, menú e Inicio) implementada y verificada en local. Referencia de la API en [`docs/API.md`](docs/API.md) y colección Postman en [`docs/postman/`](docs/postman/).

## Requisitos

- Node.js 24 LTS (`.nvmrc`; `engines` exige `>=24 <25`) y npm 11.
- Para las rutas protegidas: un proyecto Firebase con Authentication y Firestore, y una cuenta de servicio cuyo JSON queda **fuera del repositorio** (`GOOGLE_APPLICATION_CREDENTIALS`). Sin `FIREBASE_PROJECT_ID` el servidor arranca y las rutas protegidas responden 503.

## Puesta en marcha

```bash
npm ci
cp .env.example .env   # sólo valores locales; nunca credenciales reales en Git
npm run dev            # http://127.0.0.1:4000/api/v1/health
```

## Scripts

| Script                                          | Qué hace                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                                   | `tsx watch` con `.env` opcional                                       |
| `npm run build` / `npm start`                   | Compila a `dist/` / ejecuta `dist/server.js`                          |
| `npm run check`                                 | formato → lint → typecheck → pruebas → build                          |
| `npm run smoke`                                 | Arranca `dist/server.js` y comprueba salud y 404 (requiere build)     |
| `FIRESTORE_INTEGRATION=1 npm run test:firebase` | Contratos contra Firestore real con colecciones temporales `prueba_*` |
| `npm run docs:postman`                          | Regenera la colección Postman desde `scripts/generar-postman.mjs`     |

## Operación

Comandos que ejecuta un responsable con credenciales (nunca la API):

| Comando                                                                                   | Uso                                                                                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run admin:bootstrap -- --email <correo>`                                             | Crea el administrador inicial una sola vez y muestra el enlace para definir su contraseña                   |
| `npm run dev:usuario-prueba -- --email <nombre>@ejemplo.test`                             | Usuario de prueba con correo verificado (sólo `ejemplo.test`)                                               |
| `npm run catalogo:cargar -- --archivo datos/catalogo.ejemplo.json`                        | Carga beneficios nuevos sin pisar los existentes                                                            |
| `npm run puntos:vencer`                                                                   | Vence lotes caducados; reejecutable. En producción lo programa `.github/workflows/vencer-puntos.yml`        |
| `npm run reportes:conciliar [-- --reparar]`                                               | Compara el libro global con los datos de cada cliente y completa lo que falte                               |
| `npm run integracion:clave -- --sistema <nombre>`                                         | Genera una clave de integración y su hash para `INTEGRACION_CLAVES`                                         |
| `npm run respaldo:exportar [-- --salida <carpeta>]`                                       | Exporta Firestore a `respaldos/respaldo-<fecha>.json` (contiene datos personales; carpeta ignorada por Git) |
| `npm run respaldo:restaurar -- --archivo <json> --prefijo prueba_restauracion_ --limpiar` | Simulacro: restaura en colecciones temporales, verifica documento a documento y las borra                   |

## Despliegue

Render (plan gratuito) con [`render.yaml`](render.yaml); variables secretas y el JSON de la cuenta de servicio se cargan en el panel de Render. Reglas de Firestore que deniegan el acceso directo: [`firestore.rules`](firestore.rules). Procedimiento completo en el Core: `Zontes-Core/08-Produccion/Manual de despliegue y operacion.md`.

## Estructura

| Ruta                                                                              | Responsabilidad                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/app.ts` / `src/server.ts`                                                    | Construye la app (helmet, CORS por lista, límites, JSON ≤ 100 kB, rutas, errores) / arranque y cierre ordenado |
| `src/config/env.ts`                                                               | Variables validadas con Zod                                                                                    |
| `src/http/`                                                                       | `X-Request-Id`, sobre de error, validación, límite de peticiones, registro JSON y `Server-Timing`              |
| `src/auth/`                                                                       | Verificación del ID token (con revocación), frontera de autorización y claves de integración                   |
| `src/almacen/`                                                                    | Almacén transaccional en memoria (pruebas) y Firestore                                                         |
| `src/puntos/`, `src/canjes/`, `src/identidad/`, `src/reportes/`, `src/contenido/` | Reglas de negocio por módulo                                                                                   |
| `src/routes/`                                                                     | Rutas HTTP por módulo                                                                                          |
| `src/respaldo/`, `src/cli/`                                                       | Respaldo JSON y comandos de operación                                                                          |

## Seguridad

- Sin secretos en Git: `.env*`, `*.pem`, archivos de cuenta de servicio y `respaldos/` están ignorados.
- El Admin SDK omite las reglas de Firestore: toda operación pasa antes por `src/auth`. El navegador no accede a Firestore (`firestore.rules` lo deniega todo).
- Los errores 5xx no exponen detalles internos; se registran con su `requestId`. El registro de peticiones no incluye cuerpos, consultas, tokens ni correos.
