// Push delivery seam for blood alerts.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ NO PHI ON THE WIRE (docs/PROTOCOL.md §3, canonical).                       │
// │                                                                            │
// │ An alert push carries an OPAQUE POINTER and NOTHING ELSE. It NEVER carries │
// │ blood group, hospital name, address, distance, units, urgency, requester   │
// │ identity, or any other request content. Lock screens, notification logs,   │
// │ and FCM infrastructure never see request detail — all of it is fetched     │
// │ on tap behind donor auth via GET /alerts/{alertId}.                        │
// │                                                                            │
// │ The visible strings are FIXED and GENERIC (below). The only request-       │
// │ specific value on the wire is the opaque dispatch id (`alertId`).          │
// └──────────────────────────────────────────────────────────────────────────┘

/** Fixed, generic notification title — carries no request content. */
export const ALERT_NOTIFICATION_TITLE = 'Blood needed near you';

/** Fixed, generic notification body — carries no request content. */
export const ALERT_NOTIFICATION_BODY = 'Tap to view — this request expires soon';

/**
 * The complete alert push payload. Deliberately minimal: a discriminator and an
 * opaque pointer. Adding any request field here would leak PHI to the lock
 * screen and FCM logs — do not extend this interface with request content.
 */
export interface AlertPushPayload {
  type: 'BLOOD_ALERT';
  /** Opaque dispatch id; the ONLY request-specific value that crosses the wire. */
  alertId: string;
}

/**
 * The push-token verification handshake payload (GB-8). Carries only its own
 * discriminator — no request content, no id. Sent to a freshly-set token so the
 * donor can ack delivery and enter the matching pool (ARCHITECTURE: alertable =
 * push-verified).
 */
export interface VerifyPushPayload {
  type: 'VERIFY_PUSH';
}

/** Fixed, generic verification-probe title — carries no request content. */
export const VERIFY_PUSH_TITLE = 'Confirm your alerts';

/** Fixed, generic verification-probe body — carries no request content. */
export const VERIFY_PUSH_BODY = 'Tap to verify this device can receive donor alerts';

/** Fixed, generic closure-notice title — carries no request content. */
export const REQUEST_CLOSED_TITLE = 'Request update';

/** Fixed, generic closure-notice body — carries no request content. */
export const REQUEST_CLOSED_BODY =
  'A request you pledged to has been closed — tap to view';

/**
 * Closure notice (GB-12): sent to a still-active pledged donor when their
 * request reaches a terminal state. As opaque as the alert payload — the
 * alertId is the donor's own dispatch id, and fetch-on-tap already renders the
 * closed state (PROTOCOL.md §3), so no request content crosses the wire.
 */
export interface RequestClosedPushPayload {
  type: 'REQUEST_CLOSED';
  /** The donor's own dispatch id; the ONLY request-specific value on the wire. */
  alertId: string;
}

/**
 * Any payload the push transport may carry: a blood alert, a verification
 * probe, or a closure notice.
 */
export type PushPayload =
  | AlertPushPayload
  | VerifyPushPayload
  | RequestClosedPushPayload;

/**
 * Outcome of a single send:
 *  - 'ok'         delivered / accepted by the provider
 *  - 'dead_token' the token is permanently invalid (unregistered / not found);
 *                 the caller clears the donor's push credentials
 *  - 'error'      transient or unknown failure; the caller leaves the donor as-is
 */
export type PushResult = 'ok' | 'dead_token' | 'error';

/** Injectable seam: real FCM sender in prod, fake in tests (see fakePushSender.ts). */
export interface PushSender {
  send(token: string, payload: PushPayload): Promise<PushResult>;
}
