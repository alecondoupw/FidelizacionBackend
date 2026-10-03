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
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  corsAllowedOrigins: string[];
  /** Ausente hasta DEC-02: el backend arranca sin Firebase. */
  firebaseProjectId: string | undefined;
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
  };
}
