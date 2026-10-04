// Genera docs/postman/fidelizacion.postman_collection.json (F7-BE-02, DEC-13).
// Fuente única de la colección: la lista ENDPOINTS de abajo. La prueba
// src/docs/postman.test.ts falla si la colección no cubre exactamente las
// rutas registradas en Express.
//   npm run docs:postman
import { mkdir, writeFile } from "node:fs/promises";

const CLIENTE = "cliente";
const ADMIN = "admin";
const TOKEN = "token"; // ID token sin perfil todavía (registro)
const CLAVE = "clave"; // X-Api-Key de integración
const PUBLICO = "publico";

const hoy = "2026-10-03";
const hace30 = "2026-09-04";

/** [grupo, nombre, método, ruta, acceso, { query, cuerpo, descripcion }] */
const ENDPOINTS = [
  ["Salud", "Salud del servicio", "GET", "/health", PUBLICO, {}],

  ["Identidad", "Mi sesión (rol, marcas, vínculo)", "GET", "/me", CLIENTE, {}],
  [
    "Identidad",
    "Registrar cliente tras crear la cuenta",
    "POST",
    "/clientes/registro",
    TOKEN,
    {
      descripcion:
        "Sin cuerpo: el correo sale del token y debe estar verificado.",
    },
  ],
  [
    "Identidad",
    "Cambiar mi nombre",
    "PATCH",
    "/me",
    CLIENTE,
    { cuerpo: { nombre: "Ana Prueba" } },
  ],

  ["Puntos · cliente", "Mi saldo por marca", "GET", "/me/saldo", CLIENTE, {}],
  [
    "Puntos · cliente",
    "Mis movimientos",
    "GET",
    "/me/movimientos",
    CLIENTE,
    {
      query: { marca: "zontes", tipo: "otorgamiento", limite: "20" },
    },
  ],
  [
    "Puntos · cliente",
    "Cómo ganar puntos (reglas activas de mis marcas)",
    "GET",
    "/reglas",
    CLIENTE,
    {},
  ],

  [
    "Puntos · admin",
    "Listar reglas",
    "GET",
    "/admin/reglas",
    ADMIN,
    { query: { marca: "zontes" } },
  ],
  [
    "Puntos · admin",
    "Crear regla",
    "POST",
    "/admin/reglas",
    ADMIN,
    {
      cuerpo: { marca: "zontes", evento: "compra", puntos: 10, activa: true },
    },
  ],
  [
    "Puntos · admin",
    "Editar regla",
    "PATCH",
    "/admin/reglas/:id",
    ADMIN,
    {
      params: { id: "zontes__compra" },
      cuerpo: { puntos: 12 },
    },
  ],
  [
    "Puntos · admin",
    "Eliminar regla",
    "DELETE",
    "/admin/reglas/:id",
    ADMIN,
    { params: { id: "zontes__compra" } },
  ],
  [
    "Puntos · admin",
    "Sumar puntos con vencimiento propio",
    "POST",
    "/admin/asignaciones",
    ADMIN,
    {
      cuerpo: {
        idSolicitud: "{{$guid}}",
        marca: "zontes",
        correoCliente: "cliente.zontes@ejemplo.test",
        puntos: 100,
        motivo: "Compra en tienda",
        vence: "2027-10-04",
      },
      descripcion:
        "Sólo suma (entero > 0). «vence» va de hoy a 2 años y los puntos vencen al final de ese día en hora de Bolivia (DEC-18). Repetir el mismo idSolicitud devuelve 200 con repetido: true.",
    },
  ],

  [
    "Catálogo y canjes · cliente",
    "Catálogo de mis marcas",
    "GET",
    "/catalogo",
    CLIENTE,
    { query: { marca: "zontes", q: "casco" } },
  ],
  [
    "Catálogo y canjes · cliente",
    "Detalle de beneficio",
    "GET",
    "/catalogo/:id",
    CLIENTE,
    { params: { id: "{{beneficioId}}" } },
  ],
  [
    "Catálogo y canjes · cliente",
    "Canjear",
    "POST",
    "/canjes",
    CLIENTE,
    {
      cuerpo: {
        beneficioId: "{{beneficioId}}",
        varianteId: "unica",
        idSolicitud: "{{$guid}}",
      },
      descripcion:
        "idSolicitud hace el canje idempotente: reintentarlo devuelve el mismo canje.",
    },
  ],
  [
    "Catálogo y canjes · cliente",
    "Mis canjes",
    "GET",
    "/me/canjes",
    CLIENTE,
    { query: { limite: "20" } },
  ],
  [
    "Catálogo y canjes · cliente",
    "Un canje mío",
    "GET",
    "/me/canjes/:codigo",
    CLIENTE,
    { params: { codigo: "{{codigoCanje}}" } },
  ],
  [
    "Catálogo y canjes · cliente",
    "Comprobante PDF",
    "GET",
    "/me/canjes/:codigo/comprobante",
    CLIENTE,
    { params: { codigo: "{{codigoCanje}}" } },
  ],
  [
    "Catálogo y canjes · cliente",
    "QR del canje (SVG)",
    "GET",
    "/me/canjes/:codigo/qr.svg",
    CLIENTE,
    { params: { codigo: "{{codigoCanje}}" } },
  ],

  [
    "Catálogo y canjes · admin",
    "Listar beneficios",
    "GET",
    "/admin/beneficios",
    ADMIN,
    {},
  ],
  [
    "Catálogo y canjes · admin",
    "Crear beneficio",
    "POST",
    "/admin/beneficios",
    ADMIN,
    {
      cuerpo: {
        marca: "zontes",
        nombre: "Casco abierto (ejemplo)",
        descripcion: "Beneficio de demostración.",
        categoria: "accesorios",
        puntos: 120,
        activo: true,
        disponibleDesde: null,
        vigenciaCuponDias: 30,
        caracteristicas: ["Talla única"],
        variantes: [{ id: "unica", nombre: "Única", stock: 10 }],
      },
    },
  ],
  [
    "Catálogo y canjes · admin",
    "Reemplazar beneficio",
    "PUT",
    "/admin/beneficios/:id",
    ADMIN,
    {
      params: { id: "{{beneficioId}}" },
      cuerpo: {
        marca: "zontes",
        nombre: "Casco abierto (ejemplo)",
        descripcion: "",
        categoria: "accesorios",
        puntos: 100,
        activo: true,
        disponibleDesde: null,
        vigenciaCuponDias: 30,
        caracteristicas: [],
        variantes: [{ id: "unica", nombre: "Única", stock: null }],
      },
    },
  ],
  [
    "Catálogo y canjes · admin",
    "Buscar canje por código",
    "GET",
    "/admin/canjes/:codigo",
    ADMIN,
    { params: { codigo: "{{codigoCanje}}" } },
  ],
  [
    "Catálogo y canjes · admin",
    "Marcar entregado",
    "POST",
    "/admin/canjes/:codigo/entregar",
    ADMIN,
    { params: { codigo: "{{codigoCanje}}" } },
  ],
  [
    "Catálogo y canjes · admin",
    "Anular con motivo",
    "POST",
    "/admin/canjes/:codigo/anular",
    ADMIN,
    {
      params: { codigo: "{{codigoCanje}}" },
      cuerpo: { motivo: "El cliente desistió del canje" },
    },
  ],

  [
    "Identidades · admin",
    "Listar administradores",
    "GET",
    "/admin/administradores",
    ADMIN,
    {},
  ],
  [
    "Identidades · admin",
    "Invitar administrador",
    "POST",
    "/admin/administradores",
    ADMIN,
    {
      cuerpo: {
        nombre: "Luis",
        apellido: "Prueba",
        correo: "admin.nuevo@ejemplo.test",
      },
    },
  ],
  [
    "Identidades · admin",
    "Editar o desactivar administrador",
    "PATCH",
    "/admin/administradores/:uid",
    ADMIN,
    {
      params: { uid: "{{uidAdmin}}" },
      cuerpo: { activo: false },
    },
  ],
  [
    "Identidades · admin",
    "Eliminar administrador",
    "DELETE",
    "/admin/administradores/:uid",
    ADMIN,
    { params: { uid: "{{uidAdmin}}" } },
  ],
  [
    "Identidades · admin",
    "Listar clientes",
    "GET",
    "/admin/clientes",
    ADMIN,
    { query: { marca: "zontes", activo: "true", limite: "20" } },
  ],
  [
    "Identidades · admin",
    "Detalle de cliente",
    "GET",
    "/admin/clientes/:uid",
    ADMIN,
    { params: { uid: "{{uidCliente}}" } },
  ],
  [
    "Identidades · admin",
    "Editar cliente (nombre, correo, estado)",
    "PATCH",
    "/admin/clientes/:uid",
    ADMIN,
    {
      params: { uid: "{{uidCliente}}" },
      cuerpo: { nombre: "Ana Prueba" },
    },
  ],
  [
    "Identidades · admin",
    "Dar de baja cliente",
    "DELETE",
    "/admin/clientes/:uid",
    ADMIN,
    { params: { uid: "{{uidCliente}}" } },
  ],
  [
    "Identidades · admin",
    "Auditoría de una persona",
    "GET",
    "/admin/auditoria",
    ADMIN,
    { query: { objetivo: "{{uidCliente}}" } },
  ],

  [
    "Reportes · admin",
    "Resumen del dashboard",
    "GET",
    "/admin/reportes/resumen",
    ADMIN,
    {},
  ],
  [
    "Reportes · admin",
    "Actividad",
    "GET",
    "/admin/reportes/actividad",
    ADMIN,
    { query: { desde: hace30, hasta: hoy } },
  ],
  [
    "Reportes · admin",
    "Reporte de canjes",
    "GET",
    "/admin/reportes/canjes",
    ADMIN,
    { query: { desde: hace30, hasta: hoy, limite: "20" } },
  ],
  [
    "Reportes · admin",
    "Movimientos de todos los clientes",
    "GET",
    "/admin/movimientos",
    ADMIN,
    { query: { desde: hace30, hasta: hoy, limite: "20" } },
  ],
  [
    "Reportes · admin",
    "Vista previa de exportación",
    "GET",
    "/admin/exportaciones/:tipo/vista-previa",
    ADMIN,
    {
      params: { tipo: "movimientos" },
      query: { desde: hace30, hasta: hoy },
    },
  ],
  [
    "Reportes · admin",
    "Exportar (CSV o Excel)",
    "GET",
    "/admin/exportaciones/:tipo",
    ADMIN,
    {
      params: { tipo: "movimientos" },
      query: { desde: hace30, hasta: hoy, formato: "csv" },
    },
  ],

  [
    "Contenido",
    "Novedades de mis marcas",
    "GET",
    "/contenidos",
    CLIENTE,
    { query: { destacadas: "true", limite: "5" } },
  ],
  [
    "Contenido",
    "Listar publicaciones (admin)",
    "GET",
    "/admin/contenidos",
    ADMIN,
    { query: { marca: "kiden" } },
  ],
  [
    "Contenido",
    "Crear publicación",
    "POST",
    "/admin/contenidos",
    ADMIN,
    {
      cuerpo: {
        marca: "kiden",
        categoria: "evento",
        titulo: "Rodada de fin de mes (ejemplo)",
        texto: "Salida grupal de demostración.",
        enlace: null,
        destacada: true,
        activa: true,
        publicarDesde: hoy,
        publicarHasta: null,
      },
    },
  ],
  [
    "Contenido",
    "Reemplazar publicación",
    "PUT",
    "/admin/contenidos/:id",
    ADMIN,
    {
      params: { id: "{{contenidoId}}" },
      cuerpo: {
        marca: "kiden",
        categoria: "evento",
        titulo: "Rodada de fin de mes (ejemplo)",
        texto: "",
        enlace: "https://ejemplo.test/rodada",
        destacada: false,
        activa: true,
        publicarDesde: null,
        publicarHasta: null,
      },
    },
  ],
  [
    "Contenido",
    "Activar o desactivar",
    "PATCH",
    "/admin/contenidos/:id",
    ADMIN,
    { params: { id: "{{contenidoId}}" }, cuerpo: { activa: false } },
  ],
  [
    "Contenido",
    "Eliminar publicación",
    "DELETE",
    "/admin/contenidos/:id",
    ADMIN,
    { params: { id: "{{contenidoId}}" } },
  ],

  [
    "Importación de clientes",
    "Vista previa de un archivo",
    "POST",
    "/admin/importaciones/vista-previa",
    ADMIN,
    {
      query: { marca: "zontes" },
      archivo: true,
      descripcion:
        "Cuerpo: el archivo CSV o XLSX (Body → binary), máximo 5 MB y 5.000 filas, con columnas nombre y correo. No escribe nada.",
    },
  ],
  [
    "Importación de clientes",
    "Confirmar importación",
    "POST",
    "/admin/importaciones",
    ADMIN,
    {
      query: {
        marca: "zontes",
        archivo: "clientes.csv",
        idImportacion: "{{$guid}}",
      },
      archivo: true,
      descripcion:
        "Mismo archivo que la vista previa. Nunca crea cuentas ni administradores; vincula cuentas de cliente existentes con ese correo verificado. Repetir el idImportacion devuelve 200 con repetido: true.",
    },
  ],
  [
    "Importación de clientes",
    "Importaciones de los últimos 90 días",
    "GET",
    "/admin/importaciones",
    ADMIN,
    {},
  ],
  [
    "Importación de clientes",
    "Descargar el reporte",
    "GET",
    "/admin/importaciones/:id/reporte",
    ADMIN,
    { params: { id: "{{importacionId}}" }, query: { formato: "csv" } },
  ],
  [
    "Importación de clientes",
    "Importados pendientes de registro",
    "GET",
    "/admin/importados",
    ADMIN,
    { query: { marca: "zontes", limite: "20" } },
  ],

  [
    "Integración (CRM / facturación)",
    "Registrar evento desde un sistema externo",
    "POST",
    "/integracion/eventos",
    CLAVE,
    {
      cuerpo: {
        idExterno: "factura-000123",
        evento: "compra",
        marca: "zontes",
        correoCliente: "cliente.zontes@ejemplo.test",
        vence: "2027-10-04",
      },
      descripcion:
        "Autentica con X-Api-Key. Aplica la regla activa de la marca y evento; «vence» es obligatorio (DEC-18). Repetir el idExterno devuelve 200 con repetido: true; el origen queda como api:{sistema}.",
    },
  ],
];

const ACCESO = {
  [PUBLICO]: "Público, sin token.",
  [TOKEN]:
    "ID token de Firebase (Bearer) con correo verificado; aún sin perfil.",
  [CLIENTE]:
    "ID token de Firebase (Bearer). Rol cliente salvo GET/PATCH /me, que sirven a cualquier perfil activo.",
  [ADMIN]:
    "ID token de Firebase (Bearer) de un administrador activo; un cliente recibe 403.",
  [CLAVE]:
    "Cabecera X-Api-Key con una clave de integración (sin token de usuario).",
};

function peticion([, nombre, metodo, ruta, acceso, extra]) {
  const header = [];
  if (acceso === CLAVE)
    header.push({ key: "X-Api-Key", value: "{{claveIntegracion}}" });
  if (extra.cuerpo)
    header.push({ key: "Content-Type", value: "application/json" });
  if (extra.archivo) header.push({ key: "Content-Type", value: "text/csv" });
  const segmentos = ruta.split("/").filter(Boolean);
  const query = Object.entries(extra.query ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  const raw =
    `{{baseUrl}}${ruta}` +
    (query.length
      ? `?${query.map((q) => `${q.key}=${q.value}`).join("&")}`
      : "");
  return {
    name: nombre,
    request: {
      method: metodo,
      header,
      ...(acceso === TOKEN || acceso === CLIENTE || acceso === ADMIN
        ? {
            auth: {
              type: "bearer",
              bearer: [
                {
                  key: "token",
                  value:
                    acceso === ADMIN
                      ? "{{idTokenAdmin}}"
                      : "{{idTokenCliente}}",
                  type: "string",
                },
              ],
            },
          }
        : { auth: { type: "noauth" } }),
      url: {
        raw,
        host: ["{{baseUrl}}"],
        path: segmentos,
        ...(query.length ? { query } : {}),
        ...(extra.params
          ? {
              variable: Object.entries(extra.params).map(([key, value]) => ({
                key,
                value,
              })),
            }
          : {}),
      },
      ...(extra.cuerpo
        ? {
            body: {
              mode: "raw",
              raw: JSON.stringify(extra.cuerpo, null, 2),
              options: { raw: { language: "json" } },
            },
          }
        : {}),
      ...(extra.archivo ? { body: { mode: "file", file: { src: "" } } } : {}),
      description: [extra.descripcion, `Acceso: ${ACCESO[acceso]}`]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

const grupos = [...new Set(ENDPOINTS.map((e) => e[0]))];
const coleccion = {
  info: {
    name: "Fidelización Zontes / Kiden / NIU — API v1",
    description:
      "Colección de pruebas manuales de la API Express (F7-BE-02). Datos sintéticos (dominio ejemplo.test). " +
      "Obtén los ID tokens con «Autenticación → Iniciar sesión» usando tus cuentas de prueba; nunca guardes contraseñas ni tokens en la colección exportada. " +
      "Referencia completa: docs/API.md.",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "http://127.0.0.1:4000/api/v1" },
    { key: "firebaseApiKey", value: "" },
    { key: "idTokenCliente", value: "" },
    { key: "idTokenAdmin", value: "" },
    { key: "claveIntegracion", value: "" },
    { key: "beneficioId", value: "" },
    { key: "codigoCanje", value: "" },
    { key: "uidCliente", value: "" },
    { key: "uidAdmin", value: "" },
    { key: "contenidoId", value: "" },
    { key: "importacionId", value: "" },
  ],
  item: [
    {
      name: "Autenticación (Firebase)",
      description:
        "Firebase Auth emite el ID token (válido 1 hora). Completa correo y contraseña de una cuenta de prueba al enviar; " +
        "el script guarda el token en la variable indicada en el nombre. No exportes la colección con esos valores.",
      item: ["idTokenCliente", "idTokenAdmin"].map((variable) => ({
        name: `Iniciar sesión → ${variable}`,
        event: [
          {
            listen: "test",
            script: {
              type: "text/javascript",
              exec: [
                "const r = pm.response.json();",
                `if (r.idToken) pm.collectionVariables.set("${variable}", r.idToken);`,
              ],
            },
          },
        ],
        request: {
          method: "POST",
          header: [{ key: "Content-Type", value: "application/json" }],
          auth: { type: "noauth" },
          url: {
            raw: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={{firebaseApiKey}}",
            protocol: "https",
            host: ["identitytoolkit", "googleapis", "com"],
            path: ["v1", "accounts:signInWithPassword"],
            query: [{ key: "key", value: "{{firebaseApiKey}}" }],
          },
          body: {
            mode: "raw",
            raw: JSON.stringify(
              { email: "", password: "", returnSecureToken: true },
              null,
              2,
            ),
            options: { raw: { language: "json" } },
          },
        },
      })),
    },
    ...grupos.map((g) => ({
      name: g,
      item: ENDPOINTS.filter((e) => e[0] === g).map(peticion),
    })),
  ],
};

await mkdir("docs/postman", { recursive: true });
await writeFile(
  "docs/postman/fidelizacion.postman_collection.json",
  JSON.stringify(coleccion, null, 2) + "\n",
);
console.log(
  `Colección generada: ${ENDPOINTS.length} endpoints en ${grupos.length} grupos.`,
);
