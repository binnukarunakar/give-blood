// One request, live. The requester's window on a dispatch they cannot see the
// inside of: aggregates, the pledges donors chose to make, and the two outcomes
// only the hospital can report.
//
// Polling, not sockets: a 12 s GET is enough for a flow measured in minutes,
// and it stops the moment the request reaches a terminal state so a forgotten
// tab does not poll a closed request forever. A failed background poll keeps the
// last good view and says it is stale rather than blanking the screen.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useLocation, useParams } from 'react-router';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { RequestDetail } from '../lib/apiTypes';
import { useAppRefresh } from '../lib/appRefresh';
import { PledgeList } from '../requester/PledgeList';
import { RequestFacts } from '../requester/RequestFacts';
import '../requester/requester.css';
import {
  ALERT_DELAY,
  isTerminal,
  NOT_A_REQUESTER,
  OFFLINE,
  POLL_MS,
  SIMILAR_WARNING,
  terminalMessage,
} from '../requester/requesterCopy';
import { Banner, Button, Card, ConfirmSheet, Skeleton } from '../ui';

const LOAD_FAILED = 'Could not load this request.';
const NOT_FOUND = 'This request is not available for your account.';
const NO_ID = 'This link is missing a request id.';
const STALE = 'Could not refresh. The numbers below may be out of date.';
const ACTION_FAILED = 'Could not save that. Try again.';
const NOT_ACTIVE = 'That pledge is no longer active. The view has been refreshed.';
const ALREADY_CLOSED = 'This request is already closed.';
const CANCEL_CONSEQUENCE =
  'Donors stop being alerted, and anyone who pledged is released and told not to come.';

type Screen =
  | { kind: 'loading' }
  | { kind: 'ready'; request: RequestDetail }
  | { kind: 'not_requester' }
  | { kind: 'error'; message: string };

/**
 * What RequesterHome hands over when it sends a requester straight here after
 * POST /requests (GB-33): the confirmation, and the soft duplicate advisory
 * that used to be a banner on the screen we no longer stop at.
 */
export interface CreatedNavigationState {
  created?: boolean;
  warning?: string;
}

function createdState(state: unknown): CreatedNavigationState {
  return typeof state === 'object' && state !== null ? (state as CreatedNavigationState) : {};
}

function releasedMessage(released: number): string {
  return released === 1
    ? '1 pledged donor was released and told not to come.'
    : `${String(released)} pledged donors were released and told not to come.`;
}

/** The facts header and one pledge card, in outline. */
function DetailSkeleton(): ReactElement {
  return (
    <>
      <div className="facts">
        <Skeleton width="140px" height="32px" radius="pill" label="Loading this request" />
        <Skeleton width="60%" height="20px" />
        <Skeleton width="80%" height="20px" />
      </div>
      <Card>
        <Skeleton width="45%" height="20px" />
        <Skeleton width="30%" />
      </Card>
    </>
  );
}

export function RequestDetailPage(): ReactElement {
  const { requestId } = useParams<{ requestId: string }>();
  const justCreated = createdState(useLocation().state);
  const refreshToken = useAppRefresh();
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [stale, setStale] = useState(false);
  const [busyPledgeId, setBusyPledgeId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [released, setReleased] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // background = a poll or a post-action refresh: a failure must not replace a
  // screen the requester is reading, so it only raises the stale line.
  const load = useCallback(
    async (background: boolean): Promise<void> => {
      if (requestId === undefined) {
        setScreen({ kind: 'error', message: NO_ID });
        return;
      }
      const result = await api.getRequest(requestId);
      if (result.ok) {
        setStale(false);
        setScreen({ kind: 'ready', request: result.data });
        return;
      }
      if (background) {
        setStale(true);
        return;
      }
      if (result.status === 403) {
        setScreen({ kind: 'not_requester' });
        return;
      }
      if (result.status === 404) {
        setScreen({ kind: 'error', message: NOT_FOUND });
        return;
      }
      setScreen({
        kind: 'error',
        message: result.status === TRANSPORT_STATUS ? OFFLINE : LOAD_FAILED,
      });
    },
    [requestId],
  );

  // refreshToken is a dep, not a trigger: something outside this tree (demo
  // Reset) said the data behind every screen is gone, so re-read it.
  useEffect(() => {
    void load(false);
  }, [load, refreshToken]);

  const live = screen.kind === 'ready' && !isTerminal(screen.request.state);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  async function act(
    pledgeId: string,
    call: (id: string) => Promise<{ ok: boolean; status: number }>,
  ): Promise<void> {
    setBusyPledgeId(pledgeId);
    setActionError(null);
    const result = await call(pledgeId);
    setBusyPledgeId(null);
    if (!result.ok) {
      if (result.status === TRANSPORT_STATUS) setActionError(OFFLINE);
      else setActionError(result.status === 409 ? NOT_ACTIVE : ACTION_FAILED);
    }
    // Re-read either way: the server's view is the only truth about states.
    await load(true);
  }

  async function cancelRequest(): Promise<void> {
    if (requestId === undefined) return;
    setCancelling(true);
    setActionError(null);
    const result = await api.cancelRequest(requestId);
    setCancelling(false);
    setConfirmCancel(false);
    if (result.ok) {
      setReleased(result.data.pledgesReleased);
    } else if (result.status === TRANSPORT_STATUS) {
      setActionError(OFFLINE);
    } else {
      setActionError(result.status === 409 ? ALREADY_CLOSED : ACTION_FAILED);
    }
    await load(true);
  }

  if (screen.kind === 'not_requester') {
    return (
      <>
        <div className="page-head">
          <h2 className="page-title">Request</h2>
        </div>
        <Card title="Requester access">
          <p className="calm-copy">{NOT_A_REQUESTER}</p>
        </Card>
      </>
    );
  }

  const closed = screen.kind === 'ready' ? terminalMessage(screen.request.state) : null;

  return (
    <>
      <div className="page-head">
        <h2 className="page-title">Request</h2>
      </div>

      {screen.kind === 'loading' ? <DetailSkeleton /> : null}

      {screen.kind === 'error' ? (
        <>
          <div className="banner-stack">
            <Banner tone="error">{screen.message}</Banner>
          </div>
          <Button variant="secondary" onClick={() => void load(false)}>
            Try again
          </Button>
        </>
      ) : null}

      {screen.kind === 'ready' ? (
        <>
          <RequestFacts request={screen.request} live={live} />

          <div className="banner-stack">
            {/* A promise, retired by the fact that fulfils it: the moment the
                alerted count moves, the sweep has run and the sentence is
                about the past. Data, not a timer — a slow sweep leaves it up. */}
            {closed === null &&
            justCreated.created === true &&
            screen.request.donorsAlerted === 0 ? (
              <Banner role="status">Request raised. Donors are {ALERT_DELAY}.</Banner>
            ) : null}
            {justCreated.warning === SIMILAR_WARNING ? (
              <Banner tone="warn" role="status">
                Another requester already has an open request for this blood group at this hospital.
                Both stay open — nothing was merged, and both are being alerted.
              </Banner>
            ) : null}
            {closed === null ? null : (
              <Banner tone="warn" role="status">
                {closed}
              </Banner>
            )}
            {released === null ? null : <Banner role="status">{releasedMessage(released)}</Banner>}
            {stale ? (
              <Banner tone="warn" role="status">
                {STALE}
              </Banner>
            ) : null}
          </div>

          {/* A finished request with nobody on its list has no pledge section
              at all — an empty "Pledges" heading is a question with no answer. */}
          {closed !== null && screen.request.pledges.length === 0 ? null : (
            <h3 className="section-title">Pledges</h3>
          )}
          <PledgeList
            pledges={screen.request.pledges}
            busyPledgeId={busyPledgeId}
            closed={closed !== null}
            onDonated={(id) => void act(id, (pledgeId) => api.markPledgeDonated(pledgeId))}
            onNoShow={(id) => void act(id, (pledgeId) => api.markPledgeNoShow(pledgeId))}
          />

          <div className="banner-stack">
            {actionError === null ? null : <Banner tone="error">{actionError}</Banner>}
          </div>

          {closed !== null ? null : confirmCancel ? (
            <div className="danger-foot">
              <ConfirmSheet
                title="Cancel this request?"
                consequence={CANCEL_CONSEQUENCE}
                confirmLabel="Yes, cancel the request"
                cancelLabel="Keep the request"
                confirmVariant="danger"
                busy={cancelling}
                onConfirm={() => void cancelRequest()}
                onCancel={() => setConfirmCancel(false)}
              />
            </div>
          ) : (
            <div className="danger-foot">
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Cancel this request
              </Button>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}
