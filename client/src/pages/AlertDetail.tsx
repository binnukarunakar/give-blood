// Alert detail: the screen a push lands on. The notification carries only an
// id (no PHI), so everything shown here is fetched now, behind donor auth.
//
// The request may already be closed by the time the donor taps. That is the
// normal case, not an error: it renders as a calm end state with no accept UI.
//
// Every state on this screen is DERIVED FROM THE FETCH, never remembered from
// an action (GB-33). An accept used to live in React state, so a reload — a
// locked phone, a tapped notification, a browser restart — put the donor back
// on a screen offering to Accept something she had already accepted. Accept and
// withdraw now re-read GET /alerts/:id and render whatever `pledge` it returns.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import {
  AlertActions,
  AlertFacts,
  AlertState,
  closedCopy,
  isAcceptable,
  pledgeCopy,
  PledgeResult,
  type AlertAction,
} from '../donor';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { AcceptAlertInput, AlertDetail, RequestState } from '../lib/apiTypes';
import { Banner, Button, Skeleton } from '../ui';

const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const LOAD_FAILED = 'Could not load this alert.';
const NOT_FOUND = 'This alert is not available for your account.';
const NO_ID = 'This link is missing an alert id.';
const ACCEPT_FAILED = 'Could not record your acceptance. Try again.';
const DECLINE_FAILED = 'Could not record your decline. Try again.';
const ONE_PLEDGE =
  'You already have an active pledge for another request. Donors hold one pledge at a time, so withdraw that one before accepting this.';
const ALREADY_RESPONDED = 'You already responded to this alert.';

type Screen =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; alert: AlertDetail }
  /** Only from a 409 on accept: the server says closed, this fetch said open. */
  | { kind: 'closed'; state: RequestState }
  | { kind: 'declined' };

/** Chip row, blood display, hospital card — the layout that is landing. */
function AlertSkeleton(): ReactElement {
  return (
    <>
      <div className="alert-head">
        <div className="skeleton-row">
          <Skeleton width="92px" height="24px" radius="pill" label="Loading this alert" />
          <Skeleton width="110px" height="14px" />
        </div>
        <Skeleton width="200px" height="64px" radius="pill" />
      </div>
      <div className="skeleton-card">
        <Skeleton width="55%" height="22px" />
        <Skeleton width="70%" height="14px" />
        <Skeleton width="45%" height="14px" />
        <Skeleton height="44px" />
      </div>
    </>
  );
}

/** What a loaded alert renders: the pledge outranks the request's own state. */
function ReadyScreen({
  alert,
  sharePhoneDefault,
  busy,
  actionError,
  onAccept,
  onDecline,
  onWithdrawn,
}: {
  alert: AlertDetail;
  sharePhoneDefault: boolean | null;
  busy: AlertAction;
  actionError: string | null;
  onAccept: (input: AcceptAlertInput) => void;
  onDecline: () => void;
  onWithdrawn: () => void;
}): ReactElement {
  const { pledge } = alert;

  if (pledge !== null) {
    // An active pledge wins over a closed request: a donor already on her way
    // needs the directions, not the news that the request is now covered.
    if (pledge.state === 'active') {
      return <PledgeResult alert={alert} pledge={pledge} onWithdrawn={onWithdrawn} />;
    }
    // A recorded donation also outranks whatever the request did next — that
    // donor gave blood, and must never be told nothing was needed from her.
    // A pledge that merely lapsed defers to the request's own end state, which
    // is the more useful thing for that donor to read.
    if (pledge.state === 'donated' || isAcceptable(alert.requestState)) {
      return <AlertState {...pledgeCopy(pledge.state)} />;
    }
    return <AlertState {...closedCopy(alert.requestState)} />;
  }

  if (!isAcceptable(alert.requestState)) {
    return <AlertState {...closedCopy(alert.requestState)} />;
  }

  return (
    <section>
      <AlertFacts alert={alert} />
      <AlertActions
        urgency={alert.urgency}
        sharePhoneDefault={sharePhoneDefault}
        busy={busy}
        error={actionError}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    </section>
  );
}

export function AlertDetailPage(): ReactElement {
  const { alertId } = useParams<{ alertId: string }>();
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [sharePhoneDefault, setSharePhoneDefault] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<AlertAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // `quiet` = a re-read after an action the donor just took. It keeps the card
  // on screen instead of blinking through the skeleton on the way back.
  const load = useCallback(
    async (quiet = false): Promise<void> => {
      if (alertId === undefined) {
        setScreen({ kind: 'error', message: NO_ID });
        return;
      }
      if (!quiet) setScreen({ kind: 'loading' });
      setActionError(null);
      // The donor read only seeds the share-phone default; its failure is not
      // fatal (the field is then omitted and the server keeps its own value).
      const [alertResult, donorResult] = await Promise.all([api.getAlert(alertId), api.getMe()]);
      setSharePhoneDefault(donorResult.ok ? donorResult.data.sharePhoneOnAccept : null);

      if (alertResult.ok) {
        setScreen({ kind: 'ready', alert: alertResult.data });
        return;
      }
      if (alertResult.status === 404) {
        setScreen({ kind: 'error', message: NOT_FOUND });
        return;
      }
      setScreen({
        kind: 'error',
        message: alertResult.status === TRANSPORT_STATUS ? OFFLINE : LOAD_FAILED,
      });
    },
    [alertId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(input: AcceptAlertInput): Promise<void> {
    if (alertId === undefined) return;
    setBusy('accept');
    setActionError(null);
    const result = await api.acceptAlert(alertId, input);
    setBusy(null);
    if (result.ok) {
      // The accept response is not the source of truth for this screen; the
      // next GET is, and it is the same read a reload would do.
      await load(true);
      return;
    }
    if (result.status === 409 && result.error.error === 'request_closed') {
      setScreen({ kind: 'closed', state: result.error.requestState ?? 'fulfilled' });
      return;
    }
    if (result.status === 409 && result.error.error === 'active_pledge_exists') {
      setActionError(ONE_PLEDGE);
      return;
    }
    if (result.status === 409 && result.error.error === 'already_responded') {
      setActionError(ALREADY_RESPONDED);
      return;
    }
    setActionError(result.status === TRANSPORT_STATUS ? OFFLINE : ACCEPT_FAILED);
  }

  async function decline(): Promise<void> {
    if (alertId === undefined) return;
    setBusy('decline');
    setActionError(null);
    const result = await api.declineAlert(alertId);
    setBusy(null);
    if (result.ok) {
      setScreen({ kind: 'declined' });
      return;
    }
    if (result.status === 409 && result.error.error === 'already_responded') {
      setActionError(ALREADY_RESPONDED);
      return;
    }
    setActionError(result.status === TRANSPORT_STATUS ? OFFLINE : DECLINE_FAILED);
  }

  if (screen.kind === 'loading') return <AlertSkeleton />;

  if (screen.kind === 'error') {
    return (
      <div className="page-retry">
        <Banner tone="error">{screen.message}</Banner>
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  if (screen.kind === 'closed') return <AlertState {...closedCopy(screen.state)} />;

  if (screen.kind === 'declined') {
    return <AlertState title="You declined this alert" note="Other donors have been asked." />;
  }

  return (
    <ReadyScreen
      alert={screen.alert}
      sharePhoneDefault={sharePhoneDefault}
      busy={busy}
      actionError={actionError}
      onAccept={(input) => void accept(input)}
      onDecline={() => void decline()}
      onWithdrawn={() => void load(true)}
    />
  );
}
