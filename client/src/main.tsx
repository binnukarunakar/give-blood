import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { FirebaseAuthProvider } from './auth/FirebaseAuthProvider';
import { ErrorBoundary, FatalError } from './components/ErrorBoundary';
import { DEMO_MODE } from './demo/demoMode';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root is missing from index.html');
}

// Demo mode is decided at build time (see demo/demoMode.ts): with
// VITE_DEMO_MODE unset this branch folds away and rollup drops src/demo from
// the bundle, so the production entry below is the only path that exists.
if (DEMO_MODE) {
  void import('./demo/mountDemo')
    .then(({ mountDemo }) => mountDemo(container))
    .catch(() => {
      container.textContent = 'The demo bundle failed to load. Rebuild and reload.';
    });
} else {
  const root = createRoot(container);
  // Two nets, because they catch different throws. The boundary catches what is
  // raised while React renders or runs an effect — where a missing
  // VITE_FIREBASE_* variable lands (FirebaseAuthProvider's effect calls
  // firebaseConfig()), and what used to leave the deployed bundle as a blank
  // black page. The try/catch covers a throw before React owns the tree at all,
  // when there is no boundary in it yet to do the catching.
  try {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <BrowserRouter>
            <FirebaseAuthProvider>
              <App />
            </FirebaseAuthProvider>
          </BrowserRouter>
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch {
    root.render(<FatalError />);
  }
}
