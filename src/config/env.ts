import { z } from "zod";

const originList = z
  .string()
  .default("http://localhost:3000")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z
          .url()
          .refine((url) => URL.canParse(url) && new URL(url).origin === url, {
            message:
              "Cada origen debe ser protocolo://host[:puerto], sin ruta.",
          }),
      )
      .min(1),
  );

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  CORS_ALLOWED_ORIGINS: originList,
  FIREBASE_PROJECT_ID: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  /** Fuente de clientes existentes (DEC-04). Sólo hay doble sintético en F1. */
  LEGACY_SOURCE: z.enum(["sintetica"]).default("sintetica"),
  /** Prefijo de colecciones Firestore; aísla pruebas de integración. */
  FIRESTORE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_]*$/, "Sólo minúsculas, dígitos y _.")
    .default(""),
  /** Saltos de proxy de confianza para la IP real (Render: 1). 0 = ninguno. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Peticiones por minuto y por IP a la API (F7-BE-01). */
  LIMITE_POR_MINUTO: z.coerce.number().int().min(10).max(100_000).default(300),
  /** Claves de integración (DEC-05): «sistema:sha256hex» separadas por coma. */
  INTEGRACION_CLAVES: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .regex(
            /^[a-z0-9-]{2,32}:[0-9a-f]{64}$/,
            "Formato sistema:sha256 (64 hex) por clave.",
          ),
      ),
    ),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  corsAllowedOrigins: string[];
  /** Ausente: el backend arranca, pero las rutas protegidas responden 503. */
  firebaseProjectId: string | undefined;
  legacySource: "sintetica";
  firestorePrefix: string;
  /** hash SHA-256 hex → sistema. */
  integracionClaves: Map<string, string>;
  trustProxy: number;
  limitePorMinuto: number;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuración de entorno inválida: ${issues}`);
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    corsAllowedOrigins: value.CORS_ALLOWED_ORIGINS,
    firebaseProjectId: value.FIREBASE_PROJECT_ID,
    legacySource: value.LEGACY_SOURCE,
    firestorePrefix: value.FIRESTORE_PREFIX,
    trustProxy: value.TRUST_PROXY,
    limitePorMinuto: value.LIMITE_POR_MINUTO,
    integracionClaves: new Map(
      value.INTEGRACION_CLAVES.map((entrada) => {
        const [sistema, hash] = entrada.split(":") as [string, string];
        return [hash, sistema];
      }),
    ),
  };
}
