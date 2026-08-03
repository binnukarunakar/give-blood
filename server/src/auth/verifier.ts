// Firebase ID-token verification (server-authoritative auth).
//
// Canonical: docs/ARCHITECTURE.md "Identity" — donors AND hospital requesters
// log in with Firebase Auth (phone OTP); the server verifies ID tokens as JWTs
// against Google's cached securetoken JWKS. Correctness comes from `jose`; this
// module only wires issuer/audience from config and normalises the claims we
// use (uid, phone_number).
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** The authenticated principal extracted from a verified ID token. */
export interface AuthUser {
  /** Firebase uid — the token `sub` claim. */
  uid: string;
  /** E.164 phone from the `phone_number` claim; null when absent. */
  phone: string | null;
}

/** Injectable seam: real Firebase verifier in prod, fake in tests (see fakeVerifier.ts). */
export interface TokenVerifier {
  verify(idToken: string): Promise<AuthUser>;
}

/** Thrown on any token-verification failure (bad signature, exp, iss/aud, malformed). */
export class AuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
  }
}

// Fixed protocol constant (Google's securetoken JWKS endpoint) — not config.
const SECURETOKEN_JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);

// Firebase ID tokens are always issued under this host, suffixed by project id.
const FIREBASE_ISSUER_PREFIX = 'https://securetoken.google.com/';

// Created once at module load; jose caches the fetched keys internally and
// refreshes them on rotation, so every verifier shares one warm key set.
const jwks = createRemoteJWKSet(SECURETOKEN_JWKS_URL);

/** Verifies real Firebase ID tokens via jose against the securetoken JWKS. */
export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(firebaseProjectId: string) {
    this.issuer = `${FIREBASE_ISSUER_PREFIX}${firebaseProjectId}`;
    this.audience = firebaseProjectId;
  }

  async verify(idToken: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      const uid = payload.sub;
      if (typeof uid !== 'string' || uid.length === 0) {
        throw new AuthError('verified token has no sub (uid) claim');
      }
      const phoneClaim = payload.phone_number;
      const phone = typeof phoneClaim === 'string' ? phoneClaim : null;
      return { uid, phone };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('Firebase ID token verification failed', { cause: err });
    }
  }
}
