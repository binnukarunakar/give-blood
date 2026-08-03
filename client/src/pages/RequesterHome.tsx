// Requester home: the account's own requests, and the form that raises a new
// one. GET /requests/mine answers 403 not_a_requester for a signed-in account
// with no requester row — that is a normal outcome (a donor opened the tab),
// so it gets its own screen rather than an error.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { RequestCreated, RequestSummary } from '../lib/apiTypes';
import { useAppRefresh } from '../lib/appRefresh';
import { NewRequestForm } from '../requester/NewRequestForm';
import '../requester/requester.css';
import { RequestList } from '../requester/RequestList';
import { ALERT_DELAY, NOT_A_REQUESTER, OFFLINE } from '../requester/requesterCopy';
import { Banner, Button, Card, EmptyState, Skeleton } from '../ui';
import type { CreatedNavigationState } from './RequestDetail';

const LOAD_FAILED = 'Could not load your requests.';
const EMPTY = 'No requests yet. Raise one when a patient at your hospital needs blood.';

type Screen =
  | { kind: 'loading' }
  | { kind: 'list'; requests: RequestSummary[] }
  | { kind: 'not_requester' }
  | { kind: 'error'; message: string };

/** Newest first. The server already orders it; sorting here keeps the screen
 *  honest about its own promise regardless of what arrives. */
function newestFirst(requests: RequestSummary[]): RequestSummary[] {
  return [...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Two cards shaped like the list that is coming. No spinner on a full page. */
function ListSkeleton(): ReactElement {
  return (
    <>
      <Card>
        <Skeleton width="120px" height="24px" radius="pill" label="Loading your requests" />
        <Skeleton width="70%" height="20px" />
        <Skeleton width="45%" />
      </Card>
      <Card>
        <Skeleton width="120px" height="24px" radius="pill" />
        <Skeleton width="70%" height="20px" />
        <Skeleton width="45%" />
      </Card>
    </>
  );
}

export function RequesterHome(): ReactElement {
  const navigate = useNavigate();
  const refreshToken = useAppRefresh();
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await api.listMyRequests();
    if (result.ok) {
      setScreen({ kind: 'list', requests: newestFirst(result.data) });
      return;
    }
    if (result.status === 403) {
      setScreen({ kind: 'not_requester' });
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

  /**
   * Straight to the request that was just raised, not back to a list with a
   * banner pointing at it. Raising a request is not the job — watching it fill
   * is, and that screen is where a requester needs to be. The list stays one
   * back-navigation away, and carries the same request.
   */
  function onCreated(request: RequestCreated): void {
    const state: CreatedNavigationState = { created: true, warning: request.warning };
    void navigate(`/requester/requests/${request.requestId}`, { state });
  }

  function openForm(): void {
    setFormOpen(true);
  }

  if (screen.kind === 'not_requester') {
    return (
      <>
        <div className="page-head">
          <h2 className="page-title">Requester</h2>
        </div>
        <Card title="Requester access">
          <p className="calm-copy">{NOT_A_REQUESTER}</p>
          <p className="calm-copy">
            If you signed in to donate, open the <Link to="/donor">donor screen</Link>.
          </p>
        </Card>
      </>
    );
  }

  if (formOpen) {
    return (
      <>
        <div className="page-head">
          <div className="page-headings">
            <h2 className="page-title">New request</h2>
            <p className="page-lede">
              Donors near this hospital with a compatible group are {ALERT_DELAY}.
            </p>
          </div>
        </div>
        <NewRequestForm onCreated={onCreated} onCancel={() => setFormOpen(false)} />
      </>
    );
  }

  const empty = screen.kind === 'list' && screen.requests.length === 0;

  return (
    <>
      <div className="page-head">
        <h2 className="page-title page-headings">Requests</h2>
        {screen.kind === 'list' && !empty ? (
          <Button variant="primary" onClick={openForm}>
            New request
          </Button>
        ) : null}
      </div>

      <div className="banner-stack">
        {screen.kind === 'error' ? <Banner tone="error">{screen.message}</Banner> : null}
      </div>

      {screen.kind === 'loading' ? <ListSkeleton /> : null}

      {screen.kind === 'error' ? (
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      ) : null}

      {screen.kind === 'list' ? (
        empty ? (
          <EmptyState
            message={EMPTY}
            action={
              <Button variant="primary" onClick={openForm}>
                New request
              </Button>
            }
          />
        ) : (
          <RequestList requests={screen.requests} />
        )
      ) : null}
    </>
  );
}
