// Build-time env access. Values are read lazily so a missing variable fails at
// the first real use with the variable NAME (never a value) in the message —
// importing a module must never throw. Canonical list: docs/ARCHITECTURE.md
// § "Env-var surface"; the same names live in .env.example.

export type ClientEnvName =
  | 'VITE_FIREBASE_API_KEY'
  | 'VITE_FIREBASE_AUTH_DOMAIN'
  | 'VITE_FIREBASE_PROJECT_ID'
  | 'VITE_FIREBASE_APP_ID'
  | 'VITE_FIREBASE_MESSAGING_SENDER_ID'
  | 'VITE_FCM_VAPID_PUBLIC_KEY'
  | 'VITE_MAPS_BROWSER_KEY'
  | 'VITE_API_BASE_URL';

/** Raw read — empty string is treated as unset. */
export function readEnv(name: ClientEnvName): string | undefined {
  const value = import.meta.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Read or throw. The message names the missing variable and nothing else. */
export function requireEnv(name: ClientEnvName): string {
  const value = readEnv(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

export function firebaseConfig(): FirebaseWebConfig {
  return {
    apiKey: requireEnv('VITE_FIREBASE_API_KEY'),
    authDomain: requireEnv('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: requireEnv('VITE_FIREBASE_PROJECT_ID'),
    appId: requireEnv('VITE_FIREBASE_APP_ID'),
    messagingSenderId: requireEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  };
}

export function vapidPublicKey(): string {
  return requireEnv('VITE_FCM_VAPID_PUBLIC_KEY');
}

export function mapsBrowserKey(): string {
  return requireEnv('VITE_MAPS_BROWSER_KEY');
}

/**
 * API origin. Unset means same-origin: the server serves this bundle in
 * production (docs/ARCHITECTURE.md — one container), so a relative base is the
 * correct default rather than a baked-in host.
 */
export function apiBaseUrl(): string {
  return readEnv('VITE_API_BASE_URL') ?? '';
}
