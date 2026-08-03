// Typed application config, parsed once from the environment at boot.
//
// Canonical env surface: docs/ARCHITECTURE.md "Env-var surface" (server side).
// This module is the ONLY reader of process.env in the codebase — every other
// module takes a typed `Config` by injection. `loadConfig` fails fast: on any
// missing/invalid var it throws a single aggregated error naming every problem,
// so a misconfigured deploy dies at startup, never at request time.
import { z } from 'zod';

/** Pino log levels this service exposes (trace..error). Default: info. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Minimum bytes of entropy for the Cloud Scheduler shared secret. */
const SWEEP_SECRET_MIN_LENGTH = 16;
const DEFAULT_PORT = 8080;

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, 'is required'),
  FIREBASE_PROJECT_ID: z.string().min(1, 'is required'),
  SWEEP_SHARED_SECRET: z
    .string()
    .min(SWEEP_SECRET_MIN_LENGTH, `must be at least ${SWEEP_SECRET_MIN_LENGTH} characters`),
  APP_BASE_URL: z.url('must be a valid URL'),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /**
   * Where the built client bundle lives, relative to the server package (or
   * absolute). Optional: unset means the entrypoint looks in the default
   * location, and an API-only deploy with no build there simply serves no
   * static files. Never required for the API to boot.
   */
  STATIC_ROOT: z.string().min(1).optional(),
});

export type Config = z.infer<typeof configSchema>;

/** Thrown by `loadConfig` when the environment is missing or invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** One human-readable line per invalid var: `NAME: message`. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Parse the given environment into a typed `Config`. Zod collects every issue
 * before failing, so the thrown `ConfigError` lists all offending vars at once.
 * Unknown env keys are ignored.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      `Invalid environment configuration:\n${formatIssues(result.error)}`,
    );
  }
  return result.data;
}
