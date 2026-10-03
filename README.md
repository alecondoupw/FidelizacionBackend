# FidelizacionBackend

API **Express.js + TypeScript** de la plataforma de fidelización multimarca Zontes / Kiden / NIU. Express es la única capa que modifica datos sensibles: verifica identidad con Firebase Admin SDK, autoriza rol, estado, propietario y marca, y ejecuta las reglas de puntos y canjes. La documentación canónica vive en el Core de Obsidian del repositorio [FidelizacionDoc](https://github.com/alecondoupw/FidelizacionDoc) (`Zontes-Core/`).

**Estado:** F0 — base técnica instalada y verificada. Sólo expone `GET /api/v1/health`; no hay endpoints de negocio ni conexión a Firebase.

## Requisitos

- Node.js 24 LTS (`.nvmrc`; `engines` exige `>=24 <25`; Firebase Admin SDK requiere Node ≥ 22) y npm 11.

## Puesta en marcha

```bash
npm ci
cp .env.example .env   # sólo valores locales; nunca credenciales reales en Git
npm run dev            # http://127.0.0.1:4000/api/v1/health
```

## Scripts

| Script                            | Qué hace                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`                     | `tsx watch` con `.env` opcional                                             |
| `npm run build` / `npm start`     | Compila a `dist/` con `tsc` / ejecuta `dist/server.js`                      |
| `npm run lint` / `lint:fix`       | ESLint (`@eslint/js` + `typescript-eslint` + Prettier)                      |
| `npm run format` / `format:check` | Prettier                                                                    |
| `npm run typecheck`               | `tsc --noEmit`                                                              |
| `npm test`                        | Vitest + Supertest                                                          |
| `npm run smoke`                   | Arranca `dist/server.js` y comprueba salud y 404 (requiere `npm run build`) |
| `npm run check`                   | formato → lint → typecheck → test → build                                   |

## Estructura

| Ruta                        | Responsabilidad                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `src/app.ts`                | Construye la app (helmet, CORS por lista, JSON ≤ 100 kB, rutas, errores) sin abrir puertos |
| `src/server.ts`             | Arranque y cierre ordenado                                                                 |
| `src/config/env.ts`         | Variables validadas con Zod                                                                |
| `src/http/`                 | `X-Request-Id` y sobre de error `{ error: { code, message, requestId } }`                  |
| `src/routes/health.ts`      | `GET /api/v1/health`                                                                       |
| `src/auth/authorization.ts` | Frontera de autorización (falla cerrado; verificación real en F1-BE-01)                    |
| `src/firebase/admin.ts`     | Admin SDK con inicialización perezosa vía Application Default Credentials                  |

## Seguridad

- Sin secretos en Git: `.env*`, `*.pem` y archivos de cuenta de servicio están ignorados. `GOOGLE_APPLICATION_CREDENTIALS` apunta a un archivo fuera del repositorio.
- Admin SDK omite las reglas de Firestore: toda operación pasa antes por `src/auth`.
- Los errores 5xx no exponen detalles internos; se registran con su `requestId`.
