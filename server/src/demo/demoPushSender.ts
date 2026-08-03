// The demo's push transport: an in-memory inbox instead of FCM (GB-24).
//
// DEMO ONLY — never imported by production code. Production wires FcmPushSender
// in src/index.ts; this class exists so the browser demo can SHOW what a real
// push carries.
//
// The payload is recorded VERBATIM and is never enriched. That is the whole
// point of the inbox: docs/PROTOCOL.md §3 says an alert push carries a fixed
// generic title/body plus an opaque alertId and NOTHING about the request —
// adding blood group, hospital or distance here would misrepresent the
// contract the demo is supposed to demonstrate.
import type { PushPayload, PushResult, PushSender } from '../push/pushSender.js';

/** One recorded push, in send order — the shape GET /demo/pushes returns. */
export interface DemoPush {
  /** Stable per-process id; the demo UI keys its list on it. */
  id: string;
  /** The recipient donor's handle. The push token itself is never exposed. */
  toHandle: string;
  /** The opaque push object, exactly as the sender received it. */
  payload: PushPayload;
  sentAt: string;
}

/** Push token → donor handle. Injected so this class knows nothing about the seed. */
export type HandleResolver = (pushToken: string) => string;

/**
 * Records every send and always reports success. No scripted failures: the
 * demo's job is to make the happy path visible, and the dead-token path is
 * already covered by the unit suites.
 */
export class DemoPushSender implements PushSender {
  private readonly pushes: DemoPush[] = [];
  private nextId = 1;

  constructor(private readonly resolveHandle: HandleResolver) {}

  send(token: string, payload: PushPayload): Promise<PushResult> {
    this.pushes.push({
      id: `demo-push-${this.nextId}`,
      toHandle: this.resolveHandle(token),
      payload,
      sentAt: new Date().toISOString(),
    });
    this.nextId += 1;
    return Promise.resolve('ok');
  }

  /** The inbox, oldest first. */
  list(): readonly DemoPush[] {
    return this.pushes;
  }

  /** Empties the inbox (POST /demo/reset). Ids keep counting up. */
  clear(): void {
    this.pushes.length = 0;
  }
}
