/// <reference lib="webworker" />
// Service worker: precache + push + notification click.
//
// PRIVACY INVARIANT (docs/PROTOCOL.md §3, canonical): the push payload is
// OPAQUE. It carries a fixed generic title/body written by the server plus
// `data: { type, alert_id }` — no blood group, hospital, distance, units or
// urgency. This worker therefore renders the notification EXACTLY as received
// and composes nothing: request detail is fetched on tap, behind donor auth,
// by the page it opens. Do not add request content here.
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

/** Route a notification opens, by payload type. */
const DONOR_PATH = '/donor';
/**
 * Donor home, flagged so the page knows the verification probe was tapped and
 * can POST /donors/me/push-verified itself (GB-22). No request content — the
 * flag says "this device received a notification" and nothing more.
 */
const VERIFY_PATH = '/donor?push=verified';
const ALERT_PATH_PREFIX = '/alerts/';

/** The three payload discriminators the server sends (server/src/push/pushSender.ts). */
const PUSH_TYPES = ['BLOOD_ALERT', 'REQUEST_CLOSED', 'VERIFY_PUSH'] as const;
type PushType = (typeof PUSH_TYPES)[number];

function isPushType(value: string): value is PushType {
  return (PUSH_TYPES as readonly string[]).includes(value);
}

interface PushData {
  type?: PushType;
  alert_id?: string;
}

/**
 * The FCM webpush envelope: `{ notification: { title, body }, data }`. Some
 * transports flatten title/body to the top level, so both are accepted — the
 * strings are still passed through untouched either way.
 */
interface PushEnvelope {
  notification?: { title?: string; body?: string };
  title?: string;
  body?: string;
  data?: PushData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPushData(value: unknown): PushData {
  if (!isRecord(value)) return {};
  const data: PushData = {};
  if (typeof value.type === 'string' && isPushType(value.type)) data.type = value.type;
  if (typeof value.alert_id === 'string') data.alert_id = value.alert_id;
  return data;
}

function parseEnvelope(event: PushEvent): PushEnvelope {
  if (event.data === null) return {};
  let raw: unknown;
  try {
    raw = event.data.json();
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const envelope: PushEnvelope = { data: readPushData(raw.data) };
  if (typeof raw.title === 'string') envelope.title = raw.title;
  if (typeof raw.body === 'string') envelope.body = raw.body;
  if (isRecord(raw.notification)) {
    const notification: { title?: string; body?: string } = {};
    if (typeof raw.notification.title === 'string') notification.title = raw.notification.title;
    if (typeof raw.notification.body === 'string') notification.body = raw.notification.body;
    envelope.notification = notification;
  }
  return envelope;
}

/**
 * Where a notification of this type should land: the alert route for the two
 * request-bound types, donor home for the verification probe (it has no request
 * context) and for anything unrecognised.
 */
function targetPath(data: PushData): string {
  switch (data.type) {
    case 'BLOOD_ALERT':
    case 'REQUEST_CLOSED':
      return data.alert_id === undefined || data.alert_id === ''
        ? DONOR_PATH
        : `${ALERT_PATH_PREFIX}${encodeURIComponent(data.alert_id)}`;
    case 'VERIFY_PUSH':
      return VERIFY_PATH;
    default:
      return DONOR_PATH;
  }
}

self.addEventListener('push', (event: PushEvent) => {
  const envelope = parseEnvelope(event);
  // Strings are shown verbatim; this worker never substitutes or enriches copy.
  const title = envelope.notification?.title ?? envelope.title ?? '';
  const body = envelope.notification?.body ?? envelope.body ?? '';
  const data = envelope.data ?? {};
  event.waitUntil(self.registration.showNotification(title, { body, data }));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const path = targetPath(readPushData(event.notification.data));
  const url = new URL(path, self.location.origin);
  event.waitUntil(focusOrOpen(url.href));
});

/** Focus an existing app window and navigate it; otherwise open a new one. */
async function focusOrOpen(href: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin === self.location.origin) {
      await client.focus();
      if ('navigate' in client) await client.navigate(href);
      return;
    }
  }
  await self.clients.openWindow(href);
}
