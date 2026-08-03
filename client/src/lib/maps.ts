// Google Maps JS SDK loader.
//
// The SDK is OPTIONAL everywhere it is used: no browser key, a blocked script,
// or an offline device must degrade to a typed-coordinate form (onboarding) or
// an address-only card (alert detail). `loadMapsApi` therefore resolves with
// null instead of rejecting — callers branch on the value, never on a catch.
//
// Only the handful of SDK members this app touches are typed here; the project
// carries no @types/google.maps dependency and no `any`.
import { readEnv } from '../env';

export interface LatLngLiteral {
  lat: number;
  lng: number;
}

export interface MapsMouseEvent {
  latLng?: { lat: () => number; lng: () => number } | null;
}

export interface MapsMap {
  addListener: (eventName: string, handler: (event: MapsMouseEvent) => void) => void;
  setCenter: (position: LatLngLiteral) => void;
}

export interface MapsMarker {
  setPosition: (position: LatLngLiteral) => void;
}

interface MapsMapOptions {
  center: LatLngLiteral;
  zoom: number;
  disableDefaultUI: boolean;
  clickableIcons: boolean;
}

interface MapsMarkerOptions {
  position: LatLngLiteral;
  map: MapsMap;
  title: string;
}

export interface MapsApi {
  Map: new (container: HTMLElement, options: MapsMapOptions) => MapsMap;
  Marker: new (options: MapsMarkerOptions) => MapsMarker;
}

interface MapsGlobal {
  google?: { maps?: MapsApi };
}

/**
 * The same deep link POST /alerts/:id/accept returns (server
 * routes/pledgesShared.ts). The client rebuilds it when it is showing a pledge
 * it did not just create — a reloaded pledged screen has the hospital's
 * coordinates from GET /alerts/:id but no accept response to read a URL out of.
 * Destination only, never an origin: the donor's position is not ours to send.
 */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${String(lat)},${String(lng)}`;
}

const SDK_URL = 'https://maps.googleapis.com/maps/api/js';
const SCRIPT_ID = 'google-maps-sdk';
const LOAD_TIMEOUT_MS = 8000;

let pending: Promise<MapsApi | null> | null = null;

function installed(): MapsApi | null {
  return (globalThis as MapsGlobal).google?.maps ?? null;
}

/** The browser key, or undefined when this build ships without maps. */
export function mapsBrowserKeyOrUndefined(): string | undefined {
  return readEnv('VITE_MAPS_BROWSER_KEY');
}

function injectScript(key: string): Promise<MapsApi | null> {
  return new Promise((resolve) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing !== null) {
      resolve(installed());
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `${SDK_URL}?key=${encodeURIComponent(key)}&loading=async`;
    const timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    script.addEventListener('load', () => {
      clearTimeout(timer);
      resolve(installed());
    });
    script.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    document.head.appendChild(script);
  });
}

/**
 * The Maps namespace, or null when maps are unavailable for any reason (no
 * key, script blocked, load timeout). Memoised: one script tag per session.
 */
export function loadMapsApi(): Promise<MapsApi | null> {
  const ready = installed();
  if (ready !== null) return Promise.resolve(ready);

  const key = mapsBrowserKeyOrUndefined();
  if (key === undefined) return Promise.resolve(null);

  pending ??= injectScript(key);
  return pending;
}
