// Typed fetch client for the give-blood API.
//
// Contract: no method ever throws on an HTTP status. Every call returns a
// discriminated ApiResult — `{ ok: true, status, data }` or
// `{ ok: false, status, error }` — so a caller must handle the failure branch
// to reach the data. Transport failures (offline, DNS) surface the same way
// with status 0, which keeps every UI error state on one code path.
//
// The Firebase ID token is pulled per request through an injectable
// `getToken`, so tests need no Firebase and a token refresh is never cached.
import { apiBaseUrl } from '../env';
import { currentIdToken } from './firebase';
import type {
  AcceptAlertInput,
  AlertDetail,
  CreateRequestInput,
  DonationReported,
  DonorPatchInput,
  DonorRegistration,
  DonorView,
  PledgeAccepted,
  PledgeDonated,
  PledgeReleased,
  PushTokenAccepted,
  PushVerified,
  RegisterDonorInput,
  ReportDonationInput,
  RequestCancelled,
  RequestCreated,
  RequestDetail,
  RequestState,
  RequestSummary,
} from './apiTypes';

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Union of every error body the server emits. `error` is always present; the
 * rest are per-endpoint extras (invalid_body issues, duplicate_request's
 * existingRequestId, the 409 state echoes).
 */
export interface ApiErrorBody {
  error: string;
  issues?: ValidationIssue[];
  existingRequestId?: string;
  requestState?: RequestState;
  response?: string;
  state?: string;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiErrorBody };

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** status 0 = no HTTP response at all (offline, DNS, aborted). */
const TRANSPORT_STATUS = 0;
const TRANSPORT_ERROR = 'network_error';
const UNREADABLE_ERROR = 'invalid_response';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrow an unknown parsed body to ApiErrorBody, never trusting the server blindly. */
function toErrorBody(value: unknown): ApiErrorBody {
  if (!isRecord(value) || typeof value.error !== 'string') {
    return { error: UNREADABLE_ERROR };
  }
  const body: ApiErrorBody = { error: value.error };
  if (Array.isArray(value.issues)) body.issues = value.issues as ValidationIssue[];
  if (typeof value.existingRequestId === 'string') body.existingRequestId = value.existingRequestId;
  if (typeof value.requestState === 'string') body.requestState = value.requestState as RequestState;
  if (typeof value.response === 'string') body.response = value.response;
  if (typeof value.state === 'string') body.state = value.state;
  return body;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async send(method: Method, path: string, body?: unknown): Promise<Response | null> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      // getToken is inside the try on purpose: a token refresh is a network
      // call and Firebase init can throw on a misconfigured build. Either way
      // the caller must get an error RESULT, never a rejected promise — the
      // "no method ever throws" contract is what lets every screen render an
      // error state instead of hanging on a loading spinner.
      const token = await this.getToken();
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return null;
    }
  }

  /** JSON-bodied call. A 4xx/5xx becomes an error result, never an exception. */
  private async request<T>(method: Method, path: string, body?: unknown): Promise<ApiResult<T>> {
    const response = await this.send(method, path, body);
    if (response === null) {
      return { ok: false, status: TRANSPORT_STATUS, error: { error: TRANSPORT_ERROR } };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // Unparseable body on either branch — the caller gets one shape.
      return { ok: false, status: response.status, error: { error: UNREADABLE_ERROR } };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: toErrorBody(parsed) };
    }
    return { ok: true, status: response.status, data: parsed as T };
  }

  /** Call whose success case has no body (204). */
  private async requestEmpty(method: Method, path: string): Promise<ApiResult<null>> {
    const response = await this.send(method, path);
    if (response === null) {
      return { ok: false, status: TRANSPORT_STATUS, error: { error: TRANSPORT_ERROR } };
    }
    if (response.ok) {
      return { ok: true, status: response.status, data: null };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, status: response.status, error: { error: UNREADABLE_ERROR } };
    }
    return { ok: false, status: response.status, error: toErrorBody(parsed) };
  }

  // ── Donor ──────────────────────────────────────────────────────────────────

  registerDonor(input: RegisterDonorInput): Promise<ApiResult<DonorRegistration>> {
    return this.request<DonorRegistration>('POST', '/donors', input);
  }

  getMe(): Promise<ApiResult<DonorView>> {
    return this.request<DonorView>('GET', '/donors/me');
  }

  updateMe(patch: DonorPatchInput): Promise<ApiResult<DonorView>> {
    return this.request<DonorView>('PATCH', '/donors/me', patch);
  }

  setPushToken(token: string): Promise<ApiResult<PushTokenAccepted>> {
    return this.request<PushTokenAccepted>('PUT', '/donors/me/push-token', { token });
  }

  confirmPushVerified(): Promise<ApiResult<PushVerified>> {
    return this.request<PushVerified>('POST', '/donors/me/push-verified');
  }

  reportDonation(input: ReportDonationInput = {}): Promise<ApiResult<DonationReported>> {
    return this.request<DonationReported>('POST', '/donors/me/donations', input);
  }

  // ── Requester ──────────────────────────────────────────────────────────────

  createRequest(input: CreateRequestInput): Promise<ApiResult<RequestCreated>> {
    return this.request<RequestCreated>('POST', '/requests', input);
  }

  listMyRequests(): Promise<ApiResult<RequestSummary[]>> {
    return this.request<RequestSummary[]>('GET', '/requests/mine');
  }

  getRequest(requestId: string): Promise<ApiResult<RequestDetail>> {
    return this.request<RequestDetail>('GET', `/requests/${encodeURIComponent(requestId)}`);
  }

  cancelRequest(requestId: string): Promise<ApiResult<RequestCancelled>> {
    return this.request<RequestCancelled>(
      'POST',
      `/requests/${encodeURIComponent(requestId)}/cancel`,
    );
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────

  getAlert(alertId: string): Promise<ApiResult<AlertDetail>> {
    return this.request<AlertDetail>('GET', `/alerts/${encodeURIComponent(alertId)}`);
  }

  acceptAlert(alertId: string, input: AcceptAlertInput): Promise<ApiResult<PledgeAccepted>> {
    return this.request<PledgeAccepted>(
      'POST',
      `/alerts/${encodeURIComponent(alertId)}/accept`,
      input,
    );
  }

  /** 204 on success — resolves with `data: null`. */
  declineAlert(alertId: string): Promise<ApiResult<null>> {
    return this.requestEmpty('POST', `/alerts/${encodeURIComponent(alertId)}/decline`);
  }

  // ── Pledges ────────────────────────────────────────────────────────────────

  markPledgeDonated(pledgeId: string): Promise<ApiResult<PledgeDonated>> {
    return this.request<PledgeDonated>('POST', `/pledges/${encodeURIComponent(pledgeId)}/donated`);
  }

  markPledgeNoShow(pledgeId: string): Promise<ApiResult<PledgeReleased>> {
    return this.request<PledgeReleased>('POST', `/pledges/${encodeURIComponent(pledgeId)}/no-show`);
  }

  withdrawPledge(pledgeId: string): Promise<ApiResult<PledgeReleased>> {
    return this.request<PledgeReleased>('POST', `/pledges/${encodeURIComponent(pledgeId)}/withdraw`);
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

/**
 * Token source for the app-wide client. Defaults to the signed-in Firebase
 * user, which is the only source production ever uses. The local-demo
 * entrypoint (src/demo, build-time flag only) swaps it for a fake persona token
 * so the demo needs no Firebase project; no production module calls the setter,
 * and a build made without VITE_DEMO_MODE=1 contains no caller at all.
 */
let appTokenSource: () => Promise<string | null> = currentIdToken;

export function setAppTokenSource(source: () => Promise<string | null>): void {
  appTokenSource = source;
}

/** App-wide client: base URL from env, bearer token from the current source. */
export const api = createApiClient({
  baseUrl: apiBaseUrl(),
  getToken: () => appTokenSource(),
});

export { TRANSPORT_ERROR, TRANSPORT_STATUS, UNREADABLE_ERROR };
