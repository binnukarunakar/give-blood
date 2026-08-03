// The floating half of the demo chrome: the push inbox, and nothing else. It
// renders outside <App/> (mountDemo.tsx) so no production screen has a demo
// branch in it. The levers live in the persona strip, which Layout places
// under the header — this subscribes to their signal instead of owning it.
import { useSyncExternalStore, type ReactElement } from 'react';
import { demoRefreshToken, subscribeDemoRefresh } from './demoRefresh';
import { PushInbox } from './PushInbox';

export function DemoPanel(): ReactElement {
  const refreshToken = useSyncExternalStore(
    subscribeDemoRefresh,
    demoRefreshToken,
    demoRefreshToken,
  );

  return <PushInbox refreshToken={refreshToken} />;
}
