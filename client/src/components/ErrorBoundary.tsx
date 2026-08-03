// The last line of defence between a thrown error and a black rectangle.
//
// The production bundle had exactly one failure mode with no UI: a missing
// VITE_FIREBASE_* variable makes firebaseConfig() throw inside
// FirebaseAuthProvider's effect, React unmounts the whole tree, and the page
// is left blank on --bg — indistinguishable from "still loading" and from "the
// server is down". Anything the app cannot recover from now says so and offers
// the one action that can help.
//
// A class component because that is the only thing React lets be an error
// boundary. It is deliberately dumb: no retry-in-place (the tree that threw is
// gone), no error text on screen (it may name internals), one reload button.
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';

const TITLE = 'Give Blood hit an error. Reload.';
const NOTE = 'The screen could not be built. If reloading does not help, this build is misconfigured.';

/** The fallback itself, exported so a non-React failure can render it too. */
export function FatalError(): ReactElement {
  return (
    <div className="fatal">
      <div className="fatal-card">
        <p className="fatal-title">{TITLE}</p>
        <p className="fatal-note">{NOTE}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink this app has; nothing is sent anywhere.
    // env.ts guarantees a message names a variable and never its value.
    console.error('Unrecoverable render error', error, info.componentStack);
  }

  public override render(): ReactNode {
    return this.state.failed ? <FatalError /> : this.props.children;
  }
}
