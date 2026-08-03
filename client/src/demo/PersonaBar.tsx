// The demo strip, rendered under the app header in demo mode only
// (docs/DESIGN.md § Demo chrome): a "Demo" tag, the four persona pills, one
// status line, and the sweep/reset levers on the right.
//
// Switching persona is the demo's stand-in for signing out and signing in as
// someone else, which is why it replaces the sign-out button rather than
// joining it.
import { useState, type ReactElement } from 'react';
import { DemoControls, type DemoReport } from './DemoControls';
import { notifyDemoRefresh } from './demoRefresh';
import { useDemoPersonaSelection } from './personaContext';
import { DEMO_PERSONAS } from './personas';

export function DemoPersonaBar(): ReactElement | null {
  // One line, so the last thing that happened wins: a sweep or reset report
  // until the persona changes, then who the browser is acting as again.
  const [report, setReport] = useState<DemoReport | null>(null);
  const selection = useDemoPersonaSelection();
  if (selection === null) return null;
  const { persona, select } = selection;

  return (
    <div className="demo-bar">
      <span className="demo-tag">Demo</span>

      <nav className="demo-personas" aria-label="Demo persona">
        {DEMO_PERSONAS.map((option) => (
          <button
            key={option.id}
            type="button"
            className="demo-pill"
            aria-pressed={option.id === persona.id}
            onClick={() => {
              setReport(null);
              select(option.id);
            }}
          >
            {option.label}
          </button>
        ))}
      </nav>

      <p
        className={report?.tone === 'error' ? 'demo-note demo-note-error' : 'demo-note'}
        role="status"
      >
        {report === null ? `Acting as ${persona.name}. ${persona.detail}` : report.message}
      </p>

      <DemoControls onChanged={notifyDemoRefresh} onReport={setReport} />
    </div>
  );
}
