// One refresh signal, shared by two React trees — and, since GB-33, by the
// pages inside them.
//
// The demo controls sit in the persona strip, which Layout renders inside
// <App/>; the push inbox floats outside it (mountDemo.tsx). The two have no
// common provider, so "something changed, re-read now" is a module-level
// counter with subscribers rather than lifted state.
//
// The counter itself moved to src/lib/appRefresh.ts at GB-33, because Reset has
// to reach the pages too: it dropped and reseeded the database while requester
// home went on listing requests that no longer existed, and only the push inbox
// noticed. A production page may never import a demo module, so the store lives
// in lib/ and this file is the demo's name for it.
export {
  appRefreshToken as demoRefreshToken,
  notifyAppRefresh as notifyDemoRefresh,
  subscribeAppRefresh as subscribeDemoRefresh,
} from '../lib/appRefresh';
