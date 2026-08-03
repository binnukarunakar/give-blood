// Real push sender: Firebase Cloud Messaging HTTP v1.
//
// Auth uses google-auth-library's GoogleAuth with the firebase.messaging scope,
// resolved from Application Default Credentials (ADC). NO key material lives in
// code or config — GoogleAuth reads GOOGLE_APPLICATION_CREDENTIALS / the
// workload identity of the runtime. The access token is short-lived and cached
// by the library.
//
// send() NEVER throws: dispatch fans out to many donors and one bad token must
// not abort the batch. Every failure path returns a PushResult and (optionally)
// logs via an injected logger. No test hits the network — correctness here comes
// from the types plus the PushSender contract exercised through FakePushSender.
import { GoogleAuth } from 'google-auth-library';
import { assertUnreachable } from '../domain/requestFsm.js';
import {
  ALERT_NOTIFICATION_BODY,
  ALERT_NOTIFICATION_TITLE,
  type PushPayload,
  type PushResult,
  type PushSender,
  REQUEST_CLOSED_BODY,
  REQUEST_CLOSED_TITLE,
  VERIFY_PUSH_BODY,
  VERIFY_PUSH_TITLE,
} from './pushSender.js';

/** OAuth scope required to call FCM HTTP v1. */
const FIREBASE_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** FCM error code (in the v1 error `details`) that means the token is permanently invalid. */
const UNREGISTERED = 'UNREGISTERED';

/** Structured, side-effect-free logger. Never receives the raw token (avoid leaking delivery addresses). */
export type PushLogger = (entry: {
  level: 'warn' | 'error';
  msg: string;
  status?: number;
  code?: string;
}) => void;

export interface FcmPushSenderOptions {
  /** Firebase / GCP project id — forms the FCM v1 endpoint path. */
  projectId: string;
  /** Optional logger for delivery failures. */
  logger?: PushLogger;
  /** Injectable auth (defaults to ADC-backed GoogleAuth); lets a harness supply a stub. */
  auth?: GoogleAuth;
}

/** Reads the FCM v1 messaging error code out of an error response body without `any`. */
function extractFcmErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return null;
  const details = (error as Record<string, unknown>).details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null) continue;
    const code = (detail as Record<string, unknown>).errorCode;
    if (typeof code === 'string') return code;
  }
  return null;
}

/**
 * An FCM v1 `Message` resource, exactly as it goes on the wire. `data` values
 * MUST be strings (FCM rejects anything else), which is why the payload's
 * discriminator — not the payload object — is what crosses.
 */
export interface FcmMessage {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
  };
}

function fcmMessage(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
): FcmMessage {
  return { message: { token, notification: { title, body }, data } };
}

/**
 * Pure message builder — the whole request body, no network, no auth. Extracted
 * so the title/body mapping is unit-testable (GB-17); `send` only adds transport.
 *
 * The visible strings are chosen BY PAYLOAD TYPE: a closure notice or a
 * verification probe must never wear the blood-alert title (GB-12 finding). The
 * switch is exhaustive — a new PushPayload member fails to compile here rather
 * than silently inheriting the wrong copy.
 *
 * `alert_id` is carried only by the payloads that HAVE an alertId; the
 * verification probe has no request context at all, so its data object is the
 * discriminator alone. Nothing here is request content (PROTOCOL.md §3).
 */
export function buildFcmMessage(token: string, payload: PushPayload): FcmMessage {
  switch (payload.type) {
    case 'BLOOD_ALERT':
      return fcmMessage(token, ALERT_NOTIFICATION_TITLE, ALERT_NOTIFICATION_BODY, {
        type: payload.type,
        alert_id: payload.alertId,
      });
    case 'REQUEST_CLOSED':
      return fcmMessage(token, REQUEST_CLOSED_TITLE, REQUEST_CLOSED_BODY, {
        type: payload.type,
        alert_id: payload.alertId,
      });
    case 'VERIFY_PUSH':
      return fcmMessage(token, VERIFY_PUSH_TITLE, VERIFY_PUSH_BODY, {
        type: payload.type,
      });
    default:
      return assertUnreachable(payload);
  }
}

export class FcmPushSender implements PushSender {
  private readonly auth: GoogleAuth;
  private readonly endpoint: string;
  private readonly logger?: PushLogger;

  constructor(options: FcmPushSenderOptions) {
    this.auth = options.auth ?? new GoogleAuth({ scopes: [FIREBASE_MESSAGING_SCOPE] });
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${options.projectId}/messages:send`;
    this.logger = options.logger;
  }

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    try {
      const accessToken = await this.auth.getAccessToken();
      if (accessToken === null || accessToken === undefined) {
        this.logger?.({ level: 'error', msg: 'fcm: ADC returned no access token' });
        return 'error';
      }
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildFcmMessage(token, payload)),
      });
      if (res.ok) return 'ok';
      return await this.classifyFailure(res);
    } catch (err) {
      // Network error, DNS failure, ADC error — transient/unknown. Never rethrow.
      this.logger?.({
        level: 'error',
        msg: `fcm: send threw (${err instanceof Error ? err.name : 'unknown'})`,
      });
      return 'error';
    }
  }

  /** Maps a non-2xx FCM response to a PushResult. 404/410 or UNREGISTERED → dead token. */
  private async classifyFailure(res: Response): Promise<PushResult> {
    if (res.status === 404 || res.status === 410) {
      this.logger?.({ level: 'warn', msg: 'fcm: dead token', status: res.status });
      return 'dead_token';
    }
    let code: string | null = null;
    try {
      code = extractFcmErrorCode(await res.json());
    } catch {
      code = null;
    }
    if (code === UNREGISTERED) {
      this.logger?.({ level: 'warn', msg: 'fcm: dead token', status: res.status, code });
      return 'dead_token';
    }
    this.logger?.({
      level: 'error',
      msg: 'fcm: send failed',
      status: res.status,
      code: code ?? undefined,
    });
    return 'error';
  }
}
