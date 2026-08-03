// Test/E2E push sender: records every send and returns scripted results.
//
// Deterministic and inspectable — the dispatch engine tests assert the exact
// payload shape and ordering from `sent`, and later E2E flows reuse it.
import type { PushPayload, PushResult, PushSender } from './pushSender.js';

/**
 * One recorded send, in call order. `payload` is the FULL PushPayload union:
 * this fake carries closure notices and verify probes too, and narrowing it to
 * AlertPushPayload only type-checked because TypeScript method parameters are
 * bivariant (GB-17 finding) — the recorded VERIFY_PUSH / REQUEST_CLOSED sends
 * were mistyped as blood alerts.
 */
export interface RecordedSend {
  token: string;
  payload: PushPayload;
}

/**
 * In-memory PushSender. Every send is appended to the public `sent` array.
 * Results are scripted per token; any token absent from the map returns 'ok'.
 */
export class FakePushSender implements PushSender {
  /** Public, ordered log of every send — read directly in assertions. */
  public readonly sent: RecordedSend[] = [];

  private readonly scripted: Map<string, PushResult>;

  constructor(scripted: Map<string, PushResult> = new Map()) {
    this.scripted = scripted;
  }

  send(token: string, payload: PushPayload): Promise<PushResult> {
    this.sent.push({ token, payload });
    return Promise.resolve(this.scripted.get(token) ?? 'ok');
  }
}
