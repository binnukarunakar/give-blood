// Demo mode is a BUILD-TIME switch, never a runtime one.
//
// Vite statically replaces `import.meta.env.VITE_DEMO_MODE`, so a normal build
// folds every `DEMO_MODE ?` branch to its false side and rollup drops this
// whole directory from the bundle: no persona tokens, no demo screens, no
// second auth path. That is the guarantee behind the ticket's AC — a
// production build of client/ must not contain the string 'demo-asha'.
//
// Nothing here may ever be consulted at runtime to change production
// behaviour: there is no query string, no localStorage key and no header that
// turns demo mode on in a build made without VITE_DEMO_MODE=1.
export const DEMO_MODE: boolean = import.meta.env.VITE_DEMO_MODE === '1';
