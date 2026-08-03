// Donor home. GET /donors/me decides the screen: 404 means this account has no
// donor record yet and onboarding takes over; 200 means identity, alerts,
// donation record, and (when push is unverified) the enrolment card.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router';
import {
  DonorActivePledgeCard,
  DonorDonationCard,
  DonorIdentityCard,
  DonorSettings,
  Onboarding,
  PushSetup,
} from '../donor';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { DonorView } from '../lib/apiTypes';
import { useAppRefresh } from '../lib/appRefresh';
import { Banner, Button, Skeleton } from '../ui';

const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const LOAD_FAILED = 'Could not load your donor profile.';

/** Set by the service worker when the VERIFY_PUSH notification is tapped. */
const PUSH_PARAM = 'push';
const PUSH_PARAM_VALUE = 'verified';

type Screen =
  | { kind: 'loading' }
  | { kind: 'onboarding' }
  | { kind: 'ready'; donor: DonorView }
  | { kind: 'error'; message: string };

/** Shaped like the identity card and the alerts card that replace it. */
function DonorSkeleton(): ReactElement {
  return (
    <>
      <div className="skeleton-card">
        <div className="skeleton-row">
          <Skeleton width="52px" height="28px" radius="pill" label="Loading your donor profile" />
          <Skeleton width="140px" height="24px" />
        </div>
        <Skeleton width="60%" height="14px" />
        <Skeleton width="110px" height="22px" radius="pill" />
      </div>
      <div className="skeleton-card">
        <Skeleton width="80px" height="14px" />
        <Skeleton height="44px" />
        <Skeleton height="44px" />
        <Skeleton height="44px" />
      </div>
    </>
  );
}

export function DonorHome(): ReactElement {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [searchParams] = useSearchParams();
  const refreshToken = useAppRefresh();
  const cameFromVerifyPush = searchParams.get(PUSH_PARAM) === PUSH_PARAM_VALUE;

  const load = useCallback(async (): Promise<void> => {
    setScreen({ kind: 'loading' });
    const result = await api.getMe();
    if (result.ok) {
      setScreen({ kind: 'ready', donor: result.data });
      return;
    }
    if (result.status === 404) {
      setScreen({ kind: 'onboarding' });
      return;
    }
    setScreen({
      kind: 'error',
      message: result.status === TRANSPORT_STATUS ? OFFLINE : LOAD_FAILED,
    });
  }, []);

  // refreshToken is a dep, not a trigger: something outside this tree (demo
  // Reset) said the data behind every screen is gone, so re-read it.
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const setDonor = useCallback((donor: DonorView): void => {
    setScreen({ kind: 'ready', donor });
  }, []);

  if (screen.kind === 'onboarding') {
    return <Onboarding onComplete={() => void load()} />;
  }

  if (screen.kind === 'loading') {
    return <DonorSkeleton />;
  }

  if (screen.kind === 'error') {
    return (
      <div className="page-retry">
        <Banner tone="error">{screen.message}</Banner>
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  return (
    <section>
      {/* Above the identity card on purpose: a donor who is expected at a
          hospital has exactly one thing to do here, and it is not settings. */}
      {screen.donor.activePledge === null ? null : (
        <DonorActivePledgeCard pledge={screen.donor.activePledge} />
      )}
      <DonorIdentityCard donor={screen.donor} />
      {screen.donor.pushVerified ? null : (
        <PushSetup onVerified={() => void load()} autoConfirm={cameFromVerifyPush} />
      )}
      <DonorSettings donor={screen.donor} onDonor={setDonor} />
      <DonorDonationCard donor={screen.donor} onDonor={setDonor} />
    </section>
  );
}
