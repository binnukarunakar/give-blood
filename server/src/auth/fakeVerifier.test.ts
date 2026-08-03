import { describe, expect, test } from 'vitest';
import { FakeTokenVerifier } from './fakeVerifier.js';
import { AuthError, type AuthUser } from './verifier.js';

const WITH_PHONE: AuthUser = { uid: 'donor-1', phone: '+15555550100' };
const NO_PHONE: AuthUser = { uid: 'requester-1', phone: null };

function verifier(): FakeTokenVerifier {
  return new FakeTokenVerifier(
    new Map([
      ['tok-donor', WITH_PHONE],
      ['tok-requester', NO_PHONE],
    ]),
  );
}

describe('FakeTokenVerifier', () => {
  test('resolves a mapped token to its user (phone present)', async () => {
    await expect(verifier().verify('tok-donor')).resolves.toEqual(WITH_PHONE);
  });

  test('resolves a mapped token whose user has a null phone', async () => {
    await expect(verifier().verify('tok-requester')).resolves.toEqual(NO_PHONE);
  });

  test('rejects an unknown token with AuthError', async () => {
    await expect(verifier().verify('nope')).rejects.toBeInstanceOf(AuthError);
  });

  test('an empty map rejects everything', async () => {
    const empty = new FakeTokenVerifier(new Map());
    await expect(empty.verify('anything')).rejects.toBeInstanceOf(AuthError);
  });
});
