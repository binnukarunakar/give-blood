// The SPA-shell decision, shared by app.ts's not-found handler and the alert
// deep link (GB-32).
//
// A push deep link opens `/alerts/<dispatchId>` as a browser DOCUMENT load: no
// Authorization header, `Accept: text/html`. That path is ALSO a registered
// donor-authed JSON API route, so without a fallback the navigation renders
// `{"error":"unauthorized"}` as raw text instead of the app.
//
// The discriminator is the CALLER, not the path: a document load asks for
// text/html; every API client asks for application/json (or */*) and keeps the
// JSON behaviour it has today. Non-GET never gets the shell.
export const INDEX_HTML = 'index.html';

/** True for a browser document load — the only caller that should get the shell. */
export function wantsHtmlDocument(accept: string | undefined): boolean {
  return (accept ?? '').includes('text/html');
}
