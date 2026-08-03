// Deterministic TokenVerifier for tests. Lives in src/ (not a *.test.ts helper)
// because route tests across GB-8+ inject it into buildApp to exercise
// authenticated endpoints without touching Google. Test-only by convention —
// index.ts wires the real FirebaseTokenVerifier.
import { AuthError, type AuthUser, type TokenVerifier } from './verifier.js';

/** Resolves tokens from an injected token→user map; unknown tokens throw AuthError. */
export class FakeTokenVerifier implements TokenVerifier {
  constructor(private readonly tokens: Map<string, AuthUser>) {}

  async verify(idToken: string): Promise<AuthUser> {
    const user = this.tokens.get(idToken);
    if (user === undefined) {
      throw new AuthError('unknown token');
    }
    return user;
  }
}
