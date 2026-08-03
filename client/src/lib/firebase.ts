// Firebase web SDK wiring: phone-OTP auth + FCM web push.
//
// Everything initialises LAZILY. Importing this module must never touch env or
// network, so tests and the login route render without a Firebase project. The
// app instance is created on first use and memoised.
//
// Messaging is optional by design: iOS < 16.4, Firefox private windows and any
// browser without the Push API return null from `isSupported()`. The caller
// treats "no token" as "not alertable" — the server already gates the pool on
// push verification (ARCHITECTURE: alertable = push-verified).
import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  type Auth,
  type ConfirmationResult,
  type User,
  type UserCredential,
} from 'firebase/auth';
import { getMessaging, getToken, isSupported, type Messaging } from 'firebase/messaging';
import { firebaseConfig } from '../env';

const APP_NAME = 'give-blood';

let messagingInstance: Messaging | null = null;

export function firebaseApp(): FirebaseApp {
  const existing = getApps().find((app) => app.name === APP_NAME);
  if (existing !== undefined) return existing;
  return initializeApp(firebaseConfig(), APP_NAME);
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}

/** Current user's ID token, or null when signed out. Refresh is handled by the SDK. */
export async function currentIdToken(): Promise<string | null> {
  const user = firebaseAuth().currentUser;
  if (user === null) return null;
  return user.getIdToken();
}

export function currentUser(): User | null {
  return firebaseAuth().currentUser;
}

export function signOutUser(): Promise<void> {
  return signOut(firebaseAuth());
}

/**
 * Build the invisible reCAPTCHA required by phone sign-in. `containerId` must
 * be an element already in the DOM. Callers must `clear()` it before retrying a
 * failed send — a spent verifier cannot be reused.
 */
export function createRecaptchaVerifier(containerId: string): RecaptchaVerifier {
  return new RecaptchaVerifier(firebaseAuth(), containerId, { size: 'invisible' });
}

/** Step 1 of phone OTP: send the SMS. `phoneNumber` must be E.164. */
export function startPhoneSignIn(
  phoneNumber: string,
  verifier: RecaptchaVerifier,
): Promise<ConfirmationResult> {
  return signInWithPhoneNumber(firebaseAuth(), phoneNumber, verifier);
}

/** Step 2 of phone OTP: exchange the 6-digit code for a session. */
export function confirmPhoneCode(
  confirmation: ConfirmationResult,
  code: string,
): Promise<UserCredential> {
  return confirmation.confirm(code);
}

/** Messaging instance, or null where the browser cannot receive web push. */
export async function messagingIfSupported(): Promise<Messaging | null> {
  if (messagingInstance !== null) return messagingInstance;
  if (!(await isSupported())) return null;
  messagingInstance = getMessaging(firebaseApp());
  return messagingInstance;
}

/**
 * FCM registration token for this browser, or null when messaging is
 * unsupported, permission was not granted, or the SW is not registered yet.
 * The token is the value POSTed to PUT /donors/me/push-token.
 */
export async function getFcmToken(vapidKey: string): Promise<string | null> {
  const messaging = await messagingIfSupported();
  if (messaging === null) return null;
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  return token === '' ? null : token;
}

export type { ConfirmationResult, RecaptchaVerifier, User };
