// The demo-only HTTP surface: GET /demo/pushes, GET /demo/state,
// POST /demo/sweep, POST /demo/reset.
//
// Deliberately NOT part of lib/api.ts. Those endpoints exist only on the
// server's demo entrypoint, so keeping them here means the real client keeps
// exactly the surface a production build ships.
//
// Same result contract as lib/api.ts: nothing throws, every call returns a
// discriminated result, so each panel renders an error state instead of
// hanging. Bodies are narrowed field by field because a demo server answering
// with something unexpected must not crash the page.
import { apiBaseUrl } from '../env';

export interface DemoPush {
  id: string;
  /** Donor handle the push was addressed to. */
  toHandle: string;
  /** The push object exactly as the sender recorded it. Rendered verbatim. */
  payload: unknown;
  sentAt: string;
}

/**
 * The counters the persona strip reports after a sweep. Field names mirror
 * server/src/sweep/sweep.ts SweepReport; the rest of that report (pledges
 * released, closure notices) is visible in the push inbox instead.
 */
export interface DemoSweepReport {
  opened: number;
  dispatched: number;
  tiersAdvanced: number;
  expired: number;
}

export type DemoResult<T> = { ok: true; data: T } | { ok: false; error: string };

const NO_SERVER = 'The demo server did not answer. Start it and try again.';

function failed(path: string, status: number): string {
  return `The demo server answered ${String(status)} for ${path}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A counter the server did not send reads as 0 — nothing happened for it. */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The push types that carry an alert pointer (docs/PROTOCOL.md §3). */
const OPENABLE_TYPES = ['BLOOD_ALERT', 'REQUEST_CLOSED'];

export function pushType(payload: unknown): string {
  return isRecord(payload) ? readString(payload.type, 'UNKNOWN') : 'UNKNOWN';
}

/**
 * The opaque pointer, or null when this payload carries none (VERIFY_PUSH).
 * Both spellings are accepted: the server's PushPayload calls it `alertId`, the
 * FCM data block on the wire calls it `alert_id` (docs/PROTOCOL.md §3).
 */
export function pushAlertId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (!OPENABLE_TYPES.includes(pushType(payload))) return null;
  const id = typeof payload.alertId === 'string' ? payload.alertId : payload.alert_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function toPushes(body: unknown): DemoPush[] {
  if (!isRecord(body) || !Array.isArray(body.pushes)) return [];
  return body.pushes.filter(isRecord).map((push, index) => ({
    id: readString(push.id, `push-${String(index)}`),
    toHandle: readString(push.toHandle, 'unknown'),
    payload: push.payload,
    sentAt: readString(push.sentAt, ''),
  }));
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<DemoResult<unknown>> {
  let response: Response;
  try {
    response = await globalThis.fetch(`${apiBaseUrl()}${path}`, {
      method,
      // Content-Type only with a body: Fastify rejects an empty JSON body.
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: NO_SERVER };
  }
  if (!response.ok) return { ok: false, error: failed(path, response.status) };
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, error: `The demo server sent an unreadable body for ${path}.` };
  }
}

/** Every simulated notification the server has sent, in server order. */
export async function fetchDemoPushes(): Promise<DemoResult<DemoPush[]>> {
  const result = await call('GET', '/demo/pushes');
  return result.ok ? { ok: true, data: toPushes(result.data) } : result;
}

/**
 * The seeded hospital's id, for prefilling the new-request form. The server
 * prints it in its startup banner and serves it here (docs/DEMO.md § 3) — but a
 * banner in a terminal is not available to whoever is clicking the browser, and
 * a uuid is not a thing anyone types from memory.
 *
 * Fails soft: no server, an unexpected body, anything at all, and the field is
 * simply left empty for the operator-supplied id it asks for in production.
 */
export async function fetchDemoHospitalId(): Promise<DemoResult<string>> {
  const result = await call('GET', '/demo/state');
  if (!result.ok) return result;
  const body = isRecord(result.data) ? result.data : {};
  const hospital = isRecord(body.hospital) ? body.hospital : {};
  const hospitalId = typeof hospital.hospitalId === 'string' ? hospital.hospitalId : '';
  return hospitalId === ''
    ? { ok: false, error: 'The demo server sent no hospital id.' }
    : { ok: true, data: hospitalId };
}

/** The request states the server will still move — the ones worth expiring. */
const OPEN_STATES = ['open', 'alerting', 'partially_pledged', 'covered'];

/**
 * The oldest request the sweep would still act on, or null. Drives the Expire
 * lever's enabled state: there is no point offering to move a deadline that
 * has already passed or been cancelled.
 */
export async function fetchDemoOpenRequestId(): Promise<DemoResult<string | null>> {
  const result = await call('GET', '/demo/state');
  if (!result.ok) return result;
  const body = isRecord(result.data) ? result.data : {};
  const rows = Array.isArray(body.requests) ? body.requests.filter(isRecord) : [];
  const open = rows.find((row) => OPEN_STATES.includes(readString(row.state, '')));
  const requestId = open === undefined ? '' : readString(open.requestId, '');
  return { ok: true, data: requestId === '' ? null : requestId };
}

/**
 * Backdate one request's TTL. The server writes no state here — the NEXT sweep
 * expires it through the real code path (server/src/demo/demoRoutes.ts), which
 * is why the strip's status line sends the operator to the Sweep button.
 */
export function expireDemoRequest(requestId: string): Promise<DemoResult<unknown>> {
  return call('POST', '/demo/expire', { requestId });
}

function toSweepReport(body: unknown): DemoSweepReport {
  const record = isRecord(body) ? body : {};
  return {
    opened: readCount(record.opened),
    dispatched: readCount(record.dispatched),
    tiersAdvanced: readCount(record.tiersAdvanced),
    expired: readCount(record.expired),
  };
}

/** Fire one sweep by hand and return its counters for the strip's status line. */
export async function runDemoSweep(): Promise<DemoResult<DemoSweepReport>> {
  const result = await call('POST', '/demo/sweep');
  return result.ok ? { ok: true, data: toSweepReport(result.data) } : result;
}

/** Reseed the in-memory database and clear the recorded pushes. */
export function resetDemoData(): Promise<DemoResult<unknown>> {
  return call('POST', '/demo/reset');
}
