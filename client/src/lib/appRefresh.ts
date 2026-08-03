// "Everything on screen is stale — re-read it."
//
// A module-level counter with subscribers rather than lifted state, because the
// signal crosses React trees: the demo panel floats outside <App/> (see
// demo/mountDemo.tsx) and the persona strip lives inside it, so the two have no
// common provider. A page subscribes with useAppRefresh() and puts the token in
// its load effect's deps; bumping it re-runs every subscribed fetch.
//
// Production code owns this file. Demo Reset is currently its only caller
// (demo/demoRefresh.ts re-exports it), which is why the signal has to be here
// and not in src/demo: a production page may never import a demo module.
import { useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();
let token = 0;

/** The current value. Every bump is a new number, so it is a useful dep. */
export function appRefreshToken(): number {
  return token;
}

/** Tell every subscribed screen its data is stale. */
export function notifyAppRefresh(): void {
  token += 1;
  for (const listener of listeners) listener();
}

export function subscribeAppRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The token, as a render-triggering value. Put it in the load effect's deps. */
export function useAppRefresh(): number {
  return useSyncExternalStore(subscribeAppRefresh, appRefreshToken, appRefreshToken);
}
