// Demo entrypoint. Reached only from main.tsx when VITE_DEMO_MODE=1, via a
// dynamic import that a normal build folds away.
//
// It composes the SAME <App/> the production entry renders — same routes, same
// pages, same api client. The only substitutions are the auth provider (fake
// personas instead of Firebase) and the panel appended under the app.
import { StrictMode, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from '../App';
import './demo.css';
import { DemoAuthProvider } from './DemoAuthProvider';
import { DemoPanel } from './DemoPanel';
import { installDemoTokenSource } from './demoSession';
import { useDemoPersonaSelection } from './personaContext';

/**
 * The app, keyed on the active persona's uid. Pages load in effects that do not
 * depend on the identity, so without the key a switch would leave the previous
 * persona's data on screen under the new persona's banner. Changing the key
 * throws the whole subtree away and mounts it again, which is what a real
 * sign-out/sign-in does.
 */
function PersonaKeyedApp(): ReactElement {
  const selection = useDemoPersonaSelection();
  return <App key={selection?.persona.uid ?? 'no-persona'} />;
}

/**
 * Marks the document as demo-mode so demo.css can reserve room at the foot of
 * every page for the floating push inbox. Production never runs this file, so
 * no production page pays for the class.
 */
const DEMO_BODY_CLASS = 'demo-mode';

/** Returns the root so a caller (the mount test) can unmount it again. */
export function mountDemo(container: HTMLElement): Root {
  // Before the first render: the opening request must already carry a token.
  installDemoTokenSource();
  document.body.classList.add(DEMO_BODY_CLASS);

  const root = createRoot(container);
  root.render(
    <StrictMode>
      <BrowserRouter>
        <DemoAuthProvider>
          <PersonaKeyedApp />
          <DemoPanel />
        </DemoAuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
  return root;
}
