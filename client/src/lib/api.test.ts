import { describe, expect, it, vi } from 'vitest';
import { createApiClient, TRANSPORT_ERROR, TRANSPORT_STATUS } from './api';
import type { DonorView } from './apiTypes';

const BASE_URL = 'https://api.test.invalid';

const DONOR: DonorView = {
  donorId: '11111111-1111-4111-8111-111111111111',
  handle: 'donor-one',
  bloodGroup: 'O-',
  geohash5: 'dr5ru',
  tz: 'America/New_York',
  optedIn: true,
  available: true,
  snoozeUntil: null,
  sharePhoneOnAccept: false,
  pushVerified: true,
  lastDonationAt: null,
  activePledge: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch, token: string | null = 'id-token-abc') {
  return createApiClient({ baseUrl: BASE_URL, getToken: async () => token, fetchImpl });
}

describe('ApiClient', () => {
  it('attaches the Firebase ID token as a bearer header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, DONOR));
    const result = await clientWith(fetchImpl).getMe();

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/donors/me`);
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer id-token-abc');
  });

  it('omits the Authorization header when there is no token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, DONOR));
    await clientWith(fetchImpl, null).getMe();

    const headers = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns the parsed body on a happy GET', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, DONOR));
    const result = await clientWith(fetchImpl).getMe();

    expect(result).toEqual({ ok: true, status: 200, data: DONOR });
  });

  it('passes a 401 through as an error result instead of throwing', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    const result = await clientWith(fetchImpl).getMe();

    expect(result).toEqual({ ok: false, status: 401, error: { error: 'unauthorized' } });
  });

  it('keeps the per-endpoint extras on a 409 error body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(409, {
        error: 'duplicate_request',
        existingRequestId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    const result = await clientWith(fetchImpl).createRequest({
      bloodGroup: 'B+',
      unitsNeeded: 2,
      urgency: 'critical',
      hospitalId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        error: 'duplicate_request',
        existingRequestId: '22222222-2222-4222-8222-222222222222',
      },
    });
  });

  it('reports 400 validation issues without losing their shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(400, {
        error: 'invalid_body',
        issues: [{ path: 'etaBucket', message: 'Invalid option' }],
      }),
    );
    const result = await clientWith(fetchImpl).acceptAlert('44444444-4444-4444-8444-444444444444', {
      etaBucket: 'le_1h',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual([{ path: 'etaBucket', message: 'Invalid option' }]);
  });

  it('resolves a 204 decline with a null body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const result = await clientWith(fetchImpl).declineAlert('55555555-5555-4555-8555-555555555555');

    expect(result).toEqual({ ok: true, status: 204, data: null });
  });

  it('turns a transport failure into an error result with status 0', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await clientWith(fetchImpl).listMyRequests();

    expect(result).toEqual({
      ok: false,
      status: TRANSPORT_STATUS,
      error: { error: TRANSPORT_ERROR },
    });
  });

  it('sends a JSON body with a content type on writes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(202, { verificationSent: true }));
    await clientWith(fetchImpl).setPushToken('fcm-token-xyz');

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/donors/me/push-token`);
    expect(init?.method).toBe('PUT');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ token: 'fcm-token-xyz' }));
  });
});
